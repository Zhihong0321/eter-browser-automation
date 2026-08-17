/**
 * Per-project token ledger: what was spent, on which model, in which phase.
 *
 * Append-only and written to disk after every entry, so a run that is killed
 * halfway still leaves an accurate record of what it burned. Kept beside the
 * blueprint in the project directory — the blueprint is the design contract and
 * should stay diffable, so cost lives in its own file rather than mutating the
 * design record on every call.
 *
 * A NOTE ON COST, which matters here more than usual:
 *
 * The SDK reports `costUSD` from Anthropic's own pricing table, looked up by
 * model id. This pipeline's builder is kimi-k3 behind a third-party proxy and
 * its reviewer is StepFun — neither appears in that table. Any dollar figure the
 * SDK returns for them is therefore meaningless, and reporting it as if it were
 * real would be worse than reporting nothing. So every entry carries
 * `costTrusted`, and totals keep trusted and untrusted money apart.
 *
 * Token COUNTS are provider-reported and are trustworthy. Those are the numbers
 * to bill against.
 */
import fs from 'node:fs';
import path from 'node:path';

export type Phase = 'intake' | 'blueprint' | 'build' | 'review' | 'image';

export interface UsageEntry {
  at: string;
  phase: Phase;
  /** Model id as the provider reported it, not as we requested it. */
  model: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Only meaningful when costTrusted is true. See the note at the top. */
  costUSD: number;
  costTrusted: boolean;
  /** Images generated, for endpoints billed per image rather than per token. */
  images: number;
  ms: number;
  note?: string;
}

export interface ModelTotal {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  images: number;
  costUSD: number;
  costTrusted: boolean;
}

export interface LedgerTotals {
  byModel: ModelTotal[];
  byPhase: { phase: Phase; inputTokens: number; outputTokens: number; calls: number }[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  images: number;
  /** Sum of costs we actually trust. */
  costUSD: number;
  /** True when at least one call ran on a model with no reliable pricing. */
  hasUntrustedCost: boolean;
}

/**
 * Only first-party Anthropic ids have a valid entry in the SDK's pricing table.
 * Everything this pipeline runs on is deliberately NOT that.
 */
function costIsTrustworthy(model: string, provider?: string): boolean {
  if (provider && provider !== 'firstParty') return false;
  return /^claude-/i.test(model);
}

export class Ledger {
  readonly file: string;
  #entries: UsageEntry[] = [];

  constructor(projectDir: string, filename = 'ledger.json') {
    this.file = path.join(projectDir, filename);
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { entries?: UsageEntry[] };
        this.#entries = parsed.entries ?? [];
      } catch {
        // A corrupt ledger must not abort a paid run. Start fresh; the run's own
        // entries are still recorded and the old file is overwritten.
        this.#entries = [];
      }
    }
  }

  get entries(): readonly UsageEntry[] {
    return this.#entries;
  }

  /** Record one call and flush immediately. */
  record(entry: Omit<UsageEntry, 'at' | 'costTrusted'> & { costTrusted?: boolean }): UsageEntry {
    const full: UsageEntry = {
      at: new Date().toISOString(),
      costTrusted: entry.costTrusted ?? costIsTrustworthy(entry.model, entry.provider),
      ...entry,
    };
    this.#entries.push(full);
    this.#flush();
    return full;
  }

  /**
   * Record every model an SDK result touched.
   *
   * Reads `modelUsage`, not `usage`: the SDK documents `usage` as main-agent-loop
   * only, excluding subagent and auxiliary calls — which would silently
   * under-report any run that spawned a Task. Returns the entries written, empty
   * if the result carried no usage (crash and startup-error results zero it).
   */
  recordSdkResult(phase: Phase, result: unknown, ms = 0): UsageEntry[] {
    const r = result as {
      modelUsage?: Record<
        string,
        {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
          costUSD?: number;
          provider?: string;
          canonicalModel?: string;
        }
      >;
      duration_ms?: number;
    };
    const usage = r.modelUsage;
    if (!usage) return [];

    return Object.entries(usage).map(([model, u]) =>
      this.record({
        phase,
        model,
        provider: u.provider,
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
        cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
        costUSD: u.costUSD ?? 0,
        images: 0,
        ms: ms || r.duration_ms || 0,
        costTrusted: costIsTrustworthy(u.canonicalModel ?? model, u.provider),
      }),
    );
  }

  totals(): LedgerTotals {
    const byModel = new Map<string, ModelTotal>();
    const byPhase = new Map<Phase, { phase: Phase; inputTokens: number; outputTokens: number; calls: number }>();

    for (const e of this.#entries) {
      const m =
        byModel.get(e.model) ??
        {
          model: e.model,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          images: 0,
          costUSD: 0,
          costTrusted: true,
        };
      m.calls++;
      m.inputTokens += e.inputTokens;
      m.outputTokens += e.outputTokens;
      m.cacheReadInputTokens += e.cacheReadInputTokens;
      m.images += e.images;
      if (e.costTrusted) m.costUSD += e.costUSD;
      // One untrusted call taints the model's cost total; never average it away.
      else m.costTrusted = false;
      byModel.set(e.model, m);

      const p = byPhase.get(e.phase) ?? { phase: e.phase, inputTokens: 0, outputTokens: 0, calls: 0 };
      p.calls++;
      p.inputTokens += e.inputTokens;
      p.outputTokens += e.outputTokens;
      byPhase.set(e.phase, p);
    }

    const inputTokens = this.#entries.reduce((a, e) => a + e.inputTokens, 0);
    const outputTokens = this.#entries.reduce((a, e) => a + e.outputTokens, 0);

    return {
      byModel: [...byModel.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
      byPhase: [...byPhase.values()],
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      images: this.#entries.reduce((a, e) => a + e.images, 0),
      costUSD: this.#entries.filter((e) => e.costTrusted).reduce((a, e) => a + e.costUSD, 0),
      hasUntrustedCost: this.#entries.some((e) => !e.costTrusted),
    };
  }

  #flush(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(
      this.file,
      JSON.stringify({ totals: this.totals(), entries: this.#entries }, null, 2),
    );
  }
}

const n = (v: number): string => v.toLocaleString('en-US');

/** The ledger as a block a human reads at the end of a run. */
export function formatTotals(t: LedgerTotals): string {
  const lines = [
    `  tokens: ${n(t.totalTokens)} total — ${n(t.inputTokens)} in / ${n(t.outputTokens)} out`,
  ];
  if (t.images) lines.push(`  images: ${t.images}`);
  for (const m of t.byModel) {
    lines.push(
      `    ${m.model.padEnd(22)} ${String(m.calls).padStart(3)} calls · ` +
        `${n(m.inputTokens).padStart(9)} in / ${n(m.outputTokens).padStart(7)} out` +
        (m.images ? ` · ${m.images} images` : '') +
        (m.costTrusted && m.costUSD > 0 ? ` · $${m.costUSD.toFixed(4)}` : ''),
    );
  }
  for (const p of t.byPhase) {
    lines.push(`    phase ${p.phase.padEnd(16)} ${String(p.calls).padStart(3)} calls · ${n(p.inputTokens + p.outputTokens).padStart(9)} tokens`);
  }
  if (t.hasUntrustedCost) {
    lines.push(
      `  cost: not priced — this project ran on models absent from the SDK's pricing table.`,
      `        Token counts above are provider-reported and are the numbers to bill against.`,
    );
  } else {
    lines.push(`  cost: $${t.costUSD.toFixed(4)}`);
  }
  return lines.join('\n');
}
