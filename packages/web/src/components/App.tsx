import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { PanelLeftOpen, X } from 'lucide-react';
import { useStore, selectActiveRoom } from '../store';
import { useMediaQuery } from '../lib/useMediaQuery';
import { reconnectWsNow } from '../lib/ws';
import { CHAT_RAIL_W, PANEL_INLINE_MIN, PANEL_SOLO_MIN, SIDEBAR_INLINE_MIN, applyPaneVars, paneLayout } from '../lib/panes';
import { paneAutoStep } from '../lib/paneAutoClose';
import { selectScreenSize } from '../lib/screenView';
import { PaneSeparator } from './PaneSeparator';
import { Sidebar } from './Sidebar';
import { ChatPane } from './ChatPane';
import { RightPanel } from './RightPanel';
import { OverviewPanel } from './overview/OverviewPanel';
import { ProjectHeader, PROJECT_TAB_IDS } from './ProjectHeader';
import { importChunk } from '../lib/lazyChunk';
import { useActiveProject, useToki } from '../lib/useProject';
import { FilesPanel } from './files/FilesPanel';

const MapPage = lazy(() => importChunk(() => import('./map/MapPage').then((m) => ({ default: m.MapPage }))));
import { BotPage } from './BotPage';
import { AutomationsPage, UsagePage } from './FleetPages';
import { WorkflowPage } from './workflows/WorkflowPage';
import { InboxPage } from './InboxPage';
import { ProjectTasks, TasksPage } from './TasksPage';
import { PcSessionsPage } from './PcSessionsPage';
import { useInbox } from '../lib/useInbox';
import { titleWithCount } from '../lib/inbox';
import { BotDialog } from './dialogs/BotDialog';
import { RoomDialog } from './dialogs/RoomDialog';
import { SearchDialog } from './dialogs/SearchDialog';
import { PodiumDialog } from './dialogs/PodiumDialog';
import { ProfileDialog } from './dialogs/ProfileDialog';
import { SettingsDialog } from './dialogs/SettingsDialog';
import { Onboarding } from './Onboarding';
import { TokenPrompt } from './TokenPrompt';
import { Button, ConfirmHost, cn } from './ui';

const SIDEBAR_QUERY = '(min-width: ' + SIDEBAR_INLINE_MIN + 'px)';
const PANEL_QUERY = '(min-width: ' + PANEL_INLINE_MIN + 'px)';
const PANEL_SOLO_QUERY = '(min-width: ' + PANEL_SOLO_MIN + 'px)';

const CONNECT_GRACE_MS = 5000;

