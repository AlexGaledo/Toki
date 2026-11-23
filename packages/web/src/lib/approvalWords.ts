import type { ApprovalPayload } from '@pocketrocket/shared';

export function cardWords(p: Pick<ApprovalPayload, 'toolName' | 'toolInput'>): { main: string; more?: string } | null {
  const input = (p.toolInput ?? {}) as Record<string, unknown>;
  const [main, more] = p.toolName === 'handoff' ? [input.task, input.context] : [input.line, input.reason];
  if (typeof main !== 'string' || !main) return null;
  return { main, more: typeof more === 'string' && more ? more : undefined };
}
