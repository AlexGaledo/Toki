import { ROUTING_PATH } from '../config.js';
import { bashWritesReadOnly } from './bashRules.js';
import { isInside, pathsFromInput } from './pathRules.js';
import { denyMessage } from './messages.js';

export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;
export const READ_ONLY_GUARD_TOOLS = [...WRITE_TOOLS, 'Bash'] as const;

/**
 * The owner's routing rules redirect work between bots with different logins, so no bot may write them: refused
 * outright in every approvals mode, with no card to say yes on. Returns the refusal, or null. A shell command is
 * judged by what its command line shows (`bashWritesReadOnly`); like every Bash rule here it is not a sandbox.
 */
export function routingFileWrite(toolName: string, input: Record<string, unknown>, cwd: string): string | null {
  const hit = toolName === 'Bash'
    ? !!bashWritesReadOnly(String(input.command ?? ''), cwd, [ROUTING_PATH])
    : (WRITE_TOOLS as readonly string[]).includes(toolName) && pathsFromInput(toolName, input).some((p) => isInside(p, [ROUTING_PATH], cwd));
  return hit ? denyMessage('not_allowed', { subject: 'writing routing.md', note: 'it belongs to the owner', alt: 'use propose_routing_change to suggest a line' }) : null;
}

export function readOnlyWriteDecision(
  toolName: string,
  input: Record<string, unknown>,
  readOnlyRoots: string[],
  cwd: string,
  bypass: boolean,
): { decision: 'ask' | 'deny'; reason: string } | null {
  if (!readOnlyRoots.length) return null;
  if (toolName === 'Bash') {
    const hit = bashWritesReadOnly(String(input.command ?? ''), cwd, readOnlyRoots);
    if (!hit) return null;
    return bypass
      ? { decision: 'deny', reason: denyMessage('not_allowed', { subject: 'this shell command', note: 'that folder is read-only for you (the knowledge repo, or a project folder outside this room) and it writes there: ' + hit, alt: 'write inside your own workspace instead, or say so in the room' }) }
      : { decision: 'ask', reason: 'Shell write into a read-only folder: ' + hit };
  }
  if (!(WRITE_TOOLS as readonly string[]).includes(toolName)) return null;
  const hits = pathsFromInput(toolName, input).filter((p) => isInside(p, readOnlyRoots, cwd));
  if (!hits.length) return null;
  return bypass
    ? { decision: 'deny', reason: denyMessage('not_allowed', { subject: toolName, note: 'that folder is read-only for you (the knowledge repo, or a project folder outside this room): ' + hits.join(', '), alt: 'write inside your own workspace instead, or say so in the room' }) }
    : { decision: 'ask', reason: toolName + ' into a read-only folder: ' + hits.join(', ') };
}
