/** Settings › Game tools (spec toki-local-first-gamedev §2, D1): Blender, uv, the Blender MCP tools and Roblox Studio. */
import { useState } from 'react';
import { ExternalLink, FileText, RefreshCw } from 'lucide-react';
import type { GameToolFix, GameToolFixResult, GameToolsStatus } from '@pocketrocket/shared';
import { useStore } from '../../store';
import { api, ApiError } from '../../lib/api';
import { desktopCan } from '../../lib/auth';
import { openStudio, useGameTools } from '../../lib/useGameTools';
import { fixConfirm, fixResultText, gameToolRows, runFix, type GameToolRow, type GameTone } from '../../lib/gameTools';
import { Badge, Banner, Button, Dialog, Skeleton, SkeletonGroup, confirmAction } from '../ui';
import { Card, Group, Private, SectionHeader, shortPath } from './parts';

const BADGE: Record<GameTone, 'ok' | 'warn' | 'bad' | 'muted'> = { ok: 'ok', warn: 'warn', bad: 'bad', muted: 'muted' };

export function GameToolsSection() {
  const { status, error, reload, set } = useGameTools();
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState<GameToolFix | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [log, setLog] = useState<string | null | undefined>(undefined);

  const fix = async (step: GameToolFix) => {
    if (!status || busy) return;
    const ask = fixConfirm(step, status);
    if (ask && !(await confirmAction(ask))) return;
    setBusy(step);
    setProblem(null);
    try {
      const r = await runFix(step, { status: api.gameTools.status, fix: api.gameTools.fix });
      if (!r.sent) {
        set(r.status);
        setProblem(step === 'studio-mcp-setting' && r.status.studio.running ? fixResultText(step, 'studio-running') : 'That step is no longer needed or cannot run yet.');
        return;
      }
      set(r.reply.status);
      toast(fixResultText(step, r.reply.result));
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as Partial<GameToolFixResult> & { detail?: string; result?: string } | undefined) : undefined;
      if (body?.status) set(body.status);
      setProblem(body?.result ? fixResultText(step, body.result, body.detail) : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const openLog = () => {
    setLog(undefined);
    api.gameTools.crashLog().then((r) => setLog(r.log ?? ''), (e: Error) => setProblem(e.message));
  };

  const rows = status ? gameToolRows(status, { studioLauncher: desktopCan('studio') }) : null;
  return (
    <>
      <SectionHeader title="Game tools" description="Blender and Roblox Studio for game rooms. Toki runs its own Blender headless; it never opens a Blender window." />
      <div className="mb-5 space-y-1.5 text-ui text-muted">
        <p>Game tools run code as you on this PC, and follow your approval setting.</p>
        <p>Blender's asset search and model generators, and Roblox Studio's own tools, send prompts to Roblox and other third parties.</p>
      </div>
      {error && <Banner tone="error" className="mb-4" action={<Button size="sm" onClick={reload}>Retry</Button>}>{error}</Banner>}
      {status && !status.supported && <Banner tone="info" className="mb-4">Game tools work on the hub that runs on your Windows PC. This hub can't use them.</Banner>}
      {problem && <Banner tone="error" className="mb-4" onDismiss={() => setProblem(null)}>{problem}</Banner>}
      <Group title="Status" aside={<Button size="sm" variant="ghost" disabled={!status && !error} onClick={reload}><RefreshCw size={13} aria-hidden /> Check again</Button>}>
        {!rows && !error && (
          <SkeletonGroup label="Checking game tools…" className="space-y-2"><Skeleton className="h-16 w-full rounded-lg" /><Skeleton className="h-16 w-full rounded-lg" /></SkeletonGroup>
        )}
        <div className="space-y-3">
          {rows?.map((r) => (
            <ToolRow key={r.id} row={r} status={status!} busy={busy} onFix={(s) => void fix(s)} onOpenLog={openLog} />
          ))}
        </div>
      </Group>
      <Dialog open={log !== undefined} onOpenChange={(o) => !o && setLog(undefined)} title="Blender crash log" description="The last start's output. Secrets are hidden." wide>
        {log === ''
          ? <p className="text-ui text-muted">No crash log.</p>
          : <pre tabIndex={0} className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-card2 p-3 font-mono text-hint [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{log}</pre>}
      </Dialog>
    </>
  );
}

function ToolRow({ row: r, status, busy, onFix, onOpenLog }: { row: GameToolRow; status: GameToolsStatus; busy: GameToolFix | null; onFix: (s: GameToolFix) => void; onOpenLog: () => void }) {
  const whyId = 'game-tool-why-' + r.id;
  const a = r.action;
  const path = r.id === 'blender' ? status.blender.exe : r.id === 'uv' ? status.uv.path : null;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-ui font-semibold">{r.name}</h4>
            <Badge tone={BADGE[r.tone]}>{r.status}</Badge>
            {r.unverified && <Badge>Unverified</Badge>}
            {r.version && <span className="font-mono text-hint text-muted">{r.version}</span>}
          </div>
          {path && <div className="mt-0.5 text-hint text-muted"><Private value={path} display={shortPath(path)} label={r.name + ' path'} /></div>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {r.id === 'blender' && status.blenderProcess.crashLog && (
            <Button size="sm" onClick={onOpenLog}><FileText size={13} aria-hidden /> Open log</Button>
          )}
          {a?.kind === 'fix' && (
            <Button size="sm" variant="primary" disabled={!!busy} aria-busy={busy === a.step} onClick={() => onFix(a.step)}>
              {busy === a.step ? 'Working…' : a.label}
            </Button>
          )}
          {a?.kind === 'wait' && <Button size="sm" disabled aria-describedby={whyId}>{a.label}</Button>}
          {a?.kind === 'link' && (
            <a href={a.href} target="_blank" rel="noopener noreferrer" className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md bg-card2 px-2.5 text-ui text-fg hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel dark:hover:brightness-110">
              {a.label} <ExternalLink size={12} aria-hidden /><span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
          {a?.kind === 'open-studio' && <Button size="sm" onClick={openStudio}>{a.label}</Button>}
        </div>
      </div>
      {a?.kind === 'wait'
        ? <p id={whyId} className="mt-2 text-hint text-muted">{a.why}</p>
        : r.detail && <p className="mt-2 text-hint text-muted">{r.detail}</p>}
      {r.unverified && <p className="mt-1 text-hint text-dim">Studio's live steps have not been checked on this PC yet.</p>}
    </Card>
  );
}
