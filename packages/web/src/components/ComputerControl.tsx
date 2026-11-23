import { useId, useState } from 'react';
import { Hand, MonitorUp, Pause, Play } from 'lucide-react';
import type { ApprovalPayload, Bot, ComputerControl, ControlStatus, Message, TakeoverPayload } from '@pocketrocket/shared';
import { useStore, botById } from '../store';
import { api } from '../lib/api';
import { deviceId, hasComputer, holdsScreen } from '../lib/screenView';
import { ActionCard, ActionCardHeader, Button, Input, cn } from './ui';
import { broadPattern, suggestPattern } from '../lib/rulePattern';

const DEFAULT: Omit<ControlStatus, 'botId'> = { control: 'agent', holder: null, since: 0, takeover: null };

export function useControl(botId: string | undefined): ControlStatus {
  const c = useStore((s) => (botId ? s.control[botId] : undefined));
  return c ?? { botId: botId ?? '', ...DEFAULT };
}

export { hasComputer };

function useSetControl(bot: Bot) {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const run = async (control: ComputerControl, note?: string) => {
    setBusy(true);
    try {
      const st = await api.control.set(bot.id, control, { holder: deviceId(), ...(note ? { note } : {}) });
      useStore.setState((s) => ({ control: { ...s.control, [bot.id]: st } }));
    } catch (e) {
      toast("Couldn't switch control: " + (e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export function ControlBar({ bot, canTake }: { bot: Bot; canTake: boolean }) {
  const c = useControl(bot.id);
  const { busy, run } = useSetControl(bot);
  const [note, setNote] = useState('');
  const noteId = useId();
  const held = holdsScreen(c);
  const handBack = async () => {
    await run('agent', note.trim() || undefined);
    setNote('');
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-hint" role="group" aria-label={bot.name + "'s screen control"}>
      {c.control === 'agent' && canTake && (
        <>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void run('user')} title="Bot's browser and desktop stop until you return it.">
            <MonitorUp size={13} /> Take over
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run('paused')} title="Bot waits until you resume.">
            <Pause size={13} /> Pause
          </Button>
        </>
      )}
      {c.control === 'user' && !held && (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void run('user')}>
          <MonitorUp size={13} /> {c.holder ? 'Take here' : 'Take over'}
        </Button>
      )}
      {held && (
        <>
          <label htmlFor={noteId} className="sr-only">Note (never passwords)</label>
          <Input id={noteId} className="h-8 min-w-0 flex-1 basis-40 text-hint" placeholder="Note (never passwords)" value={note} maxLength={2000}
            onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void handBack(); }} />
          <Button variant="primary" disabled={busy} title="Hand back" onClick={() => void handBack()}>
            <Hand size={13} /> Hand back
          </Button>
        </>
      )}
      {c.control === 'paused' && (
        <Button size="sm" variant="primary" disabled={busy} title="Resume" onClick={() => void run('agent')}>
          <Play size={13} /> Resume
        </Button>
      )}
    </div>
  );
}

const CANT_DO = "I can't do this one. Find another way, or tell me what you need from me.";

export function TakeoverCard({ m }: { m: Message }) {
  const p = m.payload as TakeoverPayload;
  const bots = useStore((s) => s.bots);
  const bot = botById(bots, p.botId);
  const open = p.status === 'waiting' || p.status === 'parked';
  const outcome = p.status === 'done' ? 'Handed back' : p.status === 'expired' ? 'No longer waiting' : null;
  return (
    <ActionCard tone={open ? 'warn' : 'quiet'} className="max-w-[640px]">
      <ActionCardHeader meta={outcome && <span className="pt-0.5 text-hint text-muted">{outcome}</span>}>
        <span className="min-w-0 flex-1 font-medium">{bot ? bot.name : 'A bot'} {open ? 'needs you' : 'needed you'}: {p.reason}</span>
      </ActionCardHeader>
      {p.note && <div className="px-4 pt-1 text-ui text-muted">Your note: {p.note}</div>}
      {open && bot ? <TakeoverActions bot={bot} /> : <div className="h-3" />}
    </ActionCard>
  );
}

