import {
  PROTOCOL_VERSION,
  RequestError,
  methods,
  type ContentBlock,
  type InitializeResponse,
  type LoadSessionRequest,
  type NewSessionResponse,
  type PromptResponse,
  type SessionConfigOption,
  type SessionModeState,
} from '@agentclientprotocol/sdk';
import { currentModelId, type ModelInfo, type ProviderCheck, type ProviderId, type ProviderStaticInfo } from '@pocketrocket/shared';
import { VERSION } from '../../config.js';
import { childEnv, type ProviderKind } from '../env.js';
import { addSecret, redact } from '../redact.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnLimit, type TurnOutcome, type TurnSink } from '../types.js';
import type { TurnUsage } from '../../services/UsageTracker.js';
import { limitError } from '../claude.js';
import { hubMcpServer, startAcp, withTimeout, type AcpProcess } from './client.js';
import { AcpEventMapper } from './events.js';
import { decideAcpPermission, readOnlyModeChange, readOnlyViolation, strictModeChange } from './permissions.js';

export const ACP_START_TIMEOUT_MS = 12_000;
const SESSION_TIMEOUT_MS = 60_000;
const CANCEL_GRACE_MS = 5_000;

export const READ_ONLY_NOTE =
  'This run is unattended and read-only: you cannot create, change, move or delete files, and trying ends the run. ' +
  'Read what you need and report what should change instead.';

export interface AcpPreset {
  info: ProviderStaticInfo & { id: ProviderId };
  envKind: ProviderKind;
  models: ModelInfo[];
  hint: string;
  cliName: string;
  findExe(): Promise<string | null>;
  args: string[];
  env(): NodeJS.ProcessEnv;
  limitOf(text: string): TurnLimit | null;
  /**
   * Takes status lines the agent streams as answer text out of a chunk (agy writes its limit as `⚠ …` text and ends the
   * turn normally, live G11). What is left goes to the room; the warnings go to `limitOf`. Absent: all text is answer.
   */
  splitWarnings?(text: string): { text: string; warnings: string[] };
  check(probe: () => Promise<AcpProbe>): Promise<ProviderCheck>;
  /**
   * The agent's ask mode does not ask before its own file writes (agy 1.5.12, live G6), so a strict turn must run in
   * the agent's read-only mode instead, and is refused when it has none (spec 01 §4.7 item 7).
   */
  strictReadOnly?: boolean;
}

export type AcpProbe = { ok: true; init: InitializeResponse; exe: string } | { ok: false; error: string; exe: string | null; timedOut?: boolean };

export interface AcpProviderOptions {
  exe?: string;
  env?: NodeJS.ProcessEnv;
}

function messageOf(e: unknown): string {
  if (e instanceof RequestError) return e.message + (e.data !== undefined ? ' ' + JSON.stringify(e.data) : '');
  return String((e as Error)?.message ?? e);
}

function isAuthError(e: unknown): boolean {
  return e instanceof RequestError && e.code === -32000;
}

export function buildAcpPrompt(ctx: Pick<TurnContext, 'systemPrompt' | 'input' | 'bot'>, resumed: boolean): string {
  if (!resumed) return ctx.systemPrompt + '\n\n---\n\n' + ctx.input;
  return 'You are @' + ctx.bot.handle + '; room rules unchanged; reply NO_REPLY if nothing to add.\n\n' + ctx.input;
}

