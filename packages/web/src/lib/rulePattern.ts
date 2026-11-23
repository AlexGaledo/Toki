import type { ApprovalPayload } from '@pocketrocket/shared';

const SINGLE_PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function suggestPattern(p: ApprovalPayload): string | null {
  const i = (p.toolInput ?? {}) as Record<string, unknown>;
  const subject = p.toolName === 'Bash' ? str(i.command)
    : p.toolName === 'request_approval' ? str(i.command) || str(i.action)
    : p.toolName === 'WebFetch' ? str(i.url)
    : p.toolName === 'WebSearch' ? str(i.query)
    : SINGLE_PATH_TOOLS.has(p.toolName) ? str(i.file_path) || str(i.path) || str(i.notebook_path)
    : '';
  return subject && !subject.endsWith('*') ? subject : null;
}

export function broadPattern(p: ApprovalPayload): string | null {
  const exact = suggestPattern(p);
  if (!exact) return null;
  if (p.toolName === 'Bash' || p.toolName === 'request_approval') {
    const words = exact.split('\n')[0].trim().split(/\s+/);
    if (words[0] === 'cd' && words[1]) return 'cd ' + words[1] + '*';
    return words.length > 1 ? words[0] + ' *' : exact;
  }
  if (p.toolName === 'WebFetch') {
    try { return new URL(exact).origin + '/*'; } catch { return exact; }
  }
  if (SINGLE_PATH_TOOLS.has(p.toolName)) {
    const cut = Math.max(exact.lastIndexOf('/'), exact.lastIndexOf('\\'));
    return cut > 0 ? exact.slice(0, cut + 1) + '*' : exact;
  }
  return exact;
}
