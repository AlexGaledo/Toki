import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import httpProxy from 'http-proxy';
import {
  HOST, PORT, WEB_DIST, WORKSPACE_DIR, SCREEN_URL, VERSION, DATA_DIR, BOTS_DIR, ENABLED_PROVIDERS, MEDIA_DIR,
  ensureDirs, ensureHubToken, migrateLegacyDb, KNOWLEDGE_SYNC_MINUTES, HUB_TOKEN, HUB_TOKEN_PATH, PROJECTS_DIR, ROOMS_DIR, botFilesDir, setRoomRootsResolver,
} from './config.js';
import type { BusyInfo } from '@pocketrocket/shared';
import { Db } from './db/db.js';
import { reportOrphanBotDirs } from './services/orphanBotDirs.js';
import { Repos } from './db/repos.js';
import { MemoryService } from './services/MemoryService.js';
import { SkillService } from './services/SkillService.js';
import { ensureBuiltinSkills } from './services/builtinSkills.js';
import { UsageTracker } from './services/UsageTracker.js';
import { AutoMemory } from './services/AutoMemory.js';
import { SettingsStore, installSettings } from './services/SettingsStore.js';
import { SecretsStore } from './services/SecretsStore.js';
import { AccountService } from './services/AccountService.js';
import { PermissionBroker } from './permissions/PermissionBroker.js';
import { denyMessage } from './permissions/messages.js';
import { RoomRouter } from './rooms/RoomRouter.js';
import { BotRunner } from './agent/BotRunner.js';
import { RoutingRules } from './services/RoutingRules.js';
import { RoutineScheduler } from './services/RoutineScheduler.js';
import { FollowUp } from './services/FollowUp.js';
import { KnowledgeRepo } from './services/KnowledgeRepo.js';
import { VoiceProposals } from './services/VoiceProposals.js';
import { createProviders } from './providers/registry.js';
import { unattendedRefusal } from './providers/unattended.js';
import { TurnRegistry, createMcpHandler, serveTools } from './mcp/httpServer.js';
import { CONTEXT_CONNECTOR_PREFIX, contextConnectorTools, createContextApi } from './api/context.js';
import { ContextRepo } from './db/contextRepo.js';
import { ProjectService } from './services/ProjectService.js';
import { createProjectsApi } from './api/projects.js';
import { createRest } from './api/rest.js';
import { createScreenOpener } from './services/screenOpen.js';
import { startHistoryBackfill } from './db/historyIndex.js';
import { attachWs } from './api/ws.js';
import { FormBroker } from './services/FormBroker.js';
import { AUTH_CALLBACK_PATH, AuthRateLimiter, bearerToken, checkContentType, checkRequestOrigin, checkToken, clientIp, cookieValue, dropCookie, presentsHubToken, tokenMatches } from './api/guard.js';
import { ScreenSessions, screenCookieName, screenViewerPath } from './api/screenSession.js';
import { readBody } from './api/body.js';
import { handleAuthCallback } from './api/authCallback.js';
import { addSecret, logError } from './providers/redact.js';
import { ComputersRepo } from './db/computers.js';
import { ComputerManager } from './services/ComputerManager.js';
import { events } from './events.js';
import { IntegrationService } from './services/IntegrationService.js';
import { createIntegrationsApi } from './api/integrations.js';
import { TelegramService } from './services/TelegramService.js';
import { createTelegramApi } from './api/telegram.js';
import { createMcpServersApi } from './api/mcpServers.js';
import { createCredentialsApi } from './api/credentials.js';
import { CredentialStore } from './services/CredentialStore.js';
import { McpServerStore } from './services/outsideMcpStore.js';
import { cspModeFrom, webSecurityHeaders } from './api/csp.js';
import { OAUTH_START_PREFIX, handleOAuthCallback, handleOAuthStart } from './api/oauth.js';
import { OAUTH_CALLBACK_PREFIX } from './api/guard.js';
import { TriggerService } from './services/TriggerService.js';
import { WorkflowRepo } from './db/workflowRepo.js';
import { WorkflowRunner } from './services/WorkflowRunner.js';
import { createWorkflowsApi } from './api/workflows.js';
import { createFailoverApi } from './api/failover.js';
import { FailoverRepo } from './db/failoverRepo.js';
import { FailoverService } from './services/Failover.js';
import { createTriggersApi } from './api/triggers.js';
import type { SocketFactory } from './services/SlackSocketMode.js';
import { ALLOWED_HOSTS, ATTACHMENTS_DIR, PUSH_SUBJECT, VAPID_PATH } from './config.js';
import { sweepAttachments } from './agent/attachments.js';
import { seedDefaultBots } from './services/SeedBots.js';
import { DEVICE_PAIR_PATH, deviceMayAccess, setPrincipal } from './api/guard.js';
import { DevicesRepo } from './db/devices.js';
import { DeviceService } from './services/DeviceService.js';
import { PushService } from './services/PushService.js';
import { AUTH_LOGIN_PATH, AUTH_STATUS_PATH, createAuthApi, handleAuthStatus, handleLogin } from './api/auth.js';
import { AuthService, SESSION_COOKIE } from './services/AuthService.js';
import { auditRequest } from './services/AuditLog.js';
import { createDevicesApi, handleDevicePair } from './api/devices.js';
import type { WebSocket as WsSocket } from 'ws';
import { ApprovalStore, type ParkedApproval } from './db/approvalStore.js';
import { ComputerControlService, type VncControl } from './services/ComputerControl.js';
import { createTakeoverApi } from './api/takeover.js';
import { handBackNote } from './rooms/RoomRouter.js';
import { Recorder, type RecorderDeps } from './services/Recorder.js';
import { SkillDistiller } from './services/SkillDistiller.js';
import { SkillReflection } from './services/SkillReflection.js';
import { Training, type TrainingDeps } from './services/Training.js';
import { createTeachApi } from './api/teach.js';
import { MEDIA_SWEEP_MS, MediaStore, referencedMedia } from './services/MediaStore.js';
import { createMediaApi } from './api/media.js';
import { createFilesApi } from './api/files.js';
import { RoomFiles } from './rooms/roomFiles.js';
import { FileRevisions } from './services/FileRevisions.js';
import { PcRunner, type PcRunnerOptions } from './services/PcRunner.js';
import { createPcRunnerApi } from './api/pcRunner.js';
import { createCcApi } from './api/cc.js';
import { PcSessions, type PcSessionsOptions } from './services/PcSessions.js';
import { SessionMoves, type SessionMovesDeps } from './services/SessionMoves.js';
import { createPcSessionsApi } from './api/pcSessions.js';
import { runnerMayAccess } from './api/guard.js';

