import { z } from 'zod';
import { AUTO_MEMORY_EVERY, MAX_AVATAR_LENGTH, MAX_ROOM_BOTS, SEND_MODES, MAX_ROUTING_BYTES, isBotIconKey, isChatModel, isMediaRef, type Bot, type BotState, type Message, type Room, type UsageTotals, type ApprovalPayload, type OpenApproval, type LaneQueue } from './models.js';
import type { KnowledgeStatus } from './models.js';
import { PROVIDER_IDS, type Settings, type ProviderId, type ProviderLimitState, type FailoverState } from './providers.js';
import type { AccountState } from './account.js';
import type { ComputerStatus } from './models.js';
import type { TriggerFireStatus } from './triggers.js';
import { COMPUTER_CONTROLS, type ApprovalPolicy, type ControlStatus } from './models.js';
import type { RecorderStatus } from './teach.js';
import type { Task } from './tasks.js';
import { FormAnswersSchema } from './cards.js';
import type { PcSessionUpdatedEvent } from './pcSessions.js';
import type { WorkflowApprovalCard, WorkflowRunSummary } from './workflows.js';

export interface ContextUsage { contextTokens: number; window: number; rotateAt: number | null }

export const MessageVerificationSchema = z.object({
  state: z.literal('unverified'),
  reason: z.string().max(200),
});
export type MessageVerification = z.infer<typeof MessageVerificationSchema>;

export type ServerEvent =
  | { type: 'hello'; bots: Bot[]; rooms: Room[]; botStates: Record<string, BotState>; settings: Settings; principal?: 'hub' | 'device'; signedIn?: boolean; openApprovals?: OpenApproval[] }
  | { type: 'settings.changed'; settings: Settings }
  | { type: 'providers.changed'; active: ProviderId }
  | { type: 'provider.limit'; limits: ProviderLimitState[] }
  | { type: 'failover.changed'; cards: FailoverState['cards']; active: FailoverState['active'] }
  | { type: 'bots.changed'; bots: Bot[] }
  | { type: 'rooms.changed'; rooms: Room[] }
  /** Carries nothing: paired phones get every event, and /api/projects is closed to them. */
  | { type: 'projects.changed' }
  | { type: 'message.new'; message: Message }
  | { type: 'message.update'; id: string; roomId: string; patch: Partial<Message> }
  | { type: 'turn.start'; turnId: string; botId: string; roomId: string; causeId: string; hop: number }
  | { type: 'turn.delta'; turnId: string; roomId: string; botId: string; text: string }
  | { type: 'turn.end'; turnId: string; roomId: string; botId: string; messageId?: string; costUsd?: number; error?: string; stoppedBy?: 'owner'; context?: ContextUsage }
  | { type: 'bot.state'; botId: string; state: BotState; roomId?: string; note?: string }
  | { type: 'approval.request'; roomId: string; botId: string; messageId: string; approval: ApprovalPayload }
  | { type: 'approval.resolved'; approvalId: string; decision: ApprovalPayload['status'] }
  | { type: 'memory.updated'; botId: string; text: string }
  | { type: 'routine.fired'; routineId: string; runId: string; botId: string; roomId: string }
  | { type: 'usage.updated'; botId: string; roomId: string; totals: UsageTotals }
  | { type: 'account.changed'; account: AccountState }
  | { type: 'error'; message: string; context?: string }
  | { type: 'ping'; t: number }
  | { type: 'routines.changed' }
  | { type: 'workflows.changed' }
  /** Carries no step output: paired phones get every event. */
  | { type: 'workflow.run'; run: WorkflowRunSummary }
  | { type: 'workflow.cards'; cards: WorkflowApprovalCard[] }
  | { type: 'knowledge.status'; status: KnowledgeStatus }
  | { type: 'voice.updated'; botId: string }
  | { type: 'computer.state'; status: ComputerStatus }
  | { type: 'integrations.changed' }
  | { type: 'triggers.changed' }
  | { type: 'trigger.fired'; triggerId: string; fireId: string; status: TriggerFireStatus }
  | { type: 'computer.control'; status: ControlStatus }
  | { type: 'policies.changed'; policies: ApprovalPolicy[] }
  | { type: 'recorder.state'; status: RecorderStatus }
  | { type: 'skills.changed'; skillId?: string }
  | { type: 'training.changed'; botId: string }
  | { type: 'files.changed'; roomId: string; path: string }
  /** Carries no job content: paired phones get every event. */
  | { type: 'pc-runner.changed'; jobId?: string }
  | { type: 'task.changed'; roomId: string; task: Task }
  | { type: 'queue.changed'; queue: LaneQueue }
  | PcSessionUpdatedEvent;

export const WS_PING_MS = 20_000;

export const MAX_QUEUE_EDIT_CHARS = 32_000;

