import fs from 'node:fs';
import type { Bot, ModelInfo, ProviderCheck, ProviderId, ProviderInfo, ProvidersResponse, Settings } from '@pocketrocket/shared';
import { CLAUDE_EXE, ENABLED_PROVIDERS } from '../config.js';
import { ClaudeProvider } from './claude.js';
import { createCodexProvider } from './codex.js';
import { createOpenCodeProvider } from './opencode.js';
import { createGrokProvider } from './grok.js';
import { createGeminiProvider } from './gemini.js';
import type { AgentProvider } from './types.js';
import { ProviderHealth } from '../services/ProviderHealth.js';
import { events } from '../events.js';

const CHECK_TTL_MS = 60_000;

export interface RegistryDeps {
  settings: { get(): Settings };
  enabled?: readonly ProviderId[];
  health?: ProviderHealth;
  claudeExe?: () => boolean;
}

export interface ProviderRegistry {
  byId: Record<ProviderId, AgentProvider>;
  claude: ClaudeProvider;
  enabled: readonly ProviderId[];
  health: ProviderHealth;
  list(): AgentProvider[];
  get(id: ProviderId): AgentProvider;
  active(): AgentProvider;
  forBot(bot: Pick<Bot, 'provider'>): AgentProvider;
  claudeReady(): boolean;
  modelsSync(id: ProviderId): ModelInfo[];
  modelsAwaited(id: ProviderId): Promise<ModelInfo[]>;
  check(id: ProviderId, force?: boolean): Promise<ProviderCheck>;
  response(): Promise<ProvidersResponse>;
  shutdown(): Promise<void>;
}

export function createProviders(deps: RegistryDeps): ProviderRegistry {
  const claude = new ClaudeProvider();
  const byId: Record<ProviderId, AgentProvider> = {
    claude,
    codex: createCodexProvider(),
    opencode: createOpenCodeProvider(),
    grok: createGrokProvider(),
    gemini: createGeminiProvider(),
  };
  const enabled = deps.enabled ?? ENABLED_PROVIDERS;
  const cache = new Map<ProviderId, { at: number; check: ProviderCheck }>();
  const health = deps.health ?? new ProviderHealth({ onChange: (limits) => events.emitEvent({ type: 'provider.limit', limits }) });

  const get = (id: ProviderId): AgentProvider => (enabled.includes(id) ? byId[id] : undefined) ?? claude;

  const check = async (id: ProviderId, force = false): Promise<ProviderCheck> => {
    if (!enabled.includes(id)) return { ok: false, auth: 'unknown', error: id + ' is not enabled on this server' };
    const hit = cache.get(id);
    if (!force && hit && Date.now() - hit.at < CHECK_TTL_MS) return hit.check;
    let result: ProviderCheck;
    try {
      result = await get(id).check();
    } catch (e) {
      result = { ok: false, auth: 'unknown', error: String((e as Error).message ?? e) };
    }
    cache.set(id, { at: Date.now(), check: result });
    return result;
  };

  const claudeExe = deps.claudeExe ?? (() => fs.existsSync(CLAUDE_EXE));

  return {
    byId,
    claude,
    enabled,
    health,
    list: () => enabled.map((id) => byId[id]),
    get,
    active: () => get(deps.settings.get().provider),
    forBot: (bot) => get(bot.provider ?? deps.settings.get().provider),
    claudeReady: () => {
      if (!claudeExe()) return false;
      const last = cache.get('claude')?.check;
      if (last && !last.ok && !last.unresponsive) return false;
      return !health.isHeld('claude');
    },
    modelsSync: (id) => get(id).modelsSync(),
    modelsAwaited: (id) => {
      const p = get(id);
      return p.modelsAwaited ? p.modelsAwaited() : p.models();
    },
    check,
    async response(): Promise<ProvidersResponse> {
      const providers: ProviderInfo[] = [];
      for (const id of enabled) {
        const p = get(id);
        providers.push({ ...p.info, steer: p.canSteer?.() ?? false, check: await check(id), models: await p.models() });
      }
      return { active: get(deps.settings.get().provider).id, providers, limits: health.list().filter((l) => enabled.includes(l.provider)) };
    },
    async shutdown() {
      for (const id of enabled) {
        try {
          await byId[id].shutdown?.();
        } catch {
          /* best effort */
        }
      }
    },
  };
}
