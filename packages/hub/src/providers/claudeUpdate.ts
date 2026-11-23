import { execFile } from 'node:child_process';
import { CLAUDE_EXE } from '../config.js';
import { childEnv } from './env.js';

const OUTDATED_RE = /does not support this model; version \S+ or newer is required/i;

export function isOutdatedCliError(text: string | undefined): boolean {
  return !!text && OUTDATED_RE.test(text);
}

export interface CliUpdateResult {
  ok: boolean;
  output: string;
}

const REUSE_MS = 2 * 60_000;
let inflight: Promise<CliUpdateResult> | null = null;
let last: { at: number; result: CliUpdateResult } | null = null;

export function updateClaudeCli(): Promise<CliUpdateResult> {
  if (inflight) return inflight;
  if (last && Date.now() - last.at < REUSE_MS) return Promise.resolve(last.result);
  inflight = new Promise<CliUpdateResult>((resolve) => {
    const child = execFile(
      CLAUDE_EXE, ['update'],
      { timeout: 180_000, windowsHide: true, env: childEnv('claude') },
      (err, stdout, stderr) => resolve({ ok: !err, output: (String(stdout) + '\n' + String(stderr)).trim() }),
    );
    child.on('error', (e) => resolve({ ok: false, output: e.message }));
  }).then((result) => {
    last = { at: Date.now(), result };
    inflight = null;
    if (process.env.POCKETROCKET_DEBUG) console.log('[claude update]', result.ok ? 'ok' : 'failed', result.output);
    return result;
  });
  return inflight;
}
