import type { BotPreview, SearchHit } from '@pocketrocket/shared';
import type {
  Bot, BotInput, Room, RoomInput, Message, Skill, Routine, RoutineRun, RoutineInput, UsageTotals, UsageRow, HealthInfo,
  Settings, SettingsPatch, ProvidersResponse, ProviderId, ProviderCheck, SecretsStatus, AccountState, UsageGroup,
  ComputerStatus, FailoverCard, FailoverDecision, FailoverState,
  SandboxStatus,
  IntegrationsState, IntegrationInfo, IntegrationProvider, OAuthAppInput, OAuthAppStatus, PendingConnect, TokenConnectInput,
} from '@pocketrocket/shared';
import type { AuditEntry, GameProjectSetup, GameToolFix, GameToolFixResult, GameToolsStatus, TeamTemplateId, UserSessionInfo } from '@pocketrocket/shared';
import type { ProjectMapReply, ProjectOverview } from '@pocketrocket/shared';
import type { Workflow, WorkflowApprovalCard, WorkflowDecision, WorkflowInput, WorkflowPatch, WorkflowRun, WorkflowRunSummary } from '@pocketrocket/shared';
import type { KnowledgeStatus, SkillGitImportResult, VoiceProposal } from '@pocketrocket/shared';
import type { Trigger, TriggerFire, TriggerInput, TriggersState, TriggerTestInput } from '@pocketrocket/shared';
import type { ApprovalPolicy, ComputerControl, ControlStatus } from '@pocketrocket/shared';
import type { RecorderStatus, RecordingInfo, SkillReflectionConfig, SkillVersion, SkillVersionDetail } from '@pocketrocket/shared';
import type { TrainingDecision, TrainingPassResult, TrainingProposal, TrainingState } from '@pocketrocket/shared';
import type { FileChangeResult, FileListing, FileUploadInput, SlashCommandInfo, StoredFileMeta } from '@pocketrocket/shared';
import type { CredentialCreate, CredentialInfo, CredentialPatch } from '@pocketrocket/shared';
import type { MachineInfo, MachinePolicy, PcRunnerStatus } from '@pocketrocket/shared';
import type { BotExportResult, BotImportResult, ContextUsage, LaneQueue, Task, TaskStatus } from '@pocketrocket/shared';
import type { PcJobRequest, PcJobView } from './pcRun';
import type { ProjectReposFile, ReposPutBody } from './projectRepos';
import { listQuery, PC_ENTRY_PAGE, type PcSessionDetail, type PcSessionQuery, type PcSessionSummary, type PcSeqEntry } from './pcSessions';
import type { TelegramState } from './telegram';
import { getToken, reportAuthFailure, clearAuthFailure } from './auth';

export class ApiError extends Error {
  /** The reply's JSON body, e.g. a game tools fix's `result` word on a 409. */
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 401) {
    reportAuthFailure();
    const j = await r.json().catch(() => ({}));
    throw new ApiError((j as { error?: string }).error ?? 'Unauthorized', 401);
  }
  clearAuthFailure();
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError((j as { error?: string }).error ?? r.statusText, r.status, j);
  return j as T;
}

export const MESSAGE_PAGE = 200;

export type HealthResponse = HealthInfo & { version?: string; provider?: ProviderId };

export type AccountActionResponse = AccountState | { ok: boolean } | Record<string, unknown>;

export interface ProjectInfo { slug: string; name: string; dir: string; memberIds: string[]; roomId: string | null; templateVersion: number | null; kind?: 'game' | null; createdAt: number }
/** `template` wins over `team` on the hub; `team: true` alone still means the dev template. */
export interface ProjectCreateInput { name: string; team?: boolean; template?: TeamTemplateId; memberIds?: string[] }
/** `setup` comes only with the game template (B7). */
export interface ProjectCreateReply { project: ProjectInfo; bots: Bot[]; room: Room | null; setup?: GameProjectSetup }
export interface ProjectLint { issues: { kind: string; path: string; detail: string }[]; recentMisses: string[] }

const filesBase = (roomId: string) => '/api/rooms/' + encodeURIComponent(roomId) + '/files';

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'));
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.readAsDataURL(file);
  });
}

