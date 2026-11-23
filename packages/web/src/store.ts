import type { BotPreview } from '@pocketrocket/shared';
import { create } from 'zustand';
import type { Bot, BotState, Message, Room, ServerEvent, UsageTotals, Settings, SettingsPatch, ProvidersResponse, ProviderLimitState, AccountState, SendMode, FailoverState } from '@pocketrocket/shared';
import { DEFAULT_SETTINGS, MODELS, SIGNED_OUT } from '@pocketrocket/shared';
import type { KnowledgeStatus } from '@pocketrocket/shared';
import type { ControlStatus } from '@pocketrocket/shared';
import type { Skill, ComputerStatus, OpenApproval, RecorderStatus } from '@pocketrocket/shared';
import { api, MESSAGE_PAGE, type AccountActionResponse, type ProjectInfo } from './lib/api';
import { fetchProjects, projectOfRoom } from './lib/projects';
import { getLayout, layoutFromSetting, layoutToMigrate, setLayout, subscribeLayout } from './lib/layout';
import type { ProjectMapReply, ProjectOverview } from '@pocketrocket/shared';
import { wsSend } from './lib/ws';
import { play, setSoundsEnabled } from './lib/sounds';
import { notifyEvent } from './lib/notifyEvents';
import { applyFont, applyTheme, watchSystemTheme } from './lib/theme';
import { isDesktopMode, isDevice } from './lib/auth';
import { getItem, setItem } from './lib/persist';
import { newClientId, readJournal, writeJournal, type OutboxEntry } from './lib/outbox';
import { applyLaneQueue, replaceRoomQueues, type Queues } from './lib/queue';
import { applyContext, replaceRoomContexts, type Contexts } from './lib/context';
import { refreshWorkflows } from './lib/workflows';
import { OVERVIEW_OPEN_MIN, PANEL_INLINE_MIN, SIDEBAR_INLINE_MIN, readPaneWidths, writePaneWidth, type PaneId, type PaneWidths, type PanelKind } from './lib/panes';
import type { SectionId } from './components/dialogs/SettingsDialog';

export type BotTab = 'memory' | 'skills' | 'automations' | 'computer';
export type Page = { kind: 'bot'; botId: string; tab: BotTab } | { kind: 'workflow'; id: string } | { kind: 'automations' } | { kind: 'usage' } | { kind: 'inbox' } | { kind: 'tasks' } | { kind: 'pcsessions' }
  | { kind: 'map'; slug: string }
  | { kind: 'projectTasks'; slug: string };

interface Streaming { botId: string; roomId: string; text: string }

const FALLBACK_PROVIDERS: ProvidersResponse = {
  active: 'claude',
  providers: [
    {
      id: 'claude',
      label: 'Claude',
      blurb: 'Claude. Subscription or API key.',
      authModes: ['subscription', 'apiKey'],
      secretKeys: [],
      permissions: 'full',
      maturity: 'verified',
      check: { ok: true, auth: 'unknown' },
      models: MODELS.map((m) => ({ id: m.id, label: m.label })),
    },
  ],
};

const recentReceive = new Map<string, number>();
const olderRetryAt = new Map<string, number>();
const decided = new Set<string>();
const formsSent = new Set<string>();

function isAccountState(v: unknown): v is AccountState {
  return typeof v === 'object' && v !== null && 'enabled' in v && 'signedIn' in v;
}