export interface HubOptions {
  port?: number;
  token?: string | null;
  dbFile?: string;
  skipBootstrap?: boolean;
  projectsDir?: string;
  roomsDir?: string;
  dmFilesDir?: (botId: string) => string;
  routingFile?: string;
  account?: AccountService;
  computers?: (db: Db) => ComputerManager;
  integrations?: (db: Db) => IntegrationService;
  telegram?: (db: Db, vault: IntegrationService['vault']) => TelegramService;
  slackSocket?: SocketFactory;
  allowedHosts?: readonly string[];
  push?: (devices: DevicesRepo, repos: Repos) => PushService;
  seedBots?: boolean;
  vnc?: VncControl;
  recorder?: Partial<Omit<RecorderDeps, 'computers' | 'control'>>;
  training?: Partial<Pick<TrainingDeps, 'run' | 'exeExists' | 'claudeReady' | 'now' | 'timezone'>>;
  mediaDir?: string;
  mcpServers?: { file?: string; fetch?: typeof fetch };
  credentials?: { file?: string; keyFile?: string };
  pcRunner?: Partial<Omit<PcRunnerOptions, 'db'>>;
  pcBundleMaxBytes?: number;
  pcSessions?: PcSessionsOptions;
  sessionMoves?: Partial<Pick<SessionMovesDeps, 'configDir' | 'model' | 'feedEveryMs' | 'runTurn'>> & { dir?: string; uploadMaxBytes?: number };
  exit?: (code: number) => void;
}

export interface Hub {
  server: http.Server;
  port: number;
  repos: Repos;
  settings: SettingsStore;
  secrets: SecretsStore;
  account: AccountService;
  providers: ReturnType<typeof createProviders>;
  turns: TurnRegistry;
  runner: BotRunner;
  computers: ComputerManager;
  integrations: IntegrationService;
  telegram: TelegramService;
  triggers: TriggerService;
  devices: DeviceService;
  push: PushService;
  control: ComputerControlService;
  broker: PermissionBroker;
  approvals: ApprovalStore;
  workflows: WorkflowRunner;
  workflowRepo: WorkflowRepo;
  failover: FailoverService;
  skills: SkillService;
  recorder: Recorder;
  distiller: SkillDistiller;
  media: MediaStore;
  pcRunner: PcRunner;
  projects: ProjectService;
  pcSessions: PcSessions;
  sessionMoves: SessionMoves;
  listen(): Promise<number>;
  shutdown(): Promise<void>;
  stop(reason: string): Promise<void>;
  busy(): BusyInfo;
}

