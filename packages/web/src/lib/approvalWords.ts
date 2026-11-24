import type { ApprovalPayload } from '@pocketrocket/shared';

export function cardWords(p: Pick<ApprovalPayload, 'toolName' | 'toolInput'>): { main: string; more?: string } | null {
  const input = (p.toolInput ?? {}) as Record<string, unknown>;
  const [main, more] = p.toolName === 'handoff' ? [input.task, input.context] : [input.line, input.reason];
  if (typeof main !== 'string' || !main) return null;
  return { main, more: typeof more === 'string' && more ? more : undefined };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** An older card may carry the outside tool's input as a JSON string: read it as the object it stands for. */
function inputObject(v: unknown): Record<string, unknown> | null {
  if (isObj(v)) return v;
  if (typeof v !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(v);
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * One line for an approval in Needs you and the Overview. An outside tool reads "<server> · <tool>", plus the first
 * line of its code field (B4's `codeField`), instead of its input as escaped JSON. The full input stays on the card.
 */
export function approvalSummary(p: Pick<ApprovalPayload, 'toolName' | 'toolInput' | 'codeField'>): string {
  const one = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 160);
  const words = cardWords(p);
  if (words) return one(words.main);
  const t = isObj(p.toolInput) ? p.toolInput : {};
  if (typeof t.server === 'string' && typeof t.tool === 'string') {
    const code = inputObject(t.input)?.[p.codeField ?? 'code'];
    const first = typeof code === 'string' ? code.split(/\r?\n/).map((l) => l.trim()).find(Boolean) : undefined;
    return one(t.server + ' · ' + t.tool + (first ? ': ' + first : ''));
  }
  if (typeof t.command === 'string' && Object.keys(t).length <= 2) return one(t.command);
  return one(JSON.stringify(t, null, 2));
}
