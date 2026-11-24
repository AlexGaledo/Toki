import type { ApprovalPayload } from '@pocketrocket/shared';

export interface ApprovalCode {
  /** The field's name, e.g. `code`. */
  field: string;
  code: string;
  /** The input's other fields, as short text, in their own order. */
  fields: [string, string][];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The script named by `codeField` (B4), to show as code (D5). On an outside-server card `toolInput` is
 * `{ server, tool, input }` and the field is a key of `input`; on any other card it is a key of `toolInput`.
 * Null when there is no such string field, so the card falls back to the plain input view.
 */
export function approvalCode(p: Pick<ApprovalPayload, 'toolInput' | 'codeField'>): ApprovalCode | null {
  const field = p.codeField;
  if (!field || !isObj(p.toolInput)) return null;
  const t = p.toolInput;
  const own = typeof t.server === 'string' && typeof t.tool === 'string' && isObj(t.input) ? t.input : t;
  const code = own[field];
  if (typeof code !== 'string') return null;
  const fields = Object.entries(own)
    .filter(([k]) => k !== field)
    .map(([k, v]): [string, string] => [k, typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)]);
  return { field, code, fields };
}