export const ClientEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message.send'),
    roomId: z.string(),
    text: z.string(),
    attachments: z.array(z.string().max(80)).max(32).optional(),
    /** The hub posts one message per (room, id), so a client may replay its outbox after a reconnect. */
    clientMsgId: z.string().min(1).max(64).optional(),
    mode: z.enum(SEND_MODES).optional(),
  }).refine((e) => e.text.trim().length > 0 || (e.attachments?.length ?? 0) > 0, { message: 'Message is empty', path: ['text'] }),
  z.object({ type: z.literal('pong') }),
  z.object({
    type: z.literal('approval.decide'),
    approvalId: z.string(),
    decision: z.enum(['allow', 'always', 'deny']),
  }),
  z.object({ type: z.literal('form.submit'), formId: z.string().max(64), answers: FormAnswersSchema }),
  z.object({ type: z.literal('form.cancel'), formId: z.string().max(64) }),
  z.object({ type: z.literal('turn.interrupt'), turnId: z.string() }),
  z.object({ type: z.literal('queue.cancel'), journalId: z.string().max(64) }),
  z.object({ type: z.literal('queue.edit'), journalId: z.string().max(64), text: z.string().trim().min(1).max(MAX_QUEUE_EDIT_CHARS) }),
  z.object({ type: z.literal('queue.sendNow'), roomId: z.string().max(64), botId: z.string().max(64) }),
  z.object({ type: z.literal('queue.pause'), roomId: z.string().max(64), botId: z.string().max(64).optional(), paused: z.boolean() }),
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

const AvatarSchema = z.string().max(MAX_AVATAR_LENGTH).transform((v): string => (isBotIconKey(v) || isMediaRef(v) ? v : ''));

export const MAX_MEDIA_BYTES = 512 * 1024;
export const MediaUploadSchema = z.object({
  data: z.string().max(Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'not base64'),
});

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** The Claude API refuses an image over about 5 MB after base64 (which adds a third), so the raw cap sits below it. */
export const MAX_ATTACHMENT_IMAGE_BYTES = 3.5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export interface StoredFileMeta {
  ref: string;
  name: string;
  type: string;
  size: number;
  kind: 'file' | 'video';
}
export const AttachmentUploadSchema = z.object({
  data: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'not base64'),
});

export const MAX_BOT_DESCRIPTION_CHARS = 4000;

export const BotInputSchema = z.object({
  name: z.string().min(1).max(40),
  handle: z.string().regex(/^[a-z0-9_-]{2,24}$/),
  title: z.string().max(80).default(''),
  description: z.string().max(MAX_BOT_DESCRIPTION_CHARS).default(''),
  avatar: AvatarSchema.default(''),
  model: z.string().default('claude-sonnet-5'),
  allowedTools: z.array(z.string()).default(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch']),
  maxBudgetUsd: z.number().min(0.05).max(50).default(50),
  autoMemory: z.boolean().optional(),
  autoMemoryEvery: z.number().int().min(AUTO_MEMORY_EVERY.min).max(AUTO_MEMORY_EVERY.max).optional(),
  provider: z.enum(PROVIDER_IDS).nullable().optional(),
  backup: z.object({ provider: z.enum(PROVIDER_IDS), model: z.string().min(1).max(80) }).nullable().optional(),
});
export type BotInput = z.infer<typeof BotInputSchema>;

export const RoomInputSchema = z.object({
  kind: z.enum(['dm', 'group']),
  name: z.string().min(1).max(60),
  memberIds: z.array(z.string()).min(1).max(MAX_ROOM_BOTS),
  coordinatorBotId: z.string().nullable().default(null),
  avatar: AvatarSchema.optional(),
});
export type RoomInput = z.infer<typeof RoomInputSchema>;

export const RoomModelInputSchema = z.object({
  model: z.string().refine(isChatModel, 'Not a model the picker offers').nullable(),
});

export const RoutingInputSchema = z.object({ text: z.string().max(MAX_ROUTING_BYTES) });

export const RoutineInputSchema = z.object({
  botId: z.string(),
  roomId: z.string(),
  name: z.string().min(1).max(60),
  cron: z.string().max(200).default(''),
  prompt: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Epoch ms, or a local `YYYY-MM-DDTHH:mm[:ss]` read in `settings.timezone`. Fires once, then disables itself. */
  onceAt: z.union([z.number().int().positive(), z.string().min(10).max(40)]).nullable().optional(),
});
export type RoutineInput = z.infer<typeof RoutineInputSchema>;

export const ControlInputSchema = z.object({
  control: z.enum(COMPUTER_CONTROLS),
  holder: z.string().max(64).optional(),
  note: z.string().max(2000).optional(),
});
export type ControlInput = z.infer<typeof ControlInputSchema>;

export const ApprovalPolicyInputSchema = z.object({
  approvalId: z.string().max(40).optional(),
  botId: z.string().max(64).optional(),
  tool: z.string().min(1).max(120).optional(),
  pattern: z.string().min(1).max(500).optional(),
  decision: z.enum(['allow', 'deny']).default('allow'),
  machine: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).nullable().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
});
export type ApprovalPolicyInput = z.infer<typeof ApprovalPolicyInputSchema>;

export const MAX_MAINTENANCE_HOLD_MINUTES = 30;
export const MaintenanceHoldInputSchema = z.object({
  minutes: z.number().int().min(1).max(MAX_MAINTENANCE_HOLD_MINUTES).default(10),
});
export type MaintenanceHoldInput = z.infer<typeof MaintenanceHoldInputSchema>;

export const RoomMessageInputSchema = z.object({
  text: z.string().min(1),
  mode: z.enum(SEND_MODES).optional(),
});
export type RoomMessageInput = z.infer<typeof RoomMessageInputSchema>;

export const QueueCancelInputSchema = z.object({ journalId: z.string().max(64) });
export const QueueEditInputSchema = z.object({ journalId: z.string().max(64), text: z.string().trim().min(1).max(MAX_QUEUE_EDIT_CHARS) });
export const QueueSendNowInputSchema = z.object({ botId: z.string().max(64) });
export const QueuePauseInputSchema = z.object({ botId: z.string().max(64).optional(), paused: z.boolean() });
