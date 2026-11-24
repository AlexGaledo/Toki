export const MAX_ROOM_BOTS = 20;

import type { Approvals, ProviderId } from './providers.js';
import type { TriggerPayload } from './triggers.js';
import type { MessageVerification } from './protocol.js';

export type BotState = 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done' | 'error';

// 'Browser' and 'Desktop' are not Claude Code built-ins: Playwright MCP on the shared Chromium, and computer use on
// the virtual desktop.
export const BUILTIN_TOOLS = [
  'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'Browser', 'Desktop', 'NotebookEdit', 'Skill', 'Task',
] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

export interface User {
  id: string;
  displayName: string;
  role: 'owner' | 'admin' | 'member';
  previousNames: string[];
  createdAt: number;
}

/** Never carries the token or its hash. */
export interface UserSessionInfo {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  current: boolean;
}

/** Labels and ids only, never request bodies. */
export interface AuditEntry {
  id: number;
  at: number;
  actorKind: 'session' | 'hub-token' | 'device' | 'bot' | 'anonymous';
  actorId: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
}

export const MODELS = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5 (default)' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
] as const;
export const DEFAULT_MODEL = 'claude-sonnet-5';

export const BOT_ICON_KEYS = [
  'bot', 'cpu', 'compass', 'wrench', 'pen', 'smile', 'brain', 'shield', 'radar', 'anchor', 'atom', 'feather', 'hammer', 'map', 'orbit', 'hexagon',
  'search', 'terminal', 'globe', 'sparkles', 'palette', 'rocket', 'database',
  'blob-ember', 'blob-bloom', 'blob-cloud', 'blob-pebble', 'blob-clover', 'blob-star', 'blob-bean', 'blob-drop', 'blob-gem', 'blob-spike',
] as const;
export type BotIconKey = (typeof BOT_ICON_KEYS)[number];
export const isBotIconKey = (v: unknown): v is BotIconKey => (BOT_ICON_KEYS as readonly unknown[]).includes(v);
export type BotCharacterKey = Extract<BotIconKey, `blob-${string}`>;
export const isBotCharacterKey = (v: unknown): v is BotCharacterKey => isBotIconKey(v) && v.startsWith('blob-');
export interface BotPreview { text: string; at: number }
export interface SearchHit { id: string; roomId: string; roomName: string; seq: number; snippet: string; createdAt: number }
export const MAX_PODIUM_BOTS = 3;

export const MAX_AVATAR_LENGTH = 68;
export const isMediaRef = (v: unknown): v is string => typeof v === 'string' && /^img:[0-9a-f]{64}$/.test(v);
export const mediaHash = (ref: string): string => ref.slice('img:'.length);
export const isFileRef = (v: unknown): v is string => typeof v === 'string' && /^file:[0-9a-f]{64}$/.test(v);
export const fileHash = (ref: string): string => ref.slice('file:'.length);
export interface SlashCommandInfo {
  name: string;
  description: string;
  source: 'claude' | 'skill' | 'toki';
  argumentHint?: string;
}

/** Sent on its own, one of these reaches a Claude bot as the raw command and the CLI runs it on that bot's session. */
export const CLAUDE_SLASH_COMMANDS: readonly SlashCommandInfo[] = [
  { name: 'compact', description: 'Summarize this conversation to free up context', source: 'claude', argumentHint: '[what to keep]' },
  { name: 'context', description: 'Show how full the context window is', source: 'claude' },
  { name: 'cost', description: 'Show what this session has cost so far', source: 'claude' },
  { name: 'init', description: 'Write a CLAUDE.md for the project folder', source: 'claude' },
  { name: 'review', description: 'Review a pull request', source: 'claude', argumentHint: '[PR number]' },
  { name: 'security-review', description: 'Security review of the pending changes', source: 'claude' },
  { name: 'pr-comments', description: 'Fetch the comments on a pull request', source: 'claude', argumentHint: '[PR number]' },
  { name: 'release-notes', description: 'Show the Claude Code release notes', source: 'claude' },
  { name: 'todos', description: 'List the current to-do items', source: 'claude' },
];

export const TOKI_SLASH_COMMANDS: readonly SlashCommandInfo[] = [
  { name: 'clear', description: 'Start a fresh conversation for the bots in this room (the chat history stays)', source: 'toki' },
];

export function slashCommandOf(text: string): string | null {
  const m = /^\/([a-z][a-z0-9:_-]{0,63})(?=\s|$)/i.exec(text.trim());
  return m ? m[1].toLowerCase() : null;
}

export const isAttachmentRef = (v: unknown): v is string => isMediaRef(v) || isFileRef(v);

export interface Bot {
  id: string;
  name: string;
  handle: string;
  title: string;
  description: string;
  avatar: string;
  model: string;
  allowedTools: string[];
  maxBudgetUsd: number;
  autoMemory: boolean;
  autoMemoryEvery: number;
  createdAt: number;
  /** Null follows settings.provider. Absent from hubs older than v0.5: treat as null. */
  provider?: ProviderId | null;
  backup?: BotBackup | null;
}
export interface BotBackup {
  provider: ProviderId;
  model: string;
}
export const AUTO_MEMORY_EVERY = { default: 10, min: 3, max: 100 } as const;