export function App() {
  const screenSize = useStore(selectScreenSize);
  const page = useStore((s) => s.page);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const closePanel = useStore((s) => s.closePanel);
  const setPaneOpen = useStore((s) => s.setPaneOpen);
  const panelOpen = useStore((s) => s.panelOpen);
  const filesOpen = useStore((s) => s.panelOpen && s.panelKind === 'files');
  const toki = useToki();
  const overviewOpen = useStore((s) => s.panelOpen && s.panelKind === 'overview') && toki;
  const overviewRail = useStore((s) => s.overviewRail);
  const project = useActiveProject();
  const activeRoom = useStore(selectActiveRoom);
  const projectRoom = project && activeRoom?.id === project.roomId ? activeRoom : null;
  const screenParked = useStore((s) => s.screenParked);
  const dialog = useStore((s) => s.dialog);
  const openDialog = useStore((s) => s.openDialog);
  const settings = useStore((s) => s.settings);
  const helloReceived = useStore((s) => s.helloReceived);
  const device = useStore((s) => s.device);
  const showOnboarding = helloReceived && settings.onboarded === false && !device;
  const sidebarFits = useMediaQuery(SIDEBAR_QUERY);
  const panelFits = useMediaQuery(PANEL_QUERY);
  const panelFitsAlone = useMediaQuery(PANEL_SOLO_QUERY);
  const squeezed = panelOpen && !overviewOpen && panelFitsAlone && !panelFits;
  const sidebarInline = sidebarFits && !squeezed;
  const panelInline = panelFits || squeezed;
  const focus = screenSize === 'focus';
  const filesShown = filesOpen && !focus;
  const overviewShown = overviewOpen && !focus;
  const covering = !panelInline && (screenSize !== 'glance' || filesShown || overviewShown);
  const sheet = covering && overviewShown && !filesShown && screenSize === 'glance';
  const mapPage = page?.kind === 'map' && !!projectRoom;
  const tasksTab = page?.kind === 'projectTasks' && !!projectRoom;
  const coverPage = page && page.kind !== 'map' && page.kind !== 'projectTasks' ? page : null;

  const skillsRev = useStore((s) => s.skillsRev);
  useEffect(() => {
    if (helloReceived) void useStore.getState().loadInboxSkills();
  }, [helloReceived, skillsRev]);
  const waiting = useInbox().length;
  useEffect(() => {
    document.title = titleWithCount(document.title, waiting);
  }, [waiting]);

  useLayoutEffect(() => {
    let last = '';
    const apply = () => {
      if (document.body.dataset.paneDrag !== undefined) return;
      const w = paneLayout(window.innerWidth, useStore.getState());
      const key = w.sidebar + ':' + w.panel;
      if (key === last) return;
      last = key;
      applyPaneVars(w);
    };
    apply();
    window.addEventListener('resize', apply);
    const unsubscribe = useStore.subscribe(apply);
    return () => {
      window.removeEventListener('resize', apply);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        useStore.getState().toggleSidebar();
        return;
      }
      // A Radix layer that already took this Escape (a confirm, an open menu) marks it handled.
      if (e.key === 'Escape' && dialog && !e.defaultPrevented) openDialog(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, openDialog]);

  useEffect(() => {
    if (!squeezed) return;
    const was = useStore.getState().sidebarOpen;
    useStore.setState({ sidebarOpen: false });
    return () => useStore.setState({ sidebarOpen: was && window.innerWidth >= SIDEBAR_INLINE_MIN });
  }, [squeezed]);

  const auto = useRef({ sidebar: { inline: sidebarInline, autoClosed: false }, panel: { inline: panelInline, autoClosed: false } });
  useEffect(() => {
    const s = useStore.getState();
    const side = paneAutoStep(auto.current.sidebar, sidebarInline, s.sidebarOpen);
    const pane = paneAutoStep(auto.current.panel, panelInline, s.panelOpen);
    auto.current = { sidebar: side.next, panel: pane.next };
    if (side.act) setSidebarOpen(side.act === 'open');
    if (pane.act === 'close') closePanel();
    else if (pane.act === 'open') setPaneOpen('panel', true);
  }, [sidebarInline, panelInline, sidebarOpen, panelOpen, setSidebarOpen, closePanel, setPaneOpen]);

  useEffect(() => {
    if (!focus) return;
    const was = useStore.getState().sidebarOpen;
    useStore.setState({ sidebarOpen: false });
    return () => useStore.setState({ sidebarOpen: was });
  }, [focus]);

  const screenRef = useRef<HTMLDivElement>(null);
  const takesFocus = covering || focus;
  useEffect(() => {
    if (!takesFocus) return;
    const before = document.activeElement as HTMLElement | null;
    screenRef.current?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, [takesFocus]);

  return (
    <div className="flex h-dvh w-full overflow-clip pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]">
      {!(sidebarOpen && sidebarInline) && (
        <button
          className="ml-2 mt-3 flex h-8 w-8 shrink-0 items-center justify-center self-start rounded-md text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent pointer-coarse:h-10 pointer-coarse:w-10 max-md:fixed max-md:left-[calc(env(safe-area-inset-left)+0.75rem)] max-md:top-[calc(env(safe-area-inset-top)+0.75rem)] max-md:z-20 max-md:m-0 max-md:pointer-coarse:left-[calc(env(safe-area-inset-left)+0.5rem)] max-md:pointer-coarse:top-[calc(env(safe-area-inset-top)+0.5rem)]"
          title="Show bots (Ctrl+B)"
          aria-label="Show bots"
          aria-expanded={sidebarOpen}
          onClick={toggleSidebar}
        >
          <PanelLeftOpen size={16} />
        </button>
      )}
      <div id="pane-sidebar" hidden={!(sidebarOpen && sidebarInline)} className="flex shrink-0" style={{ width: 'var(--sidebar-w)' }}>
        {sidebarOpen && sidebarInline && <Sidebar />}
      </div>
      {sidebarInline && <PaneSeparator pane="sidebar" label="Resize sidebar" controls="pane-sidebar" />}
      <main className={cn('@container panel relative flex min-w-0 flex-col overflow-clip', focus && panelInline ? 'shrink-0 border-r border-line' : 'flex-1')} style={focus && panelInline ? { width: CHAT_RAIL_W } : undefined}>
        {projectRoom && project && <div inert={!!coverPage} className="flex shrink-0 flex-col"><ProjectHeader project={project} room={projectRoom} /></div>}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            inert={!!page}
            className="flex min-h-0 flex-1 flex-col"
            {...(projectRoom ? { id: PROJECT_TAB_IDS.chat.panel, role: 'tabpanel', 'aria-labelledby': PROJECT_TAB_IDS.chat.tab } : {})}
          >
            <ChatPane hideHeader={!!projectRoom} />
          </div>
          {mapPage && (
            <div id={PROJECT_TAB_IDS.map.panel} role="tabpanel" aria-labelledby={PROJECT_TAB_IDS.map.tab} className="@container absolute inset-0 flex flex-col">
              {project && projectRoom && <Suspense fallback={<div aria-hidden className="flex-1 bg-canvas" />}><MapPage project={project} room={projectRoom} /></Suspense>}
            </div>
          )}
          {tasksTab && projectRoom && (
            <div id={PROJECT_TAB_IDS.tasks.panel} role="tabpanel" aria-labelledby={PROJECT_TAB_IDS.tasks.tab} className="@container panel absolute inset-0 flex flex-col">
              <ProjectTasks roomId={projectRoom.id} />
            </div>
          )}
        </div>
        {coverPage && (
          <div className="@container panel absolute inset-0 flex flex-col">
            {coverPage.kind === 'bot' ? <BotPage botId={coverPage.botId} tab={coverPage.tab} /> : coverPage.kind === 'workflow' ? <WorkflowPage id={coverPage.id} /> : coverPage.kind === 'automations' ? <AutomationsPage /> : coverPage.kind === 'inbox' ? <InboxPage /> : coverPage.kind === 'tasks' ? <TasksPage /> : coverPage.kind === 'pcsessions' ? <PcSessionsPage /> : <UsagePage />}
          </div>
        )}
      </main>
      {panelInline && !focus && !(overviewShown && overviewRail) && <PaneSeparator pane="panel" label={filesShown ? 'Resize files' : overviewShown ? 'Resize overview' : 'Resize screen'} controls="pane-panel" />}
      {sheet && <div aria-hidden className="pr-scrim fixed inset-0 z-30 bg-scrim backdrop-blur-[2px]" onClick={closePanel} />}
      {/* One element at every size: moving an iframe in the DOM reloads it, spending a ticket and dropping noVNC. */}
      <div
        id="pane-panel"
        ref={screenRef}
        tabIndex={-1}
        role={covering ? 'dialog' : undefined}
        aria-modal={covering || undefined}
        aria-label={covering ? (filesShown ? 'Files' : overviewShown ? 'Overview' : 'Screen') : undefined}
        onKeyDown={(e) => {
          // Escape in a dialog opened from in here bubbles through its portal to this handler, and must close that dialog only.
          if (e.key === 'Escape' && covering && !focus && e.currentTarget.contains(e.target as Node)) {
            e.stopPropagation();
            closePanel();
          }
        }}
        className={cn(
          'flex focus:outline-none',
          sheet ? 'fixed inset-x-0 bottom-0 z-30 max-h-[calc(100dvh-2.5rem)] overflow-clip rounded-t-xl bg-panel pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-lg)]'
            : covering ? 'fixed inset-0 z-30 bg-bg pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]' : focus ? 'min-w-0 flex-1' : 'shrink-0',
        )}
        style={covering || focus ? undefined : { width: 'var(--panel-w)' }}
      >
        <RightPanel inline={panelInline} parked={filesShown && screenParked} beside={filesShown || overviewShown ? (covering ? 'cover' : 'inline') : null} />
        {filesOpen && <div className={focus ? 'hidden' : 'flex min-w-0 flex-1'}><FilesPanel inline={panelInline} /></div>}
        {overviewShown && <div className="flex min-w-0 flex-1"><OverviewPanel inline={panelInline} /></div>}
      </div>

      {sidebarOpen && !sidebarInline && (
        <Drawer label="Bots and chats" onClose={() => setSidebarOpen(false)}>
          <Sidebar />
        </Drawer>
      )}

      <HubStatus />
      <Toasts />

      {dialog?.kind === 'bot' && <BotDialog bot={dialog.bot} onClose={() => openDialog(null)} />}
      {dialog?.kind === 'room' && <RoomDialog room={dialog.room} onClose={() => openDialog(null)} />}
      {dialog?.kind === 'podium' && <PodiumDialog onClose={() => openDialog(null)} />}
      {dialog?.kind === 'search' && <SearchDialog onClose={() => openDialog(null)} />}
      {dialog?.kind === 'profile' && <ProfileDialog onClose={() => openDialog(null)} />}
      {dialog?.kind === 'settings' && <SettingsDialog section={dialog.section} onClose={() => openDialog(null)} />}

      <ConfirmHost />

      {showOnboarding && <Onboarding />}
      <TokenPrompt />
    </div>
  );
}

function Drawer({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-30 flex" role="dialog" aria-modal="true" aria-label={label}>
      <div aria-hidden className="pr-scrim absolute inset-0 bg-scrim backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={ref}
        tabIndex={-1}
        // React events bubble through portals, so Escape in a dialog opened from in here reaches this handler; the DOM
        // check tells them apart.
        onKeyDown={(e) => {
          if (e.key === 'Escape' && e.currentTarget.contains(e.target as Node)) {
            e.stopPropagation();
            onClose();
          }
        }}
        className="relative flex h-full w-[min(300px,100%)] max-w-full bg-bg pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-[var(--shadow-overlay)] focus:outline-none"
      >
        {children}
      </div>
    </div>
  );
}

function HubStatus() {
  const connected = useStore((s) => s.connected);
  const disconnectedAt = useStore((s) => s.disconnectedAt);
  const issue = useStore((s) => s.hubIssue);
  const hasConnected = useStore((s) => s.hasConnected);
  const [late, setLate] = useState(false);
  useEffect(() => {
    setLate(false);
    if (connected || disconnectedAt === null) return;
    const timer = setTimeout(() => setLate(true), Math.max(0, disconnectedAt + CONNECT_GRACE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [connected, disconnectedAt]);

  if (connected || issue?.kind === 'auth') return null;
  if (!late) {
    return (
      <div role="status" className="fixed left-1/2 top-4 z-[100] -translate-x-1/2 rounded-full bg-ink px-3.5 py-1.5 text-ui text-ink-fg shadow-[var(--shadow-overlay)]">
        {hasConnected && !issue ? 'Reconnecting…' : 'Connecting…'}
      </div>
    );
  }

  const cause =
    issue?.kind === 'unreachable' ? (issue.detail ? issue.detail + ' ' : '') + 'Check that Toki is running.'
    : issue?.kind === 'rateLimited' ? 'Too many failed sign-ins. Retrying in ' + Math.ceil(issue.retryInMs / 1000) + 's.'
    : issue?.kind === 'refused' ? 'Connection refused. Reload this page.'
    : 'Still trying to connect.';
  return (
    <div role="alert" className="fixed left-1/2 top-4 z-[100] w-[360px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg bg-panel p-4 shadow-[var(--shadow-overlay)] ring-1 ring-line">
      <div className="text-ui font-semibold">Can't reach Toki</div>
      <p className="mt-1 text-ui leading-relaxed text-muted">{cause}</p>
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="primary" onClick={reconnectWsNow}>Retry</Button>
      </div>
    </div>
  );
}

/** pointer-events stay on for the toasts so a modal's inert body does not swallow the dismiss button. */
function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);
  const driving = useStore(selectScreenSize) === 'focus';
  const onMap = useStore((s) => s.page?.kind === 'map');
  return (
    <div role="status" aria-live="polite" className={cn('pointer-events-none fixed right-5 z-[100] flex max-w-[calc(100vw-2.5rem)] flex-col items-end gap-2', driving || onMap ? 'bottom-24' : 'bottom-5 max-sm:bottom-[calc(10rem+env(safe-area-inset-bottom))]')}>
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pr-toast pointer-events-auto flex items-center gap-1 rounded-lg py-1 pl-3.5 pr-1 text-ui shadow-[var(--shadow-overlay)]',
            t.bad ? 'bg-bad text-on-fill' : t.warn ? 'bg-warn text-on-fill' : 'bg-ink text-ink-fg',
          )}
        >
          {t.action ? (
            <button
              className="rounded-sm py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
              onClick={() => {
                dismissToast({ id: t.id });
                t.action!.run();
              }}
            >
              {t.text} <span className="font-semibold underline underline-offset-2">{t.action.label}</span>
            </button>
          ) : (
            <span className="py-1">{t.text}</span>
          )}
          <button
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm opacity-70 hover:bg-current/15 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => dismissToast({ id: t.id })}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