export const NARROW_SIDEBAR_QUERY = '(max-width: ' + (SIDEBAR_INLINE_MIN - 1) + 'px)';
function matches(query: string): boolean {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

const tokiLayout = (device: boolean) => getLayout() === 'toki' && !device;
const OVERVIEW_RAIL_KEY = 'pocketrocket.overviewRail';
function overviewHome(vw: number): boolean {
  return tokiLayout(isDevice()) && vw >= PANEL_INLINE_MIN;
}
function readOverviewRail(vw: number): boolean {
  const v = getItem(OVERVIEW_RAIL_KEY);
  return v === '1' ? true : v === '0' ? false : vw < OVERVIEW_OPEN_MIN;
}

export interface MapAsk { botId: string; roomId: string; phase: 'sent' | 'done' }

export interface Toast {
  id: number;
  text: string;
  bad?: boolean;
  action?: { label: string; run: () => void };
  sticky?: boolean;
  warn?: boolean;
  key?: string;
}
export type ToastOptions = Pick<Toast, 'action' | 'sticky' | 'warn' | 'key'>;

export type HubIssue =
  | { kind: 'unreachable'; detail?: string }
  | { kind: 'rateLimited'; retryInMs: number }
  | { kind: 'auth' }
  | { kind: 'refused' };

export const filesRevKey = (roomId: string, folder: string) => roomId + ':' + folder;
const approvalToastKey =(roomId: string, approvalId: string) => 'approval:' + roomId + ':' + approvalId;

function applyLocalSettings(s: Settings) {
  setSoundsEnabled(s.sounds);
  applyTheme(s.theme);
  applyFont(s.font);
  if (s.layout) setLayout(layoutFromSetting(s.layout));
}

export const SEND_ACK_MS = 15_000;
const ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
function clearAck(clientId: string) {
  const t = ackTimers.get(clientId);
  if (t) clearTimeout(t);
  ackTimers.delete(clientId);
}

interface State {
  connected: boolean;
  hasConnected: boolean;
  outbox: OutboxEntry[];
  flushOutbox: () => void;
  retrySend: (clientId: string) => void;
  discardSend: (clientId: string) => void;
  disconnectedAt: number | null;
  hubIssue: HubIssue | null;
  bots: Bot[];
  rooms: Room[];
  botStates: Record<string, BotState>;
  activeRoomId: string | null;
  messages: Record<string, Message[]>;
  openApprovals: OpenApproval[];
  computers: Record<string, ComputerStatus>;
  loaded: Record<string, boolean>;
  history: Record<string, { loading: boolean; done: boolean }>;
  streaming: Record<string, Streaming>;
  unread: Record<string, number>;
  previews: Record<string, BotPreview>;
  searchTarget: { roomId: string; seq: number; query: string } | null;
  usage: Record<string, UsageTotals>;
  routinesRev: number;
  triggersRev: number;
  memory: Record<string, string>;
  panelOpen: boolean;
  sidebarOpen: boolean;
  paneW: PaneWidths;
  panelExpanded: boolean;
  panelBotId: string | null;
  panelKind: PanelKind;
  overviewRail: boolean;
  overviews: Record<string, ProjectOverview | null>;
  maps: Record<string, ProjectMapReply | null>;
  mapAsks: Record<string, MapAsk>;
  screenParked: boolean;
  filesTarget: { roomId: string; path: string; file?: string; seq: number } | null;
  filesRev: Record<string, number>;
  page: Page | null;
  dialog: { kind: 'bot'; bot: Bot | null } | { kind: 'room'; room: Room | null } | { kind: 'podium' } | { kind: 'search' } | { kind: 'profile' } | { kind: 'settings'; section?: SectionId } | null;
  toasts: Toast[];
  settings: Settings;
  providers: ProvidersResponse | null;
  limits: ProviderLimitState[];
  failover: FailoverState;
  account: AccountState;
  helloReceived: boolean;
  /** A paired device: the hub refuses settings, bot/room edits, integrations and approval rules. */
  device: boolean;
  /** Only a socket with a password session may allow a sign-in-required card. */
  signedIn: boolean;
  approvalErrors: Record<string, string>;
  formErrors: Record<string, { message: string; at: number }>;
  formSent: (formId: string) => void;
  _playedConnectedSound: boolean;
  knowledge: KnowledgeStatus | null;
  voiceRev: Record<string, number>;
  control: Record<string, ControlStatus>;
  policiesRev: number;
  recorder: Record<string, RecorderStatus>;
  skillsRev: number;
  pcRunnerRev: number;
  pcSessionFocus: string | null;
  trainingRev: Record<string, number>;
  tasksRev: Record<string, number>;
  queues: Queues;
  loadQueue: (roomId: string) => Promise<void>;
  contexts: Contexts;
  loadContext: (roomId: string) => Promise<void>;
  queueCancel: (roomId: string, journalId: string) => Promise<string | null>;
  queueEdit: (roomId: string, journalId: string, text: string) => Promise<string | null>;
  queueSendNow: (roomId: string, botId: string) => Promise<string | null>;
  queuePause: (roomId: string, botId: string, paused: boolean) => Promise<string | null>;
  inboxSkills: Skill[] | null;
  projects: ProjectInfo[];
  loadProjects: () => Promise<void>;
  loadOverview: (slug: string) => Promise<void>;
  loadMap: (slug: string) => Promise<void>;
  askForMap: (slug: string, botId: string, text: string) => void;
  openOverview: (opts?: { rail?: boolean }) => void;
  setOverviewRail: (rail: boolean) => void;
  loadInboxSkills: () => Promise<void>;

  setConnected: (v: boolean) => void;
  setHubIssue: (issue: HubIssue | null) => void;
  updateSettings: (patch: SettingsPatch) => Promise<boolean>;
  fetchProviders: () => Promise<void>;
  fetchFailover: () => Promise<void>;
  dropFailoverCard: (id: string) => void;
  fetchAccount: () => Promise<void>;
  applyAccountResponse: (res: AccountActionResponse) => void;
  applyEvent: (ev: ServerEvent) => void;
  setActiveRoom: (id: string | null) => void;
  openSearchHit: (roomId: string, seq: number, query: string) => void;
  loadMessages: (roomId: string) => Promise<void>;
  loadOlder: (roomId: string) => Promise<void>;
  sendMessage: (text: string, attachments?: string[], mode?: SendMode) => void;
  decide: (approvalId: string, decision: 'allow' | 'always' | 'deny') => void;
  interrupt: (turnId: string) => void;
  openScreen: (botId?: string | null) => void;
  openFiles: (at?: { path: string; file?: string }) => void;
  openPage: (page: Page) => void;
  closePage: () => void;
  openPcSession: (id: string) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setPaneW: (pane: PaneId, width: number) => void;
  setPaneOpen: (pane: PaneId, open: boolean) => void;
  togglePanelExpanded: () => void;
  closePanel: () => void;
  openDialog: (d: State['dialog']) => void;
  toast: (text: string, bad?: boolean, opts?: ToastOptions) => void;
  dismissToast: (which: { id: number } | { keyPrefix: string }) => void;
  refresh: () => Promise<void>;
}

let toastSeq = 0;

async function queueCall(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as Error).message || 'The hub did not take that. Try again.';
  }
}

