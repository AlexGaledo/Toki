import { MAX_ATTACHMENT_IMAGE_BYTES } from '@pocketrocket/shared';
import { STUDIO_SERVER } from '../api/gameTools.js';
import { MediaRejected, type MediaStore } from '../services/MediaStore.js';
import type { OutsideMcpServer } from '../services/outsideMcp.js';
import type { ToolResultImage } from '../providers/types.js';

/**
 * B9 look-backs (spec toki-local-first-gamedev §3): the picture a game tool returns (`look`, `screen_capture`) is kept
 * in the media store and shown on that tool's message. Only for a game room's built-in servers: Toki's own `blender`
 * entry and the Studio recipe. Any other server's images stay out of the media store.
 */
export function lookBackServers(o: { game: boolean; blender: OutsideMcpServer | null; mounted: readonly OutsideMcpServer[] }): Set<string> {
  const names = new Set<string>();
  if (!o.game) return names;
  if (o.blender && o.mounted.includes(o.blender)) names.add(o.blender.name);
  if (o.mounted.some((s) => s.name === STUDIO_SERVER)) names.add(STUDIO_SERVER);
  return names;
}

export function isLookBackTool(toolName: string, servers: ReadonlySet<string>): boolean {
  for (const s of servers) if (toolName.startsWith('mcp__' + s + '__')) return true;
  return false;
}

/** The Claude CLI names its own copy of the image (under ~/.claude/.../tool-results) in a text block. It never reaches chat. */
const CLI_IMAGE_PATH = /\[Image: source: [^\]\r\n]*\][ \t]*(\r?\n)?/g;

export function stripCliImagePaths(output: string): string {
  return output.replace(CLI_IMAGE_PATH, '');
}

/** The media ref, or null when the image is too large or not a PNG, JPEG or WebP. Same cap as a picture the owner attaches. */
export function storeLookBack(media: MediaStore, image: ToolResultImage): string | null {
  if (Math.floor(image.data.length / 4) * 3 > MAX_ATTACHMENT_IMAGE_BYTES + 3) return null;
  try {
    return media.put(Buffer.from(image.data, 'base64'), MAX_ATTACHMENT_IMAGE_BYTES);
  } catch (e) {
    if (e instanceof MediaRejected) return null;
    throw e;
  }
}
