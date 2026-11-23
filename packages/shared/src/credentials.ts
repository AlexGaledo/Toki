import { z } from 'zod';

/**
 * The secret is write-only: it goes in over REST and is read back only by the hub, when it is typed into the page.
 * No type here has a field that could carry it out.
 */
export const MAX_CREDENTIALS = 50;
export const MAX_CREDENTIAL_NAME = 40;
export const MAX_CREDENTIAL_USERNAME = 200;
export const MAX_CREDENTIAL_SECRET = 1024;

export const CREDENTIAL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

/** Deliberately has no `secret` field. */
export interface CredentialInfo {
  id: string;
  name: string;
  /** A page on any other origin is refused. */
  origin: string;
  username: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);
/** A bot can run its own local server, so a saved login is never bound to this machine. */
const isLocalHost = (h: string): boolean => LOCAL_HOSTS.has(h) || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h);

/**
 * `scheme://host[:port]`, lowercase, default port dropped: the form `location.origin` reports, compared with `===`.
 * Null for non-https, localhost or loopback, embedded user:password, or no host.
 */
export function normalizeCredentialOrigin(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.username || u.password || !u.hostname) return null;
  if (isLocalHost(u.hostname)) return null;
  return u.protocol === 'https:' ? u.origin : null;
}

const name = z.string().trim().min(1).max(MAX_CREDENTIAL_NAME).regex(CREDENTIAL_NAME_RE, 'use letters, digits, spaces, dots, dashes or underscores');
const origin = z.string().trim().min(1).max(300).transform((s, ctx) => {
  const o = normalizeCredentialOrigin(s);
  if (!o) ctx.addIssue({ code: 'custom', message: 'must be an https:// address (not localhost) without a user name or password' });
  return o ?? z.NEVER;
});
const username = z.string().max(MAX_CREDENTIAL_USERNAME).refine((s) => !/[\r\n\0]/.test(s), 'no line breaks');
const secret = z.string().min(1).max(MAX_CREDENTIAL_SECRET).refine((s) => !/\0/.test(s), 'no null characters');

export const CredentialCreateSchema = z.object({ name, origin, username: username.default(''), secret }).strict();
export type CredentialCreate = z.infer<typeof CredentialCreateSchema>;
export const CredentialPatchSchema = z.object({ name: name.optional(), origin: origin.optional(), username: username.optional(), secret: secret.optional() }).strict();
export type CredentialPatch = z.infer<typeof CredentialPatchSchema>;