function TakeoverActions({ bot }: { bot: Bot }) {
  const c = useControl(bot.id);
  const { busy, run } = useSetControl(bot);
  if (holdsScreen(c)) return <p className="px-4 pb-3 pt-1 text-ui text-muted">You have control. Hand back from the screen.</p>;
  const take = () => {
    useStore.setState({ panelBotId: bot.id });
    void run('user');
  };
  return (
    <div className="flex flex-col gap-2.5 px-4 pb-4 pt-1">
      <p className="text-ui text-muted">The bot can't act while you have control. It can read the page after you hand back.</p>
      {c.holder && <p className="text-ui text-muted">Held on another device.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" className="touch-target" disabled={busy} onClick={take}><MonitorUp size={14} aria-hidden /> {c.holder ? 'Take here' : 'Take over'}</Button>
        <Button className="touch-target" disabled={busy} onClick={() => void run('agent', CANT_DO)}>I can't do this</Button>
      </div>
    </div>
  );
}

const RULE_OFFER_AFTER = 3;

function approvedCount(messages: Record<string, Message[]>, botId: string | null, toolName: string, pattern: string): number {
  let n = 0;
  for (const list of Object.values(messages)) {
    for (const m of list) {
      if (m.kind !== 'approval' || m.authorId !== botId) continue;
      const a = m.payload as ApprovalPayload;
      if ((a.status === 'allow' || a.status === 'always') && a.toolName === toolName && suggestPattern(a) === pattern) n++;
    }
  }
  return n;
}

export function AlwaysAllow({ p, botName, onCancel, onSaved }: { p: ApprovalPayload; botName: string; onCancel: () => void; onSaved: () => void }) {
  const toast = useStore((s) => s.toast);
  const decide = useStore((s) => s.decide);
  const exact = suggestPattern(p);
  const [pattern, setPattern] = useState(broadPattern(p) ?? '*');
  const [saving, setSaving] = useState(false);
  const id = useId();
  const anyCall = pattern.trim() === '*';
  const save = async () => {
    setSaving(true);
    try {
      const trimmed = pattern.trim();
      await api.policies.fromApproval(p.approvalId, trimmed === exact || (anyCall && !exact) ? undefined : trimmed);
      decide(p.approvalId, 'allow');
      onSaved();
    } catch (e) {
      setSaving(false);
      toast("Couldn't save the rule: " + (e as Error).message, true);
    }
  };
  return (
    <div className="flex basis-full flex-col gap-1.5 text-ui">
      <label htmlFor={id} className="text-muted">Always allow {botName}:</label>
      <div className="flex flex-wrap items-center gap-2">
        <Input id={id} className="h-7 min-w-[160px] flex-1 font-mono text-hint" value={pattern} onChange={(e) => setPattern(e.target.value)} maxLength={500}
          aria-describedby={id + '-hint'} autoFocus />
        <Button size="sm" variant={anyCall ? 'outline' : 'primary'} className="touch-target" disabled={saving || !pattern.trim()} onClick={() => void save()}>{anyCall ? 'Allow every ' + p.toolName + ' call' : 'Save and allow'}</Button>
        <Button size="sm" variant="ghost" className="touch-target" onClick={onCancel}>Cancel</Button>
      </div>
      <span id={id + '-hint'} className="text-hint text-dim">Ends with *: anything starting with that. Kept after restarts; risky commands still ask. Revoke in Settings › Bots.</span>
    </div>
  );
}

export function RuleOffer({ p, botId, botName }: { p: ApprovalPayload; botId: string | null; botName: string }) {
  const toast = useStore((s) => s.toast);
  const [state, setState] = useState<'offer' | 'saving' | 'saved' | 'dismissed'>('offer');
  const initial = suggestPattern(p);
  const [pattern, setPattern] = useState(initial ?? '');
  const count = useStore((s) => (initial ? approvedCount(s.messages, botId, p.toolName, initial) : 0));
  const id = useId();
  if (p.danger || !initial || count < RULE_OFFER_AFTER || state === 'dismissed') return null;
  if (state === 'saved') return <div className="px-4 pb-3 text-hint text-muted">Rule saved. Revoke in Settings.</div>;
  const anyCall = pattern.trim() === '*';
  const save = async () => {
    setState('saving');
    try {
      await api.policies.fromApproval(p.approvalId, pattern.trim() !== initial ? pattern.trim() : undefined);
      setState('saved');
    } catch (e) {
      setState('offer');
      toast("Couldn't save the rule: " + (e as Error).message, true);
    }
  };
  return (
    <div className="flex flex-col gap-1.5 border-t border-line px-4 py-3 text-ui">
      <label htmlFor={id} className="text-muted">Never ask {botName} again for:</label>
      <div className="flex flex-wrap items-center gap-2">
        <Input id={id} className="h-7 min-w-[160px] flex-1 font-mono text-hint" value={pattern} onChange={(e) => setPattern(e.target.value)} maxLength={500}
          aria-describedby={id + '-hint'} />
        <Button size="sm" variant={anyCall ? 'outline' : 'primary'} disabled={state === 'saving' || !pattern.trim()} onClick={() => void save()}>{anyCall ? 'Allow every ' + p.toolName + ' call' : 'Make it a rule'}</Button>
        <Button size="sm" variant="ghost" onClick={() => setState('dismissed')}>Not now</Button>
      </div>
      <span id={id + '-hint'} className="text-hint text-dim">Exact match. End with * to widen; * allows all.</span>
    </div>
  );
}

