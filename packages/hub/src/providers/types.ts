import type { z } from 'zod';
import type { Bot, ModelInfo, ProviderCheck, ProviderId, ProviderLimitKind, ProviderStaticInfo, Room } from '@pocketrocket/shared';
import type { TurnUsage } from '../services/UsageTracker.js';
import type { OutsideMcpServer } from '../services/outsideMcp.js';

export interface HubTool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (input: Record<string, unknown>) => Promise<ToolOutput>;
  readOnly?: boolean;
}

export interface ToolOutput {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

export interface TurnImage {
  path: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Never logged. */
  data?: Buffer;
}

export interface TurnContext {
  turnId: string;
  bot: Bot;
  room: Room;
  members: Bot[];
  systemPrompt: string;
  input: string;
  images?: TurnImage[];
  resumeToken: string | null;
  workspaceDir: string;
  botHome: string;
  tools: HubTool[];
  allowedBuiltins: string[];
  /**
   * Approvals bypassed (read per turn): run with no permission checks at all — the adapter should put its
   * CLI / SDK in its own "skip permissions" mode (bypassPermissions, danger-full-access, no sandbox,
   * allow-all config) rather than routing asks through `permission`, which would allow them anyway.
   */
  bypassPermissions?: boolean;
  /** Strict turn (routine, trigger, workflow step): approvals apply even under bypass. */
  strictApprovals?: boolean;
  /** The hub's read-only approval mode, read per turn. */
  approvalsReadOnly?: boolean;
  permission: (
    toolName: string,
    input: Record<string, unknown>,
    extra?: { blockedPath?: string; reason?: string; danger?: boolean },
  ) => Promise<'allow' | 'deny'>;
  permissionDetailed?: (
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: unknown; blockedPath?: string },
  ) => Promise<unknown>;
  pluginDir?: string | null;
  model: string;
  maxBudgetUsd: number;
  sessionCostUsd?: number | null;
  cacheReadBudget?: number;
  maxTurns: number;
  signal: AbortSignal;
  mcp: { url: string; token: string };
  /** Readable but never writable by the bot. */
  knowledgeDir?: string | null;
  readOnlyDirs?: string[];
  projectDirs?: string[];
  /** Why this tool call may not touch a project folder, or null. Holds with approvals bypassed. */
  projectGuard?: (toolName: string, input: Record<string, unknown>, cwd: string) => string | null;
  /** Why this shell command may not ship, or null. Holds with approvals bypassed. */
  shipGuard?: (command: string, cwd: string) => string | null;
  /** Why this write may not touch a shared file, or null. Holds with approvals bypassed. */
  fileGuard?: (toolName: string, input: Record<string, unknown>, cwd: string) => string | null;
  /** Why an owner-approved rule forbids this call, or null. Holds with approvals bypassed. */
  ruleGuard?: (toolName: string, input: Record<string, unknown>) => string | null;
  fileWritten?: (toolName: string, input: Record<string, unknown>, cwd: string) => void;
  cdpUrl?: string;
  /** Never pre-approved. */
  outsideMcp?: OutsideMcpServer[];
  /** Raises the owner's card, under bypass too. A string refuses the call. */
  outsideMcpGate?: (toolName: string, input: Record<string, unknown>) => Promise<string | null>;
  /** Game rooms: starts (or reuses) the hub's headless Blender before a `blender` tool runs. A string refuses the call. */
  blenderEnsure?: () => Promise<string | null>;
  computerFilesDir?: string;
  sandboxWritableDirs?: string[];
  /** Adapters must enforce it in bypass mode too; it is not an approval. */
  controlGuard?: () => string | null;
  computerGate?: (toolName: string, input?: Record<string, unknown>) => Promise<string | null>;
  carriedSteers?: SteerInput[];
}

export interface TurnSink {
  onSession(token: string): void;
  onDelta(text: string): void;
  onText(text: string): void;
  onToolUse(id: string, name: string, input: unknown): void;
  onToolResult(id: string, output: string, isError: boolean): void;
  onState(s: 'thinking' | 'working'): void;
  onInit?(info: ProviderInit): void;
  onLimit?(report: LimitReport): void;
  onNote?(text: string): void;
}

export interface LimitReport {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  kind: ProviderLimitKind;
  window?: string;
  resetsAt?: number;
  utilization?: number;
}

export interface TurnLimit {
  kind: ProviderLimitKind;
  resetsAt?: number;
  window?: string;
}

export interface ProviderInit {
  apiKeySource?: string;
  model?: string;
  version?: string;
  tools?: string[];
  skills?: string[];
  capabilities?: string[];
}

export interface SteerInput {
  uuid: string;
  text: string;
  images?: TurnImage[];
}

export type SteerResult = { status: 'accepted' } | { status: 'queued'; reason: 'provider' | 'between-runs' };

export interface TurnOutcome {
  ok: boolean;
  error?: string;
  costUsd: number;
  usage: TurnUsage;
  durationMs: number;
  sessionCostUsd?: number;
  contextTokens?: number;
  contextWindow?: number;
  braked?: boolean;
  steers?: { consumed: string[]; pending: string[] };
  /** The provider's own limit text is never posted as the bot's reply. */
  limit?: TurnLimit;
  model?: string;
  accounted?: boolean;
}

export interface AgentProvider {
  id: ProviderId;
  label: string;
  info: ProviderStaticInfo;
  readonly reportsContextTokens?: boolean;
  models(): Promise<ModelInfo[]>;
  modelsSync(): ModelInfo[];
  modelsAwaited?(): Promise<ModelInfo[]>;
  check(): Promise<ProviderCheck>;
  runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome>;
  interrupt(turnId: string): boolean;
  steer?(turnId: string, input: SteerInput): SteerResult;
  canSteer?(): boolean;
  shutdown?(): Promise<void>;
}

export function steerTurn(provider: AgentProvider, turnId: string, input: SteerInput): SteerResult {
  return provider.steer ? provider.steer(turnId, input) : { status: 'queued', reason: 'provider' };
}

export const EMPTY_USAGE: TurnUsage = {
  costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, modelUsage: undefined, durationMs: 0,
};
