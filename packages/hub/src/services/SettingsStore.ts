import {
  AUTO_MODEL, DEFAULT_SETTINGS, SettingsSchema, isTimeZone, type Approvals, type Bot, type ModelInfo, type ProviderId, type Settings, type SettingsPatch,
} from '@pocketrocket/shared';
import { APPROVALS_ENV, ENABLED_PROVIDERS, osUserName } from '../config.js';
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';
import { knowledgeSourceError } from './KnowledgeRepo.js';

export interface SettingsDeps {
  repos: Repos;
  enabled?: readonly ProviderId[];
  approvalsEnv?: Approvals | null;
  models?: (provider: ProviderId) => ModelInfo[];
  modelsAsync?: (provider: ProviderId) => Promise<ModelInfo[]>;
}

export function defaultSettings(): Settings {
  return { ...DEFAULT_SETTINGS, userName: osUserName(), timezone: systemTimeZone() };
}

export function systemTimeZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && isTimeZone(tz) ? tz : 'UTC';
}

export class SettingsRejected extends Error {
  constructor(message: string, readonly status: 400 | 409 = 400) {
    super(message);
  }
}

export class SettingsStore {
  private cache: Settings | null = null;
  private enabled: readonly ProviderId[];
  private approvalsEnv: Approvals | null;

  constructor(private deps: SettingsDeps) {
    this.enabled = deps.enabled ?? ENABLED_PROVIDERS;
    this.approvalsEnv = deps.approvalsEnv === undefined ? APPROVALS_ENV : deps.approvalsEnv;
  }

  approvals(): Approvals {
    return this.approvalsEnv ?? this.get().approvals;
  }

  get approvalsLocked(): boolean {
    return this.approvalsEnv !== null;
  }

  ensureEnabledProvider(): void {
    const s = this.get();
    if (this.enabled.includes(s.provider)) return;
    const models = this.deps.models?.('claude') ?? [];
    const stale = models.length > 0 && s.defaultModel !== AUTO_MODEL && !models.some((m) => m.id === s.defaultModel);
    this.patch(stale ? { provider: 'claude', defaultModel: DEFAULT_SETTINGS.defaultModel } : { provider: 'claude' });
  }

  get(): Settings {
    if (!this.cache) {
      const stored = this.deps.repos.allSettings();
      const parsed = SettingsSchema.safeParse({ ...stored });
      const base = parsed.success ? parsed.data : defaultSettings();
      this.cache = stored.userName === undefined ? { ...base, userName: osUserName() } : base;
      if (stored.timezone === undefined) this.cache = { ...this.cache, timezone: systemTimeZone() };
    }
    return this.cache;
  }

  patch(p: SettingsPatch): Settings {
    const prev = this.get();
    const next = SettingsSchema.parse({ ...prev, ...p });
    if (p.provider !== undefined && !this.enabled.includes(p.provider)) {
      throw new SettingsRejected('provider: ' + p.provider + ' is not enabled on this server');
    }
    if (this.approvalsLocked && next.approvals !== prev.approvals) {
      throw new SettingsRejected('approvals: set by the server environment (POCKETROCKET_BYPASS_PERMISSIONS)', 409);
    }
    if (p.knowledgeRepo !== undefined && p.knowledgeRepo !== prev.knowledgeRepo) {
      const bad = knowledgeSourceError(p.knowledgeRepo);
      if (bad) throw new SettingsRejected('knowledgeRepo: ' + bad);
    }
    for (const [k, v] of Object.entries(next)) {
      if ((prev as Record<string, unknown>)[k] !== v || (p as Record<string, unknown>)[k] !== undefined) {
        this.deps.repos.setSetting(k, v);
      }
    }
    this.cache = next;
    events.emitEvent({ type: 'settings.changed', settings: next });
    if (next.provider !== prev.provider) {
      if (!this.repointBots(next.provider) && this.deps.modelsAsync) {
        void this.deps
          .modelsAsync(next.provider)
          .then((models) => {
            if (this.get().provider === next.provider) this.repointBots(next.provider, models);
          })
          .catch(() => {
            /* the provider is unreachable; bots keep their model and the turn path resolves it */
          });
      }
      events.emitEvent({ type: 'providers.changed', active: next.provider });
    }
    return next;
  }

  reload() {
    this.cache = null;
  }

  private repointBots(provider: ProviderId, knownModels?: ModelInfo[]): boolean {
    const models = knownModels ?? this.deps.models?.(provider) ?? [];
    if (!models.length) return false;
    let changed = false;
    for (const bot of this.deps.repos.listBots()) {
      if (bot.provider) continue;
      if (repointBotModel(this.deps.repos, bot, provider, models)) changed = true;
    }
    if (changed) events.emitEvent({ type: 'bots.changed', bots: this.deps.repos.listBots() });
    return true;
  }
}

export function modelFor(models: readonly ModelInfo[], current: string): string | null {
  if (!models.length || current === AUTO_MODEL || models.some((m) => m.id === current)) return null;
  return models.find((m) => m.default)?.id ?? models[0].id;
}

export function repointBotModel(repos: Repos, bot: Bot, provider: ProviderId, models: readonly ModelInfo[]): boolean {
  const to = modelFor(models, bot.model);
  if (!to) return false;
  const from = bot.model;
  repos.updateBot(bot.id, { model: to });
  for (const room of repos.listRooms()) {
    if (!room.memberIds.includes(bot.id)) continue;
    const msg = repos.insertMessage({
      roomId: room.id, authorType: 'system', authorId: null, kind: 'system',
      text: bot.name + ' switched to ' + to + ' (' + from + ' is not available on ' + provider + ').',
      payload: null, causeId: null, hop: 0, turnId: null,
    });
    events.emitEvent({ type: 'message.new', message: msg });
  }
  return true;
}

let installed: SettingsStore | null = null;
export function installSettings(store: SettingsStore) {
  installed = store;
}
export const settings = {
  get(): Settings {
    return installed ? installed.get() : defaultSettings();
  },
};

export const ownerTag = (): string => settings.get().userName + ' (owner)';
