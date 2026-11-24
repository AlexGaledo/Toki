import 'dotenv/config';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROVIDER_IDS, type Approvals, type ProviderId } from '@pocketrocket/shared';

const here = path.dirname(fileURLToPath(import.meta.url));

export function resolveHubDir(from: string, exists: (p: string) => boolean = fs.existsSync): string {
  for (const dir of [from, path.resolve(from, '..')]) {
    if (exists(path.join(dir, 'node_modules'))) return dir;
  }
  return path.resolve(from, '..');
}

export function resolveVersion(
  from: string,
  read: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): string {
  for (const dir of [from, path.resolve(from, '..')]) {
    try {
      const pkg = JSON.parse(read(path.join(dir, 'package.json'))) as { version?: string };
      if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
    } catch {
      /* try the next candidate */
    }
  }
  return '0.0.0-unknown';
}

export const ROOT_DIR = path.resolve(here, '..', '..', '..');

export const DATA_DIR = process.env.POCKETROCKET_DATA ? path.resolve(process.env.POCKETROCKET_DATA) : path.join(ROOT_DIR, 'data');
export const WORKSPACE_DIR = path.join(DATA_DIR, 'workspace');
export const BOTS_DIR = path.join(DATA_DIR, 'bots');
export const SKILLS_DIR = path.join(DATA_DIR, 'skills');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
export const DB_PATH = path.join(DATA_DIR, 'pocketrocket.db');
export const ROUTING_PATH = path.join(DATA_DIR, 'routing.md');
export const WEB_DIST = process.env.POCKETROCKET_WEB_DIST
  ? path.resolve(process.env.POCKETROCKET_WEB_DIST)
  : path.join(ROOT_DIR, 'packages', 'web', 'dist');

export const CLAUDE_EXE =
  process.env.CLAUDE_EXE ??
  (process.platform === 'win32'
    ? path.join(os.homedir(), '.local', 'bin', 'claude.exe')
    : path.join(os.homedir(), '.local', 'bin', 'claude'));

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.PORT ?? 7788);
/** Loopback-only and read-only; file: is blocked there. */
export const WORKSPACE_WEB_PORT = Number(process.env.WORKSPACE_WEB_PORT ?? 7789);
export const WORKSPACE_WEB_URL = 'http://127.0.0.1:' + WORKSPACE_WEB_PORT + '/';
// `|| null`, not `?? null`: an empty POCKETROCKET_TOKEN means unset, never "no token required".
export const HUB_TOKEN = process.env.POCKETROCKET_TOKEN || null;
export const ROTATE_HUB_TOKEN = ['1', 'true', 'yes', 'on'].includes(String(process.env.POCKETROCKET_ROTATE_TOKEN ?? '').toLowerCase());
export const HUB_TOKEN_PATH = path.join(DATA_DIR, 'hub-token');

/**
 * Tighten a file to owner-only (audit 2026-09-09, B17). `writeFileSync({mode})` is ignored when the file
 * already exists, and on Windows the POSIX mode only ever sets the read-only attribute — the file still
 * inherits DATA_DIR's ACL. So: chmod always, and on Windows additionally drop inheritance and grant the
 * current user alone. Both are best-effort; a failure is never fatal.
 */
/**
 * `fs.renameSync(from, to)` that rides out a brief Windows lock on `to`. `restrictFile` runs `icacls` in the
 * background, so a second write soon after the first can find the target still open and get EPERM/EACCES/EBUSY.
 * Retries for up to ~1 s, then throws the last error.
 */
export function renameOver(from: string, to: string): void {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let wait = 10; ; wait *= 2) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || wait > 640 || !(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) throw e;
      Atomics.wait(pause, 0, 0, wait);
    }
  }
}

export function restrictFile(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* different filesystem semantics; the Windows ACL pass below is the real control there */
  }
  if (process.platform !== 'win32') return;
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    return;
  }
  if (!user) return;
  try {
    execFile('icacls', [file, '/inheritance:r', '/grant:r', user + ':F'], { windowsHide: true }, () => undefined);
  } catch {
    /* icacls missing or refused: nothing else to try */
  }
}

/**
 * The hub is never unauthenticated (audit 2026-09-09, B3 / D3). `POCKETROCKET_TOKEN` wins when set;
 * otherwise a 128-bit token lives in `<DATA_DIR>/hub-token` (0600) where a human, `scripts/smoke.mjs` and
 * the desktop shell can all pick it up.
 *
 * That file is **reused** across restarts. It used to be re-minted every start so a token leaked into a log
 * died with the process — but a restart then silently invalidated the token the open UI was holding, and the
 * user got the "paste the hub token" panel after every deploy, `systemctl restart` and tsx-watch reload. The
 * token is loopback-only and 0600 on disk, so a stable value is the better trade; `POCKETROCKET_ROTATE_TOKEN=1`
 * brings the old behaviour back. Anything in the file that is not exactly 32 hex chars is ignored and replaced.
 */
