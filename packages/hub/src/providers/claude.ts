import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
  createSdkMcpServer, query, tool,
  type Options, type PermissionResult, type SDKMessage, type SDKUserMessage, type PreToolUseHookInput, type PostToolUseHookInput,
  type SDKAPIRetryMessage, type SDKAssistantMessageError, type SDKRateLimitInfo,
} from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo, ProviderCheck, ProviderLimitKind, ProviderStaticInfo } from '@pocketrocket/shared';
import { BASH_MAX_OUTPUT_CHARS, CLAUDE_EXE, DATA_DIR, MAX_MCP_OUTPUT_TOKENS, PLAYWRIGHT_MCP_CLI, VERSION } from '../config.js';
import { browserMcpRoots, sandboxCommand } from './sandbox.js';
import { isOutdatedCliError, updateClaudeCli } from './claudeUpdate.js';
import { childEnv } from './env.js';
import { SESSION_RETENTION_DAYS } from './cliRetention.js';
import { deleteGate } from '../permissions/deleteGate.js';
import { isInside, pathsFromInput } from '../permissions/pathRules.js';
import { READ_ONLY_GUARD_TOOLS, readOnlyWriteDecision, routingFileWrite } from '../permissions/readOnlyRoots.js';
import { secretFileAccess } from '../permissions/secretFiles.js';
import { denyMessage } from '../permissions/messages.js';
import { logError } from './redact.js';
import { outsideMcpHooked, outsideMcpStep } from '../services/outsideMcp.js';
import type { AgentProvider, HubTool, LimitReport, ProviderInit, SteerInput, SteerResult, TurnContext, TurnImage, TurnLimit, TurnOutcome, ToolResultImage, TurnSink } from './types.js';

// A bare allowedTools entry bypasses canUseTool everywhere, so file and shell tools must never be listed here.
const AUTO_OK = new Set(['WebSearch', 'WebFetch']);
const ALL_BUILTINS = ['Read','Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'NotebookEdit', 'Task'];
const sdkNames = (t: string) => (t === 'Task' ? ['Task', 'Agent'] : [t]);
/**
 * Playwright MCP tools a bot never gets. Each can read what a page holds outside the snapshot, including a
 * password fill_credential just typed: browser_evaluate runs page JavaScript, browser_run_code_unsafe runs
 * Playwright code in the server process, and browser_network_request returns request bodies (a sign-in POST).
 * disallowedTools wins over the `mcp__browser__*` entry in allowedTools, in bypass mode too.
 */
export const BLOCKED_BROWSER_TOOLS = ['browser_evaluate', 'browser_run_code_unsafe', 'browser_network_request'].map((t) => 'mcp__browser__' + t);
export const BLOCKED_BROWSER_MATCHER = '^(?:' + BLOCKED_BROWSER_TOOLS.join('|') + ')$';
export const BLOCKED_BROWSER_REASON = 'This browser tool is turned off for bots: it can read what a page holds, including saved passwords. Use browser_snapshot to read the page.';

export function sdkBudgetUsd(maxBudgetUsd: number, resumed: boolean, sessionCostUsd: number | null | undefined): number | undefined {
  if (!Number.isFinite(maxBudgetUsd)) return undefined;
  if (!resumed) return maxBudgetUsd;
  if (sessionCostUsd == null) return undefined;
  return sessionCostUsd + maxBudgetUsd;
}

export function runCostUsd(cumulative: number, resumed: boolean, sessionCostUsd: number | null | undefined): number {
  if (!resumed) return cumulative;
  if (sessionCostUsd == null) return 0;
  return cumulative >= sessionCostUsd ? cumulative - sessionCostUsd : cumulative;
}

export function callInputTokens(u: { input_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined): number {
  return (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
}

export function claudeChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return childEnv('claude', {
    CLAUDE_AGENT_SDK_CLIENT_APP: 'pocketrocket/' + VERSION,
    BASH_MAX_OUTPUT_LENGTH: String(BASH_MAX_OUTPUT_CHARS),
    MAX_MCP_OUTPUT_TOKENS: String(MAX_MCP_OUTPUT_TOKENS),
  }, source);
}

const MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'balanced, default', default: true },
  { id: 'claude-opus-5', label: 'Opus 5', note: 'hard problems' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', note: 'most capable, 2x Opus price' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', note: 'cheapest, fastest' },
];

export const CLAUDE_INFO: ProviderStaticInfo = {
  id: 'claude',
  label: 'Claude',
  blurb: 'Runs on your server with your Claude subscription.',
  authModes: ['subscription', 'apiKey'],
  secretKeys: ['ANTHROPIC_API_KEY'],
  permissions: 'full',
  maturity: 'verified',
};

export function fallbackModelFor(model: string): string | undefined {
  const id = (family: string) => MODELS.find((m) => m.id.includes(family))?.id;
  if (/fable/i.test(model)) return id('opus');
  if (/opus/i.test(model)) return id('sonnet');
  return undefined;
}

