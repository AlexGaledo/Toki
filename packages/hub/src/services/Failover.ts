import type { Bot, BotBackup, FailoverActive, FailoverDecision, FailoverState, ProviderId } from '@pocketrocket/shared';
import { publicCard, type FailoverRecord, type FailoverRepo } from '../db/failoverRepo.js';
import type { Repos } from '../db/repos.js';
import type { TurnLimit } from '../providers/types.js';
import { resetTime } from '../agent/turnFailure.js';
import { DEFAULT_HOLD_MS } from './ProviderHealth.js';

export class FailoverError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface LimitedTurn {
  bot: Bot;
  roomId: string;
  causeId: string;
  hop: number;
  limit: TurnLimit;
  provider: ProviderId;
  model?: string;
  stopped: boolean;
  onBackup: boolean;
  fromSeq: number;
  toSeq: number;
  budgetLeftUsd: number | null;
}

export type ContinueTurn = (c: {
  botId: string; roomId: string; causeId: string; hop: number; backup: BotBackup; fromSeq: number; toSeq: number; budgetUsd: number | null;
}) => boolean;

export interface FailoverDeps {
  repo: FailoverRepo;
  repos: Repos;
  label: (id: ProviderId) => string;
  enabled: (id: ProviderId) => boolean;
  isHeld: (id: ProviderId, model?: string) => boolean;
  note: (roomId: string, text: string, causeId: string | null, hop: number) => void;
  continueTurn: ContinueTurn;
  onChange?: (s: FailoverState) => void;
  now?: () => number;
  timeZone?: string;
}

const MIN_BUDGET_USD = 0.01;

const sameBackup = (a: BotBackup | null | undefined, b: BotBackup | null | undefined) =>
  !!a && !!b && a.provider === b.provider && a.model === b.model;

export class FailoverService {
  private now: () => number;
  private lastActive = '';

  constructor(private deps: FailoverDeps) {
    this.now = deps.now ?? Date.now;
  }

  limited(t: LimitedTurn): FailoverRecord | null {
    if (t.limit.kind !== 'usage' || t.stopped || t.onBackup) return null;
    const backup = t.bot.backup;
    if (!backup || !this.deps.enabled(backup.provider)) return null;
    if (backup.provider === t.provider && (!t.model || backup.model === t.model)) return null;
    if (this.deps.isHeld(backup.provider, backup.model)) return null;
    if (t.budgetLeftUsd !== null && t.budgetLeftUsd < MIN_BUDGET_USD) return null;
    const at = this.now();
    const expiresAt = t.limit.resetsAt && t.limit.resetsAt > at ? t.limit.resetsAt : at + DEFAULT_HOLD_MS;
    const open = this.deps.repo.pendingFor(t.bot.id, t.roomId);
    let card: FailoverRecord;
    if (open && sameBackup(open.backup, backup)) {
      this.deps.repo.refresh(open.id, { causeId: t.causeId, hop: t.hop, toSeq: t.toSeq, budgetUsd: t.budgetLeftUsd, expiresAt, resetsAt: t.limit.resetsAt });
      card = this.deps.repo.get(open.id)!;
    } else {
      if (open) this.expire(open, 'replaced');
      card = this.deps.repo.insert({
        botId: t.bot.id, roomId: t.roomId, causeId: t.causeId, hop: t.hop, provider: t.provider,
        ...(t.model ? { model: t.model } : {}), ...(t.limit.window ? { window: t.limit.window } : {}),
        backup: { provider: backup.provider, model: backup.model },
        ...(t.limit.resetsAt ? { resetsAt: t.limit.resetsAt } : {}), expiresAt, createdAt: at,
        fromSeq: t.fromSeq, toSeq: t.toSeq, budgetUsd: t.budgetLeftUsd,
      });
    }
    this.changed();
    return card;
  }