export function ensureHubToken(): string {
  if (HUB_TOKEN) return HUB_TOKEN;
  if (!ROTATE_HUB_TOKEN) {
    try {
      const existing = fs.readFileSync(HUB_TOKEN_PATH, 'utf8').trim();
      if (/^[0-9a-f]{32}$/.test(existing)) return existing;
    } catch {
      /* no readable token file yet: mint one below */
    }
  }
  const token = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HUB_TOKEN_PATH, token, { mode: 0o600 });
    restrictFile(HUB_TOKEN_PATH);
  } catch (e) {
    // The token is never logged, so this file is the only way to learn a minted one.
    console.error('[pocketrocket] could not write ' + HUB_TOKEN_PATH + ': ' + String((e as Error).message ?? e) + '. Nobody can sign in until that is fixed or POCKETROCKET_TOKEN is set.');
  }
  return token;
}

export function osUserName(): string {
  try {
    return os.userInfo().username || 'you';
  } catch {
    return 'you';
  }
}

export const MAX_HOPS = Number(process.env.MAX_HOPS ?? 3);
export function parseApprovalsEnv(raw: string | undefined): Approvals | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return null;
  // Anything unrecognised fails closed: a typo must never turn the approval cards off.
  return ['1', 'true', 'yes', 'on'].includes(v) ? 'bypass' : 'ask';
}
export const APPROVALS_ENV = parseApprovalsEnv(process.env.POCKETROCKET_BYPASS_PERMISSIONS);
export function parseEnabledProviders(raw: string | undefined): ProviderId[] {
  const wanted = new Set(String(raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  return PROVIDER_IDS.filter((id) => id === 'claude' || wanted.has(id));
}
export const ENABLED_PROVIDERS: readonly ProviderId[] = parseEnabledProviders(process.env.POCKETROCKET_PROVIDERS);
export const MAX_CONCURRENT_TURNS = Number(process.env.MAX_CONCURRENT_TURNS ?? 4);
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
export const spendCapsOff = (env: NodeJS.ProcessEnv = process.env): boolean =>
  ['1', 'true', 'yes', 'on'].includes(String(env.POCKETROCKET_NO_SPEND_CAPS ?? '').trim().toLowerCase());
export const causeCostCap = (env: NodeJS.ProcessEnv = process.env): number =>
  spendCapsOff(env) ? Infinity : Number(env.CAUSE_COST_CAP_USD ?? 5);
export const CAUSE_COST_CAP_USD = causeCostCap();
export const MAX_TURNS_PER_QUERY = Number(process.env.MAX_TURNS_PER_QUERY ?? 100);
export const MAX_TURN_CONTINUATIONS = Number(process.env.MAX_TURN_CONTINUATIONS ?? 3);
export const CUTOFF_RETRIES = Number(process.env.CUTOFF_RETRIES ?? 2);
// 0 = off: a bot keeps its whole session and the provider compacts it near the window. Set a token count to rotate
// (fresh session + summary) past that size, or after ROTATE_IDLE_MS idle above ROTATE_IDLE_MIN_TOKENS.
export const ROTATE_CONTEXT_TOKENS = Number(process.env.ROTATE_CONTEXT_TOKENS ?? 0);
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const ROTATE_IDLE_MS = Number(process.env.ROTATE_IDLE_MS ?? 30 * 60 * 1000);
export const ROTATE_IDLE_MIN_TOKENS = Number(process.env.ROTATE_IDLE_MIN_TOKENS ?? 40_000);
export const ROTATE_SEED_MESSAGES = Number(process.env.ROTATE_SEED_MESSAGES ?? 20);
export const TURN_CACHE_READ_CAP = Number(process.env.TURN_CACHE_READ_CAP ?? 3_000_000);
export const BASH_MAX_OUTPUT_CHARS = Number(process.env.BASH_MAX_OUTPUT_CHARS ?? 15_000);
export const MAX_MCP_OUTPUT_TOKENS = Number(process.env.MAX_MCP_OUTPUT_TOKENS ?? 12_000);

export const VERSION: string = resolveVersion(here);

export const SECRETS_PATH = path.join(DATA_DIR, 'secrets.json');

// No project URL or key lives in source.
export const SUPABASE_URL = (process.env.POCKETROCKET_SUPABASE_URL ?? '').trim();
export const SUPABASE_PUBLISHABLE_KEY = (process.env.POCKETROCKET_SUPABASE_KEY ?? '').trim();
// Supabase's built-in mailer only delivers to the project's own team, so email sign-in stays off (OAuth only)
// until the project has its own SMTP sender; `1` turns it on.
export const ACCOUNT_EMAIL = ['1', 'true', 'yes', 'on'].includes(String(process.env.POCKETROCKET_ACCOUNT_EMAIL ?? '').toLowerCase());
/** Owner-only like secrets.json, and never under WORKSPACE_DIR. */
export const ACCOUNT_PATH = path.join(DATA_DIR, 'account.json');

export const USER_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

export const HUB_DIR = resolveHubDir(here);
export const SCREEN_URL = process.env.SCREEN_URL ?? 'http://127.0.0.1:6080';
export const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
export const PLAYWRIGHT_MCP_CLI = path.join(HUB_DIR, 'node_modules', '@playwright', 'mcp', 'cli.js');
export const SCREEN_DISPLAY = process.env.SCREEN_DISPLAY ?? ':99';
export const DESKTOP_HOME = path.join(DATA_DIR, 'desktop-home');
export const DESKTOP_AVAILABLE =
  process.platform === 'linux' && fs.existsSync('/usr/bin/xdotool') && fs.existsSync('/usr/bin/scrot');

export function botHome(botId: string) {
  return path.join(BOTS_DIR, botId);
}
export function botPluginDir(botId: string) {
  return path.join(botHome(botId), 'plugin');
}

export function ensureDirs() {
  for (const d of [DATA_DIR, WORKSPACE_DIR, BOTS_DIR, SKILLS_DIR]) fs.mkdirSync(d, { recursive: true });
}

export function migrateLegacyDb() {
  const legacyPath = path.join(DATA_DIR, 'claudebot.db');
  if (fs.existsSync(DB_PATH) || !fs.existsSync(legacyPath)) return;
  for (const suffix of ['', '-wal', '-shm']) {
    const src = legacyPath + suffix;
    const dest = DB_PATH + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, dest);
  }
  console.log('migrated legacy claudebot.db -> pocketrocket.db');
}

export const KNOWLEDGE_DIR = path.join(DATA_DIR, 'knowledge');
export const KNOWLEDGE_SYNC_MINUTES = Number(process.env.KNOWLEDGE_SYNC_MINUTES ?? 60);

export const COMPUTERS_DIR = path.join(DATA_DIR, 'computers');
export function computerDir(botId: string) {
  return path.join(COMPUTERS_DIR, botId);
}
export function computerFilesDir(botId: string) {
  return path.join(computerDir(botId), 'files');
}
const truthy = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
const posInt = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};
export const COMPUTERS_ENABLED = process.platform === 'linux' && truthy(process.env.POCKETROCKET_COMPUTERS);
export const MAX_RUNNING_COMPUTERS = posInt(process.env.MAX_RUNNING_COMPUTERS, 99);
export const COMPUTER_IDLE_MIN = posInt(process.env.COMPUTER_IDLE_MIN, 30);
export const COMPUTER_QUOTA_BYTES = posInt(process.env.COMPUTER_QUOTA_GB, 10) * 1024 ** 3;

