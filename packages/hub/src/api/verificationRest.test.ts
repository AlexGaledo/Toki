import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proveItRequest, type Bot, type Message, type Room } from '@pocketrocket/shared';
import { events } from '../events.js';
import { createHub, type Hub } from '../hub.js';

let hub: Hub;
let base: string;
beforeAll(async () => {
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: null });
  base = 'http://127.0.0.1:' + (await hub.listen());
});
afterAll(async () => { await hub.shutdown(); });

async function api<T>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as T };
}

async function unverifiedReply(handle: string) {
  const bot = (await api<Bot>('POST', '/api/bots', { name: handle, handle })).body;
  const room = (await api<Room>('POST', '/api/rooms', { kind: 'dm', name: handle, memberIds: [bot.id] })).body;
  const msg = hub.repos.insertMessage({
    roomId: room.id, authorType: 'bot', authorId: bot.id, kind: 'text', text: 'Done, the button is blue now.',
    payload: { verification: { state: 'unverified', reason: 'Edited 1 file and ran no test, build or screenshot after.' } },
    causeId: null, hop: 0, turnId: null,
  });
  return { bot, room, msg };
}

const verification = (m: Message | undefined) => (m?.payload as { verification?: { resolved?: string } } | null)?.verification;

describe('answering an unverified reply', () => {
  it('asking sends the prove-it request as the owner and records the answer', async () => {
    const { bot, room, msg } = await unverifiedReply('prover');
    await api('POST', '/api/maintenance/hold', { minutes: 5 });
    const updates: string[] = [];
    const off = events.onEvent((e) => { if (e.type === 'message.update' && e.id === msg.id) updates.push(msg.id); });
    const r = await api<{ resolved: string }>('POST', '/api/messages/' + msg.id + '/verification', { resolved: 'asked' });
    off();
    await api('POST', '/api/maintenance/release', {});
    expect(r).toMatchObject({ status: 200, body: { resolved: 'asked' } });
    expect(updates).toEqual([msg.id]);
    expect(verification(hub.repos.getMessage(msg.id))?.resolved).toBe('asked');
    const owner = hub.repos.listMessages(room.id, { limit: 50 }).filter((m) => m.authorType === 'user');
    expect(owner.map((m) => m.text)).toEqual([proveItRequest(bot.handle)]);
  });

  it('accepting records the answer and sends nothing', async () => {
    const { room, msg } = await unverifiedReply('acceptor');
    expect((await api('POST', '/api/messages/' + msg.id + '/verification', { resolved: 'accepted' })).status).toBe(200);
    expect(verification(hub.repos.getMessage(msg.id))?.resolved).toBe('accepted');
    expect(hub.repos.listMessages(room.id, { limit: 50 }).filter((m) => m.authorType === 'user')).toEqual([]);
  });

  it('answers once, only for unverified replies, and validates the answer', async () => {
    const { room, msg } = await unverifiedReply('once');
    expect((await api('POST', '/api/messages/' + msg.id + '/verification', { resolved: 'accepted' })).status).toBe(200);
    expect((await api('POST', '/api/messages/' + msg.id + '/verification', { resolved: 'asked' })).status).toBe(409);
    expect((await api('POST', '/api/messages/' + msg.id + '/verification', { resolved: 'maybe' })).status).toBe(400);
    expect((await api('POST', '/api/messages/nope/verification', { resolved: 'asked' })).status).toBe(404);
    const plain = hub.repos.insertMessage({ roomId: room.id, authorType: 'user', authorId: null, kind: 'text', text: 'hi', payload: null, causeId: null, hop: 0, turnId: null });
    expect((await api('POST', '/api/messages/' + plain.id + '/verification', { resolved: 'asked' })).status).toBe(400);
  });
});
