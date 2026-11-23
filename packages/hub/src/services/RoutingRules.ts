import fs from 'node:fs';
import { MAX_ROUTING_BYTES } from '@pocketrocket/shared';
import { ROUTING_PATH } from '../config.js';

export const DEFAULT_ROUTING = `<!-- Your routing rules. Bots read them on every turn and can only propose edits. Keep them under 2 KB. -->
- Do the work yourself unless another bot clearly owns it.
- Move up to a stronger model for multi-step design, hard debugging, or work that is costly to get wrong.
`;

export class RoutingRules {
  constructor(private file: string = ROUTING_PATH) {}

  ensureSeeded() {
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, DEFAULT_ROUTING);
  }
  read(): string {
    try {
      return fs.readFileSync(this.file, 'utf8');
    } catch {
      return DEFAULT_ROUTING;
    }
  }
  promptText(): string {
    const text = this.read().replace(/<!--[\s\S]*?-->/g, '').trim();
    const raw = Buffer.from(text, 'utf8');
    if (raw.length <= MAX_ROUTING_BYTES) return text;
    return raw.subarray(0, MAX_ROUTING_BYTES).toString('utf8').replace(/\uFFFD+$/, '').trim();
  }
  write(text: string) {
    if (Buffer.byteLength(text, 'utf8') > MAX_ROUTING_BYTES) throw new Error('Routing rules are limited to ' + MAX_ROUTING_BYTES + ' bytes');
    fs.writeFileSync(this.file, text);
  }
  withLine(line: string): string {
    const text = this.read().replace(/\s*$/, '') + '\n- ' + line + '\n';
    if (Buffer.byteLength(text, 'utf8') > MAX_ROUTING_BYTES) throw new Error('Routing rules are full (' + MAX_ROUTING_BYTES + ' bytes)');
    return text;
  }
}
