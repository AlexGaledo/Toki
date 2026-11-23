import { useEffect, useId, useRef, useState } from 'react';
import { Lock, ShieldAlert } from 'lucide-react';
import { AUTO_MEMORY_EVERY, type Approvals, type Bot, type BotInput, type SendMode } from '@pocketrocket/shared';
import { useStore } from '../../store';
import { api, type HealthResponse } from '../../lib/api';
import { Avatar, Badge, Button, Input, RadioCard, Switch } from '../ui';
import { Card, Group, SectionHeader } from './parts';
import { ApprovalRules } from './ApprovalRules';

export function BotsSection({ health, onHealthStale }: {
  health: HealthResponse | null;
  onHealthStale: () => void;
}) {
  const stored = useStore((s) => s.settings.approvals);
  const bots = useStore((s) => s.bots);
  const updateSettings = useStore((s) => s.updateSettings);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  const memoryHintId = useId();

  const locked = !!health?.approvalsLocked;
  const inForce: Approvals = locked && health ? health.approvals : stored;

  const save = async (next: Approvals) => {
    setSaving(true);
    const ok = await updateSettings({ approvals: next });
    setSaving(false);
    setConfirming(false);
    if (!ok) onHealthStale();
  };

  const choose = (next: Approvals) => {
    if (locked || saving) return;
    if (next === inForce) return setConfirming(false);
    if (next === 'bypass') return setConfirming(true);
    void save(next);
  };

  return (
    <>
      <SectionHeader title="Bots" description="How much your bots can do on their own." />

      <Group title="Approvals" titleId={titleId}>
        <div role="radiogroup" aria-labelledby={titleId} aria-disabled={locked || undefined} className="flex flex-col gap-2">
          <RadioCard checked={inForce === 'read-only'} disabled={locked} onSelect={() => choose('read-only')} title="Read only">
            Bots can look around, but every write — files, commands, bot or room changes, sending anything — is refused outright. Nothing to approve.
          </RadioCard>
          <RadioCard checked={inForce === 'ask'} disabled={locked} onSelect={() => choose('ask')} title="Approval" badge={<Badge tone="ok">Recommended</Badge>}>
            Asks before commands, outside files, or bot changes.
          </RadioCard>
          <RadioCard checked={inForce === 'bypass'} disabled={locked} onSelect={() => choose('bypass')} title="Full permission (bypass all)">
            No checks. Only on computers you trust.
          </RadioCard>
        </div>

        {confirming && !locked && <ConfirmBypass saving={saving} onCancel={() => setConfirming(false)} onConfirm={() => void save('bypass')} />}

        {locked ? (
          <p className="mt-3 flex items-start gap-1.5 text-hint leading-snug text-muted">
            <Lock size={13} aria-hidden className="mt-0.5 shrink-0" />
            <span>
              Set by the server's environment (<code className="font-mono text-hint">POCKETROCKET_BYPASS_PERMISSIONS</code>).
            </span>
          </p>
        ) : (
          <p className="mt-3 text-hint text-muted">Applies from each bot's next reply.</p>
        )}
      </Group>

      <BusyMessagesGroup />

      <Group title="Auto-memory">
        <p id={memoryHintId} className="mb-2 text-hint leading-snug text-muted">
          Bots save lasting facts. Only adds, never rewrites.
        </p>
        <Card className="py-1">
          {bots.length
            ? <div className="divide-y divide-line">{bots.map((b) => <AutoMemoryRow key={b.id} bot={b} describedBy={memoryHintId} />)}</div>
            : <p className="py-2 text-ui text-muted">No bots yet.</p>}
        </Card>
      </Group>

      <ApprovalRules />
    </>
  );
}

