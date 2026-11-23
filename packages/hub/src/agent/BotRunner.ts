import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { AUTO_MODEL, type Bot, type BotBackup, type BotState, type CauseKind, type Message, type ProviderId, type Room, type ToolPayload } from '@pocketrocket/shared';
import path from 'node:path';
import { ATTACHMENTS_DIR, CLAUDE_EXE, DESKTOP_AVAILABLE, MAX_TURNS_PER_QUERY, MAX_TURN_CONTINUATIONS, ROTATE_IDLE_MS, TURN_CACHE_READ_CAP, WORKSPACE_DIR, botHome, spendCapsOff } from '../config.js';
import { SUPPORT_HANDLE, supportSourceDirs } from '../services/SeedBots.js';
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';
import type { MemoryService } from '../services/MemoryService.js';
import type { SkillService } from '../services/SkillService.js';
import type { UsageTracker } from '../services/UsageTracker.js';
import type { PermissionBroker } from '../permissions/PermissionBroker.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { fileNote, imageNote, materializeFiles, materializeImages } from './attachments.js';
import { EMPTY_USAGE, steerTurn, type AgentProvider, type ProviderInit, type SteerInput, type TurnContext, type TurnLimit, type TurnOutcome, type TurnSink } from '../providers/types.js';
import type { TurnRegistry } from '../mcp/httpServer.js';
import { addSecret, redact, removeSecret } from '../providers/redact.js';
import { buildSystemPrompt } from './PromptBuilder.js';
import type { PcRunner } from '../services/PcRunner.js';
import type { WorkflowRunner } from '../services/WorkflowRunner.js';
import type { PcSessions } from '../services/PcSessions.js';
import type { SessionMoves } from '../services/SessionMoves.js';
import { createHubTools } from './botTools.js';
import { settings } from '../services/SettingsStore.js';
import { ModelRouter, canUpgrade, isAuto, type RouteChoice, type RouteRequest } from './ModelRouter.js';
import type { RoutingRules } from '../services/RoutingRules.js';
import { desktopTools, SHARED_BROWSER_NOTE, SHARED_TAB_NOTE, viewScreenTool } from './desktopTools.js';
import type { ComputerEndpoint, ComputerManager } from '../services/ComputerManager.js';
import type { IntegrationService } from '../services/IntegrationService.js';
import { createIntegrationTools } from '../integrations/tools.js';
import { credentialTools } from './credentialTools.js';
import type { CredentialStore } from '../services/CredentialStore.js';
import type { ProjectService } from '../services/ProjectService.js';
import { folderAccessDenied } from '../permissions/projectGuard.js';
import { buildStateHeader } from '../services/StateHeader.js';
import { fileRootOf, type RoomFiles } from '../rooms/roomFiles.js';
import { SHIP_GUARD_SKILL, defaultBranchPushDenied } from '../permissions/shipGuard.js';
import { reposFileWriteDenied } from '../permissions/projectGuard.js';
import { normaliseRemote } from '@pocketrocket/shared';
import type { ComputerControlService } from '../services/ComputerControl.js';
import { takeoverTool } from './takeoverTool.js';
import type { FormBroker } from '../services/FormBroker.js';
import { turnFailureNote } from './turnFailure.js';
import { classifyVerification, type TurnToolCall } from './verification.js';
import { outsideMcpFor, registerOutsideMcpSecrets, vpsMountable } from '../services/outsideMcp.js';
import { loadKeyRegistry } from '../services/keyRegistry.js';
import { computerToolGuard } from '../permissions/controlInterlock.js';
import { decisionsWriteDenied, relIn, type FileRevisions, type FileRoot, type RevisionAuthor } from '../services/FileRevisions.js';
import type { MediaStore } from '../services/MediaStore.js';
import { AUTO_MEMORY_MODEL, runPass, type PassOutcome } from '../services/AutoMemory.js';
import { buildSeed, buildSummaryPrompt, cleanSummary, contextUsage, readRoomNotes, rotationNote, rotationReason, SUMMARY_SYSTEM_PROMPT, SWITCH_SEED_LEAD, switchNote } from '../services/SessionRotation.js';
import { RepeatFailureWatch, browserRefusal, brokenStart, escalationNote, type FailureKind } from './repeatFailure.js';

export interface TurnRequest {
  bot: Bot;
  room: Room;
  members: Bot[];
  hop: number;
  causeId: string;
  injected: string;
  images?: string[];
  slashCommand?: string;
  latestUserText?: string;
  routinePrompt?: string;
  chatModel?: string;
  causeBudgetUsd?: number;
  causeKind?: CauseKind;
  strictApprovals?: boolean;
  ownerRef?: string;
  freshSession?: boolean;
  providerOverride?: BotBackup;
}
export interface TurnResult {
  ok: boolean;
  turnId: string;
  finalText: string;
  costUsd: number;
  error?: string;
  model?: string;
  modelReason?: string;
  parked?: boolean;
  stopped?: boolean;
  stoppedBy?: 'owner';
  consumedSteers?: string[];
  unansweredSteers?: string[];
  limit?: TurnLimit;
  provider?: ProviderId;
  braked?: boolean;
}
export interface OffloadTurnRequest {
  bot: Bot;
  room: Room;
  members: Bot[];
  sessionId: string;
  cwd: string;
  model: string;
  prompt: string;
}
export interface OffloadTurnOutcome {
  ok: boolean;
  finalText: string;
  costUsd: number;
  error?: string;
  sessionId?: string;
}

