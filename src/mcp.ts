/**
 * Eter Browser MCP server.
 *
 * This is a THIN CLIENT. It never launches or owns a browser: the
 * `eter-browser ui` daemon owns the single agent Chrome that holds the
 * user's real login sessions. Every tool here is one HTTP call to that
 * daemon at DAEMON_URL. If the daemon is down, every tool fails with an
 * actionable message telling the agent what to ask the human to do.
 *
 * Transport is stdio, so nothing in this file may write to stdout.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DAEMON_URL } from './config.js';

const DAEMON_DOWN =
  'Eter Browser daemon is not running. Ask the user to run `npx eter-browser ui` ' +
  `(dashboard at ${DAEMON_URL}).`;

/** One HTTP round trip to the daemon. Throws Errors an agent can act on. */
async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${DAEMON_URL}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // fetch only rejects on transport failure (ECONNREFUSED, DNS, socket reset).
    throw new Error(DAEMON_DOWN);
  }

  const raw = await res.text();
  let data: unknown = undefined;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
  }

  if (!res.ok) {
    // The daemon reports every handler failure as HTTP 400 { error: "..." }.
    const err = (data as { error?: unknown } | undefined)?.error;
    throw new Error(
      typeof err === 'string' && err
        ? err
        : `Eter Browser daemon returned HTTP ${res.status} for ${method} ${path}.`,
    );
  }

  return data ?? {};
}

/**
 * Shared handler wrapper: JSON-stringifies the result, and converts any thrown
 * error into an isError tool result so an exception can never escape a handler
 * and kill the stdio server.
 */
