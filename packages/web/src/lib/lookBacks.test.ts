import { describe, expect, it } from 'vitest';
import type { Message, ToolPayload } from '@pocketrocket/shared';
import { lookBackAlt, lookBacksOf } from './lookBacks';

const IMG = 'img:' + 'a'.repeat(64);
const IMG2 = 'img:' + 'b'.repeat(64);
const FILE = 'file:' + 'c'.repeat(64);

const tool = (id: string, name: string, attachments?: string[]): Message => ({
  id, roomId: 'r1', seq: 1, authorType: 'bot', authorId: 'b1', kind: 'tool', text: '',
  payload: { toolUseId: 'u-' + id, name, input: {}, done: true } as ToolPayload,
  causeId: null, hop: 0, turnId: 't1', createdAt: 1, ...(attachments ? { attachments } : {}),
});

describe('lookBacksOf', () => {
  it('takes the picture a message.update attached to a tool message', () => {
    expect(lookBacksOf([tool('m1', 'mcp__blender__look', [IMG])])).toEqual([
      { messageId: 'm1', ref: IMG, alt: 'Look-back from blender: look' },
    ]);
  });

  it('keeps one per tool message, in order, and skips files and bad refs', () => {
    const got = lookBacksOf([
      tool('m1', 'mcp__blender__get_scene_info'),
      tool('m2', 'mcp__roblox-studio__screen_capture', [FILE, IMG2, IMG]),
      tool('m3', 'mcp__blender__look', ['img:not-a-hash', FILE]),
      tool('m4', 'mcp__blender__look', [IMG]),
    ]);
    expect(got.map((l) => [l.messageId, l.ref])).toEqual([['m2', IMG2], ['m4', IMG]]);
  });

  it('ignores pictures on text messages: those are the attachments the chat already shows', () => {
    const text: Message = { ...tool('m1', 'x', [IMG]), kind: 'text', payload: null };
    expect(lookBacksOf([text])).toEqual([]);
  });
});

describe('lookBackAlt', () => {
  it('names the server and the tool in words, never the picture', () => {
    expect(lookBackAlt('mcp__roblox-studio__screen_capture')).toBe('Look-back from roblox studio: screen capture');
    expect(lookBackAlt('mcp__blender__look')).toBe('Look-back from blender: look');
    expect(lookBackAlt('Screenshot')).toBe('Look-back from Screenshot');
  });
});
