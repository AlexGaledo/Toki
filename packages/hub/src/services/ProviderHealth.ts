import type { ProviderId, ProviderLimitState } from '@pocketrocket/shared';
import type { LimitReport, TurnLimit } from '../providers/types.js';

export const DEFAULT_HOLD_MS = 10 * 60_000;

export interface ProviderHealthDeps {
  now?: () => number;
  onChange?: (limits: ProviderLimitState[]) => void;
}

/**
 * Claude's weekly Opus and Sonnet windows cover one model only; every other window covers the whole login. The hold
 * is keyed by the model that hit it then, so a Sonnet bot keeps running while Opus is limited.
 */
export function limitModel(window: string | undefined, model: string | undefined): string | undefined {
  if (!model || !window) return undefined;
  const m = /_(opus|sonnet)$/.exec(window);
  return m && model.toLowerCase().includes(m[1]) ? model : undefined;
}

export class ProviderHealth {
  private entries = new Map<string, ProviderLimitState>();
  private now: () => number;

  constructor(private deps: ProviderHealthDeps = {}) {
    this.now = deps.now ?? Date.now;
  }

  report(provider: ProviderId, r: LimitReport, model?: string) {
    const scope = limitModel(r.window, model);
    if (r.status === 'rejected') {
      this.hold(provider, { kind: r.kind, resetsAt: r.resetsAt, window: r.window }, model, r.utilization);
      return;
    }
    const k = key(provider, scope, r.window);
    if (r.status === 'allowed') {
      if (this.entries.delete(k)) this.changed();
      return;
    }
    const at = this.now();
    const cur = this.live(k);
    if (cur?.status === 'held') return;
    this.entries.set(k, {
      provider, ...(scope ? { model: scope } : {}), status: 'warning', kind: r.kind, window: r.window,
      resetsAt: r.resetsAt, until: r.resetsAt && r.resetsAt > at ? r.resetsAt : at + DEFAULT_HOLD_MS,
      utilization: r.utilization, at,
    });
    this.changed();
  }

  hold(provider: ProviderId, limit: TurnLimit, model?: string, utilization?: number) {
    if (limit.kind !== 'usage') return;
    const at = this.now();
    const scope = limitModel(limit.window, model);
    this.entries.set(key(provider, scope, limit.window), {
      provider, ...(scope ? { model: scope } : {}), status: 'held', kind: 'usage', window: limit.window,
      resetsAt: limit.resetsAt, until: limit.resetsAt && limit.resetsAt > at ? limit.resetsAt : at + DEFAULT_HOLD_MS,
      ...(utilization !== undefined ? { utilization } : {}), at,
    });
    this.changed();
  }

  heldFor(provider: ProviderId, model?: string): ProviderLimitState | undefined {
    return this.list().find((l) => l.status === 'held' && l.provider === provider && (!l.model || l.model === model));
  }

  isHeld(provider: ProviderId, model?: string): boolean {
    return !!this.heldFor(provider, model);
  }

  list(): ProviderLimitState[] {
    const t = this.now();
    for (const [k, v] of this.entries) if (v.until <= t) this.entries.delete(k);
    return [...this.entries.values()].sort((a, b) => a.until - b.until);
  }

  private live(k: string): ProviderLimitState | undefined {
    const v = this.entries.get(k);
    return v && v.until > this.now() ? v : undefined;
  }

  private changed() {
    this.deps.onChange?.(this.list());
  }
}

function key(provider: ProviderId, model: string | undefined, window: string | undefined): string {
  return provider + '|' + (model ?? '') + '|' + (window ?? '');
}
