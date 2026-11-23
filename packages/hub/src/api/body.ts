import type { IncomingMessage } from 'node:http';

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_WS_BYTES = 256 * 1024;

export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const c of req) {
    const buf = c as Buffer;
    size += buf.length;
    if (size > limit) {
      over = true;
      if (size > limit * 8) {
        req.destroy();
        return null;
      }
      continue;
    }
    chunks.push(buf);
  }
  return over ? null : Buffer.concat(chunks);
}
