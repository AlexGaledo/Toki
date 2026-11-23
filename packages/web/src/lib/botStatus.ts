import { useMemo } from 'react';
import type { ApprovalPayload, BotState, ControlStatus, FailoverCard, Message, OpenApproval } from '@pocketrocket/shared';
import { useStore } from '../store';

export type BotStatus = 'needs_you' | 'paused' | 'waiting_on_bot' | 'idle' | 'thinking' | 'working' | 'done' | 'error';

export const STATUS_LABEL: Record<BotStatus, string> = {
  needs_you: 'Needs you',
  paused: 'Paused',
  waiting_on_bot: 'Waiting on a bot',
  idle: 'Idle',
  thinking: 'Thinking',
  working: 'Working',
  done: 'Done',
  error: 'Stopped with an error',
};

const RING: Record<BotStatus, BotState> = {
  needs_you: 'blocked',
  paused: 'waiting',
  waiting_on_bot: 'waiting',
  idle: 'idle',
  thinking: 'thinking',
  working: 'working',
  done: 'done',
  error: 'error',
};

export const avatarStatus = (status: BotStatus) => ({ state: RING[status], label: STATUS_LABEL[status] });

export const isWorking = (status: BotStatus) => status === 'thinking' || status === 'working';

export function botStatus(state: BotState | undefined, control: ControlStatus | undefined, awaitingApproval: boolean): BotStatus {
  if (state === 'blocked' || awaitingApproval || control?.takeover) return 'needs_you';
  if (control?.control === 'paused') return 'paused';
  if (state === 'waiting') return 'waiting_on_bot';
  return state ?? 'idle';
}

function openApprovals(messages: Record<string, Message[]>, known: OpenApproval[], failover: readonly FailoverCard[] = []): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of failover) out.set(c.botId, c.roomId);
  for (const a of known) out.set(a.botId, a.roomId);
  for (const [roomId, list] of Object.entries(messages)) {
    for (const m of list) {
      if (m.kind === 'approval' && m.authorId && (m.payload as ApprovalPayload | null)?.status === 'pending') out.set(m.authorId, roomId);
      else if (m.kind === 'form' && m.authorId && (m.payload as { status?: string } | null)?.status === 'pending') out.set(m.authorId, roomId);
    }
  }
  return out;
}

export function useBotStatus() {
  const botStates = useStore((s) => s.botStates);
  const control = useStore((s) => s.control);
  const messages = useStore((s) => s.messages);
  const known = useStore((s) => s.openApprovals);
  const failover = useStore((s) => s.failover.cards);
  const approvals = useMemo(() => openApprovals(messages, known, failover), [messages, known, failover]);
  return {
    statusOf: (botId: string) => botStatus(botStates[botId], control[botId], approvals.has(botId)),
    needsYouRoom: (botId: string): string | null => control[botId]?.takeover?.roomId ?? approvals.get(botId) ?? null,
  };
}