export type RoomKind = 'dm' | 'group';
export interface Room {
  id: string;
  kind: RoomKind;
  name: string;
  memberIds: string[];
  coordinatorBotId: string | null;
  /** The coordinator runs the room: only it hears the owner and wakes others; workers see only what is addressed to them. */
  leadMode?: boolean;
  createdAt: number;
  avatar?: string;
  chatModel?: string | null;
}

export type AuthorType = 'user' | 'bot' | 'system';
export type MessageKind = 'text' | 'tool' | 'approval' | 'handoff' | 'routine' | 'system' | 'trigger' | 'takeover' | 'form';

export interface ToolPayload {
  toolUseId: string;
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
  done: boolean;
}
export interface ApprovalPayload {
  approvalId: string;
  toolName: string;
  toolInput: unknown;
  reason: string;
  danger: boolean;
  status: 'pending' | 'allow' | 'always' | 'deny' | 'timeout' | 'expired';
  parked?: boolean;
  /** "always" is never remembered, so the card does not offer it. */
  once?: boolean;
  /** Only a browser signed in with the owner's password may allow it (a job on the PC); the hub token may only deny. */
  signInRequired?: boolean;
}
export interface HandoffPayload {
  fromBotId: string;
  toBotId: string;
  task: string;
  context?: string;
  workRoomId?: string;
}
export interface HandoffResultPayload {
  workRoomId: string;
}
export interface RoutinePayload {
  routineId: string;
  runId: string;
  name: string;
  manual?: boolean;
}
export interface WorkflowPayload {
  workflowId: string;
  runId: string;
  name: string;
  nodeId?: string;
  manual?: boolean;
}

/** One field of a `request_form` card. Only these three kinds exist: there is no password or secret field. */
export type FormField =
  | { id: string; kind: 'text'; label: string; help?: string; required: boolean; maxLength: number }
  | { id: string; kind: 'choice'; label: string; help?: string; required: boolean; choices: string[] }
  | { id: string; kind: 'yesno'; label: string; help?: string; required: boolean };
export type FormAnswer = string | boolean;
export interface FormPayload {
  botId: string;
  title: string;
  description?: string;
  fields: FormField[];
  status: 'pending' | 'submitted' | 'cancelled' | 'timeout' | 'expired';
  answers?: Record<string, FormAnswer>;
}
/** A button a bot attached to a message. Exactly one of `say` (sends that text as the owner's own message) or `href`. */
export interface CtaButton { label: string; say?: string; href?: string }
export interface CtaPayload { cta: CtaButton[] }
export interface VerificationPayload { verification: MessageVerification }

export const SEND_MODES = ['join', 'queue'] as const;
export type SendMode = (typeof SEND_MODES)[number];
export type QueueReason = 'shortcut' | 'setting' | 'provider' | 'between-runs' | 'requeued' | 'paused';
export interface DeliveryPayload {
  steered?: Record<string, string>;
  queued?: Record<string, { reason: QueueReason }>;
}

export interface Message {
  id: string;
  roomId: string;
  seq: number;
  authorType: AuthorType;
  authorId: string | null;
  kind: MessageKind;
  text: string;
  payload: ToolPayload | ApprovalPayload | HandoffPayload | HandoffResultPayload | RoutinePayload | WorkflowPayload | TriggerPayload | TakeoverPayload | TurnFailurePayload | FormPayload | CtaPayload | DeliveryPayload | VerificationPayload | null;
  causeId: string | null;
  hop: number;
  turnId: string | null;
  createdAt: number;
  model?: string;
  modelReason?: string;
  attachments?: string[];
  clientMsgId?: string;
  cancelledAt?: number;
  editedAt?: number;
}

export type QueueItemKind = 'message' | 'handoff' | 'routine' | 'trigger' | 'followup';
export interface QueueItem {
  journalId: string;
  messageId: string | null;
  kind: QueueItemKind;
  authorType: AuthorType | null;
  authorId: string | null;
  preview: string;
  reason: QueueReason | null;
  position: number;
  editable: boolean;
  editRefusal?: string;
  cancellable: boolean;
}
export interface LaneQueue {
  botId: string;
  roomId: string;
  paused: boolean;
  running: boolean;
  items: QueueItem[];
}
export const QUEUE_PREVIEW_CHARS = 280;

export interface Routine {
  id: string;
  botId: string;
  roomId: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  onceAt: number | null;
}
export interface RoutineRun {
  id: string;
  routineId: string;
  startedAt: number;
  endedAt: number | null;
  status: 'running' | 'success' | 'error';
  messageId: string | null;
  costUsd: number | null;
}