export interface BotReportRow {
  id: string; botId: string; roomId: string | null; kind: 'captcha' | 'login' | 'blocked' | 'other'; site: string; reason: string;
  status: 'pending' | 'resolved' | 'dismissed'; createdAt: number;
}
/** Tokens and env values are never in it, only whether they are set. */
export interface McpServerRow {
  name: string; kind: 'http' | 'stdio' | 'invalid'; status: 'configured' | 'invalid'; problems: string[];
  url?: string; urlHasQuery?: boolean; tokenSet?: boolean; command?: string; args?: string[]; argsMasked?: boolean; envKeys?: string[];
  rooms: string[]; bots: string[]; approve: 'every-call' | 'writes' | 'none' | 'mode'; readTools: string[]; needs: string[];
  lastCheck: { ok: boolean; result: string; at: number } | null;
}
export interface McpServerInput {
  name: string; url?: string; token?: string; command?: string; args?: string[]; env?: Record<string, string>;
  rooms?: string[]; bots?: string[]; approve?: McpServerRow['approve'];
}
export interface McpServerPatch {
  token?: string | null; approve?: McpServerRow['approve']; rooms?: string[]; bots?: string[];
}
export interface TaskInput { title: string; assigneeBotId?: string | null }

export const api = {
  tasks: {
    list: (roomId: string) => req<Task[]>('GET', '/api/rooms/' + encodeURIComponent(roomId) + '/tasks?all=1'),
    create: (roomId: string, t: TaskInput) => req<Task>('POST', '/api/rooms/' + encodeURIComponent(roomId) + '/tasks', t),
    update: (roomId: string, id: string, patch: { status?: TaskStatus; assigneeBotId?: string | null; title?: string }) =>
      req<Task>('PATCH', '/api/rooms/' + encodeURIComponent(roomId) + '/tasks/' + encodeURIComponent(id), patch),
  },
  verification: {
    answer: (messageId: string, resolved: 'asked' | 'accepted') =>
      req<{ ok: true; resolved: 'asked' | 'accepted' }>('POST', '/api/messages/' + encodeURIComponent(messageId) + '/verification', { resolved }),
  },
  botReports: {
    list: () => req<BotReportRow[]>('GET', '/api/bot-reports'),
    set: (id: string, status: BotReportRow['status']) => req<BotReportRow>('PATCH', '/api/bot-reports/' + encodeURIComponent(id), { status }),
  },
  gameTools: {
    status: () => req<GameToolsStatus>('GET', '/api/game-tools'),
    /** A failed step answers 409 with the same shape: read it from `ApiError.body`. */
    fix: (step: GameToolFix) => req<GameToolFixResult>('POST', '/api/game-tools/fix/' + encodeURIComponent(step), {}),
    crashLog: () => req<{ log: string | null }>('GET', '/api/game-tools/blender/crash-log'),
  },
  mcpServers: {
    list: () => req<{ servers: McpServerRow[] }>('GET', '/api/mcp-servers'),
    add: (s: McpServerInput) => req<McpServerRow>('POST', '/api/mcp-servers', s),
    patch: (name: string, p: McpServerPatch) => req<McpServerRow>('PATCH', '/api/mcp-servers/' + encodeURIComponent(name), p),
    remove: (name: string) => req<{ ok: true }>('DELETE', '/api/mcp-servers/' + encodeURIComponent(name)),
    check: (name: string) => req<{ ok: boolean; result: string; at: number }>('POST', '/api/mcp-servers/' + encodeURIComponent(name) + '/check', {}),
  },
  files: {
    list: (roomId: string, path = '') => req<FileListing>('GET', filesBase(roomId) + '?path=' + encodeURIComponent(path)),
    where: (roomId: string, abs: string) => req<{ path: string; kind: 'file' | 'dir' }>('GET', filesBase(roomId) + '/where?path=' + encodeURIComponent(abs)),
    browse: (roomId: string, path: string, botId?: string) => req<{ botId: string | null }>('POST', filesBase(roomId) + '/browse', { path, ...(botId ? { botId } : {}) }),
    /** Needs the Bearer header, so fetch it as a blob rather than putting it in an <img>. */
    rawUrl: (roomId: string, path: string, download = false) =>
      filesBase(roomId) + '/raw?path=' + encodeURIComponent(path) + (download ? '&download=1' : ''),
    blob: async (roomId: string, path: string, download = false): Promise<Blob> => {
      const token = getToken();
      const r = await fetch(api.files.rawUrl(roomId, path, download), { headers: token ? { authorization: 'Bearer ' + token } : {} });
      if (r.status === 401) reportAuthFailure();
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new ApiError((j as { error?: string }).error ?? r.statusText, r.status);
      }
      return r.blob();
    },
    upload: (roomId: string, input: FileUploadInput) => req<FileChangeResult>('POST', filesBase(roomId) + '/upload', input),
    uploadFile: async (roomId: string, path: string, file: File, overwrite = false, parents = false, name = file.name) =>
      api.files.upload(roomId, { path, name, dataBase64: await fileToBase64(file), overwrite, ...(parents ? { parents } : {}) }),
    mkdir: (roomId: string, path: string, name: string, parents = false) =>
      req<FileChangeResult>('POST', filesBase(roomId) + '/folder', parents ? { path, name, parents } : { path, name }),
    rename: (roomId: string, from: string, to: string) => req<FileChangeResult>('PATCH', filesBase(roomId), { from, to }),
    remove: (roomId: string, path: string, recursive = false) =>
      req<FileChangeResult>('DELETE', filesBase(roomId) + '?path=' + encodeURIComponent(path) + (recursive ? '&recursive=true' : '')),
  },
  projects: {
    list: () => req<ProjectInfo[]>('GET', '/api/projects'),
    create: (input: ProjectCreateInput) => req<ProjectCreateReply>('POST', '/api/projects', input),
    setMembers: (slug: string, memberIds: string[]) => req<ProjectInfo>('PUT', '/api/projects/' + encodeURIComponent(slug) + '/members', { memberIds }),
    lint: (slug: string) => req<ProjectLint>('GET', '/api/projects/' + encodeURIComponent(slug) + '/lint'),
    repos: (slug: string) => req<ProjectReposFile>('GET', '/api/projects/' + encodeURIComponent(slug) + '/repos'),
    setRepos: (slug: string, body: ReposPutBody) => req<ProjectReposFile>('PUT', '/api/projects/' + encodeURIComponent(slug) + '/repos', body),
    overview: (slug: string) => req<ProjectOverview>('GET', '/api/projects/' + encodeURIComponent(slug) + '/overview'),
    map: (slug: string) => req<ProjectMapReply>('GET', '/api/projects/' + encodeURIComponent(slug) + '/map'),
  },
  auth: {
    status: () => req<{ passwordSet: boolean; signedIn: boolean }>('GET', '/api/auth/status'),
    login: (password: string) => req<{ ok: boolean }>('POST', '/api/auth/login', { password }),
    sessions: () => req<{ sessions: UserSessionInfo[]; current: string | null; passwordSet: boolean }>('GET', '/api/auth/sessions'),
    setPassword: (password: string, currentPassword?: string) => req<{ ok: boolean }>('POST', '/api/auth/password', { password, currentPassword }),
    logout: () => req<{ ok: boolean }>('POST', '/api/auth/logout', {}),
    revoke: (id: string) => req<{ ok: boolean }>('DELETE', '/api/auth/sessions/' + encodeURIComponent(id)),
    revokeOthers: () => req<{ ended: number }>('POST', '/api/auth/sessions/revoke-others', {}),
  },
  audit: (opts: { limit?: number; before?: number } = {}) =>
    req<{ entries: AuditEntry[] }>('GET', '/api/audit?limit=' + (opts.limit ?? 50) + (opts.before ? '&before=' + opts.before : '')),
  health: () => req<HealthResponse>('GET', '/api/health'),
  screen: (botId?: string) =>
    req<{ screen: boolean; cdp: boolean; url: string; computer?: ComputerStatus }>('GET', '/api/screen' + (botId ? '?botId=' + encodeURIComponent(botId) : '')),
  // Spends the hub token on a single-use ticket so the token never reaches an iframe URL.
  screenTicket: (botId?: string) => req<{ url: string }>('POST', '/api/screen/ticket', botId ? { botId } : undefined),
  screenOpen: (url: string, roomId?: string | null, botId?: string) =>
    req<{ botId: string | null }>('POST', '/api/screen/open', { url, ...(roomId ? { roomId } : {}), ...(botId ? { botId } : {}) }),
  computers: {
    get: (botId: string) => req<ComputerStatus>('GET', '/api/computers/' + encodeURIComponent(botId)),
    wake: (botId: string, o: { auto?: boolean } = {}) => req<ComputerStatus>('POST', '/api/computers/' + encodeURIComponent(botId) + '/wake', o),
    keepAwake: (botId: string, on: boolean) => req<ComputerStatus>('PUT', '/api/computers/' + encodeURIComponent(botId) + '/keep-awake', { on }),
  },
  config: () => req<{ workspaceDir: string; version: string }>('GET', '/api/config'),
  openWorkspace: (botId?: string | null) =>
    req<{ ok: boolean; where: 'explorer' | 'finder' | 'screen' | 'file-manager'; path: string; error?: string }>('POST', '/api/workspace/open', botId ? { botId } : {}),
  media: {
    upload: (data: string) => req<{ ref: string }>('POST', '/api/media', { data }),
    uploadAttachment: (data: string) => req<{ ref: string }>('POST', '/api/media?for=attachment', { data }),
  },
  attachments: {
    upload: (file: File, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<StoredFileMeta> =>
      new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('POST', '/api/files');
        x.setRequestHeader('content-type', 'application/octet-stream');
        x.setRequestHeader('x-file-name', encodeURIComponent(file.name));
        if (file.type) x.setRequestHeader('x-file-type', file.type);
        const token = getToken();
        if (token) x.setRequestHeader('authorization', 'Bearer ' + token);
        x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
        x.onload = () => {
          let j: { error?: string } = {};
          try { j = JSON.parse(x.responseText); } catch { /* not JSON: use the status text */ }
          if (x.status === 401) reportAuthFailure();
          if (x.status >= 200 && x.status < 300) resolve(j as StoredFileMeta);
          else reject(new ApiError(j.error ?? (x.statusText || 'Upload failed'), x.status));
        };
        x.onerror = () => reject(new ApiError('Upload failed. Check the connection and try again.', 0));
        x.onabort = () => reject(new ApiError('Upload cancelled', 0));
        signal?.addEventListener('abort', () => x.abort());
        x.send(file);
      }),
    meta: (hash: string) => req<StoredFileMeta>('GET', '/api/files/' + hash + '/meta'),
    blob: async (hash: string): Promise<Blob> => {
      const token = getToken();
      const r = await fetch('/api/files/' + hash, { headers: token ? { authorization: 'Bearer ' + token } : {} });
      if (r.status === 401) reportAuthFailure();
      if (!r.ok) throw new ApiError(r.status === 404 ? 'That file is gone (files are kept a while, then cleared).' : r.statusText, r.status);
      return r.blob();
    },
  },
  commands: (roomId: string) => req<SlashCommandInfo[]>('GET', '/api/rooms/' + encodeURIComponent(roomId) + '/commands'),
  bots: {
    list: () => req<Bot[]>('GET', '/api/bots'),
    create: (b: BotInput) => req<Bot>('POST', '/api/bots', b),
    update: (id: string, b: Partial<BotInput>) => req<Bot>('PATCH', '/api/bots/' + id, b),
    remove: (id: string) => req<{ ok: true }>('DELETE', '/api/bots/' + id),
    memory: (id: string) => req<{ text: string; bytes: number; limit: number; lastAutoSavedAt: number | null }>('GET', '/api/bots/' + id + '/memory'),
    setMemory: (id: string, text: string) => req<{ ok: true }>('PUT', '/api/bots/' + id + '/memory', { text }),
    skills: (id: string) => req<string[]>('GET', '/api/bots/' + id + '/skills'),
    setSkills: (id: string, skillIds: string[]) => req<{ ok: true }>('PUT', '/api/bots/' + id + '/skills', { skillIds }),
    /** Never holds secrets, paths or permissions. */
    export: (id: string, includeMemory: boolean) => req<BotExportResult>('GET', '/api/bots/' + id + '/export' + (includeMemory ? '?memory=1' : '')),
    import: (file: unknown, includeMemory: boolean) => req<BotImportResult>('POST', '/api/bots/import' + (includeMemory ? '?memory=1' : ''), file),
    resetSession: (id: string, roomId: string) => req<{ ok: true }>('POST', '/api/bots/' + id + '/reset-session', { roomId }),
  },
  routing: {
    get: () => req<{ text: string }>('GET', '/api/routing'),
    save: (text: string) => req<{ text: string }>('PUT', '/api/routing', { text }),
  },
  rooms: {
    list: () => req<Room[]>('GET', '/api/rooms'),
    create: (r: RoomInput) => req<Room>('POST', '/api/rooms', r),
    update: (id: string, r: Partial<RoomInput>) => req<Room>('PATCH', '/api/rooms/' + id, r),
    remove: (id: string) => req<{ ok: true }>('DELETE', '/api/rooms/' + id),
    setModel: (id: string, model: string | null) => req<Room>('PUT', '/api/rooms/' + id + '/model', { model }),
    messages: (id: string, before?: number) => req<Message[]>('GET', '/api/rooms/' + id + '/messages?limit=' + MESSAGE_PAGE + (before ? '&before=' + before : '')),
    queue: (id: string) => req<LaneQueue[]>('GET', '/api/rooms/' + id + '/queue'),
    context: (id: string) => req<Record<string, ContextUsage>>('GET', '/api/rooms/' + id + '/context'),
    queueCancel: (id: string, journalId: string) => req<Message>('POST', '/api/rooms/' + id + '/queue/cancel', { journalId }),
    queueEdit: (id: string, journalId: string, text: string) => req<Message>('POST', '/api/rooms/' + id + '/queue/edit', { journalId, text }),
    queueSendNow: (id: string, botId: string) => req<{ interrupted: boolean }>('POST', '/api/rooms/' + id + '/queue/send-now', { botId }),
    queuePause: (id: string, botId: string | undefined, paused: boolean) => req<LaneQueue[]>('POST', '/api/rooms/' + id + '/queue/pause', { ...(botId ? { botId } : {}), paused }),
  },
  skills: {
    list: () => req<Skill[]>('GET', '/api/skills'),
    importable: () => req<{ name: string; description: string }[]>('GET', '/api/skills/importable'),
    import: (names: string[]) => req<Skill[]>('POST', '/api/skills/import', { names }),
    create: (name: string, description: string, markdown: string) => req<Skill>('POST', '/api/skills', { name, description, markdown }),
    get: (id: string) => req<Skill & { markdown: string }>('GET', '/api/skills/' + id),
    review: (id: string, reviewStatus: 'approved' | 'pending') => req<Skill>('PATCH', '/api/skills/' + id, { reviewStatus }),
    remove: (id: string) => req<{ ok: true }>('DELETE', '/api/skills/' + id),
  },
  routines: {
    list: () => req<Routine[]>('GET', '/api/routines'),
    create: (r: RoutineInput) => req<Routine>('POST', '/api/routines', r),
    update: (id: string, r: Partial<RoutineInput>) => req<Routine>('PATCH', '/api/routines/' + id, r),
    remove: (id: string) => req<{ ok: true }>('DELETE', '/api/routines/' + id),
    run: (id: string) => req<{ ok: boolean }>('POST', '/api/routines/' + id + '/run'),
    runs: (id: string) => req<RoutineRun[]>('GET', '/api/routines/' + id + '/runs'),
  },
  workflows: {
    list: () => req<Workflow[]>('GET', '/api/workflows'),
    get: (id: string) => req<Workflow>('GET', '/api/workflows/' + id),
    create: (w: WorkflowInput) => req<Workflow>('POST', '/api/workflows', w),
    update: (id: string, w: WorkflowPatch) => req<Workflow>('PATCH', '/api/workflows/' + id, w),
    remove: (id: string) => req<{ ok: true }>('DELETE', '/api/workflows/' + id),
    run: (id: string) => req<WorkflowRunSummary>('POST', '/api/workflows/' + id + '/run'),
    runs: (id: string, limit = 20) => req<WorkflowRunSummary[]>('GET', '/api/workflows/' + id + '/runs?limit=' + limit),
    getRun: (runId: string) => req<WorkflowRun>('GET', '/api/workflow-runs/' + runId),
    cancel: (runId: string) => req<WorkflowRunSummary>('POST', '/api/workflow-runs/' + runId + '/cancel'),
    retry: (runId: string) => req<WorkflowRunSummary>('POST', '/api/workflow-runs/' + runId + '/retry'),
    cards: () => req<WorkflowApprovalCard[]>('GET', '/api/workflow-cards'),
    /** Person-only: the hub refuses a bot, the PC runner, a cta button and chat text. */
    decide: (runId: string, d: WorkflowDecision) => req<WorkflowRunSummary>('POST', '/api/workflow-runs/' + runId + '/decision', d),
  },
  usage: (q: { botId?: string; roomId?: string } = {}) => {
    const p = new URLSearchParams();
    if (q.botId) p.set('botId', q.botId);
    if (q.roomId) p.set('roomId', q.roomId);
    return req<{ totals: UsageTotals; rows: UsageRow[]; byModel?: UsageGroup[]; byCause?: UsageGroup[]; byProvider?: UsageGroup[] }>('GET', '/api/usage?' + p.toString());
  },
  previews: () => req<Record<string, BotPreview>>('GET', '/api/previews'),
  search: (q: string) => req<SearchHit[]>('GET', '/api/search?q=' + encodeURIComponent(q)),
  sandbox: { status: () => req<SandboxStatus>('GET', '/api/sandbox/status') },
  settings: {
    get: () => req<Settings>('GET', '/api/settings'),
    update: (patch: SettingsPatch) => req<Settings>('PUT', '/api/settings', patch),
  },
  providers: {
    list: () => req<ProvidersResponse>('GET', '/api/providers'),
    check: (id: ProviderId) => req<ProviderCheck>('POST', '/api/providers/' + id + '/check'),
  },
  failover: {
    get: () => req<FailoverState>('GET', '/api/failover'),
    decide: (id: string, decision: FailoverDecision['decision']) => req<FailoverCard>('POST', '/api/failover-cards/' + encodeURIComponent(id) + '/decision', { decision }),
  },
  secrets: {
    get: () => req<SecretsStatus>('GET', '/api/secrets'),
    update: (patch: Record<string, string>) => req<SecretsStatus>('PUT', '/api/secrets', patch),
  },
  account: {
    get: () => req<AccountState>('GET', '/api/account'),
    magicLink: (email: string) => req<AccountActionResponse>('POST', '/api/account/magic-link', { email }),
    verify: (email: string, code: string) => req<AccountActionResponse>('POST', '/api/account/verify', { email, code }),
    cancel: () => req<AccountActionResponse>('POST', '/api/account/cancel', {}),
    signOut: () => req<AccountActionResponse>('POST', '/api/account/sign-out', {}),
    oauth: (provider: 'google' | 'github') => req<{ url: string }>('POST', '/api/account/oauth', { provider }),
  },
  knowledge: {
    status: () => req<KnowledgeStatus>('GET', '/api/knowledge'),
    sync: () => req<KnowledgeStatus>('POST', '/api/knowledge/sync', {}),
  },
  voice: {
    get: (botId: string) => req<{ text: string; proposals: VoiceProposal[] }>('GET', '/api/bots/' + botId + '/voice'),
    set: (botId: string, text: string) => req<{ ok: true; trimmed: boolean }>('PUT', '/api/bots/' + botId + '/voice', { text }),
    decide: (botId: string, id: string, decision: 'approve' | 'dismiss') =>
      req<{ text: string; proposals: VoiceProposal[] }>('POST', '/api/bots/' + botId + '/voice/proposals/' + id, { decision }),
  },
  notes: (botId: string) => req<{ name: string; bytes: number; mtime: number }[]>('GET', '/api/bots/' + botId + '/notes'),
  importSkillsFromGit: (url: string) => req<SkillGitImportResult>('POST', '/api/skills/import-git', { url }),
  // The hub keeps every credential; these answers never carry one.
  integrations: {
    get: () => req<IntegrationsState>('GET', '/api/integrations'),
    setApp: (p: IntegrationProvider, app: OAuthAppInput) => req<OAuthAppStatus>('PUT', '/api/integrations/apps/' + p, app),
    removeApp: (p: IntegrationProvider) => req<OAuthAppStatus>('DELETE', '/api/integrations/apps/' + p),
    startOAuth: (p: IntegrationProvider) => req<{ url: string; redirectUri: string }>('POST', '/oauth/start/' + p, {}),
    startDevice: (p: IntegrationProvider) => req<PendingConnect>('POST', '/api/integrations/device/' + p, {}),
    cancel: (p: IntegrationProvider) => req<{ ok: true }>('POST', '/api/integrations/cancel/' + p, {}),
    connectToken: (p: IntegrationProvider, body: TokenConnectInput) => req<IntegrationInfo>('POST', '/api/integrations/token/' + p, body),
    test: (id: string) => req<IntegrationInfo>('POST', '/api/integrations/' + id + '/test', {}),
    setGrants: (id: string, botIds: string[]) => req<IntegrationInfo>('PUT', '/api/integrations/' + id + '/grants', { botIds }),
    disconnect: (id: string) => req<{ ok: true }>('DELETE', '/api/integrations/' + id),
  },
  triggers: {
    get: () => req<TriggersState>('GET', '/api/triggers'),
    create: (t: TriggerInput) => req<Trigger>('POST', '/api/triggers', t),
    update: (id: string, t: Partial<TriggerInput>) => req<Trigger>('PATCH', '/api/triggers/' + id, t),
    remove: (id: string) => req<{ ok: true }>('DELETE', '/api/triggers/' + id),
    fires: (id: string) => req<TriggerFire[]>('GET', '/api/triggers/' + id + '/fires'),
    test: (id: string, body: TriggerTestInput = {}) => req<TriggerFire>('POST', '/api/triggers/' + id + '/test', body),
  },
  pcRunner: {
    status: () => req<PcRunnerStatus>('GET', '/api/pc-runner'),
    jobs: (limit = 50) => req<PcJobView[]>('GET', '/api/pc-runner/jobs?limit=' + limit),
    /** The click in a password-signed-in browser is the approval: 403 otherwise. */
    start: (body: PcJobRequest) => req<PcJobView>('POST', '/api/pc-runner/jobs', body),
    job: (id: string) => req<PcJobView>('GET', '/api/pc-runner/jobs/' + encodeURIComponent(id)),
    /** Shown once and never stored here. */
    mintToken: () => req<{ token: string }>('POST', '/api/pc-runner/token', {}),
    turnOff: () => req<{ ok: true; cancelled: number }>('DELETE', '/api/pc-runner'),
    machines: () => req<MachineInfo[]>('GET', '/api/pc-runner/machines'),
    setMachinePolicy: (id: string, policy: MachinePolicy) => req<MachineInfo>('PUT', '/api/pc-runner/machines/' + encodeURIComponent(id), { policy }),
  },
  pcSessions: {
    list: (p: PcSessionQuery = {}) => req<{ sessions: PcSessionSummary[] }>('GET', '/api/pc-sessions' + listQuery(p)),
    get: (id: string) => req<PcSessionDetail>('GET', '/api/pc-sessions/' + encodeURIComponent(id)),
    entries: (id: string, after = 0, limit = PC_ENTRY_PAGE) => req<{ entries: PcSeqEntry[]; more: boolean }>('GET', '/api/pc-sessions/' + encodeURIComponent(id) + '/entries?after=' + after + '&limit=' + limit),
    remove: (id: string) => req<{ ok: true }>('DELETE', '/api/pc-sessions/' + encodeURIComponent(id)),
    continue: (id: string, body: { prompt: string }) => req<{ ok: true }>('POST', '/api/pc-sessions/' + encodeURIComponent(id) + '/continue', body),
  },
  // The secret is write-only: it is sent here and never comes back.
  credentials: {
    list: () => req<{ credentials: CredentialInfo[] }>('GET', '/api/credentials'),
    create: (c: Omit<CredentialCreate, 'username'> & { username?: string }) => req<CredentialInfo>('POST', '/api/credentials', c),
    update: (id: string, c: CredentialPatch) => req<CredentialInfo>('PATCH', '/api/credentials/' + encodeURIComponent(id), c),
    remove: (id: string) => req<{ ok: true }>('DELETE', '/api/credentials/' + encodeURIComponent(id)),
  },
  devices: {
    list:() => req<{ devices: DeviceInfo[]; current: string | null }>('GET', '/api/devices'),
    // The answer carries a one-time code, never the hub token.
    pairing: () => req<PairingCode>('POST', '/api/devices/pairing', {}),
    rename: (id: string, name: string) => req<DeviceInfo>('PATCH', '/api/devices/' + encodeURIComponent(id), { name }),
    revoke: (id: string) => req<{ ok: true }>('DELETE', '/api/devices/' + encodeURIComponent(id)),
  },
  // Owner only; the hub never sends the token back.
  telegram: {
    get: () => req<TelegramState>('GET', '/api/telegram'),
    setToken: (token: string) => req<TelegramState>('PUT', '/api/telegram/token', { token }),
    removeToken: () => req<TelegramState>('DELETE', '/api/telegram/token'),
    link: () => req<TelegramState>('POST', '/api/telegram/link', {}),
    unlink: () => req<TelegramState>('POST', '/api/telegram/unlink', {}),
    setNotify: (notify: boolean) => req<TelegramState>('PUT', '/api/telegram/notify', { notify }),
    test: () => req<{ ok: true }>('POST', '/api/telegram/test', {}),
  },
  push: {
    status: () => req<{ publicKey: string; subscriptions: number }>('GET', '/api/push'),
    subscribe: (sub: PushSubscriptionJSON) => req<{ ok: true }>('POST', '/api/push/subscribe', sub),
    unsubscribe: (endpoint: string) => req<{ ok: boolean }>('POST', '/api/push/unsubscribe', { endpoint }),
    test: () => req<{ sent: number; failed: number }>('POST', '/api/push/test', {}),
  },
  control: {
    list: () => req<ControlStatus[]>('GET', '/api/control'),
    set: (botId: string, control: ComputerControl, o: { holder?: string; note?: string } = {}) =>
      req<ControlStatus>('PUT', '/api/computers/' + encodeURIComponent(botId) + '/control', { control, ...o }),
  },
  policies: {
    list: (botId?: string) => req<ApprovalPolicy[]>('GET', '/api/approval-policies' + (botId ? '?botId=' + encodeURIComponent(botId) : '')),
    fromApproval: (approvalId: string, pattern?: string) => req<ApprovalPolicy>('POST', '/api/approval-policies', { approvalId, ...(pattern ? { pattern } : {}) }),
    revoke: (id: string) => req<{ ok: true }>('DELETE', '/api/approval-policies/' + encodeURIComponent(id)),
  },
  teach: {
    status: (botId: string) => req<RecorderStatus>('GET', '/api/computers/' + encodeURIComponent(botId) + '/recorder'),
    start: (botId: string, title?: string) => req<RecorderStatus>('POST', '/api/computers/' + encodeURIComponent(botId) + '/recorder/start', title ? { title } : {}),
    stop: (botId: string) => req<{ recording: RecordingInfo | null; status: RecorderStatus }>('POST', '/api/computers/' + encodeURIComponent(botId) + '/recorder/stop', {}),
    recordings: (botId: string) => req<RecordingInfo[]>('GET', '/api/computers/' + encodeURIComponent(botId) + '/recordings'),
    remove: (botId: string, id: string) => req<{ ok: true }>('DELETE', '/api/computers/' + encodeURIComponent(botId) + '/recordings/' + encodeURIComponent(id)),
    distill: (botId: string, id: string, o: { name?: string; hint?: string } = {}) =>
      req<{ skill: Skill; version: SkillVersion | null }>('POST', '/api/computers/' + encodeURIComponent(botId) + '/recordings/' + encodeURIComponent(id) + '/distill', o),
  },
  skillVersions: {
    list: (skillId: string) => req<SkillVersion[]>('GET', '/api/skills/' + encodeURIComponent(skillId) + '/versions'),
    get: (skillId: string, id: string) => req<SkillVersionDetail>('GET', '/api/skills/' + encodeURIComponent(skillId) + '/versions/' + encodeURIComponent(id)),
    decide: (skillId: string, id: string, decision: 'approve' | 'reject') =>
      req<{ skill: Skill; version: SkillVersion }>('POST', '/api/skills/' + encodeURIComponent(skillId) + '/versions/' + encodeURIComponent(id), { decision }),
    correct: (skillId: string, text: string) => req<SkillVersion>('POST', '/api/skills/' + encodeURIComponent(skillId) + '/corrections', { text }),
    reflection: (botId: string) => req<SkillReflectionConfig>('GET', '/api/bots/' + encodeURIComponent(botId) + '/skill-reflection'),
    setReflection: (botId: string, patch: Partial<Omit<SkillReflectionConfig, 'botId'>>) =>
      req<SkillReflectionConfig>('PUT', '/api/bots/' + encodeURIComponent(botId) + '/skill-reflection', patch),
  },
  training: {
    get: (botId: string) => req<TrainingState>('GET', '/api/bots/' + encodeURIComponent(botId) + '/training'),
    setEnabled: (botId: string, enabled: boolean) => req<TrainingState>('PUT', '/api/bots/' + encodeURIComponent(botId) + '/training', { enabled }),
    run: (botId: string) => req<TrainingPassResult>('POST', '/api/bots/' + encodeURIComponent(botId) + '/training/run', {}),
    decide: (botId: string, id: string, decision: TrainingDecision) =>
      req<TrainingProposal>('POST', '/api/bots/' + encodeURIComponent(botId) + '/training/proposals/' + encodeURIComponent(id), { decision }),
  },
};

/** Never its token or hash. */
export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  revoked: boolean;
}
export interface PairingCode {
  code: string;
  expiresAt: number;
  ttlMs: number;
  hosts: string[];
}
