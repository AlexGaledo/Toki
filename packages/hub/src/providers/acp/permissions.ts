import path from 'node:path';
import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type { TurnContext } from '../types.js';

export type AcpPermCtx = Pick<
  TurnContext,
  'permission' | 'bypassPermissions' | 'strictApprovals' | 'workspaceDir' | 'projectGuard' | 'shipGuard' | 'fileGuard' | 'ruleGuard'
>;

export interface BrokerAsk {
  tool: string;
  input: Record<string, unknown>;
}

const PATH_KIND_TOOL: Partial<Record<string, string>> = { read: 'Read', search: 'Grep', edit: 'Edit', delete: 'Write', move: 'Write' };
const READ_KINDS = new Set(['read', 'search']);
const HUB_TOOL = /^(?:mcp__)?pocketrocket(?:__|[./:])([a-z0-9_]+)$/i;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

export function commandOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const c = r.command ?? r.cmd;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string') && c.length) return c.join(' ');
  return str(c);
}

function cardTool(tc: ToolCallUpdate): string {
  const what = (tc.name ?? tc.title ?? 'tool').replace(/\s+/g, ' ').trim().slice(0, 80);
  return 'acp:' + (tc.kind ?? 'other') + ':' + what;
}

function card(tc: ToolCallUpdate): BrokerAsk[] {
  return [{
    tool: cardTool(tc),
    input: {
      title: tc.title ?? tc.name ?? 'tool',
      ...(tc.kind ? { kind: tc.kind } : {}),
      ...(tc.locations?.length ? { paths: tc.locations.map((l) => l.path) } : {}),
      ...(tc.rawInput !== undefined && tc.rawInput !== null ? { rawInput: tc.rawInput } : {}),
    },
  }];
}

/** Never empty: what cannot be classified is one card. */
export function brokerAsks(tc: ToolCallUpdate, cwd: string): BrokerAsk[] {
  const kind = tc.kind ?? 'other';
  const pathTool = PATH_KIND_TOOL[kind];
  if (pathTool) {
    const paths = (tc.locations ?? []).map((l) => str(l.path)).filter((p): p is string => !!p);
    if (!paths.length) return card(tc);
    const key = pathTool === 'Grep' ? 'path' : 'file_path';
    return [...new Set(paths.map((p) => path.resolve(cwd, p)))].map((p) => ({ tool: pathTool, input: { [key]: p } }));
  }
  if (kind === 'execute') {
    const cmd = commandOf(tc.rawInput);
    if (!cmd) return card(tc);
    const dir = str((tc.rawInput as Record<string, unknown>).cwd);
    return [{ tool: 'Bash', input: { command: dir ? 'cd ' + JSON.stringify(dir) + ' && ' + cmd : cmd } }];
  }
  if (kind === 'fetch') {
    const url = tc.rawInput && typeof tc.rawInput === 'object' ? str((tc.rawInput as Record<string, unknown>).url) : null;
    return url ? [{ tool: 'WebFetch', input: { url } }] : card(tc);
  }
  if (kind === 'other') {
    const hub = HUB_TOOL.exec(tc.name ?? '') ?? HUB_TOOL.exec(tc.title ?? '');
    if (hub) return [{ tool: 'mcp__pocketrocket__' + hub[1], input: (tc.rawInput as Record<string, unknown>) ?? {} }];
  }
  return card(tc);
}

function guardRefusal(asks: BrokerAsk[], ctx: AcpPermCtx): string | null {
  for (const a of asks) {
    const ruled = a.tool === 'Bash' || a.tool === 'Edit' || a.tool === 'Write' ? ctx.ruleGuard?.(a.tool, a.input) : null;
    if (ruled) return ruled;
    if (a.tool === 'Bash') {
      const cmd = String(a.input.command);
      const why = ctx.shipGuard?.(cmd, ctx.workspaceDir) ?? ctx.projectGuard?.('Bash', a.input, ctx.workspaceDir);
      if (why) return why;
    } else if (a.tool === 'Edit' || a.tool === 'Write') {
      const why = ctx.projectGuard?.(a.tool, a.input, ctx.workspaceDir) ?? ctx.fileGuard?.(a.tool, a.input, ctx.workspaceDir);
      if (why) return why;
    }
  }
  return null;
}

