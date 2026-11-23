import { useEffect, useState } from 'react';
import { AUTO_MODEL_INFO, BUILTIN_TOOLS, HEAVY_MODEL_HINT, MODELS, DEFAULT_MODEL, isBotIconKey, isHeavyModel, modelOptionLabel, isMediaRef, type Bot, type BotInput, type ProviderId, type ProviderInfo } from '@pocketrocket/shared';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { iconGlyph } from '../../lib/botIcon';
import { BotIconPicker } from './BotIconPicker';
import { Button, Dialog, Field, Input, Label, Select, Textarea, cn, confirmAction } from '../ui';
import { ExportBotControls } from './BotFileDialogs';

const presets = (userName: string): { label: string; v: Partial<BotInput> }[] => [
  { label: 'Chief of staff', v: { name: 'Chief', handle: 'chief', title: 'Chief of staff / coordinator', avatar: 'compass', description: 'You coordinate the other bots. Break requests into tasks, hand them off with @handle or the handoff tool, then summarize results for ' + (userName.trim() || 'the user') + '. If a needed role is missing, create it with create_bot (focused role, clear instructions) or add an existing bot with add_to_room. Do not do specialist work yourself when a specialist is in the room.' } },
  { label: 'Researcher', v: { name: 'Researcher', handle: 'researcher', title: 'Web research', avatar: 'search', description: 'You research using WebSearch/WebFetch and write concise findings with sources into the shared workspace as markdown.', allowedTools: ['Read', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'] } },
  { label: 'Developer', v: { name: 'Dev', handle: 'dev', title: 'Software engineer', avatar: 'wrench', description: 'You implement and test code in the shared workspace. Prefer small verified changes; run tests with Bash before reporting done.' } },
  { label: 'Writer', v: { name: 'Writer', handle: 'writer', title: 'Copy & docs', avatar: 'pen', description: 'You write and edit prose: docs, emails, posts. Keep a consistent voice; ask for the audience if unclear.', allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch'] } },
];
function modelsOf(p: ProviderInfo | undefined): { id: string; label: string; note?: string; default?: boolean }[] {
  return p?.models.length ? p.models : MODELS.map((m) => ({ id: m.id, label: m.label as string }));
}

function providerOptionLabel(p: ProviderInfo | undefined): string {
  return p ? p.label + (p.maturity === 'untested' ? ' (untested)' : '') : '';
}

function useAutomationCount(botId: string | null): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    if (!botId) return;
    let live = true;
    Promise.all([api.routines.list(), api.triggers.get()])
      .then(([routines, t]) => {
        const r = routines.filter((x) => x.botId === botId && x.enabled).length;
        const g = t.triggers.filter((x) => x.botId === botId && x.enabled).length;
        const parts = [r ? r + (r === 1 ? ' schedule' : ' schedules') : '', g ? g + (g === 1 ? ' trigger' : ' triggers') : ''].filter(Boolean);
        if (live) setText(parts.length ? parts.join(' and ') : null);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [botId]);
  return text;
}

const DEFAULT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];

function PresetIcon({ icon }: { icon?: string }) {
  const Glyph = iconGlyph(icon);
  return <Glyph aria-hidden size={14} strokeWidth={1.75} />;
}

export function BotDialog({ bot, onClose }: { bot: Bot | null; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const device = useStore((s) => s.device);
  const list = providers?.providers ?? [];
  const pickProvider = list.length > 1 && !device;
  const [f, setF] = useState<BotInput>({
    name: bot?.name ?? '', handle: bot?.handle ?? '', title: bot?.title ?? '', description: bot?.description ?? '', avatar: bot && (isBotIconKey(bot.avatar) || isMediaRef(bot.avatar)) ? bot.avatar : '',
    model: bot?.model ?? settings.defaultModel ?? DEFAULT_MODEL, allowedTools: bot?.allowedTools ?? DEFAULT_TOOLS, maxBudgetUsd: bot?.maxBudgetUsd ?? 2,
    provider: bot?.provider ?? null, backup: bot?.backup ?? null,
  });
  const runsOn = list.find((p) => p.id === (f.provider ?? settings.provider));
  const models: { id: string; label: string; note?: string }[] = [AUTO_MODEL_INFO, ...modelsOf(runsOn)];
  const automations = useAutomationCount(bot && pickProvider && runsOn && runsOn.id !== 'claude' ? bot.id : null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<BotInput>) => setF({ ...f, ...p });
  const setProvider = (provider: ProviderId | null) => {
    const next = modelsOf(list.find((p) => p.id === (provider ?? settings.provider)));
    const model = f.model === AUTO_MODEL_INFO.id || next.some((m) => m.id === f.model) ? f.model : (next.find((m) => m.default) ?? next[0])?.id ?? f.model;
    const runs = provider ?? settings.provider;
    set({ provider, model, backup: f.backup?.provider === runs ? null : f.backup });
  };
  const backupChoices = list.filter((p) => p.id !== (f.provider ?? settings.provider));
  const setBackupProvider = (id: ProviderId | null) => {
    if (!id) return set({ backup: null });
    const ms = modelsOf(list.find((p) => p.id === id));
    set({ backup: { provider: id, model: (ms.find((m) => m.default) ?? ms[0])?.id ?? '' } });
  };
  const autoHandle = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);

  const save = async () => {
    setBusy(true);
    try {
      const { provider, backup, ...rest } = f;
      const input: BotInput = pickProvider ? { ...rest, provider, backup: backup?.model ? backup : null } : rest;
      if (bot) {
        await api.bots.update(bot.id, input);
      } else {
        const created = await api.bots.create(input);
        try {
          const room = await api.rooms.create({ kind: 'dm', name: created.name, memberIds: [created.id], coordinatorBotId: null });
          useStore.getState().setActiveRoom(room.id);
        } catch (e) {
          toast(created.name + " created. Couldn't open its chat: " + (e as Error).message, true);
        }
      }
      onClose();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!bot || !(await confirmAction({ title: 'Delete ' + bot.name + '?', body: 'Chat history stays.', confirmLabel: 'Delete', danger: true }))) return;
    setBusy(true);
    try {
      await api.bots.remove(bot.id);
      onClose();
    } catch (e) {
      toast("Couldn't delete " + bot.name + ': ' + (e as Error).message, true);
    } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={bot ? 'Edit ' + bot.name : 'New bot'} wide>
      {!bot && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {presets(settings.userName).map((p) => <Button key={p.label} size="sm" onClick={() => set({ ...p.v, allowedTools: p.v.allowedTools ?? DEFAULT_TOOLS })}><PresetIcon icon={p.v.avatar} />{p.label}</Button>)}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field><Label>Name</Label><Input value={f.name} onChange={(e) => set({ name: e.target.value, handle: bot ? f.handle : autoHandle(e.target.value) })} placeholder="Researcher" autoFocus /></Field>
        <Field><Label hint="mention as @handle">Handle</Label><Input value={f.handle} onChange={(e) => set({ handle: e.target.value.toLowerCase() })} placeholder="researcher" className="font-mono" /></Field>
      </div>
      {!device && <BotIconPicker botId={bot?.id ?? null} value={f.avatar} onChange={(avatar) => set({ avatar })} />}
      <Field className="mt-3"><Label>Title</Label><Input value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="Web research & summaries" /></Field>
      <Field className="mt-3">
        <Label hint="The bot's instructions">Role description</Label>
        <Textarea rows={5} value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder="What it does, and what to avoid." />
      </Field>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {pickProvider && (
          <Field className="sm:col-span-2">
            <Label>Provider</Label>
            <Select value={f.provider ?? ''} onChange={(e) => setProvider((e.target.value || null) as ProviderId | null)}>
              <option value="">Default ({providerOptionLabel(list.find((p) => p.id === settings.provider)) || settings.provider})</option>
              {list.map((p) => <option key={p.id} value={p.id}>{providerOptionLabel(p)}</option>)}
            </Select>
            {runsOn?.maturity === 'untested' && <p className="mt-1 text-hint text-warn">{runsOn.label} is untested. Check approvals before actions outside the shared folder.</p>}
            {automations && runsOn && (
              <p role="status" className="mt-1 text-hint text-warn">
                {(f.name || 'This bot') + ' has ' + automations + '. They will run on ' + runsOn.label + ' with nobody watching'}
                {runsOn.maturity === 'untested' ? ', and it is untested: check the first run.' : '. Check the first run.'}
              </p>
            )}
          </Field>
        )}
        <Field>
          <Label>Model</Label>
          <Select value={f.model} onChange={(e) => set({ model: e.target.value })}>
            {models.map((m) => <option key={m.id} value={m.id}>{modelOptionLabel(m)}</option>)}
            {!models.some((m) => m.id === f.model) && <option value={f.model}>{f.model}</option>}
          </Select>
          {isHeavyModel(f.model) && <p className="mt-1 text-hint text-muted">This model {HEAVY_MODEL_HINT}. Sonnet or Auto suits most bots.</p>}
        </Field>
        <Field><Label hint="stops a runaway reply">Usage limit per reply (API-price USD)</Label><Input type="number" step="0.5" min="0.05" value={f.maxBudgetUsd} onChange={(e) => set({ maxBudgetUsd: Number(e.target.value) })} /></Field>
        {pickProvider && backupChoices.length > 0 && (
          <>
            <Field className={f.backup ? undefined : 'sm:col-span-2'}>
              <Label hint="Asks you first">{'If ' + (runsOn?.label ?? 'it') + ' hits its limit'}</Label>
              <Select value={f.backup?.provider ?? ''} onChange={(e) => setBackupProvider((e.target.value || null) as ProviderId | null)}>
                <option value="">None: wait for the reset</option>
                {backupChoices.map((p) => <option key={p.id} value={p.id}>{'Continue on ' + providerOptionLabel(p)}</option>)}
                {f.backup && !backupChoices.some((p) => p.id === f.backup!.provider) && <option value={f.backup.provider}>{'Continue on ' + f.backup.provider}</option>}
              </Select>
            </Field>
            {f.backup && (
              <Field>
                <Label>Backup model</Label>
                <Select value={f.backup.model} onChange={(e) => set({ backup: { provider: f.backup!.provider, model: e.target.value } })}>
                  {modelsOf(list.find((p) => p.id === f.backup!.provider)).map((m) => <option key={m.id} value={m.id}>{modelOptionLabel(m)}</option>)}
                  {!modelsOf(list.find((p) => p.id === f.backup!.provider)).some((m) => m.id === f.backup!.model) && <option value={f.backup.model}>{f.backup.model}</option>}
                </Select>
              </Field>
            )}
          </>
        )}
      </div>
      <div className="mt-3">
        <Label id="bot-tools-label">Tools</Label>
        <div role="group" aria-labelledby="bot-tools-label" className="flex flex-wrap gap-1.5">
          {BUILTIN_TOOLS.filter((t) => t !== 'Skill' && t !== 'MultiEdit' && t !== 'NotebookEdit').map((t) => {
            const on = f.allowedTools.includes(t);
            return (
              <button key={t} type="button" aria-pressed={on} onClick={() => set({ allowedTools: on ? f.allowedTools.filter((x) => x !== t) : [...f.allowedTools, t] })}
                className={cn('rounded-xs border px-2 py-1 text-hint font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', on ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line bg-card text-muted')}>{t}</button>
            );
          })}
        </div>
        <p className="mt-1.5 text-hint text-dim">Browser: web. Desktop: whole screen. Bash: sees other bots' logins.</p>
      </div>
      {bot && !device && <ExportBotControls bot={bot} />}
      <div className="mt-5 flex items-center justify-between">
        <div>{bot && <Button variant="danger" size="sm" onClick={remove} disabled={busy}>Delete bot</Button>}</div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || !f.name || !/^[a-z0-9_-]{2,24}$/.test(f.handle)}>{bot ? 'Save' : 'Create bot'}</Button>
        </div>
      </div>
    </Dialog>
  );
}