export function ranModel(asked: string, fallback: string | undefined, seen: string | undefined): string | undefined {
  if (!seen || !fallback || seen.startsWith(asked)) return undefined;
  return seen.startsWith(fallback) ? fallback : undefined;
}

export function contextWindowOf(modelUsage: unknown, seen: string | undefined): number | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const windowOf = (v: unknown) => {
    const w = (v as { contextWindow?: unknown } | null)?.contextWindow;
    return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : undefined;
  };
  const entries = Object.entries(modelUsage as Record<string, unknown>);
  const own = seen ? entries.find(([k]) => k === seen || seen.startsWith(k) || k.startsWith(seen)) : undefined;
  if (own && windowOf(own[1])) return windowOf(own[1]);
  const all = entries.map(([, v]) => windowOf(v)).filter((w): w is number => w !== undefined);
  return all.length ? Math.max(...all) : undefined;
}

export function resetMs(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return v < 1e12 ? Math.round(v * 1000) : v;
}

export function limitReport(info: SDKRateLimitInfo): LimitReport {
  const overagePays = info.status === 'rejected' && info.rateLimitType !== 'overage' &&
    (info.overageStatus === 'allowed' || info.overageStatus === 'allowed_warning');
  return {
    status: overagePays ? 'allowed_warning' : info.status,
    kind: 'usage',
    window: info.rateLimitType,
    resetsAt: resetMs(info.resetsAt),
    utilization: typeof info.utilization === 'number' ? info.utilization : undefined,
  };
}

/** Provider errors: never posted as the bot's reply nor read for @mentions. */
const LIMIT_ERRORS: Partial<Record<SDKAssistantMessageError, ProviderLimitKind>> = {
  rate_limit: 'usage',
  overloaded: 'overloaded',
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
};

export function retryLimitKind(r: { error_status: number | null; error: SDKAssistantMessageError }): ProviderLimitKind | undefined {
  if (r.error === 'rate_limit' || r.error_status === 429) return 'usage';
  if (r.error === 'overloaded' || r.error_status === 529) return 'overloaded';
  if (r.error === 'server_error' || r.error_status === null || r.error_status >= 500) return 'down';
  return undefined;
}

export function limitError(limit: TurnLimit): string {
  if (limit.kind === 'usage') return 'usage limit reached' + (limit.window ? ' (' + limit.window + ')' : '');
  if (limit.kind === 'overloaded') return 'overloaded';
  if (limit.kind === 'auth') return 'not signed in (authentication failed)';
  return 'network: Claude could not be reached';
}

export function tokenBrakeError(read: number, cap: number): string {
  return 'token_budget: stopped after reading ' + read.toLocaleString('en-US') + ' cached tokens this turn (cap ' +
    cap.toLocaleString('en-US') + ") to save your plan's usage";
}

function toolServer(tools: HubTool[]) {
  const wrapped = tools.map((t) =>
    tool(
      t.name,
      t.description,
      t.inputSchema.shape,
      async (args: unknown) => (await t.handler((args ?? {}) as Record<string, unknown>)) as never,
      t.readOnly ? { annotations: { readOnlyHint: true } } : undefined,
    ),
  );
  return createSdkMcpServer({ name: 'pocketrocket', version: VERSION, alwaysLoad: true, tools: wrapped });
}

const VERSION_TIMEOUT_MS = 10_000;

/**
 * Install and sign-in instructions, Markdown. Anthropic's native installer puts the binary in ~/.local/bin,
 * which is where CLAUDE_EXE looks; `npm install -g` puts a claude.cmd shim in %APPDATA%\npm that the hub
 * would never find.
 */
const INSTALL_HINT =
  'Install Claude Code with Anthropic\'s installer (Windows PowerShell: `irm https://claude.ai/install.ps1 | iex`; ' +
  'macOS/Linux: `curl -fsSL https://claude.ai/install.sh | bash`) and sign in with `claude` (subscription), ' +
  'or set ANTHROPIC_API_KEY. Point CLAUDE_EXE at the binary if it lives elsewhere.';

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
  authMethod?: string;
  orgName?: string;
}

export function parseAuthStatus(stdout: string): ClaudeAuthStatus | undefined {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof parsed.loggedIn !== 'boolean') return undefined;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    return {
      loggedIn: parsed.loggedIn,
      email: str(parsed.email),
      subscriptionType: str(parsed.subscriptionType),
      authMethod: str(parsed.authMethod),
      orgName: str(parsed.orgName),
    };
  } catch {
    return undefined;
  }
}

export function planLabel(subscriptionType: string | undefined): string | undefined {
  if (!subscriptionType) return undefined;
  const known: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
  return known[subscriptionType.toLowerCase()] ?? subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
}