export function pushesToRemote(command: string): boolean {
  return /(^|[\s;&|(`])git\b[^;&|\n]*\bpush\b/i.test(command);
}
export const OFFLOAD_PUSH_DENIED = 'Pushing is off in a turn on the VPS. Your work is committed to the wip branch for you when the turn ends; the owner pulls it back to the PC.';

export interface SteerRequest {
  uuid: string;
  text: string;
  images?: string[];
}
export type LaneSteerResult = { status: 'accepted'; turnId: string } | { status: 'queued'; reason: 'provider' | 'between-runs' };

interface LaneTurn {
  turnId: string;
  provider: AgentProvider;
  running: boolean;
  steers: Map<string, SteerInput>;
}
export function isStaleSessionError(error: string | undefined): boolean {
  return !!error && /no conversation found with session id/i.test(error);
}

export function narrationNote(text: string): string {
  const line = text.trim().split('\n')[0].trim();
  return line.length > 140 ? line.slice(0, 139).trimEnd() + '…' : line;
}

export interface RunnerHooks {
  dispatchFromBot: (req: TurnRequest, targets: Bot[], onDone?: (r: TurnResult) => void) => string[];
  setState: (botId: string, roomId: string, state: BotState, note?: string) => void;
  routinesChanged?: () => void;
}

export class BotRunner {
  private activeTurns = new Set<string>();
  private laneTurns = new Map<string, LaneTurn>();
  private turnProviders = new Map<string, AgentProvider>();
  private aborts = new Map<string, AbortController>();
  private ownerStops = new Set<string>();
  lastInit: Partial<Record<ProviderId, ProviderInit>> = {};
  claudeReady?: () => boolean;
  private skillIndexShown = new Map<string, { name: string; description: string }[]>();
  router = new ModelRouter();
  integrations?: IntegrationService;
  projects?: ProjectService;
  roomFiles?: RoomFiles;
  revisions?: FileRevisions;
  private stateShown = new Map<string, string>();
  control?: ComputerControlService;
  pcRunner?: PcRunner;
  workflows?: WorkflowRunner;
  pcSessions?: PcSessions;
  sessionMoves?: SessionMoves;
  credentials?: CredentialStore;
  summarize: (prompt: string, systemPrompt: string) => Promise<PassOutcome> = runPass;
  repeatFailures = new RepeatFailureWatch();

  private noteFailure(bot: Bot, room: Room, kind: FailureKind, error: string, at: { causeId: string | null; hop: number; turnId: string }) {
    if (!this.repeatFailures.record(bot.id, kind + ' ' + error)) return;
    const support = !!this.repos.getBotByHandle(SUPPORT_HANDLE);
    const msg = this.repos.insertMessage({
      roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system',
      text: escalationNote({ handle: bot.handle, kind, error, support }),
      payload: null, causeId: at.causeId, hop: at.hop, turnId: at.turnId,
    });
    events.emitEvent({ type: 'message.new', message: msg });
  }

  constructor(
    private repos: Repos,
    private memory: MemoryService,
    private skills: SkillService,
    private broker: PermissionBroker,
    private usage: UsageTracker,
    private hooks: RunnerHooks,
    private providers: ProviderRegistry,
    private turns: TurnRegistry,
    private computers?: ComputerManager,
    private p7: { knowledgeDir?: () => string | null; routing?: RoutingRules } = {},
    private media?: MediaStore,
  ) {}

  forms?: FormBroker;

  interrupt(turnId: string, by?: 'owner') {
    const ac = this.aborts.get(turnId);
    if (by === 'owner' && ac) this.ownerStops.add(turnId);
    const stopped = this.turnProviders.get(turnId)?.interrupt(turnId) ?? false;
    if (ac) ac.abort();
    return stopped || !!ac;
  }
  interruptLane(botId: string, roomId: string, by?: 'owner') {
    const lane = this.laneTurns.get(botId + ':' + roomId);
    return lane ? this.interrupt(lane.turnId, by) : false;
  }
  steer(botId: string, roomId: string, req: SteerRequest): LaneSteerResult {
    const lane = this.laneTurns.get(botId + ':' + roomId);
    const bot = lane ? null : this.repos.getBot(botId);
    if (!(lane?.provider ?? (bot ? this.providerFor(bot) : this.providers.active())).steer) return { status: 'queued', reason: 'provider' };
    if (!lane?.running) return { status: 'queued', reason: 'between-runs' };
    const images = materializeImages(this.media, ATTACHMENTS_DIR, botId, req.images);
    const files = materializeFiles(this.media, ATTACHMENTS_DIR, botId, req.images);
    const input: SteerInput = { uuid: req.uuid, text: req.text + imageNote(images) + fileNote(files), ...(images.length ? { images } : {}) };
    const r = steerTurn(lane.provider, lane.turnId, input);
    if (r.status !== 'accepted') return r;
    lane.steers.set(input.uuid, input);
    return { status: 'accepted', turnId: lane.turnId };
  }
  isActive(turnId: string) {
    return this.activeTurns.has(turnId);
  }
  activeTurnCount(): number {
    return this.activeTurns.size;
  }
  interruptAll() {
    for (const id of [...this.activeTurns]) this.interrupt(id);
  }

  private providerFor(bot: Bot): AgentProvider {
    return this.providers.forBot ? this.providers.forBot(bot) : this.providers.active();
  }

  private modelIdsOf(id: ProviderId | null): string[] {
    const p = id ? this.providers.get(id) : this.providers.active();
    const ms = p.modelsSync();
    return ms.length ? [...ms.map((m) => m.id), AUTO_MODEL] : [];
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const { bot, room } = req;
    const turnId = nanoid(10);
    const budgetUsd = spendCapsOff() ? Infinity : Math.min(bot.maxBudgetUsd, req.causeBudgetUsd ?? Infinity);
    const override = req.providerOverride && this.providers.get(req.providerOverride.provider).id === req.providerOverride.provider ? req.providerOverride : undefined;
    const provider = override ? this.providers.get(override.provider) : this.providerFor(bot);
    const sessionProvider = this.repos.getSession(bot.id, room.id).provider;
    const session = this.repos.getSession(bot.id, room.id, provider.id);
    const state = this.repos.getSessionState(bot.id, room.id);
    this.memory.ensureHome(bot.id);
    let resumeToken = session.sdkSessionId;
    let seed = '';
    const folder = this.roomFiles?.forBot(room, bot.id) ?? null;
    const rotateWhy = resumeToken && (provider.id === 'claude' || provider.reportsContextTokens) ? (req.freshSession ? 'cutoff' : rotationReason(state, Date.now())) : null;
    const switched = !!sessionProvider && sessionProvider !== provider.id;
    if (rotateWhy || switched) {
      resumeToken = null;
      this.repos.saveSession(bot.id, room.id, { sdkSessionId: null, provider: provider.id });
      const note = this.repos.insertMessage({
        roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system',
        text: switched ? switchNote(bot.name, provider.label) : rotationNote(bot.name, rotateWhy!, state.contextTokens),
        payload: null, causeId: req.causeId, hop: req.hop, turnId,
      });
      events.emitEvent({ type: 'message.new', message: note });
      const summary = (await this.writeSummary(bot, room.id, session.lastSeenSeq, state.summary)) ?? state.summary;
      seed = buildSeed(this.repos, room.id, session.lastSeenSeq, { summary, roomNotes: readRoomNotes(folder?.dir), ...(switched ? { lead: SWITCH_SEED_LEAD } : {}) });
    }
    const cold = state.contextAt == null || Date.now() - state.contextAt > ROTATE_IDLE_MS;
    const keepSnapshot = !!resumeToken && !cold && state.memorySnapshot != null && state.identitySnapshot != null;
    const memoryText = keepSnapshot ? state.memorySnapshot! : this.memory.read(bot.id);
    const identity = keepSnapshot ? state.identitySnapshot! : this.memory.readIdentity(bot.id) || bot.description;
    if (!keepSnapshot) this.repos.saveSessionState(bot.id, room.id, { memorySnapshot: memoryText, identitySnapshot: identity });
    const skillsAsText = provider.id !== 'claude';
    let skillIndex: { name: string; description: string }[] | undefined;
    if (skillsAsText) {
      const key = bot.id + ':' + room.id;
      skillIndex = (keepSnapshot ? this.skillIndexShown.get(key) : undefined) ?? this.skills.skillIndex(bot.id);
      this.skillIndexShown.set(key, skillIndex);
    }
    if (!resumeToken) this.repos.saveSessionState(bot.id, room.id, { costTotal: 0, contextTokens: 0, contextAt: Date.now() });
    const pluginDir = this.skills.materialize(bot.id, bot.handle);
    const setState = (s: BotState, note?: string) => this.hooks.setState(bot.id, room.id, s, note);

    const wantsDesktop = bot.allowedTools.includes('Desktop') && DESKTOP_AVAILABLE;
    const wantsBrowser = bot.allowedTools.includes('Browser');
    let computer: ComputerEndpoint | null = null;
    let computerDown: string | undefined;
    let releaseComputer = () => undefined as void;
    let computerStart: Promise<string | null> | null = null;
    const useComputer = (): Promise<string | null> => (computerStart ??= (async () => {
      if (this.computers!.status(bot.id).state !== 'live') setState('working', 'starting its computer');
      const got = await this.computers!.acquire(bot.id);
      if (got.ok) {
        releaseComputer = got.release;
        return null;
      }
      got.release();
      computerStart = null;
      if (brokenStart(got.reason)) this.noteFailure(bot, room, 'computer', got.reason, { causeId: req.causeId, hop: req.hop, turnId });
      return 'Your computer could not start: ' + got.reason;
    })());
    if ((wantsDesktop || wantsBrowser) && !this.computers?.enabled) {
      computerDown = 'This hub has no per-bot computers (POCKETROCKET_COMPUTERS is off).';
    } else if (this.computers && (wantsDesktop || wantsBrowser)) {
      const ep = this.computers.endpoint(bot.id);
      if (ep.perBot) computer = ep;
      else computerDown = 'Every computer slot on this server is taken.';
    }
    const desktopOn = wantsDesktop && !computerDown;
    const browserOn = wantsBrowser && !computerDown;
    const computerStatus = computer?.perBot ? this.computers!.status(bot.id) : null;
    const bypass = this.broker.bypassed && !req.strictApprovals;
    const bestEffort = provider.info.permissions === 'best-effort' && !bypass;
    const providerModels = provider.modelsSync();
    const causeKind: CauseKind = req.causeKind ?? (req.hop > 0 ? 'bot' : 'user');
    const chatModel = !override && provider.id === 'claude' && req.chatModel && (req.chatModel === AUTO_MODEL || providerModels.some((m) => m.id === req.chatModel)) ? req.chatModel : null;
    const baseBot = override ? { ...bot, model: override.model } : bot;
    const routeBot = chatModel ? { ...baseBot, model: chatModel } : baseBot;
    const routeReq: RouteRequest = {
      bot: routeBot, causeKind, input: req.injected, latestUserText: req.latestUserText, routinePrompt: req.routinePrompt, chosen: !!chatModel, models: providerModels,
      opusSkills: routeBot.model === AUTO_MODEL ? this.skills.opusSkillNames(bot.id) : [],
      fallbackModel: settings.get().defaultModel,
    };
    const picked = await this.router.pick(routeReq);
    let route: RouteChoice = picked;
    const cu = picked.classifierUsage;
    if (cu && (cu.costUsd || cu.inputTokens || cu.outputTokens)) {
      this.usage.record(bot.id, room.id, 'cls-' + nanoid(8), req.causeId, cu, { model: 'claude-haiku-4-5-20251001', routeReason: 'classifier', causeKind, provider: 'claude' });
    }
    const mayMoveUp = provider.id === 'claude' && !req.strictApprovals && (causeKind === 'user' || causeKind === 'bot') && canUpgrade(routeReq, picked);
    const up: { asked: boolean; next: RouteChoice | null } = { asked: false, next: null };
    const routing = this.p7.routing;
    const mayPropose = !!routing && causeKind === 'user' && req.hop === 0 && !req.strictApprovals;
    const ac = new AbortController();
    let parkedWhy: string | null = null;
    const park = (why: string) => {
      if (parkedWhy) return;
      parkedWhy = why;
      setTimeout(() => ac.abort(), 0);
    };
    const controlBlocked = () => this.control?.blockedReason(bot.id) ?? null;
    const permCtx = {
      bot, room, turnId, hop: req.hop, causeId: req.causeId, setState: (s: 'blocked' | 'working') => setState(s),
      strictApprovals: !!req.strictApprovals,
      ownerRef: req.ownerRef, park, controlBlocked,
    };

    const keyRegistry = loadKeyRegistry();
    const fileRoot: FileRoot | null = folder ? fileRootOf(room, folder) : null;
    const fileAuthor: RevisionAuthor = {
      kind: settings.get().personaBotId === bot.id ? 'persona' : 'bot',
      id: bot.id, label: '@' + bot.handle, machine: process.platform === 'win32' ? 'pc' : 'vps', sessionId: turnId, roomId: room.id,
    };
    // In the turn's input, not the system prompt: that must stay identical across resumed turns for the prompt cache.
    let stateHeader = '';
    if (fileRoot && this.revisions) {
      const block = buildStateHeader(fileRoot, this.revisions);
      const key = bot.id + ':' + room.id;
      if (block && (!resumeToken || this.stateShown.get(key) !== block.signature)) {
        stateHeader = block.text;
        this.stateShown.set(key, block.signature);
      }
    }
    const tools = createHubTools({
      fileRoot, fileAuthor, revisions: this.revisions,
      bot, room, members: req.members, turnId, hop: req.hop, causeId: req.causeId,
      repos: this.repos, memory: this.memory, skills: this.skills, media: this.media, projects: this.projects,
      dispatchFromBot: (targets, room, onDone) => this.hooks.dispatchFromBot(room ? { ...req, room } : req, targets, onDone),
      setState: (s) => setState(s),
      desktop: false,
      models: providerModels.length ? [...providerModels.map((m) => m.id), AUTO_MODEL] : [],
      modelsFor: (id) => this.modelIdsOf(id),
      skillsAsText,
      forms: this.forms,
      strictApprovals: !!req.strictApprovals,
      requestApproval: bestEffort ? (a) => this.broker.ask(permCtx, a, ac.signal) : undefined,
      confirmFleetChange: (a) => this.broker.askFleetChange(permCtx, a.tool, a.input, a.reason, ac.signal, { evenUnderBypass: a.evenUnderBypass, machine: a.machine }),
      confirmOutsideHandoff: (a) => this.broker.askOutsideHandoff(permCtx, a.input, a.reason, ac.signal),
      useStrongerModel: provider.id === 'claude' ? (reason) => {
        if (!mayMoveUp) return 'Not available on this turn: only an Auto bot on Sonnet, on a thread a person started, can move up. Carry on with this model.';
        if (up.asked) return false;
        up.asked = true;
        const why = redact(reason.replace(/\s+/g, ' ').trim());
        up.next = this.router.upgrade(routeReq, why);
        const label = providerModels.find((m) => m.id === up.next!.model)?.label ?? up.next.model;
        const line = this.repos.insertMessage({
          roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system', text: 'Moved to ' + label + ': ' + why, payload: null,
          causeId: req.causeId, hop: req.hop, turnId,
        });
        events.emitEvent({ type: 'message.new', message: line });
        return true;
      } : undefined,
      proposeRouting: routing ? async (line, reason) => {
        if (!mayPropose) return { ok: false, message: 'Routing changes can only be proposed on a turn the owner started directly, not on a hand-off or an automation.' };
        try {
          routing!.withLine(line);
          const r = await this.broker.askRoutingChange(permCtx, { line, reason }, ac.signal);
          if (!r.allowed) return { ok: false, message: r.message };
          routing!.write(routing!.withLine(line));
          return { ok: true, message: 'Added to the routing rules.' };
        } catch (e) {
          return { ok: false, message: (e as Error).message };
        }
      } : undefined,
      proposeRule: async (rule) => {
        if (causeKind !== 'user' || req.hop !== 0 || req.strictApprovals) {
          return { ok: false, message: 'Rules can only be proposed on a turn the owner started directly, not on a hand-off or an automation.' };
        }
        const r = await this.broker.askRuleProposal(permCtx, rule, ac.signal);
        return { ok: r.allowed, message: r.message };
      },
      routinesChanged: this.hooks.routinesChanged,
      pcRunner: this.pcRunner,
      workflows: this.workflows,
      pcSessions: this.pcSessions,
      sessionMoves: this.sessionMoves,
      signal: ac.signal,
      keyRegistry: () => keyRegistry,
    });

    if (desktopOn && computer) {
      tools.push(...desktopTools({ display: computer.display, xauthority: computer.xauthority, home: computer.home, fileRoots: computer.filesDir ? [computer.filesDir] : [], guard: async () => controlBlocked() ?? (await useComputer()) }));
    }
    if (computer && this.computers) tools.push(viewScreenTool(this.computers, req.members, bot.id));
    if ((desktopOn || browserOn) && this.control) {
      tools.push(takeoverTool({
        bot, room, turnId, hop: req.hop, causeId: req.causeId, ownerRef: req.ownerRef, repos: this.repos, control: this.control,
        signal: ac.signal, setState: (s) => setState(s), park, useComputer,
      }));
    }

    if (browserOn && computer && this.credentials) {
      tools.push(...credentialTools({
        store: this.credentials, db: this.repos.db, bot, roomId: room.id, cdpUrl: computer.cdpUrl,
        confirm: (a) => this.broker.askCredentialFill(permCtx, a, ac.signal),
      }));
    }

    if (this.integrations) {
      tools.push(...createIntegrationTools(this.integrations, bot.id, (a) => this.broker.askIntegrationWrite(permCtx, a.tool, a.input, a.reason, ac.signal)));
    }

    let tabSettled = false;
    const browserTabRule = (name: string, input?: Record<string, unknown>): string | null => {
      if (!name.startsWith('mcp__browser__')) return null;
      const shared = this.computers!.turnsOn(bot.id) > 1;
      if (name.endsWith('browser_tabs')) {
        if (input?.action === 'new') tabSettled = true;
        if (input?.action === 'select' && shared) return SHARED_TAB_NOTE;
        if (input?.action === 'close') {
          if (shared && (input.index !== undefined || !tabSettled)) return SHARED_TAB_NOTE;
          tabSettled = false;
        }
        return null;
      }
      if (tabSettled) return null;
      if (shared) return SHARED_BROWSER_NOTE;
      tabSettled = true;
      return null;
    };

    const knowledgeDir = this.p7.knowledgeDir?.() ?? null;
    const folderDir = folder ? this.roomFiles!.ensure(folder) : null;
    const roomProject = folder?.kind === 'project' ? this.projects?.get(folder.projectSlug!) : undefined;
    const projectRepos = roomProject ? this.projects!.reposFile(roomProject.slug).repos : [];
    // Writes stay limited to the room's own folder: these roots are mounted read-only in the sandbox and refused by the
    // write guard, bypass or not.
    const isPersona = settings.get().personaBotId === bot.id;
    const personaProjectDirs = isPersona && this.projects
      ? this.projects.list().filter((p) => p.slug !== roomProject?.slug && (!folderDir || path.resolve(p.dir) !== path.resolve(folderDir))).map((p) => p.dir)
      : [];
    const mcpToken = this.turns.registerTurn(tools, computerToolGuard(controlBlocked));
    // The per-turn MCP bearer travels in provider config and can surface in a stderr tail: scrub it until the turn ends.
    addSecret(mcpToken);
    const outsideMcp = vpsMountable(outsideMcpFor(bot.handle, room), keyRegistry);
    registerOutsideMcpSecrets(outsideMcp);
    const images = materializeImages(this.media, ATTACHMENTS_DIR, bot.id, req.images);
    const files = materializeFiles(this.media, ATTACHMENTS_DIR, bot.id, req.images);
    const ctx: TurnContext = {
      turnId, bot, room, members: req.members,
      systemPrompt: buildSystemPrompt({
        owner: this.repos.owner(),
        bot, room, members: req.members, hop: req.hop, memory: memoryText, identity,
        projects: roomProject ? [{ name: roomProject.name, dir: roomProject.dir }] : undefined,
        roomFolder: folder && folder.kind !== 'project' && folderDir ? { kind: folder.kind, dir: folderDir } : undefined,
        browser: browserOn, desktop: desktopOn,
        toolPrefix: provider.id === 'claude' ? 'mcp__pocketrocket__' : '',
        requestApproval: bestEffort,
        fleetGate: !bypass,
        voice: this.memory.readVoice(bot.id),
        notesCount: this.memory.listNotes(bot.id).length,
        knowledgeDir,
        fleet: this.repos.listBots(),
        computer: computer?.perBot && computer.filesDir && computerStatus
          ? { display: computer.display, filesDir: computer.filesDir, diskBytes: computerStatus.diskBytes, quotaBytes: computerStatus.quotaBytes }
          : undefined,
        computerUnavailable: computerDown,
        routing: routing?.promptText(),
        keyRegistry,
        canMoveUp: provider.id === 'claude' && isAuto(bot),
        canProposeRouting: !!routing,
        skillIndex,
      }),
      input: req.slashCommand && provider.id === 'claude'
        ? req.slashCommand
        : (stateHeader ? stateHeader + '\n\n' : '') + (seed ? seed + '\n\n' + req.injected : req.injected) + imageNote(images) + fileNote(files),
      ...(images.length ? { images } : {}),
      resumeToken,
      sessionCostUsd: resumeToken ? state.costTotal : 0,
      cacheReadBudget: TURN_CACHE_READ_CAP > 0 ? TURN_CACHE_READ_CAP : undefined,
      workspaceDir: WORKSPACE_DIR,
      botHome: botHome(bot.id),
      tools,
      allowedBuiltins: computerDown ? bot.allowedTools.filter((t) => t !== 'Browser' && t !== 'Desktop') : bot.allowedTools,
      bypassPermissions: bypass,
      strictApprovals: !!req.strictApprovals,
      permission: async (name, input, extra) => {
        const r = await this.broker.decide(permCtx, name, input, { signal: ac.signal, blockedPath: extra?.blockedPath });
        return r.behavior === 'allow' ? 'allow' : 'deny';
      },
      permissionDetailed: (name, input, o) =>
        this.broker.decide(permCtx, name, input, {
          signal: (o.signal ?? ac.signal) as AbortSignal,
          suggestions: o.suggestions as never,
          blockedPath: o.blockedPath,
        }),
      pluginDir,
      model: route.model,
      maxBudgetUsd: budgetUsd,
      maxTurns: MAX_TURNS_PER_QUERY,
      signal: ac.signal,
      mcp: { url: this.turns.url(), token: mcpToken },
      knowledgeDir,
      readOnlyDirs: [...(bot.handle === SUPPORT_HANDLE ? supportSourceDirs() : []), ...(images.length || files.length ? [path.dirname((images[0] ?? files[0]).path)] : []), ...personaProjectDirs],
      projectDirs: folderDir ? [folderDir] : [],
      shipGuard: projectRepos.length || this.repos.botSkillIds(bot.id).some((id) => this.repos.getSkill(id)?.name === SHIP_GUARD_SKILL)
        ? (command, cwd) => defaultBranchPushDenied(command, cwd, undefined, projectRepos.length
            ? (remote) => {
                const want = normaliseRemote(remote);
                return want ? projectRepos.filter((r) => normaliseRemote(r.remote) === want).flatMap((r) => r.protected) : [];
              }
            : undefined)
        : undefined,
      projectGuard: this.projects || this.roomFiles
        ? (name, input, cwd) => folderAccessDenied(name, input, cwd, [
            ...(this.projects
              ? [{ root: this.projects.root, allowed: isPersona ? this.projects.knownSlugs() : roomProject ? [roomProject.slug] : [], known: this.projects.knownSlugs(), listable: isPersona }]
              : []),
            ...(this.roomFiles
              ? [{ root: this.roomFiles.roomsDir, allowed: folder?.kind === 'room' ? [room.id] : [], known: this.repos.listRooms().map((r) => r.id) }]
              : []),
          ])
        : undefined,
      fileGuard: fileRoot || this.projects
        ? (name, input, cwd) => (fileRoot ? decisionsWriteDenied(name, input, cwd, [fileRoot]) : null) ?? (this.projects ? reposFileWriteDenied(name, input, cwd, this.projects.root) : null)
        : undefined,
      ruleGuard: (name, input) => this.broker.learnedRule(bot.id, name, input),
      fileWritten: fileRoot && this.revisions
        ? (name, input, cwd) => {
            const p = input.file_path ?? input.notebook_path;
            if (typeof p !== 'string' || !p) return;
            const rel = relIn(fileRoot, path.resolve(cwd, p));
            if (rel) this.revisions!.record(fileRoot, rel, { ...fileAuthor, tool: name });
          }
        : undefined,
      cdpUrl: computer?.perBot ? computer.cdpUrl : undefined,
      outsideMcp,
      outsideMcpGate: async (name, input) => {
        const s = outsideMcp.find((x) => name.startsWith('mcp__' + x.name + '__'));
        if (!s) return 'Unknown outside tool: ' + name;
        const r = await this.broker.askOutsideMcp(permCtx, s.name, name.slice(('mcp__' + s.name + '__').length), input, ac.signal);
        return r.allowed ? null : r.message;
      },
      computerFilesDir: computer?.filesDir ?? undefined,
      controlGuard: controlBlocked,
      computerGate: computer ? async (name, input) => (await useComputer()) ?? browserTabRule(name, input) : undefined,
    };

    events.emitEvent({ type: 'turn.start', turnId, botId: bot.id, roomId: room.id, causeId: req.causeId, hop: req.hop });
    setState('thinking');

    const texts: string[] = [];
    const toolMsgIds = new Map<string, string>();
    const toolCalls: TurnToolCall[] = [];
    let lastMessageId: string | undefined;
    let pending: string | undefined;
    const postText = (text: string) => {
      texts.push(text);
      const msg = this.repos.insertMessage({
        roomId: room.id, authorType: 'bot', authorId: bot.id, kind: 'text', text, payload: null,
        causeId: req.causeId, hop: req.hop, turnId, model: route.model, modelReason: route.detail,
      });
      lastMessageId = msg.id;
      events.emitEvent({ type: 'message.new', message: msg });
    };
    const flushPending = () => {
      if (pending !== undefined) postText(pending);
      pending = undefined;
    };

    const sink: TurnSink = {
      onInit: (info) => { this.lastInit[provider.id] = info; },
      onLimit: (r) => this.providers.health?.report(provider.id, r, route.model),
      onNote: (text) => {
        const msg = this.repos.insertMessage({
          roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system', text: bot.name + "'s " + provider.label + ' session ' + text,
          payload: null, causeId: req.causeId, hop: req.hop, turnId,
        });
        events.emitEvent({ type: 'message.new', message: msg });
      },
      onSession: (token) => {
        if (token && token !== session.sdkSessionId) this.repos.saveSession(bot.id, room.id, { sdkSessionId: token, provider: provider.id });
      },
      onDelta: (text) => events.emitEvent({ type: 'turn.delta', turnId, roomId: room.id, botId: bot.id, text }),
      onText: (text) => {
        if (/^\W*NO_REPLY\W*$/.test(text.trim())) {
          pending = undefined;
          events.emitEvent({ type: 'bot.state', botId: bot.id, state: 'done', roomId: room.id, note: 'no reply' });
          return;
        }
        pending = pending === undefined ? text : pending + '\n\n' + text;
      },
      onToolUse: (id, name, input) => {
        toolCalls.push({ name, input });
        if (pending !== undefined) {
          setState('working', narrationNote(pending));
          pending = undefined;
        }
        if (computer?.perBot && (name.startsWith('mcp__browser__') || name.includes('desktop_'))) this.computers!.touch(bot.id);
        const payload: ToolPayload = { toolUseId: id, name, input, done: false };
        const msg = this.repos.insertMessage({
          roomId: room.id, authorType: 'bot', authorId: bot.id, kind: 'tool', text: name, payload,
          causeId: req.causeId, hop: req.hop, turnId,
        });
        toolMsgIds.set(id, msg.id);
        events.emitEvent({ type: 'message.new', message: msg });
      },
      onToolResult: (id, output, isError) => {
        const msgId = toolMsgIds.get(id);
        if (!msgId) return;
        const cur = this.repos.getMessage(msgId);
        if (!cur || !cur.payload) return;
        const toolName = (cur.payload as ToolPayload).name;
        const refused = browserRefusal(toolName, output);
        if (refused) this.noteFailure(bot, room, 'browser', refused, { causeId: req.causeId, hop: req.hop, turnId });
        else if (!isError && toolName.startsWith('mcp__browser__')) this.repeatFailures.clear(bot.id);
        const payload: ToolPayload = { ...(cur.payload as ToolPayload), output: redact(output.slice(0, 20000)), isError, done: true };
        this.repos.updateMessage(msgId, { payload });
        events.emitEvent({ type: 'message.update', id: msgId, roomId: room.id, patch: { payload } });
      },
      onState: (s) => setState(s),
    };

    const lane: LaneTurn = { turnId, provider, running: false, steers: new Map() };
    const consumedSteers: string[] = [];
    const runProvider = async (c: TurnContext, k: TurnSink) => {
      const carried = [...lane.steers.values()];
      lane.running = true;
      try {
        const o = await provider.runTurn(carried.length ? { ...c, carriedSteers: carried } : c, k);
        for (const u of o.steers?.consumed ?? []) {
          if (lane.steers.delete(u)) consumedSteers.push(u);
        }
        return o;
      } finally {
        lane.running = false;
        flushPending();
      }
    };
    const steerResult = () =>
      consumedSteers.length || lane.steers.size ? { consumedSteers: [...consumedSteers], unansweredSteers: [...lane.steers.keys()] } : {};
    this.activeTurns.add(turnId);
    this.aborts.set(turnId, ac);
    this.turnProviders.set(turnId, provider);
    this.laneTurns.set(bot.id + ':' + room.id, lane);
    let ok = false;
    let error: string | undefined;
    let stoppedByOwner = false;
    let limit: TurnLimit | undefined;
    let costUsd = 0;
    let cacheRead = 0;
    const brakeOn = TURN_CACHE_READ_CAP > 0;
    const braked = () => brakeOn && cacheRead >= TURN_CACHE_READ_CAP;
    let brakeHit = false;
    const nextRun = () => ({
      sessionCostUsd: this.repos.getSessionState(bot.id, room.id).costTotal,
      cacheReadBudget: brakeOn ? Math.max(0, TURN_CACHE_READ_CAP - cacheRead) : undefined,
    });
    const brakeNote = () => {
      brakeHit = true;
      const line = this.repos.insertMessage({
        roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system',
        text: bot.name + ' stopped instead of continuing: this turn already read ' + cacheRead.toLocaleString('en-US') +
          ' cached tokens (limit ' + TURN_CACHE_READ_CAP.toLocaleString('en-US') + '). Send a message to pick it up again.',
        payload: null, causeId: req.causeId, hop: req.hop, turnId,
      });
      events.emitEvent({ type: 'message.new', message: line });
    };
    try {
      const removed = room.memberIds.includes(bot.id) && !this.repos.getRoom(room.id)?.memberIds.includes(bot.id);
      let outcome: TurnOutcome = removed
        ? { ok: false, error: 'removed from this chat', costUsd: 0, usage: EMPTY_USAGE, durationMs: 0 }
        : await runProvider(ctx, sink);
      const record = (o: TurnOutcome) => {
        costUsd += o.costUsd;
        cacheRead += o.usage.cacheReadTokens;
        if (o.sessionCostUsd !== undefined) this.repos.saveSessionState(bot.id, room.id, { costTotal: o.sessionCostUsd });
        if (o.contextTokens !== undefined) {
          this.repos.saveSessionState(bot.id, room.id, { contextTokens: o.contextTokens, contextAt: Date.now(), ...(o.contextWindow ? { contextWindow: o.contextWindow } : {}) });
        }
        const u = o.usage;
        if (o.accounted || u.costUsd || u.inputTokens || u.outputTokens) {
          this.usage.record(bot.id, room.id, turnId, req.causeId, u, { model: o.model ?? route.model, routeReason: route.reason, causeKind, provider: provider.id });
        }
      };
      record(outcome);

      // The CLI's session store is not ours: a re-login, a `cleanupPeriodDays` sweep or a redeploy can drop the transcript,
      // and every turn then dies with "No conversation found with session ID". Forget the token and rerun once, fresh.
      if (ctx.resumeToken && !ac.signal.aborted && isStaleSessionError(outcome.error)) {
        this.repos.saveSession(bot.id, room.id, { sdkSessionId: null, provider: provider.id });
        this.repos.saveSessionState(bot.id, room.id, { costTotal: 0, contextTokens: 0, contextAt: Date.now() });
        const note = this.repos.insertMessage({
          roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system',
          text: bot.name + "'s saved session no longer exists; starting a fresh one (earlier conversation context is lost).",
          payload: null, causeId: req.causeId, hop: req.hop, turnId,
        });
        events.emitEvent({ type: 'message.new', message: note });
        setState('thinking');
        const lostSeed = seed ? '' : buildSeed(this.repos, room.id, session.lastSeenSeq, { summary: state.summary, roomNotes: readRoomNotes(folder?.dir) });
        outcome = await runProvider(
          { ...ctx, ...nextRun(), input: lostSeed ? lostSeed + '\n\n' + ctx.input : ctx.input, resumeToken: null, maxBudgetUsd: budgetUsd - costUsd },
          sink,
        );
        record(outcome);
      }

      const moveUp = async () => {
        if (outcome.error) return;
        const next = up.next;
        up.next = null;
        if (!next || next.model === route.model || ac.signal.aborted) return;
        if (braked()) {
          brakeNote();
          return;
        }
        if (costUsd >= budgetUsd) {
          const line = this.repos.insertMessage({
            roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system', text: bot.name + ' used its budget before it could continue.', payload: null,
            causeId: req.causeId, hop: req.hop, turnId,
          });
          events.emitEvent({ type: 'message.new', message: line });
          return;
        }
        route = next;
        setState('working');
        outcome = await runProvider(
          {
            ...ctx,
            ...nextRun(),
            resumeToken: this.repos.getSession(bot.id, room.id, provider.id)?.sdkSessionId ?? ctx.resumeToken,
            input:
              'You are now on the stronger model you asked for, for the rest of this turn. Continue from exactly where ' +
              'you left off and finish the task. Do not start over, re-explain, or ask to move up again.',
            maxBudgetUsd: budgetUsd - costUsd,
            model: route.model,
          },
          sink,
        );
        record(outcome);
      };
      await moveUp();

      for (let attempt = 1; outcome.error?.startsWith('error_max_turns') && attempt <= MAX_TURN_CONTINUATIONS; attempt++) {
        if (ac.signal.aborted) break;
        if (costUsd >= budgetUsd) break;
        if (braked()) {
          brakeNote();
          break;
        }
        const asked = up.next && up.next.model !== route.model ? up.next : null;
        if (asked) up.next = null;
        const next = asked ?? this.router.escalate(routeReq, route, 'error_max_turns');
        const escalated = next.model !== route.model;
        if (escalated) console.log('[router] ' + bot.handle + ' ' + turnId + ': ' + route.model + ' -> ' + next.model + ' (' + next.detail + ')');
        route = next;
        const note = this.repos.insertMessage({
          roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system',
          text: bot.name + ' hit the ' + MAX_TURNS_PER_QUERY + '-step limit; continuing (' + attempt + '/' + MAX_TURN_CONTINUATIONS + ')' +
            (escalated ? ' on ' + route.model + ' (escalated by the model router)' : '') + '.',
          payload: null, causeId: req.causeId, hop: req.hop, turnId,
        });
        events.emitEvent({ type: 'message.new', message: note });
        setState('working');
        outcome = await runProvider(
          {
            ...ctx,
            ...nextRun(),
            resumeToken: this.repos.getSession(bot.id, room.id, provider.id)?.sdkSessionId ?? ctx.resumeToken,
            input:
              'You stopped because you reached the step limit, not because the work was done. ' +
              'Continue from exactly where you left off and finish the task. Do not start over or re-explain.',
            maxBudgetUsd: budgetUsd - costUsd,
            model: route.model,
          },
          sink,
        );
        record(outcome);
      }
      await moveUp();

      ok = outcome.ok;
      error = outcome.error;
      limit = outcome.limit;
      if (limit) this.providers.health?.hold(provider.id, limit, outcome.model ?? route.model);
    } catch (e) {
      error = redact(String((e as Error).message ?? e));
    } finally {
      stoppedByOwner = this.ownerStops.delete(turnId) && ac.signal.aborted;
      this.activeTurns.delete(turnId);
      this.aborts.delete(turnId);
      this.turnProviders.delete(turnId);
      lane.running = false;
      this.laneTurns.delete(bot.id + ':' + room.id);
      this.turns.unregister(mcpToken);
      removeSecret(mcpToken);
      releaseComputer();
    }

    flushPending();
    const ctxUsage = provider.reportsContextTokens ? contextUsage(this.repos.getSessionState(bot.id, room.id)) : undefined;
    const context = ctxUsage ? { context: ctxUsage } : {};
    if (parkedWhy) {
      const msg = this.repos.insertMessage({
        roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system',
        text: bot.name + ' is ' + parkedWhy + ' and will continue after that.', payload: null,
        causeId: req.causeId, hop: req.hop, turnId,
      });
      events.emitEvent({ type: 'message.new', message: msg });
      events.emitEvent({ type: 'turn.end', turnId, roomId: room.id, botId: bot.id, messageId: lastMessageId, costUsd, ...context });
      setState('done', 'parked');
      return { ok: false, parked: true, turnId, finalText: texts.join('\n\n'), costUsd, model: route.model, modelReason: route.detail, ...steerResult() };
    }
    const verification = lastMessageId ? classifyVerification(toolCalls) : undefined;
    const last = verification && lastMessageId ? this.repos.getMessage(lastMessageId) : undefined;
    if (verification && last?.kind === 'text') {
      const payload = { ...((last.payload as object | null) ?? {}), verification } as Message['payload'];
      this.repos.updateMessage(last.id, { payload });
      events.emitEvent({ type: 'message.update', id: last.id, roomId: room.id, patch: { payload } });
    }
    if (!ok && !error) error = 'Turn ended without a result';
    if (error) error = redact(error);
    if (stoppedByOwner) {
      events.emitEvent({ type: 'turn.end', turnId, roomId: room.id, botId: bot.id, messageId: lastMessageId, costUsd, stoppedBy: 'owner', ...context });
      setState('done');
      return {
        ok, turnId, finalText: texts.join('\n\n'), costUsd, error, model: route.model, modelReason: route.detail,
        stopped: true, stoppedBy: 'owner', ...steerResult(),
      };
    }
    if (error) {
      const note = turnFailureNote(bot.name, error, ac.signal.aborted, limit ? { ...limit, provider: provider.label } : undefined);
      if (limit?.kind === 'usage' && !override && !bot.backup) {
        note.text += ' Set a backup in ' + bot.name + "'s settings to continue on another provider next time.";
        note.payload = { ...note.payload, setBackup: true };
      }
      const msg = this.repos.insertMessage({
        roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system',
        ...note,
        causeId: req.causeId, hop: req.hop, turnId,
      });
      events.emitEvent({ type: 'message.new', message: msg });
    }
    events.emitEvent({ type: 'turn.end', turnId, roomId: room.id, botId: bot.id, messageId: lastMessageId, costUsd, error, ...context });
    setState(error ? 'error' : 'done');
    return {
      ok, turnId, finalText: texts.join('\n\n'), costUsd, error, model: route.model, modelReason: route.detail,
      ...(ac.signal.aborted ? { stopped: true } : {}), ...steerResult(),
      ...(limit ? { limit } : {}), provider: provider.id, ...(brakeHit ? { braked: true } : {}),
    };
  }

  async runOffloadTurn(req: OffloadTurnRequest): Promise<OffloadTurnOutcome> {
    const { bot, room } = req;
    const turnId = nanoid(10);
    const causeId = nanoid(10);
    const provider = this.providers.get('claude');
    const ac = new AbortController();
    const folder = this.roomFiles?.forBot(room, bot.id) ?? null;
    const folderDir = folder ? this.roomFiles!.ensure(folder) : null;
    const roomProject = folder?.kind === 'project' ? this.projects?.get(folder.projectSlug!) : undefined;
    const bypass = this.broker.bypassed;
    const setState = (st: BotState, note?: string) => this.hooks.setState(bot.id, room.id, st, note);
    const permCtx = {
      bot, room, turnId, hop: 0, causeId, setState: (st: 'blocked' | 'working') => setState(st),
      strictApprovals: false, ownerRef: undefined, park: () => undefined, controlBlocked: () => null,
    };
    const tools = createHubTools({
      bot, room, members: req.members, turnId, hop: 0, causeId,
      repos: this.repos, memory: this.memory, skills: this.skills, media: this.media, projects: this.projects,
      fileRoot: folder ? fileRootOf(room, folder) : null,
      fileAuthor: { kind: 'bot', id: bot.id, label: '@' + bot.handle, machine: 'vps', sessionId: turnId, roomId: room.id },
      revisions: this.revisions,
      dispatchFromBot: () => [],
      setState: (st) => setState(st),
      desktop: false,
      models: [],
      forms: this.forms,
      strictApprovals: false,
      confirmFleetChange: (a) => this.broker.askFleetChange(permCtx, a.tool, a.input, a.reason, ac.signal, { evenUnderBypass: a.evenUnderBypass, machine: a.machine }),
      confirmOutsideHandoff: (a) => this.broker.askOutsideHandoff(permCtx, a.input, a.reason, ac.signal),
      routinesChanged: this.hooks.routinesChanged,
      signal: ac.signal,
      keyRegistry: () => loadKeyRegistry(),
    });
    const mcpToken = this.turns.registerTurn(tools, computerToolGuard(() => null));
    addSecret(mcpToken);
    let reported: string | undefined;
    const texts: string[] = [];
    const sink: TurnSink = {
      onSession: (t) => { if (t) reported = t; },
      onDelta: () => undefined,
      onText: (t) => { texts.push(t); },
      onToolUse: () => undefined,
      onToolResult: () => undefined,
      onState: () => undefined,
    };
    const ctx: TurnContext = {
      turnId, bot, room, members: req.members,
      systemPrompt:
        "You are continuing the owner's Claude Code session on the VPS: the working folder is a git worktree of their repo on a wip branch. " +
        'Work as before. Do not run git push; your changes are committed to the wip branch when this turn ends.',
      input: req.prompt,
      resumeToken: req.sessionId,
      sessionCostUsd: null,
      workspaceDir: req.cwd,
      botHome: botHome(bot.id),
      tools,
      allowedBuiltins: bot.allowedTools,
      bypassPermissions: bypass,
      permission: async (name, input, extra) => {
        const r = await this.broker.decide(permCtx, name, input, { signal: ac.signal, blockedPath: extra?.blockedPath });
        return r.behavior === 'allow' ? 'allow' : 'deny';
      },
      permissionDetailed: (name, input, o) =>
        this.broker.decide(permCtx, name, input, { signal: (o.signal ?? ac.signal) as AbortSignal, suggestions: o.suggestions as never, blockedPath: o.blockedPath }),
      pluginDir: null,
      model: req.model,
      maxBudgetUsd: spendCapsOff() ? Infinity : bot.maxBudgetUsd,
      maxTurns: MAX_TURNS_PER_QUERY,
      signal: ac.signal,
      mcp: { url: this.turns.url(), token: mcpToken },
      projectDirs: folderDir ? [folderDir] : [],
      shipGuard: (command) => (pushesToRemote(command) ? OFFLOAD_PUSH_DENIED : null),
      projectGuard: this.projects || this.roomFiles
        ? (name, input, cwd) => folderAccessDenied(name, input, cwd, [
            ...(this.projects ? [{ root: this.projects.root, allowed: roomProject ? [roomProject.slug] : [], known: this.projects.knownSlugs() }] : []),
            ...(this.roomFiles ? [{ root: this.roomFiles.roomsDir, allowed: folder?.kind === 'room' ? [room.id] : [], known: this.repos.listRooms().map((r) => r.id) }] : []),
          ])
        : undefined,
      fileGuard: this.projects ? (name, input, cwd) => reposFileWriteDenied(name, input, cwd, this.projects!.root) : undefined,
      ruleGuard: (name, input) => this.broker.learnedRule(bot.id, name, input),
    };
    this.activeTurns.add(turnId);
    this.aborts.set(turnId, ac);
    this.turnProviders.set(turnId, provider);
    setState('working', 'continuing a session on the VPS');
    let outcome: TurnOutcome | null = null;
    let error: string | undefined;
    try {
      outcome = await provider.runTurn(ctx, sink);
      error = outcome.error;
      const u = outcome.usage;
      if (u.costUsd || u.inputTokens || u.outputTokens) this.usage.record(bot.id, room.id, turnId, causeId, u, { model: req.model, routeReason: 'offload', causeKind: 'user', provider: 'claude' });
    } catch (e) {
      error = redact(String((e as Error).message ?? e));
    } finally {
      this.activeTurns.delete(turnId);
      this.aborts.delete(turnId);
      this.turnProviders.delete(turnId);
      this.turns.unregister(mcpToken);
      removeSecret(mcpToken);
      setState(error ? 'error' : 'done');
    }
    const ok = !!outcome?.ok && !error;
    return {
      ok, finalText: texts.join('\n\n'), costUsd: outcome?.costUsd ?? 0, ...(error ? { error: redact(error) } : {}),
      ...(reported && reported !== req.sessionId ? { sessionId: reported } : {}),
    };
  }

  private async writeSummary(bot: Bot, roomId: string, lastSeenSeq: number, previous: string | null): Promise<string | null> {
    if (this.claudeReady && !this.claudeReady()) return null;
    const prompt = buildSummaryPrompt(this.repos, bot, roomId, lastSeenSeq, previous);
    if (!prompt) return null;
    try {
      const outcome = await this.summarize(prompt, SUMMARY_SYSTEM_PROMPT);
      const u = outcome.usage;
      if (u.costUsd || u.inputTokens || u.outputTokens) {
        this.usage.record(bot.id, roomId, 'sum-' + nanoid(8), null, u, { model: AUTO_MEMORY_MODEL, routeReason: 'session-summary', causeKind: 'memory', provider: 'claude' });
      }
      const summary = cleanSummary(outcome);
      if (summary) this.repos.saveSessionState(bot.id, roomId, { summary });
      else console.warn('[rotation ' + bot.handle + '] summary skipped: ' + redact(outcome.error ?? 'empty reply'));
      return summary;
    } catch (e) {
      console.warn('[rotation ' + bot.handle + '] summary failed: ' + redact(String((e as Error).message ?? e)));
      return null;
    }
  }

  static checkExe(): { ok: boolean; error?: string } {
    return fs.existsSync(CLAUDE_EXE) ? { ok: true } : { ok: false, error: 'claude executable not found' };
  }
}
