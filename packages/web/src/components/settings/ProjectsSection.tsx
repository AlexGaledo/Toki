import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Check, FolderGit2, FolderOpen, Map as MapIcon, Plus, Server, TriangleAlert } from 'lucide-react';
import type { ProjectStub } from '@pocketrocket/shared';
import { useNewLayout } from '../../lib/newLayout';
import { useStore } from '../../store';
import { api, type ProjectInfo, type ProjectLint } from '../../lib/api';
import { TEMPLATE_CHOICES, createInput, setupLines, templateBlocked, type SetupLine, type TemplateChoice } from '../../lib/projectTemplates';
import { useGameTools } from '../../lib/useGameTools';
import { desktopCan, desktopHost } from '../../lib/auth';
import { desktopCall, hostTag, projectKey, showHostTags, splitProjects } from '../../lib/hosts';
import { Badge, Button, EmptyState, Input, Label, RadioCard, Switch, cn } from '../ui';
import { Card, Group, InlineError, SectionHeader, shortPath } from './parts';
import { ReposEditor } from './ReposEditor';

export function ProjectsSection() {
  const toast = useStore((s) => s.toast);
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const stubs = useStore((s) => s.stubs);
  const pageHost = desktopHost();
  const tagOf = (p: { slug: string; host?: 'pc' | 'server' }) => (showHostTags(stubs.length, pageHost) ? hostTag(p, pageHost) : null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [choice, setChoice] = useState<TemplateChoice>('none');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ name: string; lines: SetupLine[] } | null>(null);
  const game = useGameTools();
  const blocked = (c: TemplateChoice) => templateBlocked(c, game);

  const load = useCallback(() => {
    api.projects.list().then((list) => {
      const { local, stubs } = splitProjects(list);
      setProjects(local);
      useStore.setState({ projects: local, stubs });
    }, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const create = async () => {
    // Game tools may have changed since the page loaded: a blocked template is never sent.
    if (blocked(choice)) return;
    setBusy(true);
    setError(null);
    setMade(null);
    try {
      const r = await api.projects.create(createInput(name, choice));
      setName('');
      setChoice('none');
      toast(r.bots.length ? r.project.name + ' created with a team of ' + r.bots.length : r.project.name + ' created');
      if (r.setup) setMade({ name: r.project.name, lines: setupLines(r.setup) });
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHeader title="Projects" description="Shared folders. Only the bots you list here can work in a project's folder." />
      <Group title="New project">
        <Card>
          <div className="space-y-3">
            <div>
              <Label htmlFor="project-name">Name</Label>
              <Input id="project-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Wika" />
            </div>
            <div>
              <span id="project-template-label" className="mb-1.5 block text-label font-medium">Team</span>
              <div role="radiogroup" aria-labelledby="project-template-label" className="space-y-2">
                {TEMPLATE_CHOICES.map((t) => {
                  const why = blocked(t.id);
                  return (
                    <RadioCard key={t.id} checked={choice === t.id} disabled={!!why} onSelect={() => setChoice(t.id)} title={t.title} note={why}>
                      {t.adds}
                    </RadioCard>
                  );
                })}
              </div>
            </div>
            <Button disabled={busy || !name.trim() || !!blocked(choice)} onClick={() => void create()}>
              <Plus size={14} aria-hidden /> Create project
            </Button>
            {made && <SetupResult name={made.name} lines={made.lines} onDone={() => setMade(null)} />}
          </div>
        </Card>
      </Group>
      {error && <InlineError>{error}</InlineError>}
      {projects?.length === 0 && !stubs.length && <EmptyState title="No projects yet" className="py-6" />}
      {projects?.map((p) => <ProjectCard key={projectKey(p)} project={p} tag={tagOf(p)} onChanged={load} onError={setError} />)}
      {stubs.map((p) => <StubCard key={projectKey(p)} stub={p} tag={tagOf(p)} />)}
    </>
  );
}

/** What the game template set up, in words (the hub's `setup` reply). Stays until dismissed or the next create. */
function SetupResult({ name, lines, onDone }: { name: string; lines: SetupLine[]; onDone: () => void }) {
  return (
    <div role="status" className="rounded-md bg-card p-3 text-ui ring-1 ring-line">
      <p className="font-medium">{name} is set up</p>
      <ul className="mt-1.5 space-y-1">
        {lines.map((l) => (
          <li key={l.text} className="flex items-start gap-1.5">
            {l.ok ? <Check size={14} aria-hidden className="mt-[3px] shrink-0 text-ok" /> : <TriangleAlert size={14} aria-hidden className="mt-[3px] shrink-0 text-warn" />}
            <span className="min-w-0">{l.text}</span>
          </li>
        ))}
        <li className="flex items-start gap-1.5">
          <Check size={14} aria-hidden className="mt-[3px] shrink-0 text-ok" />
          <span className="min-w-0">Blender: starts headless for the game chat when a bot needs it, and never opens a window.</span>
        </li>
      </ul>
      <Button size="sm" variant="ghost" className="mt-2" onClick={onDone}>Done</Button>
    </div>
  );
}

/** A project on the server: a name only. Nothing here calls a `/api/projects/:slug` route, which would reach this hub. */
export function StubCard({ stub, tag }: { stub: ProjectStub; tag: string | null }) {
  const openStub = useStore((s) => s.openStub);
  return (
    <Group title={stub.name} aside={tag ? <Badge>{tag}</Badge> : undefined}>
      <Card>
        <p className="flex min-w-0 items-start gap-1.5 text-hint text-muted">
          <Server size={13} aria-hidden className="mt-[3px] shrink-0" />
          <span className="min-w-0">
            {stub.connected ? 'On your server, which is connected.' : 'On your server, which is offline.'} Last listed {new Date(stub.seenAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.
          </span>
        </p>
        <Button size="sm" className="mt-3" aria-label={'Open ' + stub.name + ' on your server'} onClick={() => openStub(stub)}>
          Open on server <ArrowRight size={13} aria-hidden />
        </Button>
      </Card>
    </Group>
  );
}

export function ProjectCard({ project, tag, onChanged, onError }: { project: ProjectInfo; tag: string | null; onChanged: () => void; onError: (m: string) => void }) {
  const bots = useStore((s) => s.bots);
  const [lint, setLint] = useState<ProjectLint | null>(null);
  const [reposOpen, setReposOpen] = useState(false);
  const fresh = useNewLayout();
  const roomId = project.roomId;
  const go = (map: boolean) => {
    if (!roomId) return;
    const s = useStore.getState();
    s.openDialog(null);
    s.closePage();
    s.setActiveRoom(roomId);
    if (map) s.openPage({ kind: 'map', slug: project.slug });
  };
  const open = fresh && roomId ? (
    <span className="flex items-center gap-1">
      <Button size="sm" variant="ghost" aria-label={'Open the map of ' + project.name} onClick={() => go(true)}><MapIcon size={13} aria-hidden />Map</Button>
      <Button size="sm" variant="ghost" aria-label={'Open project ' + project.name} onClick={() => go(false)}>Open project <ArrowRight size={13} aria-hidden /></Button>
    </span>
  ) : null;
  const badge = project.templateVersion ? <Badge>Team template v{project.templateVersion}</Badge> : null;
  // D3 follow-up: the desktop app opens the folder (I3's `openfolder`); the page never sees or sends a path.
  const folder = desktopCan('openfolder') ? (
    <Button size="sm" variant="ghost" aria-label={'Open the folder of ' + project.name} onClick={() => window.open(desktopCall.openFolder(location.origin, project.slug), '_blank')}>
      <FolderOpen size={13} aria-hidden />Open folder
    </Button>
  ) : null;
  useEffect(() => { api.projects.lint(project.slug).then(setLint, () => setLint(null)); }, [project.slug, project.memberIds.length]);

  const toggle = async (botId: string, on: boolean) => {
    const memberIds = on ? [...project.memberIds, botId] : project.memberIds.filter((id) => id !== botId);
    try {
      await api.projects.setMembers(project.slug, memberIds);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <Group
      title={project.name}
      aside={tag || badge || open || folder ? <span className="flex flex-wrap items-center justify-end gap-2">{tag && <Badge>{tag}</Badge>}{badge}{folder}{open}</span> : undefined}
    >
      <Card>
        <p className={cn('flex min-w-0 gap-1.5 text-hint text-muted', fresh ? 'items-start' : 'items-center')}>
          <FolderGit2 size={13} aria-hidden className={cn('shrink-0', fresh && 'mt-[3px]')} />
          <span className={fresh ? 'min-w-0 break-all font-mono' : 'truncate font-mono'} title={shortPath(project.dir)}>{shortPath(project.dir)}</span>
        </p>
        {!!lint?.issues.length && (
          <div className="mt-3 rounded-sm border border-warn/40 p-2 text-hint">
            <p className="mb-1 flex items-center gap-1.5 text-fg"><TriangleAlert size={13} aria-hidden /> Needs a look</p>
            <ul className="space-y-0.5 text-muted">
              {lint.issues.slice(0, 5).map((i) => <li key={i.kind + i.path} className="break-words">{i.path}: {i.detail}</li>)}
              {lint.issues.length > 5 && <li>and {lint.issues.length - 5} more</li>}
            </ul>
          </div>
        )}
        <details className="mt-3 text-ui">
          <summary className="cursor-pointer select-none">
            {project.memberIds.length} {project.memberIds.length === 1 ? 'bot has' : 'bots have'} access
          </summary>
          <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
            {bots.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate">{b.name} <span className="text-dim">@{b.handle}</span></span>
                <Switch
                  checked={project.memberIds.includes(b.id)}
                  onChange={(on) => void toggle(b.id, on)}
                  aria-label={b.name + ' can work in ' + project.name}
                />
              </li>
            ))}
          </ul>
        </details>
        <details className="mt-3 text-ui" onToggle={(e) => setReposOpen(e.currentTarget.open)}>
          <summary className="cursor-pointer select-none">Repos</summary>
          <div className="mt-2">{reposOpen && <ReposEditor slug={project.slug} />}</div>
        </details>
      </Card>
    </Group>
  );
}
