import { MAX_ATTACHMENTS, SEND_MODES, isAttachmentRef, type SendMode } from '@pocketrocket/shared';
import { getJson, setJson, versionedKey } from './persist';

export type OutboxStatus = 'sending' | 'sent' | 'failed';
export interface OutboxEntry {
  clientId: string; roomId: string; text: string; status: OutboxStatus; createdAt: number;
  attachments?: string[];
  mode?: SendMode;
}

export const OUTBOX_KEY = versionedKey('outbox', 1);
const MAX_ENTRIES = 200;

const STATUSES: readonly string[] = ['sending', 'sent', 'failed'];
const isRefs = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= MAX_ATTACHMENTS && v.every(isAttachmentRef);
function isEntry(v: unknown): v is OutboxEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  const hasPics = e.attachments === undefined || isRefs(e.attachments);
  const modeOk = e.mode === undefined || (SEND_MODES as readonly unknown[]).includes(e.mode);
  return typeof e.clientId === 'string' && e.clientId.length > 0 && e.clientId.length <= 64
    && hasPics && modeOk && typeof e.roomId === 'string' && typeof e.text === 'string' && (e.text.length > 0 || e.attachments !== undefined)
    && typeof e.status === 'string' && STATUSES.includes(e.status) && typeof e.createdAt === 'number';
}

export function readJournal(): OutboxEntry[] {
  const raw = getJson(OUTBOX_KEY, Array.isArray as (v: unknown) => v is unknown[], []);
  return raw.filter(isEntry).map((e) => (e.status === 'sent' ? { ...e, status: 'sending' as const } : e)).sort((a, b) => a.createdAt - b.createdAt);
}

export function writeJournal(entries: readonly OutboxEntry[]): void {
  setJson(OUTBOX_KEY, entries.slice(-MAX_ENTRIES));
}

export function newClientId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }
}
