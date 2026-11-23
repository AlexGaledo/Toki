import type { Bot, HandoffPayload, Message } from '@pocketrocket/shared';
import type { Repos } from '../db/repos.js';
import type { RoomRouter } from '../rooms/RoomRouter.js';
import { events } from '../events.js';
import { settings } from './SettingsStore.js';
import { parseOwnerRef } from '../rooms/ownerRef.js';

export const HANDOFF_NUDGE_MS = (Number(process.env.POCKETROCKET_HANDOFF_NUDGE_MIN) || 10) * 60_000;
export const MAX_RESUMES = 1;

export const RESUME_NOTE =
  '(The hub restarted while you were working on this, so your last turn was cut off. Continue where you left off: ' +
  'check what is already done before repeating anything, and do not start over.)';

interface Watch {
  messageId: string;
  roomId: string;
  seq: number;
  fromBotId: string;
  toBotId: string;
  causeId: string;
  hop: number;
  dueAt: number;
}

export interface FollowUpDeps {
  repos: Repos;
  router: RoomRouter;
  nudgeAfterMs?: number;
  sweepMs?: number;
  now?: () => number;
  heldRuns?: () => string[];
}

export class FollowUp {
  private watches = new Map<string, Watch>();
  private off: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly nudgeAfterMs: number;
  private readonly now: () => number;

  constructor(private deps: FollowUpDeps) {
    this.nudgeAfterMs = deps.nudgeAfterMs ?? HANDOFF_NUDGE_MS;
    this.now = deps.now ?? Date.now;
  }

  start() {
    this.off ??= events.onEvent((ev) => {
      if (ev.type === 'message.new' && ev.message.kind === 'handoff') this.watch(ev.message);
    });
    if (!this.timer) {
      this.timer = setInterval(() => this.sweep(), this.deps.sweepMs ?? 30_000);
      this.timer.unref?.();
    }
  }
  stop() {
    this.off?.();
    this.off = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  resumeInterrupted(): number {
    const { repos, router } = this.deps;
    const rows = repos.journalTakeAll();
    const routineRuns = (refs: (string | null)[]) => refs.map(parseOwnerRef).flatMap((p) => (p?.kind === 'routine' ? [p.runId] : []));
    const journaledRuns = new Set([...routineRuns(rows.map((r) => r.ownerRef)), ...routineRuns(this.deps.heldRuns?.() ?? [])]);
    for (const run of repos.runningRuns()) if (!journaledRuns.has(run.id)) repos.finishRun(run.id, 'error', null);

    let resumed = 0;
    const noted = new Set<string>();
    for (const row of rows) {
      const bot = repos.getBot(row.botId);
      const room = repos.getRoom(row.roomId);
      const giveUp = !bot || !room || !room.memberIds.includes(bot.id) || row.attempts >= MAX_RESUMES;
      if (giveUp) {
        router.ownerGone(row.ownerRef, 'cut off by a server restart');
        if (bot && room && !noted.has(bot.id + ':' + room.id)) {
          noted.add(bot.id + ':' + room.id);
          router.systemNote(room, '@' + bot.handle + ' was cut off by a server restart again, so it was not resumed. Send a message to continue.', row.causeId, row.hop);
        }
        continue;
      }
      if (!noted.has(bot.id + ':' + room.id)) {
        noted.add(bot.id + ':' + room.id);
        router.systemNote(room, 'The server restarted while @' + bot.handle + ' was working; resuming.', row.causeId, row.hop);
      }
      router.resume(bot, room, {
        causeId: row.causeId, hop: row.hop, triggerSeq: row.triggerSeq, attempts: row.attempts + 1,
        ...(row.ownerRef ? { ownerRef: row.ownerRef } : {}),
        ...(row.messageId ? { messageId: row.messageId } : {}),
        note: row.note ? row.note + '\n' + RESUME_NOTE : RESUME_NOTE,
      });
      resumed++;
    }
    return resumed;
  }

  watch(m: Message) {
    const p = m.payload as HandoffPayload | null;
    if (!p?.toBotId || !m.causeId || p.workRoomId) return;
    this.watches.set(m.id, {
      messageId: m.id, roomId: m.roomId, seq: m.seq, fromBotId: p.fromBotId, toBotId: p.toBotId,
      causeId: m.causeId, hop: m.hop, dueAt: this.now() + this.nudgeAfterMs,
    });
  }
  get watching(): number {
    return this.watches.size;
  }

  sweep(now = this.now()): string[] {
    const { repos, router } = this.deps;
    const nudged: string[] = [];
    for (const w of [...this.watches.values()]) {
      if (w.dueAt > now) continue;
      const room = repos.getRoom(w.roomId);
      const target = repos.getBot(w.toBotId);
      if (!room || !target) {
        this.watches.delete(w.messageId);
        continue;
      }
      if (router.isBusy(target.id, room.id)) continue;
      this.watches.delete(w.messageId);
      const replied = repos
        .messagesAfter(room.id, w.seq)
        .some((m) => m.authorType === 'bot' && m.authorId === target.id && (m.kind === 'text' || m.kind === 'handoff'));
      if (replied) continue;

      const member = (id: string | null | undefined): Bot | undefined =>
        id && room.memberIds.includes(id) && id !== target.id ? repos.getBot(id) : undefined;
      const nudgee = member(room.coordinatorBotId) ?? member(w.fromBotId);
      if (!nudgee) continue;
      const from = repos.getBot(w.fromBotId);
      const mins = Math.max(1, Math.round(this.nudgeAfterMs / 60_000));
      router.systemNote(
        room,
        '@' + target.handle + ' has not answered the handoff #' + w.seq + ' after ' + mins + ' min; nudging @' + nudgee.handle + '.',
        w.causeId, w.hop,
      );
      const ok = router.followUp(room, nudgee, {
        causeId: w.causeId,
        hop: w.hop,
        note:
          '(Follow-up: @' + target.handle + ' has not answered handoff #' + w.seq + (from ? ' from @' + from.handle : '') +
          ' after ' + mins + ' minutes. Decide what to do: do it yourself, give it to another bot, or tell ' +
          settings.get().userName + ' it is stuck. Do not hand it to @' + target.handle + ' again unless something changed.)',
      });
      if (ok) nudged.push(nudgee.handle);
    }
    return nudged;
  }
}