export const useStore = create<State>((set, get) => ({
  connected: false,
  hasConnected: false,
  outbox: readJournal(),
  disconnectedAt: Date.now(),
  hubIssue: null,
  bots: [],
  rooms: [],
  botStates: {},
  activeRoomId: getItem('pocketrocket.activeRoom'),
  messages: {},
  previews: {},
  searchTarget: null,
  openApprovals: [],
  computers: {},
  loaded: {},
  history: {},
  streaming: {},
  unread: {},
  usage: {},
  routinesRev: 0,
  triggersRev: 0,
  memory: {},
  panelOpen: overviewHome(window.innerWidth),
  sidebarOpen: !matches(NARROW_SIDEBAR_QUERY) && getItem('pocketrocket.sidebar') !== '0',
  paneW: readPaneWidths(window.innerWidth),
  panelExpanded: false,
  panelBotId: null,
  panelKind: overviewHome(window.innerWidth) ? 'overview' : 'screen',
  overviewRail: readOverviewRail(window.innerWidth),
  overviews: {},
  maps: {},
  mapAsks: {},
  screenParked: false,
  filesTarget: null,
  filesRev: {},
  page: null,
  dialog: null,
  toasts: [],
  settings: DEFAULT_SETTINGS,
  providers: null,
  limits: [],
  failover: { cards: [], active: [] },
  account: SIGNED_OUT,
  helloReceived: false,
  device: isDevice(),
  signedIn: false,
  approvalErrors: {},
  formErrors: {},
  formSent: (formId) => {
    formsSent.add(formId);
    const { [formId]: _c, ...formErrors } = get().formErrors;
    set({ formErrors });
  },
  _playedConnectedSound: false,
  knowledge: null,
  voiceRev: {},
  control: {},
  policiesRev: 0,
  recorder: {},
  skillsRev: 0,
  pcRunnerRev: 0,
  pcSessionFocus: null,
  trainingRev: {},
  tasksRev: {},
  contexts: {},
  loadContext: async (roomId) => {
    try {
      const byBot = await api.rooms.context(roomId);
      set({ contexts: replaceRoomContexts(get().contexts, roomId, byBot) });
    } catch {
      // An older hub (404): no meter, as before.
    }
  },
  queues: {},
  loadQueue: async (roomId) => {
    try {
      const lanes = await api.rooms.queue(roomId);
      set({ queues: replaceRoomQueues(get().queues, roomId, lanes) });
    } catch {
      // An older hub (404) or a refused device: no chips, which is what it showed before.
    }
  },
  queueCancel: (roomId, journalId) => queueCall(() => api.rooms.queueCancel(roomId, journalId)),
  queueEdit: (roomId, journalId, text) => queueCall(() => api.rooms.queueEdit(roomId, journalId, text)),
  queueSendNow: (roomId, botId) => queueCall(() => api.rooms.queueSendNow(roomId, botId)),
  queuePause: (roomId, botId, paused) => queueCall(async () => {
    const lanes = await api.rooms.queuePause(roomId, botId, paused);
    let queues = get().queues;
    for (const q of lanes) queues = applyLaneQueue(queues, q);
    set({ queues });
  }),
  inboxSkills: null,
  projects: [],
  loadProjects: async () => {
    if (get().device) return set({ projects: [] });
    set({ projects: await fetchProjects(api.projects.list) });
  },
  loadOverview: async (slug) => {
    try {
      const o = await api.projects.overview(slug);
      set({ overviews: { ...get().overviews, [slug]: o } });
    } catch {
      set({ overviews: { ...get().overviews, [slug]: null } });
    }
  },
  loadMap: async (slug) => {
    try {
      const m = await api.projects.map(slug);
      set({ maps: { ...get().maps, [slug]: m } });
    } catch {
      set({ maps: { ...get().maps, [slug]: null } });
    }
  },
  askForMap: (slug, botId, text) => {
    const roomId = get().activeRoomId;
    if (!roomId) return;
    get().sendMessage(text);
    set({ mapAsks: { ...get().mapAsks, [slug]: { botId, roomId, phase: 'sent' } } });
  },
  openOverview: (opts) => set((s) => ({
    panelOpen: true,
    panelKind: 'overview',
    screenParked: false,
    panelExpanded: false,
    overviewRail: opts?.rail === false ? false : s.overviewRail,
  })),
  setOverviewRail: (rail) => {
    setItem(OVERVIEW_RAIL_KEY, rail ? '1' : '0');
    set({ overviewRail: rail });
  },

  setConnected: (connected) => {
    const was = get().connected;
    if (connected) set({ connected, hasConnected: true, disconnectedAt: null, hubIssue: null });
    else if (was) set({ connected, disconnectedAt: Date.now() });
    if (connected && !was) {
      for (const e of get().outbox) if (e.status === 'sent') { clearAck(e.clientId); patchOutbox(e.clientId, 'sending', 'sent'); }
    }
    if (connected) get().flushOutbox();
    if (connected && !was && isDesktopMode() && !get()._playedConnectedSound) {
      set({ _playedConnectedSound: true });
      play('connected');
    }
  },

  applyEvent: (ev) => {
    const s = get();
    const loose = ev as unknown as { type: string; projects?: unknown };
    if (loose.type === 'projects.changed') {
      if (Array.isArray(loose.projects) && !s.device) set({ projects: loose.projects as ProjectInfo[] });
      else void get().loadProjects();
      return;
    }
    switch (ev.type) {
      case 'hello': {
        const settings = ev.settings ?? DEFAULT_SETTINGS;
        set({ bots: ev.bots, rooms: ev.rooms, botStates: ev.botStates, loaded: {}, settings, helloReceived: true, device: ev.principal ? ev.principal === 'device' : s.device, signedIn: !!ev.signedIn, approvalErrors: {}, formErrors: {}, openApprovals: ev.openApprovals ?? [], queues: {} });
        if (get().device && get().panelKind === 'overview') set({ panelOpen: false, panelKind: 'screen' });
        const migrate = get().device ? null : layoutToMigrate(settings.layout);
        if (migrate) void get().updateSettings({ layout: migrate }).then((saved) => { if (!saved) setLayout(migrate); });
        else applyLocalSettings(settings);
        watchSystemTheme(() => get().settings.theme);
        void get().fetchProviders();
        void get().fetchFailover();
        void get().fetchAccount();
        void get().loadProjects();
        void refreshWorkflows();
        void api.previews().then((previews) => set({ previews })).catch(() => undefined);
        void api.control.list().then((l) => set({ control: Object.fromEntries(l.map((c) => [c.botId, c])) })).catch(() => undefined);
        const active = s.activeRoomId && ev.rooms.some((r) => r.id === s.activeRoomId) ? s.activeRoomId : (ev.rooms[0]?.id ?? null);
        get().setActiveRoom(active);
        return;
      }
      case 'computer.state':
        set({ computers: { ...s.computers, [ev.status.botId]: ev.status } });
        return;
      case 'settings.changed': {
        set({ settings: ev.settings });
        applyLocalSettings(ev.settings);
        return;
      }
      case 'providers.changed': {
        void get().fetchProviders();
        return;
      }
      case 'provider.limit':
        set({ limits: ev.limits });
        return;
      case 'failover.changed':
        set({ failover: { cards: ev.cards, active: ev.active } });
        return;
      case 'account.changed':
        set({ account: ev.account });
        return;
      case 'bots.changed':
        set({ bots: ev.bots });
        void get().loadProjects();
        return;
      case 'rooms.changed': {
        set({ rooms: ev.rooms });
        void get().loadProjects();
        if (s.activeRoomId && !ev.rooms.some((r) => r.id === s.activeRoomId)) get().setActiveRoom(ev.rooms[0]?.id ?? null);
        return;
      }
      case 'message.new': {
        const m = ev.message;
        const list = s.messages[m.roomId] ?? [];
        if (m.clientMsgId) settleSends([m.clientMsgId]);
        if (list.some((x) => x.id === m.id)) return;
        const unread = { ...s.unread };
        if (m.roomId !== s.activeRoomId && m.authorType !== 'user' && (m.kind === 'text' || m.kind === 'approval' || m.kind === 'takeover')) unread[m.roomId] = (unread[m.roomId] ?? 0) + 1;
        const streaming = { ...s.streaming };
        if (m.turnId && (m.kind === 'text' || m.kind === 'tool') && streaming[m.turnId]) streaming[m.turnId] = { ...streaming[m.turnId], text: '' };
        set({ messages: { ...s.messages, [m.roomId]: [...list, m] }, unread, streaming });
        if (m.authorType === 'bot' && m.kind === 'text') {
          if (m.authorId && m.text) set({ previews: { ...get().previews, [m.authorId]: { text: m.text.slice(0, 200), at: m.createdAt } } });
          if (m.turnId) recentReceive.set(m.turnId, Date.now());
          play('receive', { roomActive: m.roomId === s.activeRoomId });
        }
        if (m.kind === 'takeover') {
          play('approvalRequest');
          void notifyEvent({ kind: 'takeover', roomId: m.roomId, botName: botById(s.bots, m.authorId)?.name ?? 'A bot', reason: m.text });
          if (m.roomId !== s.activeRoomId) {
            const bot = botById(s.bots, m.authorId);
            get().toast((bot?.name ?? 'A bot') + ' needs you on its screen', false, {
              sticky: true, warn: true, key: 'takeover:' + m.id, action: { label: 'Open', run: () => get().setActiveRoom(m.roomId) },
            });
          }
        }
        return;
      }
      case 'message.update': {
        const list = s.messages[ev.roomId];
        if (!list) return;
        set({ messages: { ...s.messages, [ev.roomId]: list.map((m) => (m.id === ev.id ? { ...m, ...ev.patch } : m)) } });
        return;
      }
      case 'turn.start':
        set({ streaming: { ...s.streaming, [ev.turnId]: { botId: ev.botId, roomId: ev.roomId, text: '' } } });
        return;
      case 'turn.delta': {
        const cur = s.streaming[ev.turnId] ?? { botId: ev.botId, roomId: ev.roomId, text: '' };
        set({ streaming: { ...s.streaming, [ev.turnId]: { ...cur, text: cur.text + ev.text } } });
        return;
      }
      case 'turn.end': {
        const streaming = { ...s.streaming };
        delete streaming[ev.turnId];
        set({ streaming, contexts: applyContext(s.contexts, ev.botId, ev.roomId, ev.context) });
        const project = projectOfRoom(s.projects, ev.roomId);
        if (project && project.slug in s.overviews) void get().loadOverview(project.slug);
        if (project && project.slug in s.maps) void get().loadMap(project.slug);
        const ask = project && s.mapAsks[project.slug];
        if (project && ask && ask.phase === 'sent' && ask.botId === ev.botId && ask.roomId === ev.roomId) {
          set({ mapAsks: { ...get().mapAsks, [project.slug]: { ...ask, phase: 'done' } } });
        }
        const roomActive = ev.roomId === s.activeRoomId;
        if (ev.error) {
          play('error', { roomActive });
        } else {
          const lastReceive = recentReceive.get(ev.turnId);
          const doubleCounted = lastReceive !== undefined && Date.now() - lastReceive < 1500;
          if (!doubleCounted) play('done', { roomActive });
          const last = [...(s.messages[ev.roomId] ?? [])].reverse().find((m) => m.turnId === ev.turnId && m.kind === 'text');
          void notifyEvent({ kind: 'turn', roomId: ev.roomId, botName: botById(s.bots, ev.botId)?.name ?? 'A bot', lastText: last?.text });
        }
        recentReceive.delete(ev.turnId);
        return;
      }
      case 'bot.state':
        set({ botStates: { ...s.botStates, [ev.botId]: ev.state } });
        return;
      case 'approval.request': {
        set({ openApprovals: [...s.openApprovals.filter((a) => a.approvalId !== ev.approval.approvalId), { approvalId: ev.approval.approvalId, botId: ev.botId, roomId: ev.roomId }] });
        play('approvalRequest');
        void notifyEvent({ kind: 'approval', roomId: ev.roomId, botName: botById(s.bots, ev.botId)?.name ?? 'A bot' });
        if (ev.roomId === s.activeRoomId) return;
        const bot = botById(s.bots, ev.botId);
        const room = s.rooms.find((r) => r.id === ev.roomId);
        const who = bot?.name ?? 'A bot';
        const where = room && room.kind === 'group' ? ' in ' + room.name : '';
        get().toast(who + ' needs your approval' + where, false, {
          sticky: true,
          warn: true,
          key: approvalToastKey(ev.roomId, ev.approval.approvalId),
          action: { label: 'Open', run: () => get().setActiveRoom(ev.roomId) },
        });
        return;
      }
      case 'approval.resolved':
        set({
          toasts: get().toasts.filter((t) => !t.key?.startsWith('approval:') || !t.key.endsWith(':' + ev.approvalId)),
          openApprovals: s.openApprovals.filter((a) => a.approvalId !== ev.approvalId),
        });
        return;
      case 'memory.updated':
        set({ memory: { ...s.memory, [ev.botId]: ev.text } });
        return;
      case 'usage.updated':
        set({ usage: { ...s.usage, [ev.botId + ':' + ev.roomId]: ev.totals } });
        return;
      case 'routines.changed':
      case 'routine.fired':
        set({ routinesRev: s.routinesRev + 1 });
        return;
      case 'error':
        if (ev.context && formsSent.has(ev.context)) {
          formsSent.delete(ev.context);
          set({ formErrors: { ...s.formErrors, [ev.context]: { message: ev.message, at: Date.now() } } });
          return;
        }
        if (ev.context && decided.has(ev.context)) {
          decided.delete(ev.context);
          set({ approvalErrors: { ...s.approvalErrors, [ev.context]: ev.message } });
          return;
        }
        if (ev.context && s.outbox.some((e) => e.clientId === ev.context)) {
          patchOutbox(ev.context, 'failed');
          clearAck(ev.context);
          return;
        }
        get().toast(ev.message, true);
        return;
      case 'knowledge.status':
        set({ knowledge: ev.status });
        return;
      case 'voice.updated':
        set({ voiceRev: { ...s.voiceRev, [ev.botId]: (s.voiceRev[ev.botId] ?? 0) + 1 } });
        return;
      case 'triggers.changed':
      case 'trigger.fired':
      case 'integrations.changed':
        set({ triggersRev: s.triggersRev + 1 });
        return;
      case 'computer.control': {
        const was = s.control[ev.status.botId]?.takeover?.messageId;
        const toasts = was && !ev.status.takeover ? s.toasts.filter((t) => t.key !== 'takeover:' + was) : s.toasts;
        set({ control: { ...s.control, [ev.status.botId]: ev.status }, toasts });
        return;
      }
      case 'policies.changed':
        set({ policiesRev: s.policiesRev + 1 });
        return;
      case 'recorder.state':
        set({ recorder: { ...s.recorder, [ev.status.botId]: ev.status } });
        return;
      case 'skills.changed':
        set({ skillsRev: s.skillsRev + 1 });
        return;
      case 'pc-runner.changed':
        set({ pcRunnerRev: s.pcRunnerRev + 1 });
        return;
      case 'files.changed': {
        const key = filesRevKey(ev.roomId, ev.path);
        set({ filesRev: { ...s.filesRev, [key]: (s.filesRev[key] ?? 0) + 1 } });
        return;
      }
      case 'training.changed':
        set({ trainingRev: { ...s.trainingRev, [ev.botId]: (s.trainingRev[ev.botId] ?? 0) + 1 } });
        return;
      case 'task.changed':
        set({ tasksRev: { ...s.tasksRev, [ev.roomId]: (s.tasksRev[ev.roomId] ?? 0) + 1 } });
        return;
      case 'queue.changed': {
        const queues = applyLaneQueue(s.queues, ev.queue);
        if (queues !== s.queues) set({ queues });
        return;
      }
      default:
        return;
    }
  },

  openSearchHit: (roomId, seq, query) => {
    set({ searchTarget: { roomId, seq, query } });
    get().setActiveRoom(roomId);
  },
  setActiveRoom: (id) => {
    if (id) setItem('pocketrocket.activeRoom', id);
    const unread = { ...get().unread };
    if (id) delete unread[id];
    set({ activeRoomId: id, unread, page: id === get().activeRoomId ? get().page : null, searchTarget: get().searchTarget?.roomId === id ? get().searchTarget : null });
    if (id) get().dismissToast({ keyPrefix: 'approval:' + id + ':' });
    if (id && !get().loaded[id]) void get().loadMessages(id);
    const room = id ? get().rooms.find((r) => r.id === id) : null;
    if (room && room.kind === 'dm') set({ panelBotId: room.memberIds[0] });
    else if (room && (!get().panelBotId || !room.memberIds.includes(get().panelBotId!))) set({ panelBotId: room.memberIds[0] ?? null });
  },

  loadMessages: async (roomId) => {
    try {
      const msgs = await api.rooms.messages(roomId);
      const existing = get().messages[roomId] ?? [];
      const ids = new Set(msgs.map((m) => m.id));
      const merged = [...msgs, ...existing.filter((m) => !ids.has(m.id))].sort((a, b) => a.seq - b.seq);
      settleSends(msgs.flatMap((m) => (m.clientMsgId ? [m.clientMsgId] : [])));
      const done = msgs.length < MESSAGE_PAGE || !!get().history[roomId]?.done;
      set({
        messages: { ...get().messages, [roomId]: merged },
        loaded: { ...get().loaded, [roomId]: true },
        history: { ...get().history, [roomId]: { loading: false, done } },
      });
      void get().loadQueue(roomId);
      void get().loadContext(roomId);
    } catch (e) {
      get().toast('Failed to load messages: ' + (e as Error).message, true);
    }
  },

  loadOlder: async (roomId) => {
    const list = get().messages[roomId];
    const h = get().history[roomId];
    if (!get().loaded[roomId] || !list?.length || h?.loading || h?.done || Date.now() < (olderRetryAt.get(roomId) ?? 0)) return;
    const setHistory = (v: { loading: boolean; done: boolean }) => set({ history: { ...get().history, [roomId]: v } });
    setHistory({ loading: true, done: false });
    try {
      const older = await api.rooms.messages(roomId, list[0].seq);
      const current = get().messages[roomId] ?? [];
      const ids = new Set(current.map((m) => m.id));
      const merged = [...older.filter((m) => !ids.has(m.id)), ...current].sort((a, b) => a.seq - b.seq);
      set({ messages: { ...get().messages, [roomId]: merged } });
      setHistory({ loading: false, done: older.length < MESSAGE_PAGE });
    } catch (e) {
      setHistory({ loading: false, done: false });
      olderRetryAt.set(roomId, Date.now() + 5000);
      get().toast("Couldn't load earlier messages: " + (e as Error).message, true);
    }
  },

  sendMessage: (text, attachments, mode) => {
    const roomId = get().activeRoomId;
    const pics = attachments?.length ? attachments : undefined;
    if (!roomId || (!text.trim() && !pics)) return;
    const entry: OutboxEntry = { clientId: newClientId(), roomId, text, status: 'sending', createdAt: Date.now(), ...(pics ? { attachments: pics } : {}), ...(mode ? { mode } : {}) };
    setOutbox([...get().outbox, entry]);
    play('send');
    get().flushOutbox();
  },
  flushOutbox: () => {
    for (const e of get().outbox) {
      if (e.status !== 'sending') continue;
      if (!wsSend({ type: 'message.send', roomId: e.roomId, text: e.text, clientMsgId: e.clientId, ...(e.attachments ? { attachments: e.attachments } : {}), ...(e.mode ? { mode: e.mode } : {}) })) return;
      patchOutbox(e.clientId, 'sent');
      clearAck(e.clientId);
      ackTimers.set(e.clientId, setTimeout(() => {
        ackTimers.delete(e.clientId);
        patchOutbox(e.clientId, get().connected ? 'failed' : 'sending', 'sent');
      }, SEND_ACK_MS));
    }
  },
  retrySend: (clientId) => {
    patchOutbox(clientId, 'sending', 'failed');
    get().flushOutbox();
  },
  discardSend: (clientId) => {
    clearAck(clientId);
    setOutbox(get().outbox.filter((e) => e.clientId !== clientId));
  },
  decide: (approvalId, decision) => {
    decided.add(approvalId);
    const { [approvalId]: _cleared, ...approvalErrors } = get().approvalErrors;
    set({ approvalErrors });
    wsSend({ type: 'approval.decide', approvalId, decision });
    play(decision === 'deny' ? 'deny' : 'approve');
  },
  interrupt: (turnId) => {
    wsSend({ type: 'turn.interrupt', turnId });
  },
  openScreen: (botId) => set({ panelOpen: true, panelKind: 'screen', screenParked: false, panelBotId: botId === undefined ? get().panelBotId : botId }),
  openFiles: (at) => {
    const s = get();
    const roomId = s.activeRoomId;
    set({
      panelOpen: true,
      panelKind: 'files',
      panelExpanded: s.panelKind === 'files' ? s.panelExpanded : false,
      screenParked: s.screenParked || (s.panelOpen && s.panelKind === 'screen'),
      filesTarget: at && roomId ? { roomId, path: at.path, file: at.file, seq: (s.filesTarget?.seq ?? 0) + 1 } : s.filesTarget,
    });
  },
  closePanel: () => {
    const s = get();
    if (tokiLayout(s.device)) {
      const back = s.panelOpen && s.panelKind !== 'overview' && window.innerWidth >= PANEL_INLINE_MIN;
      return set({ panelOpen: back, panelKind: 'overview', screenParked: false, panelExpanded: false });
    }
    set({ panelOpen: false, screenParked: false });
  },
  openPage: (page) => set({ page }),
  closePage: () => set({ page: null }),
  openPcSession: (id) => set({ page: { kind: 'pcsessions' }, pcSessionFocus: id, dialog: null }),
  toggleSidebar: () => get().setSidebarOpen(!get().sidebarOpen),
  setSidebarOpen: (open) => {
    if (!matches(NARROW_SIDEBAR_QUERY)) setItem('pocketrocket.sidebar', open ? '1' : '0');
    set({ sidebarOpen: open });
  },
  setPaneW: (pane, width) => {
    writePaneWidth(pane, width);
    set((s) => ({ paneW: { ...s.paneW, [pane]: width }, panelExpanded: pane === 'panel' ? false : s.panelExpanded }));
  },
  setPaneOpen: (pane, open) => {
    if (pane === 'sidebar') get().setSidebarOpen(open);
    else if (open) set({ panelOpen: true });
    else get().closePanel();
  },
  togglePanelExpanded: () => set((s) => ({ panelExpanded: !s.panelExpanded })),
  openDialog: (dialog) => set({ dialog }),
  toast: (text, bad, opts) => {
    if (bad && !opts?.key && get().toasts.some((t) => t.bad && t.text === text)) return;
    const id = ++toastSeq;
    const rest = opts?.key ? get().toasts.filter((t) => t.key !== opts.key) : get().toasts;
    set({ toasts: [...rest, { id, text, bad, ...opts }] });
    if (!opts?.sticky && !bad) setTimeout(() => get().dismissToast({ id }), 4000);
  },
  dismissToast: (which) => {
    const keep = 'id' in which
      ? (t: Toast) => t.id !== which.id
      : (t: Toast) => !t.key?.startsWith(which.keyPrefix);
    const toasts = get().toasts.filter(keep);
    if (toasts.length !== get().toasts.length) set({ toasts });
  },
  setHubIssue: (hubIssue) => set({ hubIssue }),
  refresh: async () => {
    const [bots, rooms] = await Promise.all([api.bots.list(), api.rooms.list()]);
    set({ bots, rooms });
  },

  updateSettings: async (patch) => {
    const prev = get().settings;
    set({ settings: { ...prev, ...patch } });
    applyLocalSettings(get().settings);
    try {
      const saved = await api.settings.update(patch);
      set({ settings: saved });
      applyLocalSettings(saved);
      return true;
    } catch (e) {
      const current = get().settings;
      const undo = Object.fromEntries(
        (Object.keys(patch) as (keyof Settings)[])
          .filter((key) => current[key] === patch[key])
          .map((key) => [key, prev[key]]),
      ) as Partial<Settings>;
      set({ settings: { ...current, ...undo } });
      applyLocalSettings(get().settings);
      get().toast("Couldn't save that change: " + (e as Error).message, true);
      return false;
    }
  },

  loadInboxSkills: async () => {
    try {
      set({ inboxSkills: await api.skills.list() });
    } catch {
      set({ inboxSkills: get().inboxSkills ?? [] });
    }
  },

  fetchProviders: async () => {
    try {
      const providers = await api.providers.list();
      set({ providers, limits: providers.limits ?? [] });
    } catch {
      set({ providers: get().providers ?? FALLBACK_PROVIDERS });
    }
  },

  fetchFailover: async () => {
    try {
      set({ failover: await api.failover.get() });
    } catch {
      // An older hub (404) has no failover: no cards, no badges.
    }
  },

  dropFailoverCard: (id) => set((s) => ({ failover: { ...s.failover, cards: s.failover.cards.filter((c) => c.id !== id) } })),

  fetchAccount: async () => {
    try {
      const account = await api.account.get();
      set({ account: isAccountState(account) ? account : SIGNED_OUT });
    } catch {
      set({ account: SIGNED_OUT });
    }
  },

  applyAccountResponse: (res) => {
    if (isAccountState(res)) set({ account: res });
    else void get().fetchAccount();
  },
}));

