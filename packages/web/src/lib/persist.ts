/**
 * The one place the web app touches `localStorage` / `sessionStorage`. Storage can be missing or throw (blocked
 * cookies, a sandboxed iframe, a full quota, private mode), so every access is guarded here.
 */
export type Area = 'local' | 'session';

const shadow: Record<Area, Map<string, string | null>> = { local: new Map(), session: new Map() };

function store(area: Area): Storage | null {
  try {
    return (area === 'local' ? globalThis.localStorage : globalThis.sessionStorage) ?? null;
  } catch {
    return null; // even touching the property can throw
  }
}

export function versionedKey(name: string, version: number): string {
  return 'pocketrocket.' + name + '.v' + version;
}

export function getItem(key: string, area: Area = 'local'): string | null {
  const held = shadow[area];
  if (held.has(key)) return held.get(key) ?? null;
  try {
    return store(area)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function setItem(key: string, value: string, area: Area = 'local'): boolean {
  try {
    const s = store(area);
    if (!s) throw new Error('no storage');
    s.setItem(key, value);
    shadow[area].delete(key);
    return true;
  } catch {
    shadow[area].set(key, value);
    return false;
  }
}

export function removeItem(key: string, area: Area = 'local'): void {
  try {
    const s = store(area);
    if (!s) throw new Error('no storage');
    s.removeItem(key);
    shadow[area].delete(key);
  } catch {
    shadow[area].set(key, null);
  }
}

export function getJson<T>(key: string, ok: (v: unknown) => v is T, fallback: T, area: Area = 'local'): T {
  const raw = getItem(key, area);
  if (raw === null) return fallback;
  try {
    const v: unknown = JSON.parse(raw);
    return ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function setJson(key: string, value: unknown, area: Area = 'local'): boolean {
  try {
    return setItem(key, JSON.stringify(value), area);
  } catch {
    return false;
  }
}

export function resetPersistMemory(): void {
  shadow.local.clear();
  shadow.session.clear();
}
