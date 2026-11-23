import { WS_PING_MS, type ClientEvent, type ServerEvent } from '@pocketrocket/shared';
import { useStore } from '../store';
import { dispatchPcSessionEvent } from './pcSessions';
import { dispatchWorkflowEvent } from './workflows';
import { getToken, reportAuthFailure, clearAuthFailure } from './auth';

let socket: WebSocket | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * A pulled cable or a sleeping laptop leaves the browser's socket "open" for minutes with no `close`, so a link
 * silent for two ping periods is dead. Any frame counts as proof of life.
 */
export const STALE_AFTER_MS = WS_PING_MS * 2 + 5000;
let watchdog: ReturnType<typeof setTimeout> | null = null;
function disarmWatchdog() {
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
}
let generation = 0;

/** Found with plain HTTP because a refused WebSocket upgrade says nothing about why. */
export type HubProbe =
  | { result: 'ok' }
  | { result: 'auth' }
  | { result: 'rateLimited'; retryInMs: number }
  | { result: 'unreachable'; detail: string };

function retryAfterMs(r: Response): number {
  const seconds = Number(r.headers.get('retry-after'));
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
}

export async function probeHub(token: string | null): Promise<HubProbe> {
  try {
    const health = await fetch('/api/health', { cache: 'no-store' });
    if (health.status === 429) return { result: 'rateLimited', retryInMs: retryAfterMs(health) };
    if (!health.ok) return { result: 'unreachable', detail: 'The server answered with HTTP ' + health.status + '.' };
  } catch {
    return { result: 'unreachable', detail: 'Nothing answered at ' + location.host + '.' };
  }
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    const r = await fetch('/api/settings', { headers, cache: 'no-store' });
    if (r.status === 401) return { result: 'auth' };
    if (r.status === 429) return { result: 'rateLimited', retryInMs: retryAfterMs(r) };
    return { result: 'ok' };
  } catch {
    return { result: 'unreachable', detail: 'The server stopped answering.' };
  }
}

function backoffMs() {
  const base = Math.min(15_000, 1000 * 2 ** retry++);
  return base / 2 + Math.random() * (base / 2);
}

function schedule(delay: number) {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(connectWs, delay);
}

export function reconnectWsNow() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retry = 0;
  connectWs();
}

export function connectWs() {
  const gen = ++generation;
  disarmWatchdog();
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  const token = getToken();
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' + (token ? '?token=' + encodeURIComponent(token) : '');
  socket = new WebSocket(url);
  let opened = false;
  const armWatchdog = () => {
    disarmWatchdog();
    watchdog = setTimeout(() => {
      if (gen !== generation) return;
      const dead = socket;
      if (dead) {
        dead.onclose = null;
        dead.close();
      }
      useStore.getState().setConnected(false);
      schedule(backoffMs());
    }, STALE_AFTER_MS);
  };
  socket.onopen = () => {
    if (gen !== generation) return;
    armWatchdog();
    opened = true;
    retry = 0;
    clearAuthFailure();
    useStore.getState().setConnected(true);
  };
  socket.onclose = () => {
    if (gen !== generation) return;
    disarmWatchdog();
    useStore.getState().setConnected(false);
    if (opened) return schedule(backoffMs());
    void diagnose(gen, token);
  };
  socket.onmessage = (e) => {
    if (gen !== generation) return;
    armWatchdog();
    try {
      const raw: unknown = JSON.parse(e.data);
      if (dispatchPcSessionEvent(raw)) return;
      if (dispatchWorkflowEvent(raw)) return;
      const ev = raw as ServerEvent;
      if (ev.type === 'ping') {
        wsSend({ type: 'pong' });
        return;
      }
      useStore.getState().applyEvent(ev);
    } catch (err) {
      console.error('bad ws event', err);
    }
  };
}

async function diagnose(gen: number, token: string | null) {
  const probe = await probeHub(token);
  if (gen !== generation) return;
  const { setHubIssue } = useStore.getState();
  switch (probe.result) {
    case 'auth':
      setHubIssue({ kind: 'auth' });
      reportAuthFailure();
      return schedule(30_000);
    case 'rateLimited':
      setHubIssue({ kind: 'rateLimited', retryInMs: probe.retryInMs });
      return schedule(probe.retryInMs);
    case 'unreachable':
      setHubIssue({ kind: 'unreachable', detail: probe.detail });
      return schedule(backoffMs());
    case 'ok':
      setHubIssue({ kind: 'refused' });
      return schedule(backoffMs());
  }
}

export function wsSend(ev: ClientEvent): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(ev));
  return true;
}