export type SkillSource = 'imported' | 'authored' | 'bot';
export interface Skill {
  id: string;
  name: string;
  description: string;
  path: string;
  source: SkillSource;
  reviewStatus: 'approved' | 'pending';
  createdByBot: string | null;
  version?: number;
  parentId?: string | null;
  pendingVersions?: number;
}

export interface UsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
}

export interface UsageRow extends UsageTotals {
  botId: string;
  roomId: string;
}

export interface HealthInfo {
  ok: boolean;
  apiKeySource?: string;
  // No account email, plan or CLI path here: GET /api/health answers without the hub token, and a home-directory
  // path spells out the machine's user name.
  error?: string;
  approvals: Approvals;
  approvalsLocked: boolean;
}

export interface BusyInfo {
  blocking: number;
  running: number;
  liveCards: number;
  pendingLanes: number;
  parkedCards: number;
  waitingRuns: number;
  heldUntil: number | null;
}

export const AUTO_MODEL = 'auto';
export const AUTO_MODEL_INFO = { id: AUTO_MODEL, label: 'Auto', note: 'Sonnet, moves up when needed' } as const;

export const HEAVY_MODEL_HINT = 'uses your plan limit much faster';
export const isHeavyModel = (id: string): boolean => /opus|fable/i.test(id);
export function modelOptionLabel(m: { id: string; label: string; note?: string }): string {
  const hint = isHeavyModel(m.id) && !/plan limit/i.test(m.note ?? '') ? HEAVY_MODEL_HINT : '';
  const extra = [m.note, hint].filter(Boolean).join(', ');
  return m.label + (extra ? ' — ' + extra : '');
}

export const CHAT_MODELS = [
  { id: AUTO_MODEL, label: 'Auto', note: 'Sonnet 5, moves up when needed' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'Everyday work' },
  { id: 'claude-opus-5', label: 'Opus 5', note: 'Hard problems, ' + HEAVY_MODEL_HINT },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku', note: 'Quick checks' },
] as const;
export const isChatModel = (v: unknown): boolean => CHAT_MODELS.some((m) => m.id === v);

export const MAX_ROUTING_BYTES = 2048;

export const CAUSE_KINDS = ['user', 'bot', 'routine', 'trigger', 'workflow', 'memory', 'reflection', 'training'] as const;
export type CauseKind = (typeof CAUSE_KINDS)[number];

export interface UsageGroup extends UsageTotals {
  key: string;
}
export interface UsageResponse {
  totals: UsageTotals;
  rows: UsageRow[];
  byModel?: UsageGroup[];
  byCause?: UsageGroup[];
  byProvider?: UsageGroup[];
}

export interface KnowledgeStatus {
  source: string;
  mode: 'off' | 'clone' | 'link';
  dir: string | null;
  syncing: boolean;
  lastSyncedAt: number | null;
  head: string | null;
  lastError: string | null;
}

export interface VoiceProposal {
  id: string;
  botId: string;
  text: string;
  createdAt: number;
}

export interface SkillGitImportResult {
  imported: Skill[];
  skipped: { name: string; reason: string }[];
}

// Per-bot computers run as the same OS user: separation, not isolation. Never present it as isolation.

export interface OpenApproval {
  approvalId: string;
  botId: string;
  roomId: string;
}

export type ComputerState = 'asleep' | 'starting' | 'live';
export interface ComputerStatus {
  botId: string;
  perBot: boolean;
  state: ComputerState;
  slot: number | null;
  keepAwake: boolean;
  alwaysOn?: { used: number; limit: number };
  diskBytes: number;
  quotaBytes: number;
  lastUsedAt: number | null;
  reason?: string;
}

export const COMPUTER_CONTROLS = ['agent', 'user', 'paused'] as const;
export type ComputerControl = (typeof COMPUTER_CONTROLS)[number];

export interface ControlStatus {
  botId: string;
  control: ComputerControl;
  holder: string | null;
  since: number;
  takeover: { messageId: string; roomId: string; reason: string; parked: boolean } | null;
}

export const TURN_FAILURE_BEHAVIOUR = 'behaviour';
export interface TurnFailurePayload {
  turnFailure: typeof TURN_FAILURE_BEHAVIOUR | 'external';
  setBackup?: boolean;
}

export interface TakeoverPayload {
  botId: string;
  reason: string;
  status: 'waiting' | 'parked' | 'done' | 'expired';
  note?: string;
  ownerRef?: string | null;
  runId?: string | null;
}

/**
 * `pattern` matches the call's subject (a command, path or URL): `*` matches anything, a trailing `*` is a prefix
 * match, anything else must match exactly.
 */
export interface ApprovalPolicy {
  id: string;
  botId: string;
  tool: string;
  pattern: string;
  decision: 'allow' | 'deny';
  createdAt: number;
  machine?: string | null;
  expiresAt?: number | null;
  /** A rule with a message is checked before bypass and before the shell allowlist. */
  message?: string | null;
}

export interface SandboxStatus {
  available: boolean;
  active: boolean;
  reason: string;
}
