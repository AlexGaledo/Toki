import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

/** Key names only, never values; no UI or bot tool writes it, and bot file tools are refused it. */
export const KEY_REGISTRY_PATH = path.join(DATA_DIR, 'key-registry.json');

export type KeyTier = 0 | 1 | 2 | 3;
export type KeyPlace = 'vps' | 'pc';
export interface KeyEntry {
  tier: KeyTier;
  where: KeyPlace[];
  service?: string;
  notes?: string;
}
export type KeyRegistry = Map<string, KeyEntry>;

export const KEY_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TIERS = new Set([0, 1, 2, 3]);
const PLACES = new Set(['vps', 'pc']);

const warned = new Set<string>();
function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn('[key-registry] ' + msg);
}

export function parseKeyRegistry(raw: unknown): KeyRegistry {
  const out: KeyRegistry = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const keys = (raw as { keys?: unknown }).keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return out;
  for (const [name, v] of Object.entries(keys as Record<string, unknown>)) {
    if (!KEY_NAME_RE.test(name)) { warnOnce('ignored "' + name + '": not a valid key name'); continue; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) { warnOnce('ignored "' + name + '": not an object'); continue; }
    const e = v as { tier?: unknown; where?: unknown; service?: unknown; notes?: unknown };
    if (typeof e.tier !== 'number' || !TIERS.has(e.tier)) { warnOnce('ignored "' + name + '": tier must be 0, 1, 2 or 3'); continue; }
    if (!Array.isArray(e.where) || !e.where.every((w) => typeof w === 'string' && PLACES.has(w))) {
      warnOnce('ignored "' + name + '": where must list "vps" and/or "pc"');
      continue;
    }
    const where = [...new Set(e.where as KeyPlace[])];
    if (e.tier === 3 && where.includes('vps')) {
      warnOnce('rejected "' + name + '": a tier 3 key is PC-only and may not list "vps"');
      continue;
    }
    out.set(name, {
      tier: e.tier as KeyTier,
      where,
      ...(typeof e.service === 'string' && e.service ? { service: e.service.slice(0, 80) } : {}),
      ...(typeof e.notes === 'string' && e.notes ? { notes: e.notes.slice(0, 200) } : {}),
    });
  }
  return out;
}

export function loadKeyRegistry(file: string = KEY_REGISTRY_PATH): KeyRegistry {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warnOnce('could not read ' + file + ': ' + String((e as Error).message ?? e));
    return new Map();
  }
  return parseKeyRegistry(raw);
}

export interface Route {
  place: KeyPlace | 'blocked';
  reason: string;
  missing: string[];
}

const on = (r: KeyRegistry, k: string, p: KeyPlace) => r.get(k)!.where.includes(p);

/** A need the registry does not name is blocked, never guessed. */
export function routeByNeeds(registry: KeyRegistry, needs: readonly string[], runnerPaired: boolean): Route {
  const want = [...new Set(needs.map((n) => n.trim()).filter(Boolean))];
  const unknown = want.filter((k) => !registry.has(k));
  if (unknown.length) {
    return { place: 'blocked', reason: 'Not in the key registry: ' + unknown.join(', ') + '. Ask the owner to add it; do not guess where it lives.', missing: unknown };
  }
  const notOnPc = want.filter((k) => !on(registry, k, 'pc'));
  const critical = want.filter((k) => registry.get(k)!.tier === 3);
  if (critical.length) {
    if (notOnPc.length) return { place: 'blocked', reason: 'Tier 3 keys (' + critical.join(', ') + ') only run on the PC, and the PC does not hold: ' + notOnPc.join(', ') + '.', missing: notOnPc };
    if (!runnerPaired) return { place: 'blocked', reason: 'Tier 3 keys (' + critical.join(', ') + ') only run on the PC, and no PC runner is paired.', missing: [] };
    return { place: 'pc', reason: 'Tier 3 keys (' + critical.join(', ') + ') never leave the PC.', missing: [] };
  }
  if (want.every((k) => on(registry, k, 'vps'))) {
    return { place: 'vps', reason: want.length ? 'Every key is on the VPS.' : 'No keys needed.', missing: [] };
  }
  if (!notOnPc.length) {
    if (runnerPaired) return { place: 'pc', reason: 'Not every key is on the VPS; the PC holds them all.', missing: [] };
    return { place: 'blocked', reason: 'Only the PC holds every key, and no PC runner is paired.', missing: [] };
  }
  return { place: 'blocked', reason: 'Neither the VPS nor the PC holds every key. Missing on the PC: ' + notOnPc.join(', ') + '.', missing: notOnPc };
}

export function keyRegistryNote(registry: KeyRegistry, prefix = ''): string | null {
  if (!registry.size) return null;
  const list = (p: KeyPlace) => [...registry].filter(([, e]) => e.where.includes(p)).map(([k, e]) => k + ' (tier ' + e.tier + ')').join(', ') || 'none';
  return 'Keys (names only; you never see values). On the VPS: ' + list('vps') + '. On the PC: ' + list('pc') + '. ' +
    'Before work that needs one of these keys, call ' + prefix + 'where_to_run({ needs: [names] }) and follow its answer: ' +
    '"vps" means do it here, "pc" means ' + prefix + 'run_on_pc with the same needs, "blocked" means tell the owner what is missing. Never pick the place yourself.';
}
