import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, DEFAULT_PROFILE_ID } from './config.js';
import type { SendLimits } from './sendlimit.js';

export type SessionStatus = 'ready' | 'logged_out' | 'pending_login' | 'unknown' | 'error';

export interface SessionRecord {
  /** Slug derived from the hostname, unique within a profile. */
  id: string;
  /** User-facing name. Defaults to the hostname, editable. */
  label: string;
  /** The page opened to sign in, and re-loaded to verify. */
  url: string;
  /** Scheme + host, used for cookie lookups. */
  origin: string;
  addedAt: string;
  status: SessionStatus;
  statusDetail?: string;
  account?: string;
  /**
   * Cookie names observed for this origin at the moment the user confirmed login.
   * Learned, never hardcoded — this is what makes any site work.
   */
  cookieNames: string[];
  lastCheckedAt?: string;
  cookieExpiresAt?: string;
}

export interface LaunchConfig {
  channel: string;
  headless: boolean;
  args: string[];
}

export interface ProfileRecord {
  id: string;
  label: string;
  createdAt: string;
  /** Captured at enrollment and replayed verbatim on every run — fingerprint continuity. */
  launch: LaunchConfig;
  sessions: Record<string, SessionRecord>;
}

export interface Manifest {
  version: 2;
  profiles: Record<string, ProfileRecord>;
  settings: {
    idleTimeoutMs: number;
    healthIntervalMs: number;
    maxActionsPerMinute: number;
    whatsappSend: SendLimits;
  };
}

const DEFAULT_LAUNCH: LaunchConfig = {
  channel: 'chrome',
  headless: false,
  args: ['--no-first-run', '--no-default-browser-check', '--start-maximized'],
};

/** "https://www.facebook.com/me" -> { origin, id: "facebook-com", label: "facebook.com" } */
export function describeUrl(raw: string): { url: string; origin: string; id: string; label: string } {
  let input = raw.trim();
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
  const u = new URL(input);
  const host = u.hostname.replace(/^www\./i, '');
  return {
    url: u.toString(),
    origin: u.origin,
    id: host.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
    label: host,
  };
}

function freshManifest(): Manifest {
  return {
    version: 2,
    profiles: {
      [DEFAULT_PROFILE_ID]: {
        id: DEFAULT_PROFILE_ID,
        label: 'Agent Browser',
        createdAt: new Date().toISOString(),
        launch: { ...DEFAULT_LAUNCH, args: [...DEFAULT_LAUNCH.args] },
        sessions: {},
      },
    },
    settings: { ...DEFAULTS },
  };
}

export class Vault {
  readonly home: string;
  readonly manifestPath: string;
  #manifest: Manifest;

  constructor(home: string) {
    this.home = home;
    this.manifestPath = path.join(home, 'manifest.json');
    fs.mkdirSync(path.join(home, 'profiles'), { recursive: true });
    this.#manifest = this.#load();
  }

  #load(): Manifest {
    if (!fs.existsSync(this.manifestPath)) {
      const m = freshManifest();
      fs.writeFileSync(this.manifestPath, JSON.stringify(m, null, 2));
      return m;
    }
    const raw = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8')) as Manifest;
    // Shallow-merge new top-level settings in, but merge whatsappSend one level
    // deeper: a manifest that overrides only `perDay` must keep the defaults for the
    // other four limits rather than losing them to undefined.
    raw.settings = {
      ...DEFAULTS,
      ...raw.settings,
      whatsappSend: { ...DEFAULTS.whatsappSend, ...raw.settings?.whatsappSend },
    };
    if (!raw.profiles?.[DEFAULT_PROFILE_ID]) {
      raw.profiles = freshManifest().profiles;
    }

    // v1 stored sessions keyed by a hardcoded siteId with no url/cookieNames.
    if ((raw.version as number) < 2) {
      for (const profile of Object.values(raw.profiles)) {
        for (const [key, old] of Object.entries(profile.sessions)) {
          const legacy = old as unknown as { siteId?: string; enrolledAt?: string };
          if (old.url) continue;
          const guess = legacy.siteId === 'x' ? 'https://x.com/home' : `https://www.${legacy.siteId}.com/`;
          const d = describeUrl(guess);
          // Re-key under the new id — leaving it under the v1 key makes every
          // lookup by `record.id` miss.
          delete profile.sessions[key];
          profile.sessions[d.id] = {
            ...d,
            addedAt: legacy.enrolledAt ?? new Date().toISOString(),
            status: 'unknown',
            cookieNames: [],
            account: old.account,
          };
        }
      }
      raw.version = 2;
    }

