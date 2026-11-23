import type { MessageVerification } from '@pocketrocket/shared';

/**
 * B1 "done needs evidence": a deterministic check over one turn's tool calls, in order. A turn that changed files and
 * ran nothing afterwards that could catch a mistake (tests, a build, a linter, a screenshot) ends in a reply the app
 * labels "unverified". It is a label, not a gate: the reply still posts. Enforced here, not in the prompt.
 */

/** One tool call as a provider reported it (`TurnSink.onToolUse`). */
export interface TurnToolCall { name: string; input: unknown }

/**
 * Tools that change files. Claude's own, plus the chip names other providers map theirs to (Codex `file_change` ->
 * Write/Edit/Delete, OpenCode `apply_patch`/`patch` -> ApplyPatch/Patch). ACP agents report a `kind` instead.
 */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ApplyPatch', 'Patch', 'Delete']);

const CHECK_COMMAND = /\b(test|vitest|jest|pytest|tsc|build|lint|eslint|cargo (test|check)|go test)\b/;
const SCRIPT_COMMAND = /\b(npm run|pnpm)\b/;

function obj(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

export function isWriteCall(c: TurnToolCall): boolean {
  return WRITE_TOOLS.has(c.name) || obj(c.input).kind === 'edit' || obj(c.input).kind === 'delete';
}

/** The shell command of a Bash call (Claude, Codex, OpenCode) or an ACP `execute`, else null. */
function commandOf(c: TurnToolCall): string | null {
  const i = obj(c.input);
  if (c.name !== 'Bash' && i.kind !== 'execute') return null;
  const cmd = i.command ?? obj(i.rawInput).command;
  if (typeof cmd === 'string') return cmd;
  if (Array.isArray(cmd)) return cmd.map(String).join(' ');
  return null;
}

export function isVerifyCall(c: TurnToolCall): boolean {
  if (c.name.toLowerCase().includes('screenshot')) return true;
  const cmd = commandOf(c);
  return cmd !== null && (CHECK_COMMAND.test(cmd) || SCRIPT_COMMAND.test(cmd));
}

/** The files a write call names, for the count in the reason. */
function pathsOf(c: TurnToolCall): string[] {
  const i = obj(c.input);
  const one = [i.file_path, i.notebook_path, i.path, i.filePath].filter((p): p is string => typeof p === 'string');
  const many = Array.isArray(i.paths) ? i.paths.filter((p): p is string => typeof p === 'string') : [];
  return [...one, ...many];
}

/**
 * The turn's verification state: undefined when it changed no files or checked its work after the last change,
 * otherwise `unverified` with a reason that counts the files it changed.
 */
export function classifyVerification(calls: readonly TurnToolCall[]): MessageVerification | undefined {
  let lastWrite = -1;
  for (let i = 0; i < calls.length; i++) if (isWriteCall(calls[i])) lastWrite = i;
  if (lastWrite < 0) return undefined;
  if (calls.slice(lastWrite + 1).some(isVerifyCall)) return undefined;
  const writes = calls.filter(isWriteCall);
  const files = new Set(writes.flatMap(pathsOf));
  const n = files.size || writes.length;
  return { state: 'unverified', reason: 'edited ' + n + (n === 1 ? ' file' : ' files') + ', ran no test/build/screenshot after' };
}