function authStatus(): Promise<ClaudeAuthStatus | undefined> {
  return new Promise((resolve) => {
    const child = execFile(CLAUDE_EXE, ['auth', 'status'], { timeout: 5000, windowsHide: true }, (_err, stdout) => {
      resolve(parseAuthStatus(String(stdout)));
    });
    child.on('error', () => resolve(undefined));
  });
}

export function userContent(input: string, images: readonly TurnImage[]) {
  const inline = images.filter((i) => i.data);
  if (!inline.length) return input;
  return [
    { type: 'text' as const, text: input },
    ...inline.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data!.toString('base64') } })),
  ];
}

/**
 * B9: the first base64 image block of a tool result, straight from the SDK message. The CLI also saves a copy under
 * ~/.claude/.../tool-results and names it in a text block; that file is never read.
 */
export function firstImage(content: unknown): ToolResultImage | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const c of content as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } }[]) {
    const src = c?.type === 'image' ? c.source : undefined;
    if (src?.type === 'base64' && typeof src.media_type === 'string' && typeof src.data === 'string') return { mediaType: src.media_type, data: src.data };
  }
  return undefined;
}

export const STEER_CAPABILITY = 'interrupt_receipt_v1';
export const STOP_RESULT_WAIT_MS = 5_000;

export function inputChannel() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (closed) return;
      await new Promise<void>((r) => (wake = r));
      wake = undefined;
    }
  }
  return {
    messages: messages(),
    push(m: SDKUserMessage) {
      if (closed) return false;
      queue.push(m);
      wake?.();
      return true;
    },
    close() {
      closed = true;
      wake?.();
    },
  };
}

type SdkUuid = NonNullable<SDKUserMessage['uuid']>;
const userMessage = (text: string, images: readonly TurnImage[], uuid: string): SDKUserMessage =>
  ({ type: 'user', message: { role: 'user', content: userContent(text, images) }, parent_tool_use_id: null, uuid: uuid as SdkUuid });

interface LiveTurn {
  known: Map<string, SteerInput>;
  consumed: Set<string>;
  push?: (s: SteerInput) => void;
  stop?: () => void;
  initSeen: boolean;
  steerable: boolean;
  ending: boolean;
}