  /** The REST route in front of this refuses anyone but an owner principal. */
  decide(id: string, d: FailoverDecision): FailoverRecord {
    const card = this.deps.repo.get(id);
    if (!card) throw new FailoverError(404, 'Card not found');
    if (card.status !== 'pending') throw new FailoverError(409, 'This card was already answered.');
    if (card.expiresAt <= this.now()) {
      this.expire(card, 'expired');
      this.changed();
      throw new FailoverError(409, 'This card expired.');
    }
    const bot = this.deps.repos.getBot(card.botId);
    const room = this.deps.repos.getRoom(card.roomId);
    if (!bot || !room || !room.memberIds.includes(bot.id)) {
      this.expire(card, 'gone');
      this.changed();
      throw new FailoverError(409, 'That bot is no longer in this chat.');
    }
    const to = this.deps.label(card.backup.provider);
    const from = this.deps.label(card.provider);
    if (d.decision === 'wait') {
      this.deps.repo.settle(card.id, 'waited', this.now());
      this.deps.note(card.roomId, bot.name + ' waits for ' + from + ' to reset' + this.at(card) + '. Send a message after that to pick it up.', card.causeId, card.hop);
      this.changed();
      return this.deps.repo.get(card.id)!;
    }
    // Only on the backup the card offered, and only while it can run.
    if (!sameBackup(bot.backup, card.backup)) {
      this.expire(card, 'gone');
      this.changed();
      throw new FailoverError(409, bot.name + "'s backup changed since this card was raised. Send the message again.");
    }
    if (!this.deps.enabled(card.backup.provider)) throw new FailoverError(409, to + ' is not enabled on this hub.');
    if (this.deps.isHeld(card.backup.provider, card.backup.model)) throw new FailoverError(409, to + ' is at its own limit right now.');
    if (!this.deps.repo.settle(card.id, 'continued', this.now())) throw new FailoverError(409, 'This card was already answered.');
    this.deps.note(
      card.roomId,
      bot.name + ' continues on ' + to + ' (' + card.backup.model + '), with approvals on. Until ' + from + ' resets' + this.at(card) +
        ', what you send ' + bot.name + ' runs there too.',
      card.causeId, card.hop,
    );
    const queued = this.deps.continueTurn({
      botId: card.botId, roomId: card.roomId, causeId: card.causeId, hop: card.hop, backup: card.backup,
      fromSeq: card.fromSeq, toSeq: card.toSeq, budgetUsd: card.budgetUsd,
    });
    if (!queued) this.deps.note(card.roomId, bot.name + ' could not be queued on ' + to + '.', card.causeId, card.hop);
    this.changed();
    return this.deps.repo.get(card.id)!;
  }

  stickyFor(botId: string): BotBackup | null {
    const bot = this.deps.repos.getBot(botId);
    if (!bot?.backup) return null;
    const hit = this.deps.repo.listActive(this.now()).filter((c) => c.botId === botId).at(-1);
    if (!hit || !sameBackup(hit.backup, bot.backup) || !this.deps.enabled(hit.backup.provider)) return null;
    return { ...hit.backup };
  }

  sweep() {
    const t = this.now();
    this.deps.repo.pruneOrphans(this.deps.repos.listBots().map((b) => b.id), this.deps.repos.listRooms().map((r) => r.id));
    let n = 0;
    for (const c of this.deps.repo.listPending()) {
      if (c.expiresAt > t) continue;
      this.expire(c, 'expired');
      n++;
    }
    if (n || this.activeKey() !== this.lastActive) this.changed();
  }

  state(): FailoverState {
    const t = this.now();
    return {
      cards: this.deps.repo.listPending().filter((c) => c.expiresAt > t).map(publicCard),
      active: this.active(),
    };
  }

  private active(): FailoverActive[] {
    const seen = new Set<string>();
    const out: FailoverActive[] = [];
    for (const c of this.deps.repo.listActive(this.now()).reverse()) {
      if (seen.has(c.botId) || !this.stickyFor(c.botId)) continue;
      seen.add(c.botId);
      out.push({ botId: c.botId, from: c.provider, backup: { ...c.backup }, until: c.expiresAt });
    }
    return out;
  }

  private activeKey(): string {
    return this.active().map((a) => a.botId + '@' + a.until).join(',');
  }

  private expire(card: FailoverRecord, why: 'expired' | 'replaced' | 'gone') {
    if (!this.deps.repo.settle(card.id, 'expired', this.now())) return;
    if (why !== 'expired') return;
    const bot = this.deps.repos.getBot(card.botId);
    if (!bot || !this.deps.repos.getRoom(card.roomId)) return;
    this.deps.note(
      card.roomId,
      'Not continued on ' + this.deps.label(card.backup.provider) + '. ' + this.deps.label(card.provider) +
        (card.resetsAt ? ' reset at ' + resetTime(card.resetsAt, this.now(), this.deps.timeZone) : ' should be available again') +
        '; send ' + bot.name + ' a message to pick it up.',
      card.causeId, card.hop,
    );
  }

  private at(card: FailoverRecord): string {
    return card.resetsAt ? ' at ' + resetTime(card.resetsAt, this.now(), this.deps.timeZone) : '';
  }

  private changed() {
    const s = this.state();
    this.lastActive = s.active.map((a) => a.botId + '@' + a.until).join(',');
    this.deps.onChange?.(s);
  }
}
