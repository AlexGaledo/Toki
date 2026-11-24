import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { ToolResultImage, TurnContext, TurnSink } from './types.js';

// B9: the look-back image comes from the SDK message's tool_result block, never from the CLI's tool-results file.
let script: unknown[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: (_: { options: Options }) => ({
    async *[Symbol.asyncIterator]() { for (const m of script) yield m; },
    interrupt: async () => undefined,
    close: () => undefined,
  }),
}));
const { ClaudeProvider, firstImage } = await import('./claude.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-b9-claude-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SDK_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('the image the SDK carried')]);
// A decoy at the path the CLI names: if the hub read the file, it would get these bytes instead.
const cliFile = path.join(tmp, '.claude', 'projects', 'ws', 'sess', 'tool-results', 'mcp-blender-blob-1.png');
fs.mkdirSync(path.dirname(cliFile), { recursive: true });
fs.writeFileSync(cliFile, Buffer.concat([SDK_PNG.subarray(0, 8), Buffer.from('DECOY from the tool-results file')]));

function ctx(): TurnContext {
  return {
    turnId: 't1', bot: { id: 'b', handle: 'b', name: 'B', allowedTools: ['Read'] } as never, room: { id: 'r' } as never, members: [],
    systemPrompt: 'sys', input: 'hi', resumeToken: null, workspaceDir: tmp, botHome: tmp, tools: [],
    allowedBuiltins: ['Read'], permission: async () => 'allow', model: 'claude-sonnet-5', maxBudgetUsd: 2, maxTurns: 30,
    signal: new AbortController().signal, mcp: { url: '', token: '' },
  };
}
const toolResult = (content: unknown) => ({
  type: 'user', parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content }] },
});
const done = { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 1, result: 'ok', usage: {} };

async function run(content: unknown) {
  const seen: { output: string; image?: ToolResultImage }[] = [];
  const sink: TurnSink = {
    onSession: () => undefined, onDelta: () => undefined, onText: () => undefined, onToolUse: () => undefined, onState: () => undefined,
    onToolResult: (_id, output, _err, image) => { seen.push({ output, image }); },
  };
  script = [toolResult(content), done];
  await new ClaudeProvider().runTurn(ctx(), sink);
  return seen;
}

describe('tool_result images from the SDK message', () => {
  it('hands the runner the first base64 image block as the SDK carried it, not the tool-results file', async () => {
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const [r] = await run([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SDK_PNG.toString('base64') } },
      { type: 'text', text: '[Image: source: ' + cliFile + ']' },
      { type: 'text', text: "Through camera 'Camera'." },
    ]);
    expect(r!.image).toEqual({ mediaType: 'image/png', data: SDK_PNG.toString('base64') });
    expect(Buffer.from(r!.image!.data, 'base64').toString()).toContain('the image the SDK carried');
    expect(readSpy.mock.calls.map((c) => String(c[0])).filter((p) => p.includes('tool-results'))).toEqual([]);
    readSpy.mockRestore();
    // The provider still reports the text as before; the runner strips the path for look-back tools.
    expect(r!.output).toBe('[image]\n[Image: source: ' + cliFile + "]\nThrough camera 'Camera'.");
  });

  it('passes no image for a text-only or string result', async () => {
    expect((await run([{ type: 'text', text: 'ok' }]))[0]!.image).toBeUndefined();
    expect((await run('plain'))[0]!.image).toBeUndefined();
  });

  it('firstImage takes only the first base64 image, and ignores url sources and malformed blocks', () => {
    const a = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QQ==' } };
    const b = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'Qg==' } };
    expect(firstImage([a, b])).toEqual({ mediaType: 'image/png', data: 'QQ==' });
    expect(firstImage([{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }, b])).toEqual({ mediaType: 'image/jpeg', data: 'Qg==' });
    expect(firstImage([{ type: 'image' }, { type: 'image', source: { type: 'base64', data: 1 } }, null])).toBeUndefined();
    expect(firstImage('text')).toBeUndefined();
  });
});
