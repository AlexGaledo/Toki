import { ASK_EVERY_TIME_TOOLS, SIGN_IN_TOOLS, type ApprovalPayload, type ControlStatus, type FailoverCard, type FormPayload, type Message, type OpenApproval, type Skill, type VerificationPayload, type WorkflowApprovalCard } from '@pocketrocket/shared';
import { toolAsk } from './toolPhrases';

export type InboxKind = 'approval' | 'takeover' | 'skill' | 'form' | 'workflow' | 'failover' | 'verify';

const WORKFLOW_CARD_WAIT_MS = 24 * 3_600_000;

export interface InboxItem {
  key: string;
  kind: InboxKind;
  botId: string | null;
  roomId: string | null;
  title: string;
  detail: string | null;
  since: number | null;
  approvalId?: string;
  workflowCard?: WorkflowApprovalCard;
  failoverCard?: FailoverCard;
  /** Context for the row, never a consent surface. */
  approval?: Pick<ApprovalPayload, 'toolName' | 'toolInput'>;
  /** Allowing is never offered here: it goes through the full card. */
  canDeny?: boolean;
}

export interface InboxInput {
  openApprovals: OpenApproval[];
  messages: Record<string, Message[]>;
  control: Record<string, ControlStatus>;
  skills: Skill[] | null;
  workflowCards?: { card: WorkflowApprovalCard; roomId: string | null }[];
  failoverCards?: FailoverCard[];
}

const PROPOSAL_TOOLS: ReadonlySet<string> = new Set(['handoff', 'propose_routing_change']);

export function rowMayDeny(p: ApprovalPayload): boolean {
  return !p.danger && !p.once && !p.signInRequired
    && !ASK_EVERY_TIME_TOOLS.has(p.toolName) && !SIGN_IN_TOOLS.has(p.toolName) && !PROPOSAL_TOOLS.has(p.toolName);
}

const isPendingApproval = (m: Message): m is Message & { payload: ApprovalPayload } =>
  m.kind === 'approval' && (m.payload as ApprovalPayload | null)?.status === 'pending';

const isPendingForm = (m: Message): m is Message & { payload: FormPayload } =>
  m.kind === 'form' && (m.payload as FormPayload | null)?.status === 'pending';

const unansweredVerification = (m: Message) => {
  const v = m.kind === 'text' ? (m.payload as Partial<VerificationPayload> | null)?.verification : undefined;
  return v && !v.resolved ? v : undefined;
};

export function selectInbox({ openApprovals, messages, control, skills, workflowCards, failoverCards }: InboxInput): InboxItem[] {
  const items: InboxItem[] = [];

  for (const card of failoverCards ?? []) {
    items.push({
      key: 'failover:' + card.id,
      kind: 'failover',
      botId: card.botId,
      roomId: card.roomId,
      title: 'Hit its usage limit',
      detail: null,
      since: card.createdAt,
      failoverCard: card,
    });
  }

  for (const { card, roomId } of workflowCards ?? []) {
    items.push({
      key: 'workflow:' + card.runId + ':' + card.nodeId,
      kind: 'workflow',
      botId: null,
      roomId,
      title: 'Approval needed',
      detail: card.workflowName + ': ' + card.title,
      since: card.expiresAt - WORKFLOW_CARD_WAIT_MS,
      workflowCard: card,
    });
  }

  const cards = new Map<string, { m: Message & { payload: ApprovalPayload }; roomId: string }>();
  for (const [roomId, list] of Object.entries(messages)) {
    for (const m of list) if (isPendingApproval(m)) cards.set(m.payload.approvalId, { m, roomId });
  }
  const seen = new Set<string>();
  const add = (approvalId: string, botId: string | null, roomId: string) => {
    if (seen.has(approvalId)) return;
    seen.add(approvalId);
    const card = cards.get(approvalId);
    const p = card?.m.payload;
    items.push({
      key: 'approval:' + approvalId,
      kind: 'approval',
      botId,
      roomId,
      title: p ? 'Wants to ' + toolAsk(p.toolName) : 'Needs your approval',
      approval: p ? { toolName: p.toolName, toolInput: p.toolInput } : undefined,
      detail: p?.reason ? p.reason : null,
      since: card?.m.createdAt ?? null,
      approvalId,
      canDeny: !!p && rowMayDeny(p),
    });
  };
  for (const a of openApprovals) add(a.approvalId, a.botId, a.roomId);
  for (const [approvalId, { m, roomId }] of cards) add(approvalId, m.authorId, roomId);

  for (const [roomId, list] of Object.entries(messages)) {
    for (const m of list) {
      if (!isPendingForm(m)) continue;
      items.push({
        key: 'form:' + m.id,
        kind: 'form',
        botId: m.payload.botId || m.authorId,
        roomId,
        title: 'Asked you for some details',
        detail: m.payload.title || null,
        since: m.createdAt,
      });
    }
  }

  for (const [roomId, list] of Object.entries(messages)) {
    for (const m of list) {
      const v = unansweredVerification(m);
      if (!v) continue;
      items.push({ key: 'verify:' + m.id, kind: 'verify', botId: m.authorId, roomId, title: 'Says done without proof', detail: v.reason, since: m.createdAt });
    }
  }

  for (const c of Object.values(control)) {
    const t = c.takeover;
    if (!t) continue;
    const card = messages[t.roomId]?.find((m) => m.id === t.messageId);
    items.push({
      key: 'takeover:' + t.messageId,
      kind: 'takeover',
      botId: c.botId,
      roomId: t.roomId,
      title: 'Needs you on its screen',
      detail: t.reason || null,
      since: card?.createdAt ?? c.since ?? null,
    });
  }

  for (const s of skills ?? []) {
    const n = s.pendingVersions ?? 0;
    if (s.reviewStatus !== 'pending' && n === 0) continue;
    items.push({
      key: 'skill:' + s.id,
      kind: 'skill',
      botId: s.createdByBot,
      roomId: null,
      title: s.reviewStatus === 'pending' ? 'New skill to review' : n === 1 ? 'Skill change to review' : n + ' skill changes to review',
      detail: s.name,
      since: null,
    });
  }

  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (a.it.since ?? Infinity) - (b.it.since ?? Infinity) || a.i - b.i)
    .map((x) => x.it);
}

export function fmtAge(since: number | null, now: number): string | null {
  if (since === null) return null;
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

export function titleWithCount(base: string, count: number): string {
  const bare = base.replace(/^\(\d+\)\s*/, '');
  return count > 0 ? '(' + count + ') ' + bare : bare;
}
