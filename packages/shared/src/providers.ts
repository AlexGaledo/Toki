import { z } from 'zod';
import { MAX_AVATAR_LENGTH, SEND_MODES, isMediaRef } from './models.js';

// 'gemini' is Google's Antigravity CLI (`agy acp`) through the generic ACP adapter.
export const PROVIDER_IDS = ['claude', 'codex', 'opencode', 'grok', 'gemini'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ModelInfo {
  id: string;
  label: string;
  note?: string;
  default?: boolean;
}

export const RENAMED_MODELS: Readonly<Record<string, string>> = {
  'gemini-default': 'gemini-3.1-pro',
  'gemini-3-pro': 'gemini-3.1-pro',
  'gemini-3-flash': 'gemini-3.8-flash',
};

export function currentModelId(id: string): string {
  return Object.hasOwn(RENAMED_MODELS, id) ? RENAMED_MODELS[id] : id;
}

export type ProviderAuth = 'subscription' | 'apiKey' | 'none' | 'unknown';

export interface ProviderCheck {
  ok: boolean;
  version?: string;
  auth: ProviderAuth;
  account?: string;
  /** The desktop app reads this field by name. */
  plan?: string;
  authMethod?: string;
  orgName?: string;
  exePath?: string;
  unresponsive?: boolean;
  versionWarning?: string;
  error?: string;
  hint?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  blurb: string;
  authModes: ProviderAuth[];
  secretKeys: string[];
  permissions: 'full' | 'best-effort';
  maturity: 'verified' | 'untested';
  testedVersions?: string;
  /** Claude: true once the CLI has reported `interrupt_receipt_v1`, so false until its first turn. Absent: false. */
  steer?: boolean;
  check: ProviderCheck;
  models: ModelInfo[];
}

export type ProviderStaticInfo = Omit<ProviderInfo, 'check' | 'models' | 'steer'>;

export const PROVIDER_LIMIT_KINDS = ['usage', 'overloaded', 'down', 'auth'] as const;
export type ProviderLimitKind = (typeof PROVIDER_LIMIT_KINDS)[number];

export interface ProviderLimitState {
  provider: ProviderId;
  model?: string;
  status: 'held' | 'warning';
  kind: ProviderLimitKind;
  window?: string;
  resetsAt?: number;
  until: number;
  /** How much of the window is used, exactly as the provider reports it (Claude: believed 0..1, not yet confirmed on Max). */
  utilization?: number;
  at: number;
}

export interface FailoverCard {
  id: string;
  botId: string;
  roomId: string;
  provider: ProviderId;
  model?: string;
  window?: string;
  backup: { provider: ProviderId; model: string };
  resetsAt?: number;
  expiresAt: number;
  createdAt: number;
  status: 'pending' | 'continued' | 'waited' | 'expired';
}
export interface FailoverActive {
  botId: string;
  from: ProviderId;
  backup: { provider: ProviderId; model: string };
  until: number;
}
export interface FailoverState {
  cards: FailoverCard[];
  active: FailoverActive[];
}
export const FailoverDecisionSchema = z.object({ decision: z.enum(['continue', 'wait']) });
export type FailoverDecision = z.infer<typeof FailoverDecisionSchema>;

export interface ProvidersResponse {
  active: ProviderId;
  providers: ProviderInfo[];
  limits?: ProviderLimitState[];
}

/**
 * 'read-only': nothing writes, refused without a card. 'ask': risky work raises a card. 'bypass': no cards.
 * POCKETROCKET_BYPASS_PERMISSIONS overrides the stored value and locks it to 'ask' or 'bypass'.
 */
export const APPROVALS = ['read-only', 'ask', 'bypass'] as const;
export type Approvals = (typeof APPROVALS)[number];

export function isTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const SettingsSchema = z.object({
  provider: z.enum(PROVIDER_IDS).default('claude'),
  defaultModel: z.string().default('auto'),
  userName: z.string().min(1).max(40).default('you'),
  userAvatar: z.string().max(MAX_AVATAR_LENGTH).refine((v) => v === '' || isMediaRef(v), 'not an uploaded picture').default(''),
  sounds: z.boolean().default(true),
  onboarded: z.boolean().default(false),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  font: z.enum(['google-sans', 'figtree']).default('google-sans'),
  layout: z.enum(['auto', 'toki', 'classic']).default('auto'),
  /** Only the REST API writes it; no bot tool can. */
  approvals: z.enum(APPROVALS).default('ask'),
  routerClassifier: z.boolean().default(false),
  timezone: z.string().max(64).refine(isTimeZone, 'not a known IANA time zone').default('UTC'),
  knowledgeRepo: z.string().max(500).default(''),
  podiumBotIds: z.array(z.string().max(64)).max(3).default([]),
  /** Only the REST API writes it, so no bot can grant itself the owner's messages. */
  personaBotId: z.string().max(64).default(''),
  /** Only the REST API writes it, so no bot can turn it off. */
  sandbox: z.enum(['off', 'on']).default('off'),
  spendAlertThresholdUsd: z.number().min(0).max(1000).default(5),
  busyMessages: z.enum(SEND_MODES).default('join'),
  offloadModel: z.string().min(1).max(80).default('claude-sonnet-5-5'),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

export const SettingsPatchSchema = SettingsSchema.partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** Write-only: GET /api/secrets returns only which keys are set. An empty string clears. */
export const SecretsPatchSchema = z.record(z.string(), z.string());
export interface SecretsStatus { keys: Record<string, boolean> }