function handler<Args>(run: (args: Args) => Promise<unknown>): (args: Args) => Promise<CallToolResult> {
  return async (args: Args): Promise<CallToolResult> => {
    try {
      const result = await run(args);
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  };
}

const siteId = z
  .string()
  .describe("Session id as returned by list_sessions, e.g. 'facebook', 'instagram', 'x', 'linkedin'.");

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'eter-browser', version: '0.1.0' });

  // ------------------------------------------------------------- sessions

  server.registerTool(
    'list_sessions',
    {
      title: 'List login sessions',
      description:
        "List the user's shared browser login sessions and whether each is ready to use RIGHT NOW. " +
        'Call this FIRST before any browsing that needs a login. Each session reports its siteId, ' +
        'status (ready / needs_login / checkpoint / unknown), the signed-in account when known, how ' +
        'many minutes since it was last verified, and whether it is stale enough to re-check. Also ' +
        'returns the state of the shared agent Chrome and the sites that can still be enrolled.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async () => {
      const status = (await call('GET', '/api/status')) as {
        sessions?: unknown;
        browser?: unknown;
        availableSites?: unknown;
      };
      return {
        browser: status.browser ?? null,
        sessions: status.sessions ?? [],
        availableSites: status.availableSites ?? [],
      };
    }),
  );

  server.registerTool(
    'check_session',
    {
      title: 'Re-verify a session',
      description:
        'Re-verify one session against the live site. Use when a session looks stale or an action ' +
        'failed with an auth error. This drives the real browser, so it is slower than list_sessions ' +
        "— do not call it in a loop. A result status of 'ready' means you can act on that site now; " +
        "anything else means the human has to help (see request_login).",
      inputSchema: { siteId },
      annotations: { openWorldHint: true },
    },
    handler(async ({ siteId: id }: { siteId: string }) =>
      call('POST', `/api/sessions/${encodeURIComponent(id)}/check`, { deep: true }),
    ),
  );

  server.registerTool(
    'request_login',
    {
      title: 'Ask the human to sign in',
      description:
        "Ask the human to sign in. Opens the agent Chrome at the site's login page. The human must " +
        'complete it — you cannot. After calling this, tell the user to sign in and then call ' +
        'check_session. Only use this when list_sessions or check_session shows the site is not ready.',
      inputSchema: { siteId },
      annotations: { openWorldHint: true },
    },
    handler(async ({ siteId: id }: { siteId: string }) =>
      call('POST', `/api/sessions/${encodeURIComponent(id)}/login`),
    ),
  );

  // -------------------------------------------------------------- browser

  server.registerTool(
    'browser_navigate',
    {
      title: 'Navigate the agent browser',
      description:
        'Navigate the shared agent Chrome to a URL and return the final URL and page title. Pages ' +
        'behind a login require a ready session for that site — check list_sessions first. Follow ' +
        'this with browser_read to see what loaded.',
      inputSchema: {
        url: z.string().describe('Absolute URL to open, including the scheme (https://...).'),
      },
      annotations: { openWorldHint: true },
    },
    handler(async ({ url }: { url: string }) => call('POST', '/api/browser/navigate', { url })),
  );

  server.registerTool(
    'browser_read',
    {
      title: 'Read the current page',
      description:
        'Read the visible text of the current page in the shared agent Chrome, along with its URL ' +
        'and title. Use it after browser_navigate, browser_click or browser_type to see the result. ' +
        'Requires a ready session for that site when the page is behind a login.',
      inputSchema: {
        maxChars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum characters of page text to return. Defaults to 8000.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ maxChars }: { maxChars?: number }) =>
      call('POST', '/api/browser/read', { maxChars: maxChars ?? 8000 }),
    ),
  );

  server.registerTool(
    'browser_click',
    {
      title: 'Click an element',
      description:
        'Click an element by its visible text or accessible name. Matching is case-insensitive and ' +
        'the text is treated as a regular expression; pass role to disambiguate when several things ' +
        'share a name. Fails if nothing matches, so read the page first. Requires a ready session ' +
        'for that site when the page is behind a login.',
      inputSchema: {
        name: z.string().describe('Visible text or accessible name of the element to click.'),
        role: z
          .string()
          .optional()
          .describe("ARIA role to narrow the match, e.g. 'button', 'link', 'checkbox'."),
      },
      annotations: { openWorldHint: true },
    },
    handler(async ({ name, role }: { name: string; role?: string }) =>
      call('POST', '/api/browser/click', { name, role }),
    ),
  );

  server.registerTool(
    'browser_type',
    {
      title: 'Type into a field',
      description:
        'Type into a field found by label/placeholder/accessible name. The label is matched ' +
        'case-insensitively as a regular expression. Set submit to true to press Enter afterwards ' +
        '(useful for search boxes). Requires a ready session for that site when the page is behind ' +
        'a login. Never type the human\'s credentials — use request_login for sign-in.',
      inputSchema: {
        label: z.string().describe('Label, placeholder or accessible name of the input field.'),
        text: z.string().describe('Text to type into the field.'),
        submit: z.boolean().optional().describe('Press Enter after typing. Defaults to false.'),
      },
      annotations: { openWorldHint: true },
    },
    handler(async ({ label, text, submit }: { label: string; text: string; submit?: boolean }) =>
      call('POST', '/api/browser/type', { label, text, submit: submit === true }),
    ),
  );

  server.registerTool(
    'browser_screenshot',
    {
      title: 'Screenshot the current page',
      description:
        'Take a screenshot of the current page in the shared agent Chrome and return the PNG file ' +
        "path on the user's machine. Use it when the page text alone is not enough, or to show the " +
        'human what the browser is looking at.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async () => call('POST', '/api/browser/screenshot')),
  );

  // ------------------------------------------------------------- whatsapp

  server.registerTool(
    'whatsapp_list_chats',
    {
      title: 'List WhatsApp chats',
      description:
        "List the signed-in user's WhatsApp Web conversations, most recent first, with the exact chat " +
        'name, last message preview, timestamp and unread count. Call this FIRST before reading or ' +
        'sending, because whatsapp_read_chat and whatsapp_send_message match on the exact chat name. ' +
        "Requires a ready 'web-whatsapp-com' session; if it is not linked the tool says so and the " +
        'human must scan a QR code (see request_login).',
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('How many chats to return. Defaults to 20.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ limit }: { limit?: number }) => call('POST', '/api/wa/chats', { limit: limit ?? 20 })),
  );

  server.registerTool(
    'whatsapp_read_chat',
    {
      title: 'Read a WhatsApp conversation',
      description:
        'Read recent messages from one WhatsApp conversation, oldest first. Each message reports its ' +
        "direction ('in' or 'out'), author, timestamp, text and delivery status. target is either an " +
        'exact chat name from whatsapp_list_chats, or a phone number in international format with no ' +
        "plus sign (e.g. 60123456789). Opening a chat marks it as read on the user's phone.",
      inputSchema: {
        target: z.string().describe('Exact chat name from whatsapp_list_chats, or a phone number like 60123456789.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('How many recent messages to return. Defaults to 20.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ target, limit }: { target: string; limit?: number }) =>
      call('POST', '/api/wa/read', { target, limit: limit ?? 20 }),
    ),
  );

  server.registerTool(
    'whatsapp_send_message',
    {
      title: 'Send a WhatsApp message',
      description:
        'Send a WhatsApp message and verify it actually left. target is either an exact chat name from ' +
        'whatsapp_list_chats, or a phone number in international format with no plus sign (e.g. ' +
        '60123456789) — the number form is the only way to reach someone with no existing chat. ' +
        'Returns ok:false if the message never came back as a sent outgoing message; NEVER tell the ' +
        'user it sent unless ok is true. This messages real people from the human\'s own account, so ' +
        'only call it for a message the user explicitly asked you to send, to a recipient they named.',
      inputSchema: {
        target: z.string().describe('Exact chat name from whatsapp_list_chats, or a phone number like 60123456789.'),
        text: z.string().describe('The exact message text to send.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    handler(async ({ target, text }: { target: string; text: string }) =>
      call('POST', '/api/wa/send', { target, text }),
    ),
  );

  // ------------------------------------------------------------- chatgpt

  server.registerTool(
    'chatgpt_ask',
    {
      title: 'Ask ChatGPT a question',
      description:
        'A free text-in / text-out reasoning engine, driven through the signed-in ChatGPT web UI. Ask a ' +
        'plain-language question, get plain text back. It is NOT an API: there is no system prompt, no ' +
        'temperature, no model choice, no token counts, and no guaranteed JSON — asking for a strict ' +
        'schema will sometimes get prose instead. Every call runs in a temporary chat and is completely ' +
        'STATELESS: it remembers nothing between calls, so a follow-up question must repeat whatever ' +
        'context it needs. One question at a time; concurrent callers queue behind each other and a ' +
        'question takes roughly 4-10 seconds. Best for second opinions, summarising, classifying and ' +
        'drafting, where a wrong answer is cheap. Returns ok:false rather than a partial answer, so ' +
        'never treat a failed call as a short reply.',
      inputSchema: {
        question: z
          .string()
          .describe('The question, in plain language, exactly as you would type it into a chat box.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ question }: { question: string }) => call('POST', '/api/chatgpt/ask', { question })),
  );

  // ------------------------------------------------------------- facebook

  server.registerTool(
    'facebook_read_my_posts',
    {
      title: 'Read my Facebook posts',
      description:
        "Read the signed-in user's own recent Facebook posts. Requires a ready 'facebook' session; " +
        'the daemon re-verifies it first and errors if the human needs to sign in again — in that ' +
        'case call request_login. Each post includes a permalink you can pass to facebook_comment.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('How many posts to read. Defaults to 5. Keep it small to stay under rate limits.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ limit }: { limit?: number }) =>
      call('POST', '/api/fb/my-posts', { limit: limit ?? 5 }),
    ),
  );

  server.registerTool(
    'facebook_read_feed',
    {
      title: 'Read the Facebook feed',
      description:
        "Read recent posts from the signed-in user's Facebook home feed. Requires a ready 'facebook' " +
        'session; the daemon re-verifies it first and errors if the human needs to sign in again. ' +
        'Each post includes a permalink you can pass to facebook_comment.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('How many posts to read. Defaults to 5. Keep it small to stay under rate limits.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ limit }: { limit?: number }) => call('POST', '/api/fb/feed', { limit: limit ?? 5 })),
  );

  server.registerTool(
    'facebook_comment',
    {
      title: 'Comment on a Facebook post',
      description:
        'Post a comment on a Facebook post. postUrl must be a permalink returned by ' +
        "facebook_read_my_posts or facebook_read_feed. Requires a ready 'facebook' session. This " +
        "publishes publicly under the human's own name, so only do it when the user explicitly " +
        'asked for this exact comment.',
      inputSchema: {
        postUrl: z
          .string()
          .describe('Permalink of the post, exactly as returned by facebook_read_my_posts or facebook_read_feed.'),
        text: z.string().describe('The comment text to publish.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    handler(async ({ postUrl, text }: { postUrl: string; text: string }) =>
      call('POST', '/api/fb/comment', { postUrl, text }),
    ),
  );

  server.registerTool(
    'facebook_recon',
    {
      title: 'Find people interested in a topic on Facebook',
      description:
        'READ ONLY. Sweeps Facebook for people who appear interested in a topic. EVERY CALL CREATES A ' +
        'NEW PROJECT — it never appends to an earlier harvest. It RETURNS IMMEDIATELY with the project ' +
        'id and the path to its HTML report, while the sweep keeps running in the background for ' +
        'several minutes: poll facebook_recon_projects until that project\'s status leaves "running", ' +
        'then read its counters and contacts. Do not call this again while one is running. ' +
        'Scores every post against a per-topic keyword pack, then opens only the promising ones to ' +
        'collect commenters. Collects name, profile URL, Messenger link, and any phone or email the ' +
        'person published themselves, with the quote that shows their interest. Never replies, ' +
        'comments, likes or messages anyone. Sources: "feed", "search" or "search:<query>", ' +
        '"group:<url>", "thread:<url>". Group sources only work for groups the human has ALREADY ' +
        'joined — this tool never joins anything, so its reach is capped by existing membership and a ' +
        'topic with no matching joined group will return an empty harvest. A contact already found by ' +
        'an earlier project is flagged with priorProjects rather than dropped — check it before ' +
        'suggesting outreach, so the same person is not pitched twice.',
      inputSchema: {
        topic: z.string().describe('The subject to prospect for, e.g. "solar".'),
        sources: z
          .array(z.string())
          .optional()
          .describe('Where to look. Defaults to ["feed"]. e.g. ["group:https://www.facebook.com/groups/xyz", "search"].'),
        minScore: z.number().int().optional().describe('Gate threshold. Lower finds more and noisier. Defaults to 3.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ topic, sources, minScore }: { topic: string; sources?: string[]; minScore?: number }) =>
      call('POST', '/api/fb/recon', { topic, sources, minScore }),
    ),
  );

  server.registerTool(
    'facebook_recon_projects',
    {
      title: 'List Facebook prospecting projects',
      description:
        'READ ONLY. List every fb-recon project on this machine, newest first, with its status, ' +
        'inputs, counters and harvested contacts. Use this to answer "what prospecting have we done" ' +
        'or to re-read an earlier run\'s results instead of sweeping Facebook again.',
      annotations: { readOnlyHint: true },
    },
    handler(async () => call('GET', '/api/fb/recon/projects')),
  );

  // ---------------------------------------------------- automation registry

  server.registerTool(
    'search_automations',
    {
      title: 'Find an automation',
      description:
        'Search the catalogue of built automations by intent, e.g. "find companies on google maps" or ' +
        '"who messaged me". Call this FIRST when a request sounds like a job this machine already knows ' +
        'how to do — a purpose-built automation is far faster and more reliable than driving the browser ' +
        'with primitives. Each result gives an id, what it is for, its effect (read / write / destructive), ' +
        'any login it needs, and the exact argument shape to pass to run_automation. An empty query ' +
        'returns the whole catalogue, which answers "what can you do?".',
      inputSchema: {
        query: z.string().describe('Plain-language description of the job. Empty string lists everything.'),
        limit: z.number().int().optional().describe('Max results. Defaults to 10.'),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async ({ query, limit }: { query: string; limit?: number }) =>
      call('POST', '/api/automations/search', { query, limit }),
    ),
  );

  server.registerTool(
    'run_automation',
    {
      title: 'Run an automation',
      description:
        'Run an automation found via search_automations, by id. Pass its arguments as `args`, matching the ' +
        'signature that search returned. Check the effect first: `destructive` automations send or post ' +
        'something on behalf of the user, and need the user to have asked for that specific action. ' +
        'Long jobs (e.g. gmaprecon_harvest) do a bounded chunk per call and are safe to call repeatedly ' +
        'until their status reports nothing pending.',
      inputSchema: {
        id: z.string().describe('Automation id, e.g. "gmaprecon_harvest".'),
        args: z.record(z.string(), z.unknown()).optional().describe('Arguments object matching the signature.'),
      },
      annotations: { openWorldHint: true },
    },
    handler(async ({ id, args }: { id: string; args?: Record<string, unknown> }) =>
      call('POST', '/api/automations/run', { id, args: args ?? {} }),
    ),
  );

  return server;
}

/** Build the MCP server and serve it over stdio. Called by `eter-browser mcp`. */
export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
