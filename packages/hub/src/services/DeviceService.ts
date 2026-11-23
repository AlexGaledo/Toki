import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { DeviceInfo, DevicesRepo } from '../db/devices.js';
import { tokenMatches } from '../api/guard.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 5 * 60_000;
const MAX_CODES = 5;
const TOUCH_EVERY_MS = 60_000;
const TOKEN_PREFIX = 'prd_';

export class PairingError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const c = raw.replace(/[\s-]/g, '').toUpperCase();
  return c.length === CODE_LENGTH && [...c].every((ch) => CODE_ALPHABET.includes(ch)) ? c : null;
}

/**
 * P9: paired devices. A hub-token holder (the desktop app) mints a one-time pairing code, shows it as a QR
 * code, and the phone trades it for a device token of its own. Only the token's SHA-256 is stored; checks
 * compare hashes in constant time against every live device, with no early exit. Revocation is a row update
 * read on the very next request, and listeners (the hub's socket tracker) close what the device has open.
 */
export class DeviceService {
  private codes: { code: string; expires: number }[] = [];
  private touched = new Map<string, number>();
  private revokeListeners = new Set<(deviceId: string) => void>();

  constructor(private repo: DevicesRepo, private now: () => number = Date.now) {}

  mintPairingCode(): { code: string; expiresAt: number } {
    this.sweep();
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const expires = this.now() + PAIRING_TTL_MS;
    this.codes.push({ code, expires });
    if (this.codes.length > MAX_CODES) this.codes.splice(0, this.codes.length - MAX_CODES);
    return { code, expiresAt: expires };
  }

  redeem(rawCode: unknown, rawName: unknown): { token: string; device: DeviceInfo } {
    this.sweep();
    const code = normalizeCode(rawCode);
    let found = -1;
    for (let i = 0; i < this.codes.length; i++) if (tokenMatches(code ?? '', this.codes[i].code)) found = i;
    if (code === null || found < 0) throw new PairingError(403, 'That pairing code is wrong or has expired. Make a new one on the desktop.');
    this.codes.splice(found, 1);
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, 40) : 'Phone';
    const device = this.repo.create({ id: 'dev_' + randomBytes(8).toString('hex'), name, tokenHash: hashDeviceToken(token), now: this.now() });
    return { token, device };
  }

  authenticate(supplied: string | null): string | null {
    if (!supplied || !supplied.startsWith(TOKEN_PREFIX)) return null;
    const h = Buffer.from(hashDeviceToken(supplied), 'hex');
    let found: string | null = null;
    for (const d of this.repo.activeHashes()) {
      const other = Buffer.from(d.tokenHash, 'hex');
      if (other.length === h.length && timingSafeEqual(other, h)) found = d.id;
    }
    if (found) this.touch(found);
    return found;
  }

  list(): DeviceInfo[] { return this.repo.list(); }
  get(id: string): DeviceInfo | undefined { return this.repo.get(id); }
  rename(id: string, name: string): DeviceInfo | undefined { return this.repo.rename(id, name.trim().slice(0, 40) || 'Phone'); }

  revoke(id: string): boolean {
    const ok = this.repo.revoke(id);
    this.touched.delete(id);
    if (ok) for (const l of this.revokeListeners) l(id);
    return ok;
  }
  onRevoke(fn: (deviceId: string) => void): () => void {
    this.revokeListeners.add(fn);
    return () => this.revokeListeners.delete(fn);
  }

  pendingCodes(): number { this.sweep(); return this.codes.length; }

  private touch(id: string): void {
    const t = this.now();
    if (t - (this.touched.get(id) ?? 0) < TOUCH_EVERY_MS) return;
    this.touched.set(id, t);
    this.repo.touch(id, t);
  }
  private sweep(): void {
    const t = this.now();
    this.codes = this.codes.filter((c) => c.expires > t);
  }
}