function BusyMessagesGroup() {
  const value = useStore((s) => s.settings.busyMessages ?? 'join');
  const updateSettings = useStore((s) => s.updateSettings);
  const titleId = useId();
  const choose = (next: SendMode) => { if (next !== value) void updateSettings({ busyMessages: next }); };
  return (
    <Group title="When a bot is busy" titleId={titleId}>
      <div role="radiogroup" aria-labelledby={titleId} className="flex flex-col gap-2">
        <RadioCard checked={value === 'join'} onSelect={() => choose('join')} title="Join the running turn" badge={<Badge tone="ok">Recommended</Badge>}>
          Your message reaches the bot at its next step, so it can change course. Ctrl+Enter queues instead.
        </RadioCard>
        <RadioCard checked={value === 'queue'} onSelect={() => choose('queue')} title="Queue for after">
          The bot reads your message when its reply ends. The menu beside Send can still join.
        </RadioCard>
      </div>
      <p className="mt-3 text-hint text-muted">Only Claude can take a message mid-turn, with a recent Claude CLI. Other providers always queue.</p>
    </Group>
  );
}

function AutoMemoryRow({ bot, describedBy }: { bot: Bot; describedBy: string }) {
  const toast = useStore((s) => s.toast);
  const [on, setOn] = useState(bot.autoMemory);
  const [every, setEvery] = useState(String(bot.autoMemoryEvery));
  useEffect(() => setOn(bot.autoMemory), [bot.autoMemory]);
  useEffect(() => setEvery(String(bot.autoMemoryEvery)), [bot.autoMemoryEvery]);

  const save = async (patch: Partial<BotInput>) => {
    try {
      await api.bots.update(bot.id, patch);
    } catch (e) {
      setOn(bot.autoMemory);
      setEvery(String(bot.autoMemoryEvery));
      toast("Couldn't save that change: " + (e as Error).message, true);
    }
  };
  const commitEvery = () => {
    const n = Math.round(Number(every));
    const next = every.trim() && Number.isFinite(n) ? Math.min(AUTO_MEMORY_EVERY.max, Math.max(AUTO_MEMORY_EVERY.min, n)) : bot.autoMemoryEvery;
    setEvery(String(next));
    if (next !== bot.autoMemoryEvery) void save({ autoMemoryEvery: next });
  };

  return (
    <div className="flex items-center gap-3 py-2.5">
      <Avatar bot={bot} size={28} />
      <span className="min-w-0 flex-1 truncate text-ui font-medium">{bot.name}</span>
      <span className="flex items-center gap-1.5 text-hint text-muted">
        every
        <Input
          type="number" inputMode="numeric" min={AUTO_MEMORY_EVERY.min} max={AUTO_MEMORY_EVERY.max} step={1}
          value={every} disabled={!on} aria-label={'Replies between auto-memory passes for ' + bot.name}
          onChange={(e) => setEvery(e.target.value)} onBlur={commitEvery}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          className="h-7 w-14 px-2 text-center disabled:opacity-40"
        />
        replies
      </span>
      <Switch checked={on} aria-label={'Auto-memory for ' + bot.name} aria-describedby={describedBy} onChange={(next) => { setOn(next); void save({ autoMemory: next }); }} />
    </div>
  );
}

function ConfirmBypass({ saving, onCancel, onConfirm }: { saving: boolean; onCancel: () => void; onConfirm: () => void }) {
  const keepAskingRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  useEffect(() => keepAskingRef.current?.focus(), []);

  return (
    <div role="group" aria-labelledby={headingId} className="mt-3 rounded-lg bg-warn/10 p-4 ring-1 ring-warn/30">
      <div className="flex gap-3">
        <ShieldAlert size={18} aria-hidden className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0">
          <p id={headingId} className="text-ui font-semibold">Turn off approvals?</p>
          <p className="mt-1 text-ui leading-relaxed text-fg">
            Hidden web instructions could run commands here, unchecked.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button ref={keepAskingRef} variant="primary" disabled={saving} onClick={onCancel}>Keep asking</Button>
            <Button variant="danger" disabled={saving} onClick={onConfirm}>{saving ? 'Saving…' : 'Run without asking'}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
