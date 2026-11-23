/**
 * xAI list prices, USD per 1M tokens, `<200k` context tier (docs.x.ai/docs/models, 2026-09-08).
 * Approximate on purpose: the `>=200k` tier doubles every rate and we do not model it, and the CLI's own
 * `total_cost_usd` (stamped for API-key traffic) always wins when present. These rates only fill the gap on
 * OAuth/pool traffic, where the server does not report cost.
 */
export interface Rate {
  input: number;
  cachedInput: number;
  output: number;
}

export const GROK_RATES: Record<string, Rate> = {
  'grok-4.6': { input: 2, cachedInput: 0.5, output: 6 },
  'grok-4.5': { input: 2, cachedInput: 0.3, output: 6 },
  'grok-4.3': { input: 1.25, cachedInput: 0.2, output: 2.5 },
  'grok-build-0.1': { input: 1, cachedInput: 0.2, output: 2 },
  'grok-code-fast-1': { input: 1, cachedInput: 0.2, output: 2 },
  'grok-4-fast': { input: 0.2, cachedInput: 0.05, output: 0.5 },
};

export const FALLBACK_RATE: Rate = GROK_RATES['grok-4.6'];

export function rateFor(model: string): Rate {
  if (GROK_RATES[model]) return GROK_RATES[model];
  const hit = Object.keys(GROK_RATES)
    .filter((id) => model.startsWith(id))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? GROK_RATES[hit] : FALLBACK_RATE;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function estimateCostUsd(model: string, t: TokenCounts): number {
  const r = rateFor(model);
  const perToken = (usd: number) => usd / 1_000_000;
  return (
    (t.inputTokens + t.cacheWriteTokens) * perToken(r.input) +
    t.cacheReadTokens * perToken(r.cachedInput) +
    t.outputTokens * perToken(r.output)
  );
}