export function botRoots(botId: string, roomId?: string): string[] {
  return [WORKSPACE_DIR, botHome(botId), ...(COMPUTERS_ENABLED ? [computerFilesDir(botId)] : []), ...(roomId ? roomRoots(botId, roomId) : [])];
}

export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
export function botFilesDir(botId: string) {
  return path.join(botHome(botId), 'files');
}
let roomRoots: (botId: string, roomId: string) => string[] = () => [];
export function setRoomRootsResolver(fn: (botId: string, roomId: string) => string[]) {
  roomRoots = fn;
}

// P4: integrations. Tokens live AES-256-GCM encrypted in integrations.json; the key in vault.key (0600),
// which deploy/backup.sh leaves out of every archive so a leaked backup holds no usable token.
export const VAULT_KEY_PATH = path.join(DATA_DIR, 'vault.key');
export const INTEGRATIONS_PATH = path.join(DATA_DIR, 'integrations.json');
export const CREDENTIALS_PATH = path.join(DATA_DIR, 'credentials.json');

/**
 * Hostnames (comma or space separated) the hub also answers to, besides loopback, e.g.
 * `POCKETROCKET_ALLOWED_HOSTS=myhub.tail1234.ts.net`. Off by default (decision Q9). A listed host is only
 * accepted on a request that reached the hub over HTTPS through a proxy on this machine (Tailscale Serve
 * sets `X-Forwarded-Proto: https` and connects from loopback); the hub itself still binds 127.0.0.1 only.
 * Anything that is not a plain DNS name (a scheme, a port, a wildcard, an IP literal, a loopback name) is
 * dropped with a warning rather than widening the check.
 */
export function parseAllowedHosts(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const h of String(raw ?? '').split(/[\s,]+/)) {
    const v = h.trim().toLowerCase().replace(/\.$/, '');
    if (!v) continue;
    const ok = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(v)
      && !/^[0-9.]+$/.test(v) && v !== 'localhost' && !v.endsWith('.localhost');
    if (!ok) {
      console.warn('[pocketrocket] POCKETROCKET_ALLOWED_HOSTS: ignoring ' + JSON.stringify(h) + ' (expected a hostname like myhub.tail1234.ts.net)');
      continue;
    }
    if (!out.includes(v)) out.push(v);
  }
  return out;
}
export const ALLOWED_HOSTS: readonly string[] = parseAllowedHosts(process.env.POCKETROCKET_ALLOWED_HOSTS);
/** 0600, like hub-token. */
export const VAPID_PATH = path.join(DATA_DIR, 'vapid.json');
/** VAPID `sub` claim. Apple wants a mailto: or https: URL here; it is sent to the push service, never to a bot. */
export const PUSH_SUBJECT = process.env.POCKETROCKET_PUSH_SUBJECT || 'https://github.com/AlexGaledo/Toki';
