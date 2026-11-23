import { AUTO_MODEL, DEFAULT_MODEL, type Bot, type CauseKind, type ModelInfo } from '@pocketrocket/shared';
import type { TurnUsage } from '../services/UsageTracker.js';

export type ModelTier = 'haiku' | 'sonnet' | 'opus';
export type RouteReason = 'pinned' | 'chosen' | 'background' | 'explicit' | 'skill' | 'routine' | 'triage' | 'classifier' | 'default' | 'retry' | 'stronger';

export interface RouteRequest {
  bot: Pick<Bot, 'model'>;
  causeKind: CauseKind;
  input: string;
  /** Only this, on a turn a person started, can be an explicit ask for a stronger model. */
  latestUserText?: string;
  routinePrompt?: string;
  chosen?: boolean;
  models: readonly ModelInfo[];
  opusSkills?: readonly string[];
  fallbackModel?: string;
}

export interface RouteChoice {
  model: string;
  tier: ModelTier | null;
  reason: RouteReason;
  detail: string;
}

export interface ClassifierResult {
  tier: ModelTier | null;
  usage?: TurnUsage;
}
export type Classifier = (input: string) => Promise<ClassifierResult>;

const TIER_LABEL: Record<ModelTier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };

const PREFERRED: Record<ModelTier, readonly string[]> = {
  haiku: ['claude-haiku-4-5-20251001'],
  sonnet: ['claude-sonnet-5'],
  opus: ['claude-opus-5'],
};
const HINTS: Record<ModelTier, readonly RegExp[]> = {
  haiku: [/haiku/, /cheapest/, /\bmini\b|\bfast(est)?\b|\blite\b|\bcheap/],
  sonnet: [/sonnet/],
  opus: [/opus/, /hardest|strongest/],
};

export function isAuto(bot: Pick<Bot, 'model'>): boolean {
  return bot.model === AUTO_MODEL;
}

export function explicitRequest(text: string): string | null {
  const m = text.match(/\bthink\s+(?:really\s+|very\s+)?hard(?:er)?\b|\bultrathink\b|(?:^|[\s(])\/opus\b/i);
  return m ? m[0].trim() : null;
}

export function invokedSkill(text: string, skills: readonly string[]): string | null {
  for (const name of skills) {
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('(?:^|[\\s(])/' + n + '\\b|\\b' + n + '\\s+skill\\b', 'i').test(text)) return name;
  }
  return null;
}

export function resolveTier(tier: ModelTier, models: readonly ModelInfo[], fallbackModel?: string): { model: string; exact: boolean } {
  if (!models.length) {
    const fb = fallbackModel && fallbackModel !== AUTO_MODEL ? fallbackModel : DEFAULT_MODEL;
    return { model: fb, exact: false };
  }
  for (const id of PREFERRED[tier]) if (models.some((m) => m.id === id)) return { model: id, exact: true };
  const text = (m: ModelInfo) => (m.id + ' ' + m.label + ' ' + (m.note ?? '')).toLowerCase();
  for (const re of HINTS[tier]) {
    const hit = models.find((m) => m.id !== AUTO_MODEL && re.test(text(m)));
    if (hit) return { model: hit.id, exact: true };
  }
  const real = models.filter((m) => m.id !== AUTO_MODEL);
  const def = real.find((m) => m.default) ?? real[0];
  if (!def) return { model: fallbackModel && fallbackModel !== AUTO_MODEL ? fallbackModel : DEFAULT_MODEL, exact: false };
  return { model: def.id, exact: tier === 'sonnet' };
}

function choose(req: RouteRequest, tier: ModelTier, reason: RouteReason, why: string): RouteChoice {
  const r = resolveTier(tier, req.models, req.fallbackModel);
  const suffix = r.exact ? '' : ' (no ' + TIER_LABEL[tier] + ' on this provider; using ' + r.model + ')';
  return { model: r.model, tier, reason, detail: 'Auto: ' + TIER_LABEL[tier] + ' ' + why + suffix };
}

function pinned(req: RouteRequest): RouteChoice {
  return req.chosen
    ? { model: req.bot.model, tier: null, reason: 'chosen', detail: 'Chosen for this chat' }
    : { model: req.bot.model, tier: null, reason: 'pinned', detail: 'Set on the bot' };
}

export function route(req: RouteRequest): RouteChoice {
  if (!isAuto(req.bot)) return pinned(req);
  if (req.causeKind === 'memory') return choose(req, 'haiku', 'background', 'for the auto-memory pass');
  if (req.causeKind === 'reflection') return choose(req, 'haiku', 'background', 'for the skill reflection pass');
  if (req.causeKind === 'training') return choose(req, 'haiku', 'background', 'for the bot training pass');
  const asked = req.causeKind === 'user' ? explicitRequest(req.latestUserText ?? '') : null;
  if (asked) return choose(req, 'opus', 'explicit', 'because the message asked ("' + asked + '")');
  const ownText = req.causeKind === 'user' ? req.latestUserText : req.causeKind === 'routine' ? req.routinePrompt : undefined;
  const skill = invokedSkill(ownText ?? '', req.opusSkills ?? []);
  if (skill) return choose(req, 'opus', 'skill', 'because skill "' + skill + '" declares model: opus');
  if (req.causeKind === 'routine') return choose(req, 'sonnet', 'routine', 'for a routine');
  if (req.causeKind === 'trigger') return choose(req, 'haiku', 'triage', 'to triage a trigger');
  if (req.causeKind === 'workflow') return choose(req, 'sonnet', 'routine', 'for a workflow step');
  return choose(req, 'sonnet', 'default', '(default)');
}

export const CLASSIFIER_MAX_CHARS = 2000;

export interface ModelRouterOptions {
  classify?: Classifier;
  classifierEnabled?: () => boolean;
}

export function canUpgrade(req: RouteRequest, prev: RouteChoice): boolean {
  return isAuto(req.bot) && prev.tier === 'sonnet' && resolveTier('opus', req.models, req.fallbackModel).model !== prev.model;
}

export class ModelRouter {
  constructor(private opts: ModelRouterOptions = {}) {}

  async pick(req: RouteRequest): Promise<RouteChoice & { classifierUsage?: TurnUsage }> {
    const base = route(req);
    if (base.reason !== 'default' || !this.opts.classify || !this.opts.classifierEnabled?.()) return base;
    let res: ClassifierResult;
    try {
      res = await this.opts.classify(req.input.slice(-CLASSIFIER_MAX_CHARS));
    } catch {
      return base;
    }
    if (!res.tier) return { ...base, classifierUsage: res.usage };
    const why = res.tier === 'haiku' ? '(classifier: simple request)' : res.tier === 'opus' ? '(classifier: hard request)' : '(classifier: normal request)';
    return { ...choose(req, res.tier, 'classifier', why), classifierUsage: res.usage };
  }

  upgrade(req: RouteRequest, reason: string): RouteChoice {
    return choose(req, 'opus', 'stronger', 'because the bot moved up: ' + reason);
  }

  escalate(req: RouteRequest, prev: RouteChoice, after: 'error_max_turns' | 'error'): RouteChoice {
    if (after === 'error_max_turns') return prev;
    if (!isAuto(req.bot) || prev.tier === 'opus' || prev.reason === 'background') return prev;
    const next = choose(req, 'opus', 'retry', 'after an error (retry)');
    return next.model === prev.model ? prev : next;
  }
}
