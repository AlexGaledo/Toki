import { randomBytes } from 'node:crypto';
import { tokenMatches } from './guard.js';

export const SCREEN_VIEWER_PATH = '/screen/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=screen%2Fwebsockify';

export const SCREEN_COOKIE = 'pr_screen';

/* A session is valid for its scope only, so a viewer of bot A's screen is refused on bot B's. */
const SCOPE_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function screenCookieName(scope: string | null): string {
  return scope ? SCREEN_COOKIE + '_' + scope : SCREEN_COOKIE;
}

/**
 * Where the browser lands after redeeming a ticket for this scope. P2: `viewOnly` adds noVNC's `view_only=1`
 * while the bot has control. That flag is only the UI-side guard; x11vnc's own view-only mode is the real one.
 */
export function screenViewerPath(scope: string | null, viewOnly = false): string {
  const vo = viewOnly ? '&view_only=1' : '';
  if (!scope) return SCREEN_VIEWER_PATH + vo;
  return '/screen/' + scope + '/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=screen%2F' + scope + '%2Fwebsockify' + vo;
}

const TICKET_TTL_MS = 60_000;
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_TICKETS = 64;
const MAX_SESSIONS = 32;

interface Entry { value: string; expires: number; scope: string | null; owner?: string }

/**
 * Why a ticket at all: an `<iframe>` cannot send an Authorization header, so the only way the hub token could
 * reach the noVNC proxy was the iframe's own URL — where it then sits in the DOM, in the parent document's
 * history and in anything that later reads `location`. Instead the app spends the token once, over a normal
 * authenticated POST, on a single-use ticket; the browser trades that ticket for an httpOnly cookie it can
 * never read back, and the hub token never appears in a URL at all.
 */
export class ScreenSessions {
  private tickets: Entry[] = [];
  private sessions: Entry[] = [];
  constructor(private now: () => number = Date.now) {}

  mintTicket(scope: string | null = null, owner?: string | null): { ticket: string; url: string } {
    if (scope !== null && !SCOPE_RE.test(scope)) throw new Error('bad screen scope');
    this.sweep();
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.push({ value: ticket, expires: this.now() + TICKET_TTL_MS, scope, ...(owner ? { owner } : {}) });
    if (this.tickets.length > MAX_TICKETS) this.tickets.splice(0, this.tickets.length - MAX_TICKETS);
    return { ticket, url: '/screen/session?ticket=' + encodeURIComponent(ticket) };
  }

  redeem(ticket: string | null): string | null {
    return this.redeemScoped(ticket)?.cookie ?? null;
  }

  redeemScoped(ticket: string | null): { cookie: string; scope: string | null } | null {
    this.sweep();
    const i = this.find(this.tickets, ticket);
    if (i < 0) return null;
    const [{ scope, owner }] = this.tickets.splice(i, 1);
    const value = randomBytes(32).toString('base64url');
    this.sessions.push({ value, expires: this.now() + SESSION_TTL_MS, scope, ...(owner ? { owner } : {}) });
    if (this.sessions.length > MAX_SESSIONS) this.sessions.splice(0, this.sessions.length - MAX_SESSIONS);
    return { cookie: cookieHeader(value, Math.floor(SESSION_TTL_MS / 1000), scope), scope };
  }

  valid(cookie: string | null, scope: string | null = null): boolean {
    this.sweep();
    const i = this.find(this.sessions, cookie);
    return i >= 0 && this.sessions[i].scope === scope;
  }

  ownerOf(cookie: string | null, scope: string | null = null): string | null {
    this.sweep();
    const i = this.find(this.sessions, cookie);
    return i >= 0 && this.sessions[i].scope === scope ? this.sessions[i].owner ?? null : null;
  }

  revokeOwner(owner: string): void {
    this.tickets = this.tickets.filter((e) => e.owner !== owner);
    this.sessions = this.sessions.filter((e) => e.owner !== owner);
  }

  private find(list: Entry[], supplied: string | null): number {
    if (supplied === null) return -1;
    let found = -1;
    for (let i = 0; i < list.length; i++) if (tokenMatches(supplied, list[i].value)) found = i;
    return found;
  }

  private sweep(): void {
    const t = this.now();
    this.tickets = this.tickets.filter((e) => e.expires > t);
    this.sessions = this.sessions.filter((e) => e.expires > t);
  }
}

/**
 * `Secure` is deliberately absent: the hub speaks plain http on 127.0.0.1 (remote access is an SSH tunnel or
 * Tailscale, which terminate as loopback), so a Secure cookie would simply never be stored and the Screen tab
 * would never load. `Path=/screen` keeps it off `/api` and `/ws`, and `SameSite=Strict` keeps any other site
 * from riding it — including through a top-level navigation, which is where Lax would still send it.
 */
function cookieHeader(value: string, maxAgeSeconds: number, scope: string | null = null): string {
  return screenCookieName(scope) + '=' + value + '; HttpOnly; SameSite=Strict; Path=' + (scope ? '/screen/' + scope : '/screen') + '; Max-Age=' + maxAgeSeconds;
}