export class AcpProvider implements AgentProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly info: ProviderStaticInfo;
  readonly reportsContextTokens = true;
  private active = new Map<string, { cancel: () => void }>();
  private notedFallbacks = new Set<string>();

  constructor(private preset: AcpPreset, private opts: AcpProviderOptions = {}) {
    this.id = preset.info.id;
    this.label = preset.info.label;
    this.info = preset.info;
  }

  async models(): Promise<ModelInfo[]> {
    return this.preset.models;
  }
  modelsSync(): ModelInfo[] {
    return this.preset.models;
  }

  private exe(): Promise<string | null> {
    return this.opts.exe ? Promise.resolve(this.opts.exe) : this.preset.findExe();
  }

  private env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return childEnv(this.preset.envKind, { ...this.preset.env(), ...extra, ...this.opts.env });
  }

  private initialize(p: AcpProcess): Promise<InitializeResponse> {
    return withTimeout(
      p.conn.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { compaction: {} } },
        clientInfo: { name: 'pocketrocket', version: VERSION },
      }),
      ACP_START_TIMEOUT_MS,
      this.preset.cliName,
    );
  }

  async probe(): Promise<AcpProbe> {
    const exe = await this.exe();
    if (!exe) return { ok: false, error: this.preset.cliName + ' was not found', exe: null };
    let p: AcpProcess;
    try {
      p = startAcp(exe, this.preset.args, { cwd: process.cwd(), env: this.env() }, {
        onUpdate: () => undefined,
        onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      });
    } catch (e) {
      return { ok: false, error: messageOf(e), exe };
    }
    try {
      const init = await Promise.race([
        this.initialize(p),
        p.exited.then((code) => {
          throw new Error(p.spawnError() ?? this.preset.cliName + ' exited with code ' + String(code) + tail(p.stderr()));
        }),
      ]);
      return { ok: true, init, exe };
    } catch (e) {
      const error = messageOf(e);
      return { ok: false, error, exe, timedOut: /did not answer within/.test(error) };
    } finally {
      p.stop();
      await Promise.race([p.exited, sleep(3000)]);
    }
  }

  check(): Promise<ProviderCheck> {
    return this.preset.check(() => this.probe());
  }

  interrupt(turnId: string): boolean {
    const a = this.active.get(turnId);
    if (!a) return false;
    a.cancel();
    return true;
  }

  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    const started = Date.now();
    const cli = this.preset.cliName;
    const mapper = new AcpEventMapper(sink, this.preset.splitWarnings?.bind(this.preset));
    const outcome = (error: string | undefined, extra: Partial<TurnOutcome> = {}): TurnOutcome => ({
      ok: !error,
      error,
      costUsd: 0,
      usage: { ...EMPTY_USAGE, durationMs: Date.now() - started },
      durationMs: Date.now() - started,
      ...(mapper.contextTokens !== undefined ? { contextTokens: mapper.contextTokens } : {}),
      ...(mapper.contextSize ? { contextWindow: mapper.contextSize } : {}),
      ...extra,
    });

    const exe = await this.exe();
    if (!exe) return outcome(cli + ' was not found. ' + this.preset.hint, { limit: { kind: 'down' } });

    addSecret(ctx.mcp.token);
    let sessionId: string | null = null;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let budgetHit = false;
    const readOnly = !!ctx.strictApprovals && !!this.preset.strictReadOnly;
    let readOnlyId: string | null = null;
    let violation: string | null = null;
    let prompted = false;
    let answeredModel: string | undefined;
    const spent = (): Partial<TurnOutcome> =>
      prompted && mapper.worked ? { accounted: true, ...(answeredModel && answeredModel !== ctx.model ? { model: answeredModel } : {}) } : {};
    let p: AcpProcess;
    try {
      p = startAcp(exe, this.preset.args, { cwd: ctx.workspaceDir, env: this.env() }, {
        onUpdate: (n) => {
          if (sessionId && n.sessionId !== sessionId) return;
          if (readOnlyId !== null && !violation) {
            violation = readOnlyViolation(n.update, readOnlyId);
            if (violation) cancel();
          }
          mapper.push(n.update);
          if (!budgetHit && ctx.maxBudgetUsd > 0 && ownCost() > ctx.maxBudgetUsd) {
            budgetHit = true;
            cancel();
          }
        },
        onPermission: (req, signal) => decideAcpPermission(req, ctx, AbortSignal.any([signal, ctx.signal]), readOnly),
      });
    } catch (e) {
      return outcome('could not start ' + cli + ': ' + messageOf(e), { limit: { kind: 'down' } });
    }

    let resumed = false;
    const ownCost = () => {
      const total = mapper.sessionCostUsd ?? 0;
      return resumed ? Math.max(0, total - (ctx.sessionCostUsd ?? 0)) : total;
    };
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      if (sessionId) void p.conn.agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => undefined);
      else p.stop();
      killTimer = setTimeout(() => p.stop(), CANCEL_GRACE_MS);
    };
    this.active.set(ctx.turnId, { cancel });
    ctx.signal.addEventListener('abort', cancel, { once: true });
    const died = p.exited.then((code) => {
      throw new Error(p.spawnError() ? cli + ' failed to start: ' + p.spawnError() : cli + ' exited with code ' + String(code) + tail(p.stderr()));
    });
    died.catch(() => undefined);

    try {
      sink.onState('thinking');
      const init = await Promise.race([this.initialize(p), died]);
      sink.onInit?.({ model: ctx.model, version: init.agentInfo?.version ?? undefined });
      const caps = init.agentCapabilities ?? {};
      const mcpServers = [hubMcpServer(init, ctx.mcp)];
      const extraDirs = [ctx.botHome, ...(ctx.projectDirs ?? [])];
      const dirs: { additionalDirectories?: string[] } = caps.sessionCapabilities?.additionalDirectories ? { additionalDirectories: extraDirs } : {};

      let modes: SessionModeState | null | undefined;
      let configOptions: SessionConfigOption[] | null | undefined;
      if (ctx.resumeToken && (caps.sessionCapabilities?.resume || caps.loadSession)) {
        const params: LoadSessionRequest = { sessionId: ctx.resumeToken, cwd: ctx.workspaceDir, mcpServers, ...dirs };
        try {
          if (caps.sessionCapabilities?.resume) {
            const r = await Promise.race([withTimeout(p.conn.agent.request(methods.agent.session.resume, params), SESSION_TIMEOUT_MS, cli), died]);
            modes = r.modes;
            configOptions = r.configOptions;
          } else {
            // session/load replays the old conversation as updates: keep it out of the room.
            mapper.muted = true;
            const r = await Promise.race([withTimeout(p.conn.agent.request(methods.agent.session.load, params), SESSION_TIMEOUT_MS, cli), died]);
            modes = r?.modes;
            configOptions = r?.configOptions;
          }
        } catch (e) {
          if (isAuthError(e)) throw e;
          return outcome('No conversation found with session ID ' + ctx.resumeToken + ' (' + cli + ': ' + redact(messageOf(e)).slice(0, 200) + ')');
        } finally {
          mapper.muted = false;
        }
        sessionId = ctx.resumeToken;
        resumed = true;
      } else {
        const r: NewSessionResponse = await Promise.race([
          withTimeout(p.conn.agent.request(methods.agent.session.new, { cwd: ctx.workspaceDir, mcpServers, ...dirs }), SESSION_TIMEOUT_MS, cli),
          died,
        ]);
        sessionId = r.sessionId;
        modes = r.modes;
        configOptions = r.configOptions;
      }
      sink.onSession(sessionId);
      if (cancelled) {
        return outcome('interrupted');
      }

      if (readOnly) {
        const ro = readOnlyModeChange(modes, configOptions);
        const refused = (why: string) => outcome(cli + ' ' + why + ', so this unattended run was not started: ' + cli + ' does not ask before it writes files.');
        if (!ro) return refused('offers no read-only mode');
        try {
          if (ro.kind === 'mode' && !ro.current) await p.conn.agent.request(methods.agent.session.setMode, { sessionId, modeId: ro.modeId });
          else if (ro.kind === 'config' && !ro.current) await p.conn.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: ro.configId, value: ro.value });
        } catch (e) {
          if (cancelled) return outcome('interrupted');
          return refused('would not switch to its read-only mode (' + redact(messageOf(e)).slice(0, 200) + ')');
        }
        readOnlyId = ro.kind === 'mode' ? ro.modeId : ro.value;
      } else if (ctx.strictApprovals) {
        const change = strictModeChange(modes, configOptions);
        if (change?.kind === 'mode') await p.conn.agent.request(methods.agent.session.setMode, { sessionId, modeId: change.modeId });
        else if (change?.kind === 'config') await p.conn.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: change.configId, value: change.value });
      }
      // The bot's model, when the agent offers it as a model option. Otherwise the agent keeps its own current one, and
      // the room is told once. The offered values differ by sign-in (live G8/G11: the Google sign-in lacks gemini-4-*),
      // so they are read from the session, and a model the agent still refuses (-32602 "Unknown model ID") falls back
      // the same way instead of failing the turn.
      const modelOpt = (configOptions ?? []).find((o) => o.type === 'select' && (o.category === 'model' || o.id === 'model'));
      const wanted = currentModelId(ctx.model);
      if (modelOpt && modelOpt.type === 'select') {
        answeredModel = modelOpt.currentValue;
        if (modelOpt.currentValue !== wanted) {
          const values = modelOpt.options.flatMap((o) => ('group' in o ? o.options : [o])).map((o) => o.value);
          let missed = !values.includes(wanted);
          if (!missed) {
            try {
              await Promise.race([p.conn.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: modelOpt.id, value: wanted }), died]);
              answeredModel = wanted;
            } catch (e) {
              if (cancelled) return outcome('interrupted');
              if (/exited with code|failed to start|connection closed|process exited/i.test(messageOf(e))) throw e;
              missed = true;
            }
          }
          if (missed && wanted && modelOpt.currentValue) this.noteFallback(ctx, sink, wanted, modelOpt.currentValue);
        }
      }

      const prompt: ContentBlock[] = [{ type: 'text', text: buildAcpPrompt(ctx, resumed) + (readOnly ? '\n\n' + READ_ONLY_NOTE : '') }];
      if (init.agentCapabilities?.promptCapabilities?.image) {
        for (const img of ctx.images ?? []) if (img.data) prompt.push({ type: 'image', data: img.data.toString('base64'), mimeType: img.mediaType });
      }
      prompted = true;
      const res: PromptResponse = await Promise.race([p.conn.agent.request(methods.agent.session.prompt, { sessionId, prompt }), died]);
      mapper.flush();

      const costUsd = ownCost();
      const extra: Partial<TurnOutcome> = {
        costUsd,
        usage: { ...EMPTY_USAGE, ...acpTokens(res), costUsd, durationMs: Date.now() - started },
        // A finished run is a usage row even when the agent reports no cost or tokens (agy on Gemini reports neither).
        accounted: true,
        ...(answeredModel && answeredModel !== ctx.model ? { model: answeredModel } : {}),
        ...(mapper.sessionCostUsd !== undefined ? { sessionCostUsd: mapper.sessionCostUsd } : {}),
      };
      if (violation) return outcome(cli + ' was stopped: it ' + violation + ' during an unattended read-only run', extra);
      if (budgetHit) return outcome('budget exceeded: $' + costUsd.toFixed(4) + ' over the $' + String(ctx.maxBudgetUsd) + ' cap', extra);
      if (res.stopReason === 'cancelled' || cancelled) return outcome('interrupted', extra);
      if (res.stopReason === 'end_turn') {
        const warned = mapper.warnings.length ? this.preset.limitOf(mapper.warnings.join('\n')) : null;
        if (!mapper.answered) {
          const limit = warned ?? this.limitFromNotices(mapper.notices);
          return limit ? outcome(limitError(limit), { ...extra, limit }) : outcome(undefined, extra);
        }
        if (warned) sink.onLimit?.({ status: warned.resetsAt ? 'rejected' : 'allowed_warning', kind: warned.kind, ...(warned.resetsAt ? { resetsAt: warned.resetsAt } : {}) });
        return outcome(undefined, extra);
      }
      if (res.stopReason === 'max_tokens') return outcome(cli + ' stopped: it reached its output token limit', extra);
      if (res.stopReason === 'max_turn_requests') return outcome(cli + ' stopped: it reached its own step limit', extra);
      if (res.stopReason === 'refusal') return outcome(cli + ' refused to continue', extra);
      return outcome(cli + ' stopped: ' + String(res.stopReason), extra);
    } catch (e) {
      mapper.flush();
      if (violation) return outcome(cli + ' was stopped: it ' + violation + ' during an unattended read-only run', spent());
      if (cancelled) return outcome('interrupted', spent());
      let msg = messageOf(e);
      // The agent died: its stdout closed first, so the pending request failed as "connection closed". Say how it died.
      if (/connection closed|process exited/i.test(msg)) {
        const code = await Promise.race([p.exited, sleep(1000).then(() => undefined)]);
        if (code !== undefined) msg = p.spawnError() ? cli + ' failed to start: ' + p.spawnError() : cli + ' exited with code ' + String(code) + tail(p.stderr());
      }
      const text = msg + (mapper.notices.length ? ' ' + mapper.notices.join(' ') : '') + (mapper.warnings.length ? ' ' + mapper.warnings.join(' ') : '');
      if (isAuthError(e)) {
        const limit: TurnLimit = { kind: 'auth' };
        return outcome(limitError(limit) + '. ' + this.preset.hint, { ...spent(), limit });
      }
      const limit = this.preset.limitOf(text);
      if (limit) return outcome(limitError(limit), { ...spent(), limit });
      return outcome((text.startsWith(cli + ' ') ? '' : cli + ': ') + redact(text).slice(0, 500), spent());
    } finally {
      clearTimeout(killTimer);
      ctx.signal.removeEventListener('abort', cancel);
      this.active.delete(ctx.turnId);
      p.stop();
      await Promise.race([p.exited, sleep(3000)]);
    }
  }

  private noteFallback(ctx: TurnContext, sink: TurnSink, wanted: string, used: string) {
    const key = ctx.bot.id + '|' + wanted + '|' + used;
    if (this.notedFallbacks.has(key)) return;
    this.notedFallbacks.add(key);
    sink.onNote?.('could not use ' + wanted + ' (' + this.preset.cliName + ' does not offer it on this sign-in), so it ran on ' + used + '.');
  }

  private limitFromNotices(notices: string[]): TurnLimit | null {
    for (const n of notices) {
      const l = this.preset.limitOf(n);
      if (l) return l;
    }
    return null;
  }
}

/**
 * Token counts from the prompt answer's `usage`, an ACP field still marked unstable (not in the stable
 * `PromptResponse` type), so it is read defensively. Absent or malformed: no counts.
 */
export function acpTokens(res: unknown): Pick<TurnUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'> | Record<string, never> {
  const u = (res as { usage?: unknown } | null)?.usage;
  if (!u || typeof u !== 'object') return {};
  const n = (k: string) => {
    const v = (u as Record<string, unknown>)[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  };
  return { inputTokens: n('inputTokens'), outputTokens: n('outputTokens'), cacheReadTokens: n('cachedReadTokens'), cacheWriteTokens: n('cachedWriteTokens') };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
}

function tail(stderr: string): string {
  const t = stderr.trim();
  return t ? ': ' + redact(t.slice(-500)) : '';
}