function pick(options: PermissionOption[], kinds: PermissionOptionKind[]): RequestPermissionResponse {
  for (const k of kinds) {
    const o = options.find((x) => x.kind === k);
    if (o) return { outcome: { outcome: 'selected', optionId: o.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

/** `allow_always` only when nothing else is offered and the turn is not strict. */
export function allowResponse(options: PermissionOption[], strict: boolean): RequestPermissionResponse {
  return pick(options, strict ? ['allow_once'] : ['allow_once', 'allow_always']);
}
export function denyResponse(options: PermissionOption[]): RequestPermissionResponse {
  return pick(options, ['reject_once', 'reject_always']);
}

/** Refused on a read-only (strict) turn. */
export const WRITE_KINDS: ReadonlySet<string> = new Set(['edit', 'delete', 'move', 'switch_mode']);

/** Bypass never applies on strict turns; the project, shipping and shared-file guards hold under bypass too. */
export async function decideAcpPermission(
  req: RequestPermissionRequest,
  ctx: AcpPermCtx,
  signal: AbortSignal,
  readOnly = false,
): Promise<RequestPermissionResponse> {
  const strict = !!ctx.strictApprovals;
  if (readOnly && WRITE_KINDS.has(req.toolCall.kind ?? '')) return denyResponse(req.options);
  const asks = brokerAsks(req.toolCall, ctx.workspaceDir);
  if (guardRefusal(asks, ctx)) return denyResponse(req.options);
  if (ctx.bypassPermissions && !strict) return allowResponse(req.options, false);
  for (const a of asks) {
    if (signal.aborted) return { outcome: { outcome: 'cancelled' } };
    const verdict = await ctx.permission(a.tool, a.input);
    if (verdict !== 'allow') return denyResponse(req.options);
  }
  if (signal.aborted) return { outcome: { outcome: 'cancelled' } };
  return allowResponse(req.options, strict);
}

/** Never chosen on a strict turn. */
const PERMISSIVE = /bypass|yolo|danger|full.?access|accept.?edits|auto.?(?:approve|accept|edit)|allow.?all|(?<!un)trust(?:ed)?\b|skip/i;
const ASKS = /\bask|always.?ask|manual|untrusted|on.?request|strict|confirm|default|normal|review/i;
const READ_ONLY = /read.?only|\bplan\b|view.?only/i;

interface ModeLike {
  id: string;
  name: string;
  description?: string | null;
}

function label(m: ModeLike): string {
  return m.id + ' ' + m.name + ' ' + (m.description ?? '');
}

export function strictModeId(modes: ModeLike[], currentId: string | null): string | null {
  const current = modes.find((m) => m.id === currentId);
  if (current && ASKS.test(label(current)) && !PERMISSIVE.test(label(current))) return null;
  const asks = modes.find((m) => ASKS.test(label(m)) && !PERMISSIVE.test(label(m)) && !READ_ONLY.test(label(m)));
  if (asks) return asks.id === currentId ? null : asks.id;
  const ro = modes.find((m) => READ_ONLY.test(label(m)) && !PERMISSIVE.test(label(m)));
  if (ro) return ro.id === currentId ? null : ro.id;
  return null;
}

export function strictModeChange(
  modes: SessionModeState | null | undefined,
  configOptions: SessionConfigOption[] | null | undefined,
): { kind: 'mode'; modeId: string } | { kind: 'config'; configId: string; value: string } | null {
  if (modes?.availableModes?.length) {
    const id = strictModeId(modes.availableModes, modes.currentModeId);
    return id ? { kind: 'mode', modeId: id } : null;
  }
  const opt = (configOptions ?? []).find((o) => o.type === 'select' && o.category === 'mode');
  if (opt && opt.type === 'select') {
    const flat = opt.options.flatMap((o) => ('group' in o ? o.options : [o]));
    const id = strictModeId(flat.map((o) => ({ id: o.value, name: o.name, description: o.description })), opt.currentValue);
    return id ? { kind: 'config', configId: opt.id, value: id } : null;
  }
  return null;
}

/**
 * A strict turn on an agent whose ask mode does not ask before its own writes (agy, live G6): the read-only mode to
 * run in, or null when the agent offers none (the turn is then refused). Unlike `strictModeChange`, a mode that merely
 * "asks" is not enough. `current` is set when the agent already runs in it.
 */
export function readOnlyModeChange(
  modes: SessionModeState | null | undefined,
  configOptions: SessionConfigOption[] | null | undefined,
): { kind: 'mode'; modeId: string; current: boolean } | { kind: 'config'; configId: string; value: string; current: boolean } | null {
  const ro = (list: ModeLike[]) => list.find((m) => READ_ONLY.test(label(m)) && !PERMISSIVE.test(label(m)));
  if (modes?.availableModes?.length) {
    const m = ro(modes.availableModes);
    return m ? { kind: 'mode', modeId: m.id, current: m.id === modes.currentModeId } : null;
  }
  const opt = (configOptions ?? []).find((o) => o.type === 'select' && o.category === 'mode');
  if (opt && opt.type === 'select') {
    const flat = opt.options.flatMap((o) => ('group' in o ? o.options : [o]));
    const m = ro(flat.map((o) => ({ id: o.value, name: o.name, description: o.description })));
    return m ? { kind: 'config', configId: opt.id, value: m.id, current: m.id === opt.currentValue } : null;
  }
  return null;
}

/** A write kind or a mode change breaks a read-only turn, even when the agent never asks. */
export function readOnlyViolation(u: SessionUpdate, readOnlyId: string): string | null {
  if ((u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') && u.kind && WRITE_KINDS.has(u.kind)) {
    return 'tried to ' + (u.kind === 'switch_mode' ? 'leave read-only mode' : 'change files') + ' (' + (u.title ?? u.kind) + ')';
  }
  if (u.sessionUpdate === 'current_mode_update' && u.currentModeId !== readOnlyId) return 'left read-only mode (' + u.currentModeId + ')';
  if (u.sessionUpdate === 'config_option_update') {
    const mode = u.configOptions.find((o) => o.type === 'select' && o.category === 'mode');
    if (mode && mode.type === 'select' && mode.currentValue !== readOnlyId) return 'left read-only mode (' + mode.currentValue + ')';
  }
  return null;
}