    // Idempotent repair: the map key must equal the record's own id, otherwise
    // every lookup by id misses. Cheap enough to run on every load.
    let rekeyed = false;
    for (const profile of Object.values(raw.profiles)) {
      for (const [key, rec] of Object.entries(profile.sessions)) {
        if (rec.id && key !== rec.id) {
          delete profile.sessions[key];
          profile.sessions[rec.id] = rec;
          rekeyed = true;
        }
      }
    }
    if (rekeyed || (raw.version as number) === 2) {
      fs.writeFileSync(this.manifestPath, JSON.stringify(raw, null, 2));
    }
    return raw;
  }

  save(): void {
    fs.writeFileSync(this.manifestPath, JSON.stringify(this.#manifest, null, 2));
  }

  get manifest(): Manifest {
    return this.#manifest;
  }

  profile(id = DEFAULT_PROFILE_ID): ProfileRecord {
    const p = this.#manifest.profiles[id];
    if (!p) throw new Error(`No such profile: ${id}`);
    return p;
  }

  profileDir(id = DEFAULT_PROFILE_ID): string {
    const dir = path.join(this.home, 'profiles', id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  profileInitialized(id = DEFAULT_PROFILE_ID): boolean {
    return fs.existsSync(path.join(this.profileDir(id), 'Local State'));
  }

  /**
   * Mint a profile on first use, so a subsystem can own a Chrome that is not the
   * agent's. gmap-recon needs this for two measured reasons: Google silently
   * degrades a profile that has been searching (101 results fresh, 64 once used),
   * and runIsolated opens its throwaway tab in the SAME context — which is unsafe
   * next to WhatsApp Web, where a second tab takes the linked-device session over.
   */
  ensureProfile(id: string, label: string): ProfileRecord {
    const existing = this.#manifest.profiles[id];
    if (existing) return existing;
    this.#manifest.profiles[id] = {
      id,
      label,
      createdAt: new Date().toISOString(),
      launch: { ...DEFAULT_LAUNCH, args: [...DEFAULT_LAUNCH.args] },
      sessions: {},
    };
    this.save();
    return this.#manifest.profiles[id];
  }

  sessions(profileId = DEFAULT_PROFILE_ID): SessionRecord[] {
    return Object.values(this.profile(profileId).sessions);
  }

  session(id: string, profileId = DEFAULT_PROFILE_ID): SessionRecord {
    const all = this.profile(profileId).sessions;
    // Tolerate a map keyed differently from the record's own id.
    const s = all[id] ?? Object.values(all).find((x) => x.id === id);
    if (!s) {
      const known = this.sessions(profileId).map((x) => x.id).join(', ') || '(none)';
      throw new Error(`No session "${id}". Known sessions: ${known}`);
    }
    return s;
  }

  /** Adds (or returns) a session for any URL the user names. */
  add(rawUrl: string, label?: string, profileId = DEFAULT_PROFILE_ID): SessionRecord {
    const d = describeUrl(rawUrl);
    const p = this.profile(profileId);
    const existing = p.sessions[d.id];
    if (existing) {
      existing.url = d.url;
      if (label) existing.label = label;
      this.save();
      return existing;
    }
    p.sessions[d.id] = {
      id: d.id,
      label: label?.trim() || d.label,
      url: d.url,
      origin: d.origin,
      addedAt: new Date().toISOString(),
      status: 'pending_login',
      statusDetail: 'Waiting for you to sign in',
      cookieNames: [],
    };
    this.save();
    return p.sessions[d.id];
  }

  remove(id: string, profileId = DEFAULT_PROFILE_ID): void {
    delete this.profile(profileId).sessions[id];
    this.save();
  }

  update(id: string, patch: Partial<SessionRecord>, profileId = DEFAULT_PROFILE_ID): SessionRecord {
    const p = this.profile(profileId);
    p.sessions[id] = { ...this.session(id, profileId), ...patch };
    this.save();
    return p.sessions[id];
  }
}
