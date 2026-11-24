/**
 * The desktop shell opens `/?desktop=1#token=<hex>`. The hash is stripped at once so the token never lands in
 * history or a shared link. Runs on import: import this before anything reads the URL.
 */
import { getItem, removeItem, setItem } from './persist';

const TOKEN_KEY = 'pocketrocket.token';
const DESKTOP_KEY = 'pocketrocket.desktop';
const DESKTOP_CAPS_KEY = 'pocketrocket.desktopCaps';
const DESKTOP_HOST_KEY = 'pocketrocket.desktopHost';

function boot() {
  try {
    const hash = location.hash;
    if (hash.startsWith('#token=')) {
      const token = decodeURIComponent(hash.slice('#token='.length));
      if (token) setItem(TOKEN_KEY, token, 'session');
      history.replaceState(null, '', location.pathname + location.search);
    }
    const params = new URLSearchParams(location.search);
    if (params.get('desktop') === '1') {
      setItem(DESKTOP_KEY, '1', 'session');
      setItem(DESKTOP_CAPS_KEY, params.get('caps') ?? '', 'session');
      // I3 opens the server hub's page with `host=server`; the PC hub's page has no `host`.
      setItem(DESKTOP_HOST_KEY, params.get('host') === 'server' ? 'server' : 'pc', 'session');
    }
  } catch {
    /* history unavailable (e.g. sandboxed iframe) — fall back to no-auth */
  }
}
boot();

export function getToken(): string | null {
  return getItem(TOKEN_KEY, 'session') ?? getDeviceToken();
}

export function isDesktopMode(): boolean {
  return getItem(DESKTOP_KEY, 'session') === '1';
}

export function desktopCan(cap: string): boolean {
  return isDesktopMode() && (getItem(DESKTOP_CAPS_KEY, 'session') ?? '').split(',').includes(cap);
}

/** Which hub the desktop app opened this page on. Outside the desktop app there is only this hub: `pc`. */
export function desktopHost(): 'pc' | 'server' {
  return isDesktopMode() && getItem(DESKTOP_HOST_KEY, 'session') === 'server' ? 'server' : 'pc';
}

type Listener = () => void;
let needsToken = false;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export function reportAuthFailure(): void {
  // A refused device token has been revoked: drop it.
  if (!hasHubToken() && getDeviceToken()) {
    clearDeviceToken();
    unpaired = true;
  }
  if (needsToken) return;
  needsToken = true;
  emit();
}

export function clearAuthFailure(): void {
  if (!needsToken) return;
  needsToken = false;
  emit();
}

export function getNeedsToken(): boolean {
  return needsToken;
}

export function subscribeAuthFailure(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setToken(token: string): void {
  setItem(TOKEN_KEY, token, 'session');
  clearAuthFailure();
}

// The device token is kept in localStorage, never in a URL.
const DEVICE_KEY = 'pocketrocket.deviceToken';
let unpaired = false;
let pairError: string | null = null;

export function getDeviceToken(): string | null {
  return getItem(DEVICE_KEY);
}
function clearDeviceToken(): void {
  removeItem(DEVICE_KEY);
}
function hasHubToken(): boolean {
  return !!getItem(TOKEN_KEY, 'session');
}

export function isDevice(): boolean {
  return !hasHubToken() && !!getDeviceToken();
}
export function wasUnpaired(): boolean {
  return unpaired;
}
export function getPairError(): string | null {
  return pairError;
}

export function guessDeviceName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Windows/i.test(ua)) return 'Windows browser';
  if (/Macintosh/i.test(ua)) return 'Mac browser';
  if (/Linux/i.test(ua)) return 'Linux browser';
  return 'Phone';
}

export async function redeemPairingCode(code: string): Promise<boolean> {
  pairError = null;
  try {
    const r = await fetch('/api/devices/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: guessDeviceName() }),
      cache: 'no-store',
    });
    const j = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!r.ok || !j.token) {
      pairError = r.status === 429
        ? 'Too many tries. Make a new code.'
        : j.error ?? "Code didn't work. Make a new one.";
      return false;
    }
    setItem(DEVICE_KEY, j.token);
    unpaired = false;
    clearAuthFailure();
    return true;
  } catch {
    pairError = "Couldn't reach the server to pair.";
    return false;
  }
}

/** Takes `#pair=<CODE>` off the URL straight away, so the code never sits in history. */
export async function pairFromHash(): Promise<void> {
  let code: string | null = null;
  try {
    if (location.hash.startsWith('#pair=')) {
      code = decodeURIComponent(location.hash.slice('#pair='.length));
      history.replaceState(null, '', location.pathname + location.search);
    }
  } catch {
    return;
  }
  if (!code) return;
  if (!(await redeemPairingCode(code))) reportAuthFailure();
}
