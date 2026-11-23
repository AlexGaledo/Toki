import { z } from 'zod';
import type { IntegrationProvider } from './integrations.js';

export const TRIGGER_SOURCES = [
  'github.notifications', 'github.repo', 'gmail', 'calendar', 'drive', 'slack', 'clickup', 'teams',
] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

export const TRIGGER_SOURCE_PROVIDER: Record<TriggerSource, IntegrationProvider> = {
  'github.notifications': 'github', 'github.repo': 'github', gmail: 'google', calendar: 'google', drive: 'google',
  slack: 'slack', clickup: 'clickup', teams: 'teams',
};

export const TRIGGER_SOURCE_LABEL: Record<TriggerSource, string> = {
  'github.notifications': 'GitHub notifications', 'github.repo': 'GitHub repository events', gmail: 'Gmail',
  calendar: 'Google Calendar', drive: 'Google Drive', slack: 'Slack', clickup: 'ClickUp', teams: 'Microsoft Teams',
};

export const TRIGGER_FILTERS: Record<TriggerSource, ReadonlyArray<{ key: string; label: string; placeholder: string; required?: boolean }>> = {
  'github.notifications': [
    { key: 'repo', label: 'Repository', placeholder: 'owner/name' },
    { key: 'reason', label: 'Reason', placeholder: 'review_requested, mention' },
    { key: 'type', label: 'Type', placeholder: 'PullRequest, Issue' },
    { key: 'title', label: 'Title contains', placeholder: 'release' },
  ],
  'github.repo': [
    { key: 'repo', label: 'Repository', placeholder: 'owner/name', required: true },
    { key: 'type', label: 'Event', placeholder: 'IssuesEvent, PullRequestEvent' },
    { key: 'action', label: 'Action', placeholder: 'opened, labeled' },
    { key: 'labels', label: 'Label', placeholder: 'bug' },
    { key: 'from', label: 'Actor', placeholder: 'octocat' },
  ],
  gmail: [
    { key: 'from', label: 'From', placeholder: 'boss@example.com' },
    { key: 'subject', label: 'Subject contains', placeholder: 'invoice' },
    { key: 'labels', label: 'Label', placeholder: 'INBOX, IMPORTANT' },
  ],
  calendar: [
    { key: 'calendar', label: 'Calendar', placeholder: 'primary' },
    { key: 'title', label: 'Title contains', placeholder: 'interview' },
    { key: 'status', label: 'Status', placeholder: 'confirmed, cancelled' },
  ],
  drive: [
    { key: 'title', label: 'File name contains', placeholder: 'report' },
    { key: 'removed', label: 'Removed', placeholder: 'true' },
  ],
  slack: [
    { key: 'channel', label: 'Channel id', placeholder: 'C0123ABCD' },
    { key: 'from', label: 'User id', placeholder: 'U0123ABCD' },
    { key: 'text', label: 'Text contains', placeholder: 'deploy' },
    { key: 'type', label: 'Event', placeholder: 'message, app_mention' },
  ],
  clickup: [
    { key: 'workspace', label: 'Workspace id', placeholder: 'first workspace' },
    { key: 'list', label: 'List', placeholder: 'Sprint 12' },
    { key: 'status', label: 'Status', placeholder: 'in review' },
    { key: 'assignees', label: 'Assignee', placeholder: 'alex' },
  ],
  teams: [
    { key: 'chat', label: 'Chat topic', placeholder: 'Design' },
    { key: 'from', label: 'From', placeholder: 'Jordan' },
    { key: 'text', label: 'Text contains', placeholder: 'urgent' },
  ],
};

/** All third-party text: never instructions. */
export interface TriggerEvent {
  source: TriggerSource;
  id: string;
  title: string;
  text: string;
  from: string;
  url: string;
  at: string;
  fields: Record<string, string>;
}

export interface Trigger {
  id: string;
  name: string;
  enabled: boolean;
  source: TriggerSource;
  filter: Record<string, string>;
  botId: string;
  roomId: string;
  prompt: string;
  maxPerHour: number;
  budgetUsd: number;
  createdAt: number;
  updatedAt: number;
  lastFiredAt: number | null;
}

export type TriggerFireStatus = 'running' | 'success' | 'error' | 'skipped';
export interface TriggerFire {
  id: string;
  triggerId: string;
  eventId: string | null;
  title: string;
  status: TriggerFireStatus;
  note: string | null;
  messageId: string | null;
  costUsd: number | null;
  test: boolean;
  startedAt: number;
  endedAt: number | null;
}

export interface TriggerPayload {
  triggerId: string;
  fireId: string;
  name: string;
  source: TriggerSource;
  eventId: string | null;
  manual?: boolean;
}

export interface TriggerPollStatus {
  key: string;
  source: TriggerSource;
  lastPolledAt: number | null;
  nextPollAt: number | null;
  failures: number;
  lastError: string | null;
}

export interface TriggersState {
  triggers: Trigger[];
  available: TriggerSource[];
  polls: TriggerPollStatus[];
  stats: Record<string, { firesLastHour: number; spentLastDayUsd: number }>;
}

export const TriggerInputSchema = z.object({
  name: z.string().min(1).max(60),
  enabled: z.boolean().default(true),
  source: z.enum(TRIGGER_SOURCES),
  filter: z.record(z.string(), z.string().max(200)).default({}),
  botId: z.string().min(1),
  roomId: z.string().min(1),
  prompt: z.string().min(1).max(4000),
  maxPerHour: z.number().int().min(1).max(60).default(6),
  budgetUsd: z.number().min(0.05).max(100).default(2),
});
export type TriggerInput = z.infer<typeof TriggerInputSchema>;

/** PATCH body: any subset, with no defaults (zod's `.partial()` would still fill them in and reset fields). */
export const TriggerPatchSchema = z.object({
  name: z.string().min(1).max(60),
  enabled: z.boolean(),
  source: z.enum(TRIGGER_SOURCES),
  filter: z.record(z.string(), z.string().max(200)),
  botId: z.string().min(1),
  roomId: z.string().min(1),
  prompt: z.string().min(1).max(4000),
  maxPerHour: z.number().int().min(1).max(60),
  budgetUsd: z.number().min(0.05).max(100),
}).partial();

export const TriggerTestSchema = z.object({
  event: z.object({
    id: z.string().max(200).optional(),
    title: z.string().max(500).optional(),
    text: z.string().max(10_000).optional(),
    from: z.string().max(200).optional(),
    url: z.string().max(1000).optional(),
    fields: z.record(z.string(), z.string().max(500)).optional(),
  }).optional(),
});
export type TriggerTestInput = z.infer<typeof TriggerTestSchema>;
