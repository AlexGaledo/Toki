/**
 * D4 of docs/specs/toki-local-first-gamedev.md (Phase 3: one app, two hosts). Owner decision 6: projects stay on their
 * host. `GET /api/projects` lists this hub's own projects (`host: 'pc'`) followed by **stubs** for the server's: names
 * only, with no folder, members or room here. A stub's slug may equal a local project's, so a stub never goes near a
 * `/api/projects/:slug/*` route: `splitProjects` keeps stubs out of `ProjectInfo[]`, which is all those routes see.
 *
 * The desktop calls are the exact ones in docs/verify/phase3-infra/README.md ("Exact web calls for D4"): one parameter on
 * `/`, no fragment, nothing else.
 */
import { PROJECT_SLUG_RE, REMOTE_HOST_IDS, type HostId, type ProjectStub, type RemoteHostId } from '@pocketrocket/shared';
import type { ProjectInfo } from './api';

/** One row of `GET /api/projects`. Older hubs send local projects without `host`. */
export type ProjectListItem = (ProjectInfo & { host?: 'pc' }) | ProjectStub;

const isRemoteHost = (h: unknown): h is RemoteHostId => (REMOTE_HOST_IDS as readonly unknown[]).includes(h);

export function isStub(p: { host?: unknown }): p is ProjectStub {
  return p.host !== undefined && p.host !== 'pc';
}

/** This hub's projects, and the other host's stubs. Anything else in the body (an unknown host, a non-object) is dropped. */
export function splitProjects(list: unknown): { local: ProjectInfo[]; stubs: ProjectStub[] } {
  const local: ProjectInfo[] = [];
  const stubs: ProjectStub[] = [];
  if (!Array.isArray(list)) return { local, stubs };
  for (const p of list as unknown[]) {
    if (!p || typeof p !== 'object') continue;
    const item = p as { host?: unknown; slug?: unknown };
    if (typeof item.slug !== 'string') continue;
    if (item.host === undefined || item.host === 'pc') {
      // Strip the tag so a local project reads exactly as before Phase 3.
      const { host: _host, ...rest } = item as ProjectInfo & { host?: 'pc' };
      local.push(rest);
    } else if (isRemoteHost(item.host)) stubs.push(item as ProjectStub);
  }
  return { local, stubs };
}

/** The key for any project row: host plus slug, since a slug is unique only on its own host. */
export function projectKey(p: { host?: HostId; slug: string }): string {
  return (p.host ?? 'pc') + ':' + p.slug;
}

export const HOST_LABEL: Record<HostId, string> = { pc: 'This PC', server: 'Server' };

/** The words on a project's host tag. A local project lives on this page's hub, which is the server on the server page. */
export function hostTag(p: { slug: string; host?: HostId }, pageHost: HostId): string {
  return HOST_LABEL[p.host && p.host !== 'pc' ? p.host : pageHost];
}

/**
 * Tags show once the list can hold more than one host: a stub is known, or this is the server's page. A single-host
 * list stays as it was, with no "This PC" on every row.
 */
export function showHostTags(stubCount: number, pageHost: HostId): boolean {
  return stubCount > 0 || pageHost !== 'pc';
}

/** `project=<slug>` (I3 opens the server page with it). Only a real slug is taken; anything else is no link. */
export function projectDeepLink(search: string): string | null {
  const slug = new URLSearchParams(search).get('project');
  return slug && slug.length <= 40 && PROJECT_SLUG_RE.test(slug) ? slug : null;
}

/** The query without `project`, so a reload does not reopen it. Other parameters (`desktop`, `caps`, `host`) stay. */
export function withoutProjectParam(search: string): string {
  const p = new URLSearchParams(search);
  p.delete('project');
  const s = p.toString();
  return s ? '?' + s : '';
}

export const desktopCall = {
  openFolder: (origin: string, slug: string) => origin + '/?openfolder=' + encodeURIComponent(slug),
  openServerProject: (origin: string, slug: string) => origin + '/?openproject=server:' + encodeURIComponent(slug),
  backToPc: (origin: string) => origin + '/?openhost=pc',
};

/** What a click on a stub does. `can` is `desktopCan`. */
export type StubOpen = { kind: 'call'; url: string } | { kind: 'prompt'; phase: 'ask' | 'elsewhere' };

export function openStubAction(stub: ProjectStub, can: (cap: string) => boolean, origin: string): StubOpen {
  if (!can('hosts')) return { kind: 'prompt', phase: 'elsewhere' };
  if (stub.connected) return { kind: 'call', url: desktopCall.openServerProject(origin, stub.slug) };
  return { kind: 'prompt', phase: 'ask' };
}

/**
 * The offline Server project prompt.
 * - `ask`: "This project is on your server. Connect to open it." Connect or Cancel.
 * - `working`: Connect was pressed and the call made. The shell navigates the window away on success, so there is no
 *   reply; a `hosts.changed` that reads the host as disconnected is the failure.
 * - `failed`: the reason is only in the desktop notification (the hub has no error field yet).
 * - `elsewhere`: outside the desktop app, nothing can connect: open it there.
 */
export type ServerPrompt = { stub: ProjectStub; phase: 'ask' | 'working' | 'failed' | 'elsewhere' } | null;

export type PromptEvent =
  | { type: 'open'; stub: ProjectStub; phase: 'ask' | 'elsewhere' }
  | { type: 'connect' }
  | { type: 'hosts'; stubs: readonly ProjectStub[] }
  | { type: 'close' };

export function promptStep(state: ServerPrompt, ev: PromptEvent): ServerPrompt {
  switch (ev.type) {
    case 'open':
      return { stub: ev.stub, phase: ev.phase };
    case 'close':
      return null;
    case 'connect':
      return state && (state.phase === 'ask' || state.phase === 'failed') ? { ...state, phase: 'working' } : state;
    case 'hosts': {
      if (!state || state.phase !== 'working') return state;
      const sameHost = ev.stubs.filter((s) => s.host === state.stub.host);
      // Connected: the shell is about to navigate to the project. Keep working until the page unloads.
      if (sameHost.some((s) => s.connected)) return state;
      return { ...state, phase: 'failed' };
    }
  }
}
