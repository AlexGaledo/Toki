import { Cron } from 'croner';
import type { Routine, RoutinePayload } from '@pocketrocket/shared';
import type { Repos } from '../db/repos.js';
import type { RoomRouter } from '../rooms/RoomRouter.js';
import { events } from '../events.js';
import { settings } from './SettingsStore.js';

export type Schedule = { cron: string; onceAt: number | null };

export class RoutineScheduler {
  private jobs = new Map<string, Cron>();
  private offSettings: (() => void) | null = null;
  private zone = '';
  workflows?: (routineId: string, manual: boolean) => boolean;

  constructor(private repos: Repos, private router: RoomRouter, private opts: { timezone?: () => string } = {}) {}

  timezone(): string {
    return this.opts.timezone?.() ?? settings.get().timezone;
  }

  static validate(expr: string, timezone?: string): string | null {
    try {
      const c = new Cron(expr, { paused: true, timezone });
      c.stop();
      return null;
    } catch (e) {
      return String((e as Error).message ?? e);
    }
  }

  static resolveSchedule(i: { cron?: string; onceAt?: number | string | null }, timezone: string, now = Date.now()): Schedule | { error: string } {
    if (i.onceAt !== undefined && i.onceAt !== null) {
      let at: number | null;
      if (typeof i.onceAt === 'number') at = i.onceAt;
      else {
        try {
          const c = new Cron(i.onceAt, { paused: true, timezone });
          at = c.nextRun()?.getTime() ?? null;
          c.stop();
        } catch (e) {
          return { error: 'Invalid once_at "' + i.onceAt + '": ' + String((e as Error).message ?? e) };
        }
      }
      if (at === null || at <= now) return { error: 'once_at is in the past (' + timezone + ').' };
      return { cron: '', onceAt: at };
    }
    const cron = (i.cron ?? '').trim();
    if (!cron) return { error: 'A routine needs a cron pattern or a one-shot time (once_at).' };
    const bad = RoutineScheduler.validate(cron, timezone);
    return bad ? { error: 'Invalid cron: ' + bad } : { cron, onceAt: null };
  }

  start() {
    this.reload();
    this.zone = this.timezone();
    this.offSettings ??= events.onEvent((ev) => {
      if (ev.type === 'settings.changed' && ev.settings.timezone !== this.zone) {
        this.zone = ev.settings.timezone;
        this.reload();
      }
    });
    const now = Date.now();
    for (const r of this.repos.listRoutines()) {
      if (r.enabled && r.onceAt !== null && r.onceAt <= now) this.fire(r.id);
    }
  }
  stop() {
    this.clearJobs();
    this.offSettings?.();
    this.offSettings = null;
  }
  private clearJobs() {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
  }
  reload() {
    this.clearJobs();
    for (const r of this.repos.listRoutines()) if (r.enabled) this.schedule(r);
    events.emitEvent({ type: 'routines.changed' });
  }
  private schedule(r: Routine) {
    try {
      let job: Cron;
      if (r.onceAt !== null) {
        if (r.onceAt <= Date.now()) {
          this.repos.updateRoutine(r.id, { nextRunAt: null });
          return;
        }
        job = new Cron(new Date(r.onceAt), { protect: true }, () => {
          this.fire(r.id);
        });
      } else {
        job = new Cron(r.cron, { protect: true, timezone: this.timezone() }, () => {
          this.fire(r.id);
        });
      }
      this.jobs.set(r.id, job);
      const next = job.nextRun();
      this.repos.updateRoutine(r.id, { nextRunAt: next ? next.getTime() : null });
    } catch (e) {
      console.error('[routine ' + r.name + '] invalid schedule: ' + (r.onceAt ?? r.cron), e);
    }
  }

  fire(routineId: string, opts: { manual?: boolean } = {}): boolean {
    const r = this.repos.getRoutine(routineId);
    if (!r) return false;
    if (this.workflows?.(r.id, !!opts.manual)) {
      this.afterFire(r, opts);
      return true;
    }
    const bot = this.repos.getBot(r.botId);
    const room = this.repos.getRoom(r.roomId);
    if (!bot || !room) return false;
    const run = this.repos.createRun(r.id, null);
    const payload: RoutinePayload = { routineId: r.id, runId: run.id, name: r.name, ...(opts.manual ? { manual: true } : {}) };
    const msg = this.router.fireRoutine(room, bot, '[Routine "' + r.name + '"] ' + r.prompt, payload, (res) => {
      this.repos.finishRun(run.id, res.ok ? 'success' : 'error', res.costUsd);
    });
    this.repos.db.run('UPDATE routine_runs SET message_id=? WHERE id=?', msg.id, run.id);
    this.afterFire(r, opts);
    events.emitEvent({ type: 'routine.fired', routineId: r.id, runId: run.id, botId: bot.id, roomId: room.id });
    return true;
  }

  private afterFire(r: Routine, opts: { manual?: boolean }) {
    if (r.onceAt !== null && !opts.manual) {
      this.jobs.get(r.id)?.stop();
      this.jobs.delete(r.id);
      this.repos.updateRoutine(r.id, { lastRunAt: Date.now(), nextRunAt: null, enabled: false });
    } else {
      const next = r.onceAt !== null ? (r.enabled && r.onceAt > Date.now() ? r.onceAt : null) : this.jobs.get(r.id)?.nextRun()?.getTime();
      this.repos.updateRoutine(r.id, { lastRunAt: Date.now(), nextRunAt: next ?? null });
    }
  }
}
