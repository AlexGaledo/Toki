/**
 * Secret scrubbing for anything a child process says (audit 2026-09-09, B22).
 *
 * Provider stderr/stdout tails end up in room messages and in the SQLite `messages` table. OpenCode's inline
 * config carries an `Authorization: Bearer <per-turn MCP token>` line, a CLI can echo an API key back in an
 * error, and a bot can `echo $XAI_API_KEY`. Everything on its way to the room goes through `redact()` first.
 *
 * Two layers: shape-based patterns (bearer headers, vendor key formats) and an exact-value registry the hub
 * fills in with the tokens it minted itself (hub token, per-turn MCP tokens, bridge token, server password).
 */

const known = new Set<string>();

export function addSecret(value: string | null | undefined): void {
  if (typeof value === 'string' && value.length >= 8) known.add(value);
}
export function removeSecret(value: string | null | undefined): void {
  if (typeof value === 'string') known.delete(value);
}
export function clearSecrets(): void {
  known.clear();
}

const PATTERNS: RegExp[] = [
  /\b(authorization\s*[:=]\s*)?bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(sk|xai|ghp|gho)-?[A-Za-z0-9_-]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[usr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /\bpk_\d+_[A-Za-z0-9]{16,}/g,
  // Catches token shapes the hub never stored (a refreshed or mistyped one).
  // Telegram bot token, `<bot id>:<secret>`. It sits in the URL path (`/bot123456789:AAA…/getMe`), where `\b` finds
  // no boundary between `bot` and the digits, so the guard is a lookbehind on a digit instead.
  /(?<![0-9])\d{8,10}:[A-Za-z0-9_-]{35,}/g,
  /\bya29\.[A-Za-z0-9._-]{20,}/g,
  /\b1\/\/[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const s of known) {
    if (out.includes(s)) out = out.split(s).join('[redacted]');
  }
  for (const re of PATTERNS) out = out.replace(re, (m) => (m.toLowerCase().startsWith('bearer') || /authorization/i.test(m) ? m.replace(/(bearer\s+)[^\s]+/i, '$1[redacted]') : '[redacted]'));
  return out;
}

/** Redacts every string (keys too) in a JSON-like value, keeping its shape. */
export function redactValue(v: unknown): unknown {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [redact(k), redactValue(x)]));
  return v;
}

export function redactUnknown(v: unknown): string {
  return redact(typeof v === 'string' ? v : String(v ?? ''));
}

export function knownSecretCount(): number {
  return known.size;
}

/** Caught errors can carry token-bearing URLs or bodies: the hub prints them only through this. */
export function logError(prefix: string, e: unknown): void {
  const text = e instanceof Error ? e.stack ?? e.message : typeof e === 'string' ? e : JSON.stringify(e) ?? String(e);
  console.error(prefix, redact(text));
}
