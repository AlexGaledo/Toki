// The hub holds every credential; these shapes carry no secret.
import { z } from 'zod';

export const INTEGRATION_PROVIDERS = ['github', 'google', 'slack', 'clickup', 'teams'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export type IntegrationMethod = 'oauth' | 'token';

export type IntegrationStatus = 'connected' | 'error' | 'expired';

export interface IntegrationInfo {
  id: string;
  provider: IntegrationProvider;
  method: IntegrationMethod;
  accountLabel: string;
  scopes: string[];
  status: IntegrationStatus;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  lastCheckedAt: number | null;
  botIds: string[];
  warnings: string[];
  hasAppToken?: boolean;
}

/** The secret is never sent back, only whether one is stored. */
export interface OAuthAppStatus {
  configured: boolean;
  clientId: string | null;
  hasSecret: boolean;
  tenant: string | null;
}

export interface PendingConnect {
  provider: IntegrationProvider;
  kind: 'browser' | 'device';
  startedAt: number;
  expiresAt: number;
  userCode?: string;
  verificationUri?: string;
  error?: string;
}

export interface IntegrationsState {
  connections: IntegrationInfo[];
  apps: Record<IntegrationProvider, OAuthAppStatus>;
  pending: PendingConnect[];
  redirectUris: Record<IntegrationProvider, string>;
}

export const OAuthAppInputSchema = z.object({
  clientId: z.string().trim().min(4).max(300),
  /** Empty keeps the stored secret. */
  clientSecret: z.string().trim().max(500).optional(),
  tenant: z.string().trim().regex(/^[A-Za-z0-9.-]{1,100}$/).optional(),
});
export type OAuthAppInput = z.infer<typeof OAuthAppInputSchema>;

export const TokenConnectSchema = z.object({
  token: z.string().trim().max(2000).optional(),
  appToken: z.string().trim().max(2000).optional(),
});
export type TokenConnectInput = z.infer<typeof TokenConnectSchema>;

export const IntegrationGrantsSchema = z.object({ botIds: z.array(z.string()).max(200) });

/** No token and no chat id in here. */
export interface TelegramState {
  configured: boolean;
  botUsername: string | null;
  linked: boolean;
  linkedName: string | null;
  notify: boolean;
  pendingCode: { code: string; deepLink: string; expiresAt: number } | null;
  error: string | null;
}