export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly reportsContextTokens = true;
  readonly label = 'Claude';
  readonly info = CLAUDE_INFO;
  private live = new Map<string, LiveTurn>();
  lastInit: ProviderInit = {};

  async models(): Promise<ModelInfo[]> {
    return MODELS;
  }
  modelsSync(): ModelInfo[] {
    return MODELS;
  }

  async check(): Promise<ProviderCheck> {
    const hint = INSTALL_HINT;
    const exePath = CLAUDE_EXE;
    if (!fs.existsSync(CLAUDE_EXE)) {
      return { ok: false, auth: 'none', exePath, error: 'claude executable not found at ' + CLAUDE_EXE, hint };
    }
    const answer = await new Promise<{ version?: string; timedOut: boolean }>((resolve) => {
      const child = execFile(CLAUDE_EXE, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        if (err) resolve({ timedOut: !!(err as { killed?: boolean }).killed });
        else resolve({ version: String(stdout).trim().split('\n')[0] || undefined, timedOut: false });
      });
      child.on('error', () => resolve({ timedOut: false }));
    });
    const { version } = answer;
    if (!version) {
      const error = answer.timedOut
        ? 'claude --version did not answer within ' + VERSION_TIMEOUT_MS / 1000 + 's'
        : 'claude --version failed to run';
      return { ok: false, auth: 'unknown', exePath, unresponsive: true, error, hint };
    }
    if (process.env.ANTHROPIC_API_KEY) return { ok: true, version, auth: 'apiKey', exePath, hint };
    const status = await authStatus();
    if (status?.loggedIn === false) {
      return { ok: false, version, auth: 'none', exePath, error: 'Claude Code is installed but not signed in.', hint };
    }
    // Older CLIs have no `auth status`: fall back to the init message, where an OAuth login reports
    // apiKeySource 'none' (the expected value for a subscription, not an error).
    const auth = status?.loggedIn || this.lastInit.apiKeySource === undefined || this.lastInit.apiKeySource === 'none'
      ? 'subscription'
      : 'unknown';
    return {
      ok: true, version, auth, exePath, hint,
      account: status?.email,
      plan: planLabel(status?.subscriptionType),
      authMethod: status?.authMethod,
      orgName: status?.orgName,
    };
  }

  interrupt(turnId: string): boolean {
    const live = this.live.get(turnId);
    if (!live?.stop) return false;
    live.stop();
    return true;
  }

  canSteer(): boolean {
    return !!this.lastInit.capabilities?.includes(STEER_CAPABILITY);
  }

  steer(turnId: string, input: SteerInput): SteerResult {
    const live = this.live.get(turnId);
    if (!live?.push || live.ending || !live.initSeen) return { status: 'queued', reason: 'between-runs' };
    if (!live.steerable) return { status: 'queued', reason: 'provider' };
    live.known.set(input.uuid, input);
    live.push(input);
    return { status: 'accepted' };
  }

  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    const live: LiveTurn = { known: new Map(), consumed: new Set(), initSeen: false, steerable: false, ending: false };
    for (const s of ctx.carriedSteers ?? []) live.known.set(s.uuid, s);
    this.live.set(ctx.turnId, live);
    const done = (outcome: TurnOutcome): TurnOutcome => {
      if (!live.known.size) return outcome;
      const uuids = [...live.known.keys()];
      return { ...outcome, steers: { consumed: uuids.filter((u) => live.consumed.has(u)), pending: uuids.filter((u) => !live.consumed.has(u)) } };
    };
    try {
      const first = await this.runOnce(ctx, sink, live, ctx.carriedSteers ?? []);
      if (!first.outdatedCli || first.usedTools || ctx.signal.aborted) return done(first.outcome);
      sink.onState('working');
      const update = await updateClaudeCli();
      if (!update.ok) {
        const detail = update.output.split('\n').filter((l) => l.trim()).pop();
        return done({
          ...first.outcome,
          error: first.outcome.error + ' Automatic `claude update` failed' + (detail ? ' (' + detail + ')' : '') +
            '. Run `claude update` in a terminal, then try again.',
        });
      }
      if (ctx.signal.aborted) return done(first.outcome);
      sink.onState('thinking');
      const carry = [...live.known.values()];
      for (const s of carry) live.consumed.delete(s.uuid);
      return done((await this.runOnce(ctx, sink, live, carry)).outcome);
    } finally {
      live.ending = true;
      this.live.delete(ctx.turnId);
    }
  }

  private async runOnce(
    ctx: TurnContext, sink: TurnSink, live: LiveTurn, carry: SteerInput[],
  ): Promise<{ outcome: TurnOutcome; outdatedCli: boolean; usedTools: boolean }> {
    const started = Date.now();
    const bot = ctx.bot;
    const pluginDir = ctx.pluginDir ?? null;
    const resumed = !!ctx.resumeToken;

    const allowed = ctx.allowedBuiltins.filter((t) => AUTO_OK.has(t));
    const disallowed = ALL_BUILTINS.filter((t) => !ctx.allowedBuiltins.includes(t)).flatMap(sdkNames);
    const browserOn = ctx.allowedBuiltins.includes('Browser') && !!ctx.cdpUrl && fs.existsSync(PLAYWRIGHT_MCP_CLI);
    const mcpServers: NonNullable<Options['mcpServers']> = { pocketrocket: toolServer(ctx.tools) };
    if (browserOn) {
      mcpServers.browser = {
        type: 'stdio', command: process.execPath,
        args: [
          PLAYWRIGHT_MCP_CLI, '--cdp-endpoint', ctx.cdpUrl!, '--caps', 'vision',
          '--output-dir', path.join(ctx.botHome, 'playwright-output'), '--output-max-size', String(64 * 1024 * 1024),
        ],
      };
    }

    // Left out of allowedTools so outside bypass each call reaches canUseTool and the broker.
    for (const s of ctx.outsideMcp ?? []) {
      mcpServers[s.name] = s.kind === 'stdio'
        ? { type: 'stdio', command: s.command, args: s.args, env: s.env }
        : { type: 'http', url: s.url, ...(s.token ? { headers: { Authorization: 'Bearer ' + s.token } } : {}) };
    }

    const channel = inputChannel();
    const openerUuid = randomUUID();
    const openerText = [ctx.input, ...carry.map((s) => s.text)].join('\n\n');
    channel.push(userMessage(openerText, [...(ctx.images ?? []), ...carry.flatMap((s) => s.images ?? [])], openerUuid));
    const runSteers = new Set<string>();
    const consume = (uuids: readonly string[] | undefined) => {
      for (const u of uuids ?? []) {
        if (u === openerUuid) for (const s of carry) live.consumed.add(s.uuid);
        else if (live.known.has(u)) live.consumed.add(u);
      }
    };
    const outstanding = () => [...runSteers].filter((u) => !live.consumed.has(u));
    live.initSeen = false;
    live.steerable = false;
    live.ending = false;

    const decide = async (
      name: string,
      toolInput: Record<string, unknown>,
      o: { signal: AbortSignal; suggestions?: unknown; blockedPath?: string },
    ): Promise<PermissionResult> => {
      if (ctx.permissionDetailed) return (await ctx.permissionDetailed(name, toolInput, o)) as PermissionResult;
      const d = await ctx.permission(name, toolInput, { blockedPath: o.blockedPath });
      return d === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: denyMessage('declined', { alt: 'choose another approach or say so in the room' }) };
    };

    // Writes into the read-only knowledge repo ask (or, under bypass, are denied) before acceptEdits sees them.
    const knowledgeDir = ctx.knowledgeDir ?? null;
    const readOnlyDirs = [...(knowledgeDir ? [knowledgeDir] : []), ...(ctx.readOnlyDirs ?? [])];
    const knowledgeGuard = readOnlyDirs.length
      ? [{
          matcher: READ_ONLY_GUARD_TOOLS.join('|'),
          hooks: [
            async (hookInput: unknown) => {
              const i = hookInput as PreToolUseHookInput;
              const d = readOnlyWriteDecision(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>, readOnlyDirs, ctx.workspaceDir, !!ctx.bypassPermissions);
              if (!d) return {};
              return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: d.decision, permissionDecisionReason: d.reason } };
            },
          ],
        }]
      : [];

    // A PreToolUse deny holds in bypass mode too, where canUseTool is skipped.
    const controlGuard = ctx.controlGuard
      ? [{
          matcher: 'mcp__browser__.*|mcp__pocketrocket__desktop_.*',
          hooks: [
            async (hookInput: unknown) => {
              const i = hookInput as PreToolUseHookInput;
              const why = ctx.controlGuard!() ?? (await ctx.computerGate?.(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>)) ?? null;
              if (!why) return {};
              return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } };
            },
          ],
        }]
      : [];

    // Under bypass too: bypass skips canUseTool, never a hook. ctx.bypassPermissions is already off on strict turns.
    const gatedOutside = (ctx.outsideMcp ?? []).filter(outsideMcpHooked);
    const outsideGuard = gatedOutside.length
      ? [{
          matcher: 'mcp__(' + gatedOutside.map((s) => s.name).join('|') + ')__.*',
          hooks: [
            async (hookInput: unknown) => {
              const i = hookInput as PreToolUseHookInput;
              const s = gatedOutside.find((g) => i.tool_name.startsWith('mcp__' + g.name + '__'));
              if (!s) return {};
              const input = (i.tool_input ?? {}) as Record<string, unknown>;
              // `pass` leaves the call to bypass or, otherwise, to canUseTool's normal card.
              const step = outsideMcpStep(s, i.tool_name.slice(('mcp__' + s.name + '__').length), input, { bypass: !!ctx.bypassPermissions, readOnly: !!ctx.approvalsReadOnly });
              // Toki's own Blender starts on the first call it is needed for, and again after a crash.
              const down = step.kind !== 'refuse' && s.name === 'blender' && ctx.blenderEnsure ? await ctx.blenderEnsure() : null;
              if (down) return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: down } };
              if (step.kind === 'pass') return {};
              const why = step.kind === 'refuse' ? step.message
                : step.kind === 'allow' ? null
                : ctx.outsideMcpGate
                  ? await ctx.outsideMcpGate(i.tool_name, input)
                  : 'This outside tool needs the owner\'s approval, and none can be asked for here.';
              return {
                hookSpecificOutput: why
                  ? { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why }
                  : {
                      hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const,
                      permissionDecisionReason: step.kind === 'allow' ? 'A read tool of this server: no approval needed.' : 'Approved by the owner.',
                    },
              };
            },
          ],
        }]
      : [];

    // These hold in every mode: no bot writes the routing rules or touches the hub's key files.
    const guards = [
      {
        matcher: [...new Set([...READ_ONLY_GUARD_TOOLS, 'Read', 'Glob', 'Grep'])].join('|'),
        hooks: [
          async (hookInput: unknown) => {
            const i = hookInput as PreToolUseHookInput;
            const input = (i.tool_input ?? {}) as Record<string, unknown>;
            const cwd = i.cwd || ctx.workspaceDir;
            const why = routingFileWrite(i.tool_name, input, cwd) ?? secretFileAccess(i.tool_name, input, cwd);
            if (!why) return {};
            return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } };
          },
        ],
      },
      // Second line behind disallowedTools: a hook deny holds in bypass mode too.
      ...(browserOn
        ? [{
            matcher: BLOCKED_BROWSER_MATCHER,
            hooks: [
              async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: BLOCKED_BROWSER_REASON } }),
            ],
          }]
        : []),
      ...outsideGuard,
      ...controlGuard,
      ...knowledgeGuard,
      ...(ctx.shipGuard
        ? [{
            matcher: 'Bash',
            hooks: [
              async (hookInput: unknown) => {
                const i = hookInput as PreToolUseHookInput;
                const why = ctx.shipGuard!(String((i.tool_input as { command?: unknown } | undefined)?.command ?? ''), i.cwd || ctx.workspaceDir);
                if (!why) return {};
                return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } };
              },
            ],
          }]
        : []),
      ...(ctx.fileGuard
        ? [{
            matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
            hooks: [
              async (hookInput: unknown) => {
                const i = hookInput as PreToolUseHookInput;
                const why = ctx.fileGuard!(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>, i.cwd || ctx.workspaceDir);
                if (!why) return {};
                return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } };
              },
            ],
          }]
        : []),
      ...(ctx.ruleGuard
        ? [{
            matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit',
            hooks: [
              async (hookInput: unknown) => {
                const i = hookInput as PreToolUseHookInput;
                const why = ctx.ruleGuard!(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>);
                if (!why) return {};
                return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } };
              },
            ],
          }]
        : []),
      ...(ctx.projectGuard
        ? [{
            matcher: 'Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep|Bash',
            hooks: [
              async (hookInput: unknown) => {
                const i = hookInput as PreToolUseHookInput;
                const why = ctx.projectGuard!(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>, i.cwd || ctx.workspaceDir);
                if (!why) return {};
                return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } };
              },
            ],
          }]
        : []),
    ];

    const afterWrite = ctx.fileWritten
      ? {
          PostToolUse: [{
            matcher: 'Write|Edit|MultiEdit|NotebookEdit',
            hooks: [
              async (hookInput: unknown) => {
                const i = hookInput as PostToolUseHookInput;
                try {
                  ctx.fileWritten!(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>, i.cwd || ctx.workspaceDir);
                } catch (e) {
                  logError('[file revisions]', e);
                }
                return {};
              },
            ],
          }],
        }
      : {};

    const fallbackModel = fallbackModelFor(ctx.model);
    const options: Options = {
      pathToClaudeCodeExecutable: CLAUDE_EXE,
      spawnClaudeCodeProcess: (o) => {
        const sb = sandboxCommand(o, {
          cwd: o.cwd ?? ctx.workspaceDir,
          botHome: ctx.botHome,
          writable: [...(ctx.projectDirs ?? []), ...(ctx.computerFilesDir ? [ctx.computerFilesDir] : []), ...(ctx.sandboxWritableDirs ?? [])],
          readOnly: [...readOnlyDirs, ...(browserOn ? browserMcpRoots(PLAYWRIGHT_MCP_CLI) : [])],
          resumeToken: ctx.resumeToken,
        }, { dataDir: DATA_DIR });
        return spawn(sb?.command ?? o.command, sb?.args ?? o.args, { cwd: sb ? undefined : o.cwd, env: sb?.env ?? o.env, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as never;
      },
      cwd: ctx.workspaceDir,
      additionalDirectories: [
        ctx.botHome,
        ...(ctx.computerFilesDir ? [ctx.computerFilesDir] : []),
        ...readOnlyDirs,
        ...(ctx.projectDirs ?? []),
      ],
      resume: ctx.resumeToken ?? undefined,
      model: ctx.model,
      fallbackModel,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: ctx.systemPrompt },
      settingSources: [],
      settings: { cleanupPeriodDays: SESSION_RETENTION_DAYS, bashOutputMaxChars: BASH_MAX_OUTPUT_CHARS },
      plugins: pluginDir ? [{ type: 'local', path: pluginDir }] : undefined,
      skills: pluginDir ? 'all' : [],
      ...(ctx.bypassPermissions
        ? { permissionMode: 'bypassPermissions' as const, allowDangerouslySkipPermissions: true }
        : { permissionMode: 'acceptEdits' as const }),
      tools: [...ctx.allowedBuiltins.filter((t) => ALL_BUILTINS.includes(t)).flatMap(sdkNames), ...(pluginDir ? ['Skill'] : [])],
      allowedTools: [...allowed, 'mcp__pocketrocket__*', ...(browserOn ? ['mcp__browser__*'] : [])],
      disallowedTools: [...disallowed, ...(browserOn ? BLOCKED_BROWSER_TOOLS : [])],
      mcpServers,
      strictMcpConfig: true,
      canUseTool: (name, toolInput, o) => decide(name, toolInput, o),
      // Read/Glob/Grep never prompt, so this escalates out-of-workspace paths to "ask".
      hooks: ctx.bypassPermissions ? { PreToolUse: guards, ...afterWrite } : {
        ...afterWrite,
        PreToolUse: [
          ...guards,
          {
            matcher: 'Bash',
            hooks: [
              async (hookInput) => {
                const i = hookInput as PreToolUseHookInput;
                const hit = deleteGate(String((i.tool_input as { command?: unknown } | undefined)?.command ?? ''), i.cwd || ctx.workspaceDir);
                if (!hit) return {};
                return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: hit.reason } };
              },
            ],
          },
          {
            matcher: 'Read|Glob|Grep|NotebookEdit',
            hooks: [
              async (hookInput) => {
                const i = hookInput as PreToolUseHookInput;
                const roots = [
                  ctx.workspaceDir,
                  ctx.botHome,
                  ...(ctx.computerFilesDir ? [ctx.computerFilesDir] : []),
                  ...(ctx.projectDirs ?? []),
                  ...(i.tool_name !== 'NotebookEdit' ? readOnlyDirs : []),
                ];
                const paths = pathsFromInput(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>);
                const outside = paths.filter((p) => !isInside(p, roots, ctx.workspaceDir));
                if (process.env.POCKETROCKET_DEBUG) console.log('[hook PreToolUse]', i.tool_name, paths, outside.length ? 'ASK' : 'ok');
                if (!outside.length) return {};
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'ask',
                    permissionDecisionReason: i.tool_name + ' outside workspace: ' + outside.join(', '),
                  },
                };
              },
            ],
          },
        ],
      },
      includePartialMessages: true,
      maxTurns: ctx.maxTurns,
      maxBudgetUsd: sdkBudgetUsd(ctx.maxBudgetUsd, resumed, ctx.sessionCostUsd),
      // Allowlisted env only: the child never sees POCKETROCKET_TOKEN or another provider's API key.
      env: claudeChildEnv(),
      stderr: (d) => { if (process.env.POCKETROCKET_DEBUG) process.stderr.write('[claude ' + bot.handle + '] ' + d); },
    };

    let ok = false;
    let error: string | undefined;
    let costUsd = 0;
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let modelUsage: unknown;
    let durationMs = 0;
    let outdatedCli: string | undefined;
    let usedTools = false;
    let gotResult = false;
    let sessionCostUsd: number | undefined;
    const calls = new Map<string, { input: number; cacheRead: number; cacheWrite: number; output: number }>();
    let contextTokens: number | undefined;
    let braked = false;
    const runningCacheRead = () => [...calls.values()].reduce((n, c) => n + c.cacheRead, 0);
    let rejected: LimitReport | undefined;
    let apiError: TurnLimit | undefined;
    let lastRetry: SDKAPIRetryMessage | undefined;
    let seenModel: string | undefined;

    const q = query({ prompt: channel.messages, options });
    let stopping = false;
    let closed = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const closeQuery = () => {
      if (closed) return;
      closed = true;
      live.ending = true;
      channel.close();
      q.close();
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      live.ending = true;
      void (async () => {
        let receipt: { still_queued?: string[] } | undefined;
        try {
          receipt = await q.interrupt();
        } catch {
          /* the query already ended */
        }
        const stillQueued = (receipt?.still_queued ?? []).filter((u) => live.known.has(u));
        for (const u of stillQueued) live.consumed.delete(u);
        if (!closed && (stillQueued.length || outstanding().length)) closeTimer = setTimeout(closeQuery, STOP_RESULT_WAIT_MS);
      })();
    };
    live.stop = stop;
    live.push = (s) => {
      runSteers.add(s.uuid);
      channel.push(userMessage(s.text, s.images ?? [], s.uuid));
    };
    const onAbort = () => stop();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type === 'system' && m.subtype === 'init') {
          const capabilities = (m as { capabilities?: string[] }).capabilities;
          this.lastInit = { apiKeySource: m.apiKeySource, model: m.model, version: m.claude_code_version, tools: m.tools, skills: m.skills, capabilities };
          live.initSeen = true;
          live.steerable = !!capabilities?.includes(STEER_CAPABILITY);
          sink.onInit?.(this.lastInit);
          if (m.session_id) sink.onSession(m.session_id);
          continue;
        }
        if (m.type === 'rate_limit_event') {
          const report = limitReport(m.rate_limit_info);
          if (report.status === 'rejected') rejected = report;
          sink.onLimit?.(report);
          continue;
        }
        if (m.type === 'system' && m.subtype === 'api_retry') {
          lastRetry = m;
          if (process.env.POCKETROCKET_DEBUG) console.log('[claude ' + bot.handle + '] api_retry', m.attempt + '/' + m.max_retries, m.error_status, m.error);
          continue;
        }
        if (m.type === 'stream_event') {
          if (m.parent_tool_use_id) continue;
          consume(m.user_message_uuids);
          const ev = m.event as { type: string; delta?: { type?: string; text?: string } };
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) sink.onDelta(ev.delta.text);
          continue;
        }
        if (m.type === 'assistant') {
          if (m.parent_tool_use_id) continue;
          consume(m.user_message_uuids);
          const limitKind = m.error ? LIMIT_ERRORS[m.error] : undefined;
          if (limitKind) {
            apiError = { kind: limitKind, ...(limitKind === 'usage' && rejected ? { resetsAt: rejected.resetsAt, window: rejected.window } : {}) };
            continue;
          }
          if (!m.error) {
            rejected = undefined;
            apiError = undefined;
            lastRetry = undefined;
            if (m.message.model && m.message.model !== '<synthetic>') seenModel = m.message.model;
          }
          const mu = m.message.usage as (Parameters<typeof callInputTokens>[0] & { output_tokens?: number | null }) | undefined;
          if (mu) {
            calls.set(m.message.id ?? 'call-' + calls.size, {
              input: mu.input_tokens ?? 0, cacheRead: mu.cache_read_input_tokens ?? 0,
              cacheWrite: mu.cache_creation_input_tokens ?? 0, output: mu.output_tokens ?? 0,
            });
            contextTokens = callInputTokens(mu);
            if (!braked && ctx.cacheReadBudget !== undefined && runningCacheRead() > ctx.cacheReadBudget) {
              braked = true;
              stop();
            }
          }
          for (const block of m.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              if (isOutdatedCliError(block.text)) outdatedCli = block.text.trim();
              else sink.onText(block.text);
            } else if (block.type === 'tool_use') {
              usedTools = true;
              sink.onToolUse(block.id, block.name, block.input);
              sink.onState('working');
            }
          }
          continue;
        }
        if (m.type === 'user') {
          if (m.parent_tool_use_id) continue;
          const content = m.message.content;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const output = typeof block.content === 'string'
              ? block.content
              : (block.content ?? []).map((c) => (c.type === 'text' ? c.text : '[' + c.type + ']')).join('\n');
            sink.onToolResult(block.tool_use_id, output, !!block.is_error, firstImage(block.content));
          }
          sink.onState('thinking');
          continue;
        }
        if (m.type === 'result') {
          gotResult = true;
          consume([openerUuid]);
          const listed = (m as { user_message_uuids?: string[] }).user_message_uuids;
          consume(listed);
          sessionCostUsd = m.total_cost_usd ?? 0;
          costUsd = runCostUsd(sessionCostUsd, resumed, ctx.sessionCostUsd);
          ok = m.subtype === 'success';
          error = ok ? undefined : m.subtype + ((m as { errors?: string[] }).errors?.length ? ': ' + (m as { errors?: string[] }).errors!.join('; ') : '');
          const resultText = (m as { result?: string }).result;
          if (!outdatedCli && isOutdatedCliError(resultText)) outdatedCli = resultText!.trim();
          if (!outdatedCli && error && isOutdatedCliError(error)) outdatedCli = error;
          const u = m.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
          usage = {
            inputTokens: usage.inputTokens + (u?.input_tokens ?? 0),
            outputTokens: usage.outputTokens + (u?.output_tokens ?? 0),
            cacheReadTokens: usage.cacheReadTokens + (u?.cache_read_input_tokens ?? 0),
            cacheWriteTokens: usage.cacheWriteTokens + (u?.cache_creation_input_tokens ?? 0),
          };
          modelUsage = (m as { modelUsage?: unknown }).modelUsage;
          durationMs += m.duration_ms ?? 0;
          if (stopping || !ok || !listed || outdatedCli || !outstanding().length) {
            live.ending = true;
            break;
          }
          continue;
        }
      }
    } catch (e) {
      if (!closed) {
        error = error ?? String((e as Error).message ?? e);
        if (!outdatedCli && isOutdatedCliError(error)) outdatedCli = error;
      }
    } finally {
      live.ending = true;
      live.push = undefined;
      live.stop = undefined;
      if (closeTimer) clearTimeout(closeTimer);
      ctx.signal.removeEventListener('abort', onAbort);
      if (stopping || outstanding().length) closeQuery();
      else channel.close();
    }
    if (outdatedCli) {
      ok = false;
      error = outdatedCli;
    }
    if (!gotResult && calls.size) {
      const sum = (k: 'input' | 'cacheRead' | 'cacheWrite' | 'output') => [...calls.values()].reduce((n, c) => n + c[k], 0);
      usage = { inputTokens: sum('input'), outputTokens: sum('output'), cacheReadTokens: sum('cacheRead'), cacheWriteTokens: sum('cacheWrite') };
    }
    if (braked) {
      ok = false;
      error = tokenBrakeError(runningCacheRead(), ctx.cacheReadBudget!);
    }
    let limit: TurnLimit | undefined;
    if (!stopping && !ctx.signal.aborted && !outdatedCli) {
      if (apiError?.kind === 'usage' || (!apiError && rejected)) {
        const resetsAt = apiError?.resetsAt ?? rejected?.resetsAt;
        const window = apiError?.window ?? rejected?.window;
        limit = { kind: 'usage', ...(resetsAt !== undefined ? { resetsAt } : {}), ...(window ? { window } : {}) };
      } else if (apiError) {
        limit = apiError;
      } else if (!ok && lastRetry) {
        const kind = retryLimitKind(lastRetry);
        if (kind) limit = { kind };
      }
    }
    if (limit) {
      ok = false;
      error = limitError(limit);
    }
    const model = ranModel(ctx.model, fallbackModel, seenModel);
    const contextWindow = contextWindowOf(modelUsage, seenModel);

    const outcome: TurnOutcome = {
      ok, error, costUsd,
      usage: { costUsd, ...usage, modelUsage, durationMs: durationMs || Date.now() - started },
      durationMs: durationMs || Date.now() - started,
      sessionCostUsd, contextTokens, braked: braked || undefined,
      ...(contextWindow ? { contextWindow } : {}),
      ...(limit ? { limit } : {}),
      ...(model ? { model } : {}),
    };
    return { outcome, outdatedCli: !!outdatedCli, usedTools };
  }
}