export function createHub(opts: HubOptions = {}): Hub {
  const token = opts.token !== undefined ? opts.token : ensureHubToken();
  addSecret(token);
  let port = opts.port ?? PORT;
  if (!opts.skipBootstrap) {
    ensureDirs();
    migrateLegacyDb();
  }

  const db = opts.dbFile ? new Db(opts.dbFile) : new Db();
  const stopHistoryBackfill = startHistoryBackfill(db);
  const repos = new Repos(db);
  const memory = new MemoryService();
  if (!opts.skipBootstrap) {
    reportOrphanBotDirs(BOTS_DIR, repos.listBots().map((b) => b.id));
  }
  const skills = new SkillService(repos);
  if (!opts.skipBootstrap) {
    try { ensureBuiltinSkills(skills, repos); } catch (e) { logError('[builtin skills]', e); }
  }
  const secrets = new SecretsStore();
  const account = opts.account ?? new AccountService();
  const settings = new SettingsStore({
    repos,
    enabled: ENABLED_PROVIDERS,
    models: (p) => providers.modelsSync(p),
    modelsAsync: (p) => providers.modelsAwaited(p),
  });
  const usage = new UsageTracker(repos, { alertThresholdUsd: () => settings.get().spendAlertThresholdUsd });
  installSettings(settings);
  repos.renameOwner(settings.get().userName);
  if (opts.seedBots) {
    const seeded = seedDefaultBots(repos, memory);
    if (seeded.length) console.log('created default bots: ' + seeded.map((b) => '@' + b.handle).join(', '));
  }
  const providers = createProviders({ settings, enabled: ENABLED_PROVIDERS });
  settings.ensureEnabledProvider();
  const knowledge = new KnowledgeRepo({ repos, source: () => settings.get().knowledgeRepo });
  const voice = new VoiceProposals(repos, memory);
  const approvalStore = new ApprovalStore(db);
  approvalStore.clearSessionPolicies();
  const broker = new PermissionBroker(repos, {
    bypass: () => settings.approvals() === 'bypass',
    globalReadOnly: () => settings.approvals() === 'read-only',
    readOnlyRoots: () => { const d = knowledge.activeDir(); return d ? [d] : []; },
    store: approvalStore,
  });
  const expired = repos.expirePendingApprovals();
  if (expired.length) console.log('expired ' + expired.length + ' approval card(s) left open by the previous run');
  const router = new RoomRouter(repos, usage);
  const turns = new TurnRegistry();
  const routing = new RoutingRules(opts.routingFile);
  if (!opts.skipBootstrap) routing.ensureSeeded();
  const computers = opts.computers
    ? opts.computers(db)
    : new ComputerManager(new ComputersRepo(db), {
        routineDueSoon: (botId, withinMs) => {
          const t = Date.now();
          return repos.listRoutines().some((r) => r.botId === botId && r.enabled && r.nextRunAt !== null && r.nextRunAt - t <= withinMs);
        },
      });
  const offComputers = events.onEvent((ev) => {
    if (ev.type === 'bots.changed') void computers.prune(ev.bots.map((b) => b.id)).catch((e) => console.warn('[computers] ' + (e as Error).message));
  });
  const media = new MediaStore(opts.mediaDir ?? MEDIA_DIR);
  const runner = new BotRunner(repos, memory, skills, broker, usage, {
    dispatchFromBot: (req, targets, onDone) => router.dispatchFromBot(req, targets, onDone),
    setState: (botId, roomId, state, note) => router.setState(botId, roomId, state, note),
    routinesChanged: () => scheduler.reload(),
  }, providers, turns, computers, { knowledgeDir: () => knowledge.activeDir(), routing }, media);
  router.runner = runner;
  router.unattendedRefusal = (bot, provider) => unattendedRefusal(providers, bot, provider);
  const forms = new FormBroker(repos);
  runner.forms = forms;
  const claudeReady = () => providers.claudeReady();
  runner.claudeReady = claudeReady;
  router.autoMemory = new AutoMemory({ repos, memory, usage, claudeReady, voice });
  const scheduler = new RoutineScheduler(repos, router);
  const followUp = new FollowUp({ repos, router, heldRuns: () => [...approvalStore.parkedOwnerRefs(), ...control.parkedOwnerRefs()] });

  const control = new ComputerControlService({ computers, repos, vnc: opts.vnc });
  const usesComputer = (botId: string) => {
    const tools = repos.getBot(botId)?.allowedTools ?? [];
    return tools.includes('Browser') || tools.includes('Desktop');
  };
  const screenOpener = createScreenOpener({ repos, computers, usesComputer });
  computers.wire({
    usesComputer,
    personHolds: (botId) => control.get(botId).control !== 'agent',
  });
  const restoredTakeovers = control.restoreParked();
  if (restoredTakeovers) console.log('restored ' + restoredTakeovers + ' parked takeover(s) from the previous run');
  runner.control = control;
  router.control = control;
  broker.onParkedDecision = (p, decision) => {
    router.resumeParked(p.botId, p.roomId, { causeId: p.causeId, hop: p.hop, ownerRef: p.ownerRef, note: parkedDecisionNote(p, decision) });
  };
  control.onParkedHandBack = (botId, t, note) => {
    router.resumeParked(botId, t.roomId, {
      causeId: t.causeId, hop: t.hop, ownerRef: t.ownerRef,
      note: note === null
        ? '(Nobody took over your computer within ' + Math.round(control.maxParkMs / 3_600_000) + ' hours of your request "' + t.reason +
          '", so you have control again. Do not ask again right away; tell the user what is still blocked.)'
        : handBackNote(note || 'no note'),
    });
  };
  approvalStore.prunePolicies(repos.listBots().map((b) => b.id));
  const offP2 = events.onEvent((ev) => {
    if (ev.type !== 'bots.changed') return;
    const ids = ev.bots.map((b) => b.id);
    approvalStore.prunePolicies(ids);
    control.prune(ids);
  });
  const takeoverApi = createTakeoverApi({ repos, control, store: approvalStore, broker });
  let p2Timer: NodeJS.Timeout | null = null;

  const recorder = new Recorder({ computers, control, ...opts.recorder });
  recorder.listen();
  const claudeModels = () => providers.modelsSync('claude');
  const distiller = new SkillDistiller({ repos, skills, recorder, usage, claudeReady, models: claudeModels });
  router.skillReflection = new SkillReflection({ repos, skills, usage, claudeReady, models: claudeModels });
  const training = new Training({ repos, memory, usage, claudeReady, models: claudeModels, ...opts.training });
  skills.versionsRepo.prune(repos.listBots().map((b) => b.id));
  training.prune(repos.listBots().map((b) => b.id));
  const offP6 = events.onEvent((ev) => {
    if (ev.type !== 'bots.changed') return;
    skills.versionsRepo.prune(ev.bots.map((b) => b.id));
    training.prune(ev.bots.map((b) => b.id));
  });
  const teachApi = createTeachApi({ repos, skills, recorder, distiller, training });

  const integrations = opts.integrations ? opts.integrations(db) : new IntegrationService({ db });
  runner.integrations = integrations;
  integrations.pruneGrants(repos.listBots().map((b) => b.id));
  const offBots = events.onEvent((ev) => { if (ev.type === 'bots.changed') integrations.pruneGrants(ev.bots.map((b) => b.id)); });
  const integrationsApi = createIntegrationsApi({ integrations, repos });
  const hubUrlForPhone = () => { const h = (opts.allowedHosts ?? ALLOWED_HOSTS)[0]; return h ? 'https://' + h + '/' : null; };
  const telegram = opts.telegram ? opts.telegram(db, integrations.vault) : new TelegramService({ db, vault: integrations.vault, hubUrl: hubUrlForPhone });
  const telegramApi = createTelegramApi({ telegram });

  const triggers = new TriggerService({ db, repos, integrations, router, socket: opts.slackSocket });
  const workflowRepo = new WorkflowRepo(db);
  const triggersApi = createTriggersApi({ triggers, inUse: (id) => workflowRepo.forTrigger(id).length > 0 });
  router.triggerBudget = (id) => triggers.remainingBudget(id);

  const screenSessions = new ScreenSessions();

  const allowedHosts = opts.allowedHosts ?? ALLOWED_HOSTS;
  const devicesRepo = new DevicesRepo(db);
  const devices = new DeviceService(devicesRepo);
  const push = opts.push
    ? opts.push(devicesRepo, repos)
    : PushService.withFile({ devices: devicesRepo, repos, subject: PUSH_SUBJECT, vapidPath: VAPID_PATH });
  push.setTelegram(telegram);
  const devicesApi = createDevicesApi({ devices, push, allowedHosts });
  const deviceSockets = new Map<string, Set<{ close(): void }>>();
  const trackDeviceSocket = (deviceId: string, s: { close(): void }, onClose: (fn: () => void) => void) => {
    let set = deviceSockets.get(deviceId);
    if (!set) deviceSockets.set(deviceId, (set = new Set()));
    const mine = set;
    mine.add(s);
    onClose(() => {
      mine.delete(s);
      if (!mine.size && deviceSockets.get(deviceId) === mine) deviceSockets.delete(deviceId);
    });
  };
  const offRevoke = devices.onRevoke((id) => {
    screenSessions.revokeOwner(id);
    for (const s of deviceSockets.get(id) ?? []) s.close();
    deviceSockets.delete(id);
  });
  const mediaApi = createMediaApi({ media });
  const sweepMedia = () => {
    if (opts.skipBootstrap && !opts.mediaDir) return;
    try { media.sweep(referencedMedia(repos, settings.get())); } catch (e) { logError('[media]', e); }
    try { sweepAttachments(ATTACHMENTS_DIR, new Set(repos.listBots().map((b) => b.id))); } catch (e) { logError('[attachments]', e); }
  };
  let mediaTimer: NodeJS.Timeout | null = null;
  const busy = (): BusyInfo => {
    const running = runner.activeTurnCount();
    const liveCards = broker.liveCardCount();
    return {
      blocking: running + liveCards, running, liveCards,
      pendingLanes: router.pendingLaneCount(), parkedCards: broker.parked().length, waitingRuns: repos.runningRuns().length,
      heldUntil: router.heldUntil(),
    };
  };
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let stopping: Promise<void> | null = null;
  const rest = createRest({
    busy,
    stop: () => { setImmediate(() => void hub.stop('maintenance stop')); },
    media, routineInUse: (id) => workflowRepo.forRoutine(id).length > 0,
    repos, memory, skills, scheduler, router, runner, settings, secrets, providers, screenSessions, account, knowledge, voice, computers, screenOpener, routing,
    viewOnly: (scope) => control.viewOnly(scope),
  });
  const handleMcp = createMcpHandler(turns);
  const contextRepo = new ContextRepo(db);
  const projects = new ProjectService({ db, repos, memory, root: opts.projectsDir ?? PROJECTS_DIR });
  runner.projects = projects;
  const roomFiles = new RoomFiles({ projects, roomsDir: opts.roomsDir ?? ROOMS_DIR, dmDir: opts.dmFilesDir ?? botFilesDir });
  runner.roomFiles = roomFiles;
  const revisions = new FileRevisions(repos.db);
  runner.revisions = revisions;
  const workflows = new WorkflowRunner({
    repos, workflows: workflowRepo, router, usage, roomFiles, revisions,
    triggerExists: (id) => !!triggers.repo.get(id),
    heldOwners: () => [...approvalStore.parkedOwnerRefs(), ...control.parkedOwnerRefs()],
  });
  scheduler.workflows = (id, manual) => workflows.fireRoutine(id, { manual });
  triggers.workflows = (id, event, manual) => workflows.fireTrigger(id, event, { manual });
  runner.workflows = workflows;
  const workflowsApi = createWorkflowsApi({ repos, workflows: workflowRepo, runner: workflows });
  const failover = new FailoverService({
    repo: new FailoverRepo(db), repos,
    label: (id) => providers.get(id).label,
    enabled: (id) => providers.enabled.includes(id),
    isHeld: (id, model) => providers.health.isHeld(id, model),
    note: (roomId, text, causeId, hop) => {
      const room = repos.getRoom(roomId);
      if (room) router.systemNote(room, text, causeId, hop);
    },
    continueTurn: (c) => router.continueOnBackup(c),
    onChange: (s) => events.emitEvent({ type: 'failover.changed', ...s }),
  });
  router.failover = failover;
  const failoverApi = createFailoverApi({ failover });
  setRoomRootsResolver((botId, roomId) => {
    const room = repos.getRoom(roomId);
    const folder = room ? roomFiles.forBot(room, botId) : null;
    return folder ? [folder.dir] : [];
  });
  const filesApi = createFilesApi({ repos, roomFiles, screenOpener, revisions });
  const pcRunner = new PcRunner({ db, file: path.join(DATA_DIR, 'pc-runner.json'), ...opts.pcRunner });
  runner.pcRunner = pcRunner;
  const pcSessions = new PcSessions(db, opts.pcSessions);
  runner.pcSessions = pcSessions;
  pcSessions.linker = (repo) => projects.linksFor(repo);
  const sessionMoves = new SessionMoves({
    db, repos, pcRunner, pcSessions, projects,
    dir: opts.sessionMoves?.dir ?? path.join(DATA_DIR, 'pc-moves'),
    runTurn: opts.sessionMoves?.runTurn ?? ((r) => runner.runOffloadTurn(r)),
    configDir: opts.sessionMoves?.configDir, model: opts.sessionMoves?.model, feedEveryMs: opts.sessionMoves?.feedEveryMs,
  });
  pcSessions.mover = (id) => {
    const m = sessionMoves.summary(id);
    return m;
  };
  pcSessions.locked = (id) => sessionMoves.locked(id);
  pcRunner.onFinished = (job) => sessionMoves.onJobFinished(job);
  sessionMoves.reconcile();
  runner.sessionMoves = sessionMoves;
  const pcRunnerApi = createPcRunnerApi({ pcRunner, repos, db, pcSessions, projects, sessionMoves, bundleMaxBytes: opts.pcBundleMaxBytes, sessionMaxBytes: opts.sessionMoves?.uploadMaxBytes });
  const pcSessionsApi = createPcSessionsApi({ pcSessions, db, sessionMoves });
  let pcPruneTimer: NodeJS.Timeout | null = null;
  const prunePcSessions = () => {
    try {
      const { removed } = pcSessions.prune();
      if (removed) console.log('[pc-sessions] pruned ' + removed + ' mirrored session(s)');
    } catch (e) {
      logError('[pc-sessions]', e);
    }
  };
  const ccApi = createCcApi({ repos, roomFiles, revisions, router, projects, sessionMoves });
  projects.pruneMembers(repos.listBots().map((b) => b.id));
  const offProjectBots = events.onEvent((ev) => { if (ev.type === 'bots.changed') projects.pruneMembers(ev.bots.map((b) => b.id)); });
  const projectsApi = createProjectsApi({ projects, repos, db });
  const mcpServersApi = createMcpServersApi({ store: new McpServerStore(opts.mcpServers?.file), db, fetch: opts.mcpServers?.fetch });
  const credentials = new CredentialStore(db, opts.credentials);
  runner.credentials = credentials;
  const credentialsApi = createCredentialsApi({ store: credentials, db });
  const contextApi = createContextApi({ context: contextRepo, projects });
  const connectorTools = contextConnectorTools(contextRepo);

  const webHeaders = webSecurityHeaders(cspModeFrom(process.env.POCKETROCKET_CSP));

  const MIME: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
    '.webmanifest': 'application/manifest+json',
  };

  const screenProxy = httpProxy.createProxyServer({ target: SCREEN_URL, ws: true, changeOrigin: true });
  // Nothing secret rides these URLs any more, but the noVNC page is a live view of a real desktop: keep it
  // out of caches, out of Referer headers, and out of anyone else's frame.
  screenProxy.on('proxyRes', (proxyRes) => {
    proxyRes.headers['referrer-policy'] = 'no-referrer';
    proxyRes.headers['cache-control'] = 'no-store';
    proxyRes.headers['x-frame-options'] = 'SAMEORIGIN';
  });
  screenProxy.on('error', (_err, _req, res) => {
    if (res && 'writeHead' in res && typeof res.writeHead === 'function' && !res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('This screen is not running.');
    } else if (res && 'destroy' in res) {
      (res as { destroy: () => void }).destroy();
    }
  });

  const isPublicAsset = (pathname: string): boolean => {
    const file = path.join(WEB_DIST, pathname);
    if (!file.startsWith(WEB_DIST + path.sep)) return false;
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };

  /**
   * `/screen/*` is the one place a browser cannot set a header (an iframe, then a websocket), so it presents the
   * httpOnly cookie `/screen/session` handed out for a ticket.
   */
  const screenAuth = (req: http.IncomingMessage): boolean => {
    const { scope } = screenRoute(new URL(req.url ?? '/', 'http://localhost').pathname);
    return screenSessions.valid(cookieValue(req, screenCookieName(scope)), scope) || (token !== null && tokenMatches(bearerToken(req), token));
  };

  function screenRoute(pathname: string): { scope: string | null; rest: string; target: string } {
    const m = /^\/screen\/([^/]+)(\/.*)?$/.exec(pathname);
    const ep = m ? computers.existingEndpoint(m[1]) : null;
    if (m && ep) return { scope: m[1], rest: m[2] ?? '/', target: ep.screenUrl };
    return { scope: null, rest: pathname.slice('/screen'.length), target: SCREEN_URL };
  }

  const limiter = new AuthRateLimiter();
  const auth = new AuthService(db);
  if (process.env.POCKETROCKET_RESET_PASSWORD === '1' && auth.clearPassword(repos.owner().id)) {
    console.log('[pocketrocket] POCKETROCKET_RESET_PASSWORD=1: the owner password was cleared and every browser signed out. Set a new one in Settings, then remove the variable.');
  }
  // Cookies ignore ports, so hubs on one machine need different names or signing in to one signs out the other.
  const sessionCookieName = () => SESSION_COOKIE + '_' + port;
  const authDeps = { db, repos, auth, limiter, cookieName: sessionCookieName };
  const authApi = createAuthApi(authDeps);
  const offSessionRevoke = auth.onRevoke((id) => {
    screenSessions.revokeOwner('session:' + id);
    for (const s of deviceSockets.get('session:' + id) ?? []) s.close();
    deviceSockets.delete('session:' + id);
  });
  const sessionOf = (req: http.IncomingMessage) => auth.authenticate(cookieValue(req, sessionCookieName()));

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const guard = checkRequestOrigin(req, port, { allowedHosts });
      if (!guard.ok) {
        res.writeHead(guard.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: guard.reason }));
        return;
      }
      const ip = clientIp(req);
      if (limiter.blocked(ip)) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
        res.end(JSON.stringify({ error: 'Too many failed authentication attempts; try again in a minute' }));
        return;
      }
      if (url.pathname === '/screen/session' && (req.method ?? 'GET') === 'GET') {
        const redeemed = screenSessions.redeemScoped(url.searchParams.get('ticket'));
        if (!redeemed) {
          limiter.fail(ip);
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or expired screen ticket' }));
          return;
        }
        limiter.succeed(ip);
        res.writeHead(302, {
          'set-cookie': redeemed.cookie,
          location: screenViewerPath(redeemed.scope, control.viewOnly(redeemed.scope)),
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
        res.end();
        return;
      }
      let deviceId: string | null = null;
      const deviceToken = (t: string) => (deviceId = devices.authenticate(t)) !== null;
      const runnerToken = (t: string) => pcRunner.authenticate(t);
      const session = sessionOf(req);
      if (!checkToken(req, url, token, { isPublicAsset, screenAuth, deviceToken, runnerToken, session: () => !!session })) {
        limiter.fail(ip);
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid hub token' }));
        return;
      }
      if (presentsHubToken(req, url, token)) setPrincipal(req, { kind: 'hub', userId: repos.owner().id });
      else if (session) {
        setPrincipal(req, { kind: 'hub', sessionId: session.sessionId, userId: session.userId });
      } else if (deviceId) {
        setPrincipal(req, { kind: 'device', deviceId });
        limiter.succeed(ip);
        if (!deviceMayAccess(req.method ?? 'GET', url.pathname)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not available from a paired device; use the desktop app' }));
          return;
        }
      } else if (runnerToken(bearerToken(req) ?? '')) {
        setPrincipal(req, { kind: 'runner' });
        limiter.succeed(ip);
        if (!runnerMayAccess(req.method ?? 'GET', url.pathname)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not available to the PC runner' }));
          return;
        }
      }
      const auditMethod = req.method ?? 'GET';
      // The connector's secret is its path, so the path itself must not reach the log.
      const auditPath = url.pathname.startsWith(CONTEXT_CONNECTOR_PREFIX) ? CONTEXT_CONNECTOR_PREFIX + '*' : url.pathname;
      if (auditMethod !== 'GET') {
        const end = res.end.bind(res) as (...a: unknown[]) => http.ServerResponse;
        let logged = false;
        res.end = ((...a: unknown[]) => {
          if (!logged) {
            logged = true;
            auditRequest(db, req, auditMethod, auditPath, res.statusCode);
          }
          return end(...a);
        }) as typeof res.end;
      }
      if (url.pathname === AUTH_STATUS_PATH && auditMethod === 'GET') { handleAuthStatus(req, res, authDeps); return; }
      if (url.pathname === AUTH_CALLBACK_PATH && (req.method ?? 'GET') === 'GET') {
        await handleAuthCallback(req, res, url, { account, limiter });
        return;
      }
      if (url.pathname.startsWith(OAUTH_CALLBACK_PREFIX) && (req.method ?? 'GET') === 'GET') {
        await handleOAuthCallback(req, res, url, { integrations, limiter });
        return;
      }
      if (presentsHubToken(req, url, token)) limiter.succeed(ip);
      const ct = checkContentType(req, url);
      if (!ct.ok) {
        res.writeHead(ct.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: ct.reason }));
        return;
      }
      if (url.pathname === DEVICE_PAIR_PATH && (req.method ?? 'GET') === 'POST') {
        await handleDevicePair(req, res, { devices, limiter });
        return;
      }
      // The public connector. A wrong secret must not feed the limiter: behind the proxy every caller is
      // 127.0.0.1, so anyone on the internet could lock the owner out of their own hub.
      if (url.pathname.startsWith(CONTEXT_CONNECTOR_PREFIX)) {
        const secret = decodeURIComponent(url.pathname.slice(CONTEXT_CONNECTOR_PREFIX.length));
        if (!secret || !contextRepo.connectorTokenMatches(secret)) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        let body: unknown;
        if ((req.method ?? 'GET') === 'POST') {
          const buf = await readBody(req);
          if (buf === null) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Request body too large' }));
            return;
          }
          try { body = buf.length ? JSON.parse(buf.toString('utf8')) : undefined; } catch { body = undefined; }
        }
        await serveTools(connectorTools, req, res, body);
        return;
      }
      if (url.pathname === '/mcp') {
        let body: unknown;
        if ((req.method ?? 'GET') === 'POST') {
          const buf = await readBody(req);
          if (buf === null) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Request body too large' }));
            return;
          }
          const raw = buf.toString('utf8');
          try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
        }
        await handleMcp(req, res, body);
        return;
      }
      if (url.pathname.startsWith(OAUTH_START_PREFIX)) {
        await handleOAuthStart(req, res, url, { integrations });
        return;
      }
      if (url.pathname === AUTH_LOGIN_PATH && auditMethod === 'POST') { await handleLogin(req, res, authDeps); return; }
      if (await authApi(req, res, url)) return;
      if (await mediaApi(req, res)) return;
      if (await devicesApi(req, res)) return;
      if (await integrationsApi(req, res)) return;
      if (await telegramApi(req, res)) return;
      if (await triggersApi(req, res)) return;
      if (await workflowsApi(req, res)) return;
      if (await failoverApi(req, res)) return;
      if (await contextApi(req, res)) return;
      if (await projectsApi(req, res)) return;
      if (await filesApi(req, res)) return;
      if (await mcpServersApi(req, res)) return;
      if (await credentialsApi(req, res)) return;
      if (await pcRunnerApi(req, res)) return;
      if (await ccApi(req, res)) return;
      if (await pcSessionsApi(req, res)) return;
      if (await takeoverApi(req, res)) return;
      if (await teachApi(req, res)) return;
      if (await rest(req, res)) return;
      if (url.pathname.startsWith('/screen/')) {
        const route = screenRoute(url.pathname);
        req.url = route.rest + url.search;
        // The screen backend runs beside the bots, and a sign-in cookie opens the whole hub.
        dropCookie(req, sessionCookieName());
        screenProxy.web(req, res, { target: route.target });
        return;
      }
      let file = path.join(WEB_DIST, url.pathname === '/' ? 'index.html' : url.pathname);
      if (!file.startsWith(WEB_DIST)) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIST, 'index.html');
      if (!fs.existsSync(file)) {
        res.writeHead(200, { 'content-type': 'text/plain', ...webHeaders });
        res.end('Toki hub running. Web UI not built; run `pnpm dev` for Vite dev server or `pnpm build`.');
        return;
      }
      const isShell = ['index.html', 'theme-init.js', 'sw.js', 'manifest.json', 'manifest.webmanifest'].includes(path.basename(file));
      res.writeHead(200, {
        ...webHeaders,
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': isShell ? 'no-cache, no-store, must-revalidate' : 'public, max-age=31536000, immutable',
      });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      logError('[static]', e);
      res.writeHead(500);
      res.end('error');
    }
  });

  const wss = attachWs(server, { media, forms, repos, router, broker, settings, signedIn: (req) => !!sessionOf(req) });
  server.on('upgrade', (req, socket, head) => {
    const p = req.url ?? '';
    const url = new URL(p, 'http://localhost');
    const ip = clientIp(req);
    if (limiter.blocked(ip) || !checkRequestOrigin(req, port, { allowedHosts }).ok) {
      socket.destroy();
      return;
    }
    let deviceId: string | null = null;
    const deviceToken = (t: string) => (deviceId = devices.authenticate(t)) !== null;
    const session = sessionOf(req);
    if (!checkToken(req, url, token, { isPublicAsset, screenAuth, deviceToken, session: () => !!session })) {
      limiter.fail(ip);
      socket.destroy();
      return;
    }
    if (presentsHubToken(req, url, token)) {
      limiter.succeed(ip);
      setPrincipal(req, { kind: 'hub', userId: repos.owner().id });
    } else if (session) {
      setPrincipal(req, { kind: 'hub', sessionId: session.sessionId, userId: session.userId });
    } else if (deviceId) {
      limiter.succeed(ip);
      setPrincipal(req, { kind: 'device', deviceId });
    }
    if (url.pathname === '/ws') {
      const id: string | null = deviceId;
      const sessionId = session?.sessionId;
      wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
        if (sessionId && !presentsHubToken(req, url, token)) trackDeviceSocket('session:' + sessionId, { close: () => ws.close(4001, 'signed out') }, (fn) => ws.once('close', fn));
        if (id) trackDeviceSocket(id, { close: () => ws.close(4001, 'device revoked') }, (fn) => ws.once('close', fn));
        wss.emit('connection', ws, req);
      });
    } else if (url.pathname.startsWith('/screen/')) {
      const route = screenRoute(url.pathname);
      req.url = route.rest + url.search;
      if (route.scope) socket.once('close', computers.viewerOpened(route.scope));
      const owner = screenSessions.ownerOf(cookieValue(req, screenCookieName(route.scope)), route.scope);
      if (owner) trackDeviceSocket(owner, { close: () => socket.destroy() }, (fn) => socket.once('close', fn));
      dropCookie(req, sessionCookieName());
      screenProxy.ws(req, socket, head, { target: route.target });
    } else {
      socket.destroy();
    }
  });

  const hub: Hub = {
    busy,
    stop(reason: string) {
      stopping ??= (async () => {
        console.log('[pocketrocket] ' + reason + ': shutting down');
        const force = setTimeout(() => exit(0), 8000);
        force.unref();
        try {
          await hub.shutdown();
        } catch (e) {
          logError('[shutdown]', e);
        }
        clearTimeout(force);
        exit(0);
      })();
      return stopping;
    },
    server, get port() { return port; }, repos, settings, secrets, account, providers, turns, runner, computers, integrations, telegram, triggers, devices, push, pcRunner, pcSessions, sessionMoves, projects,
    control, broker, approvals: approvalStore, workflows, workflowRepo, failover,
    skills, recorder, distiller, media,
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          port = (server.address() as { port: number }).port;
          const resumed = followUp.resumeInterrupted();
          if (resumed) console.log('resuming ' + resumed + ' turn(s) cut off by the previous run');
          workflows.recover();
          followUp.start();
          control.start();
          broker.sweepParked();
          failover.sweep();
          p2Timer ??= setInterval(() => { broker.sweepParked(); control.sweep(); auth.expireDue(); workflows.sweep(); failover.sweep(); }, 60_000);
          p2Timer.unref();
          prunePcSessions();
          pcPruneTimer ??= setInterval(prunePcSessions, 24 * 60 * 60_000);
          pcPruneTimer.unref();
          sweepMedia();
          mediaTimer ??= setInterval(sweepMedia, MEDIA_SWEEP_MS);
          mediaTimer.unref();
          scheduler.start();
          training.start();
          triggers.start();
          push.start();
          knowledge.start(KNOWLEDGE_SYNC_MINUTES);
          void computers.startBackground(repos.listBots()).catch((e) => console.warn('[computers] ' + (e as Error).message));
          void account.start();
          console.log(
            'Toki hub v' + VERSION + ' · node ' + process.versions.node +
            ' · provider ' + settings.get().provider + ' · data ' + DATA_DIR +
            ' · http://' + HOST + ':' + port,
          );
          console.log('[pocketrocket] workspace: ' + WORKSPACE_DIR + (token ? '  (token required)' : ''));
          if (settings.approvals() === 'bypass') {
            console.warn(
              '[pocketrocket] WARNING: permissions bypassed — bots run every shell/file/web action with no approval card (' +
              (settings.approvalsLocked ? 'set by POCKETROCKET_BYPASS_PERMISSIONS; =0 to restore' : 'turn approvals back on in Settings') + ')',
            );
          }
          if (token) console.log('[pocketrocket] open: http://' + HOST + ':' + port + '/  (sign in with the token from ' + (HUB_TOKEN ? 'POCKETROCKET_TOKEN' : HUB_TOKEN_PATH) + ')');
          resolve(port);
        });
      }),
    async shutdown() {
      stopHistoryBackfill();
      scheduler.stop();
      await training.stop();
      triggers.stop();
      followUp.stop();
      control.stop();
      offP2();
      offP6();
      await recorder.shutdown();
      if (p2Timer) clearInterval(p2Timer);
      if (mediaTimer) clearInterval(mediaTimer);
      if (pcPruneTimer) clearInterval(pcPruneTimer);
      pcSessions.stop();
      knowledge.stop();
      offComputers();
      computers.stopBackground();
      offBots();
      offProjectBots();
      for (const p of integrations.pending()) integrations.cancel(p.provider);
      account.stop();
      push.stop();
      telegram.stop();
      offRevoke();
      offSessionRevoke();
      router.freeze();
      runner.interruptAll();
      await providers.shutdown();
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      try { db.raw.close(); } catch { /* already closed */ }
    },
  };
  return hub;
}

function parkedDecisionNote(p: ParkedApproval, decision: 'allow' | 'always' | 'deny' | 'timeout'): string {
  const what = '"' + p.toolName + '"' + (p.reason ? ' (' + p.reason + ')' : '');
  if (decision === 'allow' || decision === 'always') {
    return '(Approval granted: the user allowed ' + what + '. Retry exactly the same call now; it goes through without another card. Then finish the task.)';
  }
  if (decision === 'deny') return '(Approval denied: ' + denyMessage('declined', { subject: what, alt: 'choose another approach or say so in the room' }) + ')';
  return '(Approval expired: ' + denyMessage('timeout', { note: 'nobody answered ' + what + ' in time, so it was denied', alt: 'say so in the room' }) + ')';
}
