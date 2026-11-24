import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Message, ToolPayload } from '@pocketrocket/shared';
import { lookBacksOf } from './lib/lookBacks';

let useStore: typeof import('./store')['useStore'];

beforeAll(async () => {
  // The store reads the window and storage on import.
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 }; };
  vi.stubGlobal('window', { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal('localStorage', mem());
  vi.stubGlobal('sessionStorage', mem());
  ({ useStore } = await import('./store'));
  vi.unstubAllGlobals();
}, 60_000);

describe('a look-back arriving through message.update (B9 -> D2)', () => {
  it('shows once the hub patches the finished tool message with its picture', () => {
    const running: ToolPayload = { toolUseId: 'u1', name: 'mcp__blender__look', input: { view: 'camera' }, done: false };
    const m: Message = { id: 't1', roomId: 'r1', seq: 1, authorType: 'bot', authorId: 'b1', kind: 'tool', text: '', payload: running, causeId: null, hop: 0, turnId: 'turn1', createdAt: 1 };
    useStore.setState({ messages: { r1: [] } });
    useStore.getState().applyEvent({ type: 'message.new', message: m });
    expect(lookBacksOf(useStore.getState().messages.r1 ?? [])).toEqual([]);

    // The exact patch BotRunner.onToolResult emits for a game tool's picture.
    const ref = 'img:' + 'f'.repeat(64);
    useStore.getState().applyEvent({ type: 'message.update', id: 't1', roomId: 'r1', patch: { payload: { ...running, output: 'Rendered.', done: true }, attachments: [ref] } });
    expect(lookBacksOf(useStore.getState().messages.r1 ?? [])).toEqual([{ messageId: 't1', ref, alt: 'Look-back from blender: look' }]);
  });
});
