import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostname(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const i = h.lastIndexOf(':');
  return i > 0 ? h.slice(0, i) : h;
}
function port(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim();
  const i = h.lastIndexOf(':');
  return i > 0 && !h.endsWith(']') ? h.slice(i + 1) : null;
}

/** Empty means loopback only. */
export interface OriginOptions {
  allowedHosts?: readonly string[];
}

/**
 * True when a proxy on this machine says the browser spoke HTTPS to it: `X-Forwarded-Proto: https` (first hop)
 * on a connection from loopback. Tailscale Serve terminates TLS for the tailnet name and connects to the hub
 * from 127.0.0.1. Nothing off the machine can reach the hub's socket (it binds loopback), and a web page
 * cannot add the header to a request without a preflight that the Origin check then fails.
 */
export function forwardedHttps(req: IncomingMessage): boolean {
  const raw = req.headers['x-forwarded-proto'];
  const proto = String(Array.isArray(raw) ? raw[0] : raw ?? '').split(',')[0].trim().toLowerCase();
  if (proto !== 'https') return false;
  const ip = req.socket?.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Loopback-only hardening for a hub that binds 127.0.0.1:
 * - `Host` must name a loopback address (blocks DNS rebinding, where an attacker's domain resolves to 127.0.0.1).
 *   The port is not pinned so an SSH tunnel on a different local port still works.
 * - `Origin`, when present, must be a loopback origin on the hub's port or on the port the request came in on
 *   (i.e. same-origin as the page the hub itself served). Blocks CSRF from arbitrary web pages.
 *
 * `Origin: null` is treated as foreign (audit 2026-09-09, B1). It used to be whitelisted, but a sandboxed
 * iframe (`<iframe sandbox="allow-scripts">`) on any site sends exactly that, with `text/plain` and therefore
 * no preflight, which reached every mutating route.
 */
export function checkRequestOrigin(
  req: IncomingMessage,
  hubPort: number,
  opts: OriginOptions = {},
): { ok: true } | { ok: false; status: number; reason: string } {
  const host = req.headers.host;
  const hn = hostname(host);
  const allowed = (name: string) => (opts.allowedHosts?.length ?? 0) > 0 && forwardedHttps(req) && opts.allowedHosts!.includes(name.toLowerCase());
  const hostOk = !!hn && (LOOPBACK.has(hn) || allowed(hn));
  if (!hostOk) return { ok: false, status: 403, reason: 'Bad Host header: ' + (host ?? '(none)') };

  const origin = req.headers.origin;
  if (origin) {
    if (origin === 'null') return { ok: false, status: 403, reason: 'Opaque origin rejected (Origin: null)' };
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      return { ok: false, status: 403, reason: 'Bad Origin: ' + origin };
    }
    // P9: the page Tailscale Serve hands the phone is https://<allowed host>[:port]; any port, since Serve can
    // listen on 443, 8443 or 10000. Plain http:// on an allowed name is never same-origin with that page.
    const remoteOk = u.protocol === 'https:' && allowed(u.hostname);
    const okHost = LOOPBACK.has(u.hostname);
    const okPort = u.port === String(hubPort) || (port(host) !== null && u.port === port(host));
    if (!remoteOk && (!okHost || !okPort)) return { ok: false, status: 403, reason: 'Cross-origin request rejected: ' + origin };
  }
  return { ok: true };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH']);

/** A cross-site form cannot send JSON, and asking for JSON forces a preflight the Origin check fails. */
export function checkContentType(req: IncomingMessage, url: URL): { ok: true } | { ok: false; status: number; reason: string } {
  if (!url.pathname.startsWith('/api/')) return { ok: true };
  if (!MUTATING.has(req.method ?? 'GET')) return { ok: true };
  const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (ct === 'application/json') return { ok: true };
  if (ct === 'application/octet-stream' && /^\/api\/pc-runner\/jobs\/[A-Za-z0-9_-]+\/(bundle|session)$/.test(url.pathname)) return { ok: true };
  if (ct === 'application/octet-stream' && /^\/api\/files\/?$/.test(url.pathname)) return { ok: true };
  return { ok: false, status: 415, reason: 'Content-Type must be application/json (got ' + (ct || '(none)') + ')' };
}

export function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

export function dropCookie(req: IncomingMessage, name: string): void {
  const raw = req.headers.cookie;
  if (!raw) return;
  const kept = raw.split(';').map((p) => p.trim()).filter((p) => p && p.slice(0, p.indexOf('=')) !== name);
  if (kept.length) req.headers.cookie = kept.join('; ');
  else delete req.headers.cookie;
}

export function cookieValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Constant-time string compare, length-guarded. */
export function tokenMatches(supplied: string | null, expected: string): boolean {
  if (supplied === null) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export interface TokenOptions {
  isPublicAsset?: (pathname: string) => boolean;
  /** Left out, `/screen` is refused outright, never the looser query-string rule. */
  screenAuth?: (req: IncomingMessage) => boolean;
  deviceToken?: (supplied: string) => boolean;
  session?: (req: IncomingMessage) => boolean;
  /**
   * PC runner: true when `supplied` is the paired runner's token. Only ever offered the Authorization header,
   * never `?token=`, and left out of the websocket upgrade so the runner token cannot open /ws or a Screen.
   */
  runnerToken?: (supplied: string) => boolean;
}

/**
 * Where the account email link (and an OAuth provider) sends the browser back to. A top-level navigation from
 * the user's default browser, so it can carry neither the hub token nor the UI's cookie.
 */
export const AUTH_CALLBACK_PATH = '/auth/callback';

/**
 * P4: where a provider sends the browser back after an integration sign-in, `/oauth/callback/<provider>`.
 * Token-exempt for the same reason as AUTH_CALLBACK_PATH. It is safe because the handler accepts it only
 * for a `state` this hub minted moments ago (single use, 10 minutes) and exchanges the code together with
 * the PKCE verifier only this hub holds; anything else counts as a failed auth for the rate limiter.
 */
export const OAUTH_CALLBACK_PREFIX = '/oauth/callback/';

/** Allowlist, not deny-list: with a token configured, everything needs it except the paths below. */
export function checkToken(req: IncomingMessage, url: URL, token: string | null, opts: TokenOptions = {}): boolean {
  if (!token) return true;
  const method = req.method ?? 'GET';
  if (url.pathname === '/api/health' && method === 'GET') return true;
  if (url.pathname === AUTH_CALLBACK_PATH && method === 'GET') return true;
  if (url.pathname.startsWith(OAUTH_CALLBACK_PREFIX) && method === 'GET') return true;
  if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) return true;
  if (url.pathname.startsWith('/screen/')) return opts.screenAuth?.(req) ?? false;
  if (method === 'GET' && (url.pathname === '/' || (opts.isPublicAsset?.(url.pathname) ?? false))) return true;
  if (url.pathname === DEVICE_PAIR_PATH && method === 'POST') return true;
  if (url.pathname === '/api/auth/login' && method === 'POST') return true;
  if (url.pathname === '/api/auth/status' && method === 'GET') return true;
  if (opts.session?.(req)) return true;
  const supplied = bearerToken(req) ?? url.searchParams.get('token');
  if (tokenMatches(supplied, token)) return true;
  const bearer = bearerToken(req);
  if (bearer !== null && (opts.runnerToken?.(bearer) ?? false)) return true;
  return supplied !== null && (opts.deviceToken?.(supplied) ?? false);
}

/** Only a request that carried the hub token may clear the rate limiter, not a token-exempt path. */
export function presentsHubToken(req: IncomingMessage, url: URL, token: string | null): boolean {
  return token !== null && tokenMatches(bearerToken(req) ?? url.searchParams.get('token'), token);
}

/**
 * In-memory brute-force brake (audit 2026-09-09, B15): 10 failed auths from one IP inside a minute lock that
 * IP out for a minute. Per hub process, deliberately tiny — the hub is loopback-only, so the population of
 * "IPs" is 127.0.0.1 plus whatever a tunnel presents, and the point is to make walking a token byte by byte
 * (see B16) impractical rather than to be a real WAF.
 */
export class AuthRateLimiter {
  private hits = new Map<string, { count: number; first: number; blockedUntil: number }>();
  constructor(
    private max = 10,
    private windowMs = 60_000,
    private blockMs = 60_000,
    private now: () => number = Date.now,
  ) {}

  blocked(ip: string): boolean {
    const e = this.hits.get(ip);
    if (!e) return false;
    if (e.blockedUntil > this.now()) return true;
    if (e.blockedUntil) this.hits.delete(ip);
    return false;
  }

  fail(ip: string): boolean {
    const t = this.now();
    const e = this.hits.get(ip);
    if (!e || t - e.first > this.windowMs) {
      this.hits.set(ip, { count: 1, first: t, blockedUntil: 0 });
      return false;
    }
    e.count += 1;
    if (e.count >= this.max) {
      e.blockedUntil = t + this.blockMs;
      return true;
    }
    return false;
  }

  succeed(ip: string): void {
    this.hits.delete(ip);
  }
}

export function clientIp(req: IncomingMessage): string {
  return req.socket?.remoteAddress ?? '?';
}

export const DEVICE_PAIR_PATH = '/api/devices/pair';

export type Principal =
  | { kind: 'hub'; sessionId?: string; userId?: string }
  | { kind: 'device'; deviceId: string }
  | { kind: 'runner' };

const principals = new WeakMap<IncomingMessage, Principal>();
export function setPrincipal(req: IncomingMessage, p: Principal): void {
  principals.set(req, p);
}
export function principalOf(req: IncomingMessage): Principal | null {
  return principals.get(req) ?? null;
}
export function screenOwnerOf(req: IncomingMessage): string | null {
  const p = principals.get(req);
  if (p?.kind === 'device') return p.deviceId;
  return p?.kind === 'hub' && p.sessionId ? 'session:' + p.sessionId : null;
}
export function deviceIdOf(req: IncomingMessage): string | null {
  const p = principals.get(req);
  return p?.kind === 'device' ? p.deviceId : null;
}

/**
 * The capability split (P9). The hub token can do everything. A device token is an **allowlist**: what a phone
 * needs to follow the fleet (read bots, rooms, messages, routines, usage), chat, answer approval cards (once —
 * "always" is refused over the socket, see ws.ts), watch a Screen, and run Automations. Anything not listed —
 * and so every route a later phase adds until it is listed here — is refused with 403. In particular a device
 * can never:
 *   - mint a pairing code, rename or revoke another device (only itself),
 *   - read or write secrets, integrations or their OAuth apps (`/api/secrets`, `/api/integrations/*`, `/oauth/*`),
 *   - change settings at all (`PUT /api/settings` is where approvals/bypass live) or the account,
 *   - change the fleet (bots, rooms, memory, skills review/import) or spawn a provider CLI check,
 *   - reach `/api/debug/*` or open the workspace on the hub's machine.
 * 403, never 401: the web client reads 401 as "this token is wrong" and would drop a perfectly good pairing.
 */
export const DEVICE_ALLOW: readonly [method: string, path: RegExp][] = [
  ['GET', /^\/api\/previews$/],
  ['GET', /^\/api\/search$/],
  ['GET', /^\/api\/health$/],
  ['GET', /^\/api\/settings$/],
  ['GET', /^\/api\/providers$/],
  ['GET', /^\/api\/account$/],
  ['GET', /^\/api\/config$/],
  ['GET', /^\/api\/bots$/],
  ['GET', /^\/api\/bots\/[^/]+\/(memory|skills|voice|notes)$/],
  ['GET', /^\/api\/rooms$/],
  ['GET', /^\/api\/rooms\/[^/]+\/messages$/],
  ['GET', /^\/api\/rooms\/[^/]+\/context$/],
  ['GET', /^\/api\/rooms\/[^/]+\/commands$/],
  ['GET', /^\/api\/media\/[0-9a-f]{64}$/],
  ['GET', /^\/api\/files\/[0-9a-f]{64}(\/meta)?$/],
  ['POST', /^\/api\/rooms\/[^/]+\/messages$/],
  ['GET', /^\/api\/skills$/],
  ['GET', /^\/api\/skills\/[^/]+$/],
  ['GET', /^\/api\/usage$/],
  ['GET', /^\/api\/knowledge$/],
  ['GET', /^\/api\/workflows(\/[^/]+(\/runs)?)?$/],
  ['GET', /^\/api\/workflow-(runs\/[^/]+|cards)$/],
  ['POST', /^\/api\/workflow-runs\/[^/]+\/decision$/],
  ['GET', /^\/api\/failover$/],
  ['POST', /^\/api\/failover-cards\/[^/]+\/decision$/],
  ['GET', /^\/api\/screen$/],
  ['POST', /^\/api\/screen\/ticket$/],
  ['GET', /^\/api\/computers\/[^/]+$/],
  ['POST', /^\/api\/computers\/[^/]+\/wake$/],
  ['PUT', /^\/api\/computers\/[^/]+\/keep-awake$/],
  ['GET', /^\/api\/control$/],
  ['GET', /^\/api\/computers\/[^/]+\/control$/],
  ['PUT', /^\/api\/computers\/[^/]+\/control$/],
  // Creating or revoking an approval rule changes policy, so it stays a hub-token action.
  ['GET', /^\/api\/approval-policies$/],
  ['GET', /^\/api\/approvals\/parked$/],
  ['GET', /^\/api\/routines$/],
  ['POST', /^\/api\/routines$/],
  ['PATCH', /^\/api\/routines\/[^/]+$/],
  ['DELETE', /^\/api\/routines\/[^/]+$/],
  ['POST', /^\/api\/routines\/[^/]+\/run$/],
  ['GET', /^\/api\/routines\/[^/]+\/runs$/],
  ['GET', /^\/api\/triggers$/],
  ['POST', /^\/api\/triggers$/],
  ['PATCH', /^\/api\/triggers\/[^/]+$/],
  ['DELETE', /^\/api\/triggers\/[^/]+$/],
  ['GET', /^\/api\/triggers\/[^/]+\/fires$/],
  ['POST', /^\/api\/triggers\/[^/]+\/test$/],
  // The handlers refuse anything but the device itself.
  ['GET', /^\/api\/devices$/],
  ['DELETE', /^\/api\/devices\/[^/]+$/],
  ['GET', /^\/api\/push$/],
  ['POST', /^\/api\/push\/(subscribe|unsubscribe|test)$/],
  ['GET', /^\/api\/computers\/[^/]+\/recorder$/],
  ['POST', /^\/api\/computers\/[^/]+\/recorder\/stop$/],
  ['GET', /^\/api\/computers\/[^/]+\/recordings$/],
  ['GET', /^\/api\/computers\/[^/]+\/recordings\/[^/]+$/],
  ['GET', /^\/api\/skills\/[^/]+\/versions$/],
  ['GET', /^\/api\/skills\/[^/]+\/versions\/[^/]+$/],
  ['GET', /^\/api\/bots\/[^/]+\/skill-reflection$/],
  ['GET', /^\/api\/bots\/[^/]+\/training$/],
  // Creating or changing a task assigns work to bots, so it stays a desktop action.
  ['GET', /^\/api\/rooms\/[^/]+\/tasks$/],
  // Only the owner's own messages can be cancelled or edited, from any principal.
  ['GET', /^\/api\/rooms\/[^/]+\/queue$/],
  ['POST', /^\/api\/rooms\/[^/]+\/queue\/(cancel|edit|send-now|pause)$/],
];

/** Nothing under `/oauth/`, which starts integration sign-ins. */
export function deviceMayAccess(method: string, pathname: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (!p.startsWith('/api/')) return method === 'GET' && !p.startsWith('/oauth/') && p !== '/mcp' && !p.startsWith('/mcp/');
  return DEVICE_ALLOW.some(([m, re]) => m === method && re.test(p));
}

// The runner token reaches exactly its own routes; the hub token cannot pose as the runner.
const RUNNER_ALLOW: readonly [method: string, path: RegExp][] = [
  ['POST', /^\/api\/pc-runner\/heartbeat$/],
  ['GET', /^\/api\/pc-runner\/jobs\/next$/],
  ['POST', /^\/api\/pc-runner\/jobs\/[A-Za-z0-9_-]+\/(start|result)$/],
  ['POST', /^\/api\/pc-runner\/jobs\/[A-Za-z0-9_-]+\/bundle$/],
  ['POST', /^\/api\/pc-runner\/jobs\/[A-Za-z0-9_-]+\/session$/],
  ['GET', /^\/api\/pc-runner\/jobs\/[A-Za-z0-9_-]+\/(session|bundle)$/],
  ['GET', /^\/api\/cc\/rooms$/],
  ['GET', /^\/api\/cc\/session(-state)?$/],
  ['GET', /^\/api\/cc\/rooms\/[A-Za-z0-9_-]+\/(messages|state|files\/text)$/],
  ['POST', /^\/api\/cc\/rooms\/[A-Za-z0-9_-]+\/(messages|files\/text|decision|handoff)$/],
  ['GET', /^\/api\/pc-sessions\/sync$/],
  ['PUT', /^\/api\/pc-sessions\/[A-Za-z0-9_.:%-]+$/],
  ['POST', /^\/api\/pc-sessions\/[A-Za-z0-9_.:%-]+\/entries$/],
];

export function runnerMayAccess(method: string, pathname: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return RUNNER_ALLOW.some(([m, re]) => m === method && re.test(p));
}
