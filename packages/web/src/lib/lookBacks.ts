import { isMediaRef, type Message, type ToolPayload } from '@pocketrocket/shared';

/** One look-back (B9): the picture a game tool returned, kept on its tool message as `img:<sha256>`. */
export interface LookBack {
  messageId: string;
  ref: string;
  alt: string;
}

/**
 * Alt text from the tool's name, never from the picture or the tool's output:
 * `mcp__blender__look` → "Look-back from blender: look".
 */
export function lookBackAlt(toolName: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  const [server, tool] = m ? [m[1], m[2]] : [null, toolName];
  const words = (s: string) => s.replace(/[_-]+/g, ' ').trim();
  return 'Look-back from ' + (server ? words(server) + ': ' : '') + (words(tool) || 'a tool');
}

/** The first picture of each tool message, in order. Files and anything that is not a media ref are skipped. */
export function lookBacksOf(items: readonly Message[]): LookBack[] {
  const out: LookBack[] = [];
  for (const m of items) {
    if (m.kind !== 'tool' || !m.payload) continue;
    const ref = m.attachments?.find(isMediaRef);
    if (ref) out.push({ messageId: m.id, ref, alt: lookBackAlt((m.payload as ToolPayload).name) });
  }
  return out;
}