export const selectActiveRoom = (s: State) => s.rooms.find((r) => r.id === s.activeRoomId) ?? null;
export const botById = (bots: Bot[], id: string | null | undefined) => (id ? bots.find((b) => b.id === id) : undefined);

function setOutbox(outbox: OutboxEntry[]) {
  useStore.setState({ outbox });
  writeJournal(outbox);
}

function patchOutbox(clientId: string, status: OutboxEntry['status'], only?: OutboxEntry['status']) {
  const cur = useStore.getState().outbox;
  const at = cur.find((e) => e.clientId === clientId);
  if (!at || at.status === status || (only && at.status !== only)) return;
  setOutbox(cur.map((e) => (e.clientId === clientId ? { ...e, status } : e)));
}

function settleSends(clientIds: string[]) {
  const cur = useStore.getState().outbox;
  if (!cur.length) return;
  const done = new Set(clientIds);
  if (!cur.some((e) => done.has(e.clientId))) return;
  for (const id of done) clearAck(id);
  setOutbox(cur.filter((e) => !done.has(e.clientId)));
}

subscribeLayout(() => {
  const s = useStore.getState();
  if (tokiLayout(s.device)) {
    if (!s.panelOpen && window.innerWidth >= PANEL_INLINE_MIN) useStore.setState({ panelOpen: true, panelKind: 'overview', overviewRail: readOverviewRail(window.innerWidth) });
  } else if (s.panelKind === 'overview') {
    useStore.setState({ panelOpen: false, panelKind: 'screen' });
  }
  if ((s.page?.kind === 'map' || s.page?.kind === 'projectTasks') && !tokiLayout(s.device)) useStore.setState({ page: null });
});
