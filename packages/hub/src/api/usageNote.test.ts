import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { SHARED_SUBSCRIPTION_NOTE } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';

// B11 through the real hub: GET /api/usage carries the note once PUT /api/hosts/server/projects has run.
const TOKEN = 'usage-note-test-token';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-usagenote-'));
let hub: Hub;
let port: number;
beforeAll(async () => {
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, projectsDir: path.join(tmp, 'projects'), roomsDir: path.join(tmp, 'rooms') });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function request(method: string, p: string, body?: unknown) {
  const headers = { host: '127.0.0.1:' + port, 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the helper reads whatever JSON the route replies with
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe('GET /api/usage subscriptionNote', () => {
  it('NEGATIVE: absent while no server host is known', async () => {
    const r = await request('GET', '/api/usage');
    expect(r.status).toBe(200);
    expect(r.json).not.toHaveProperty('subscriptionNote');
  });

  it('present once the desktop app has reported the server, even while it is disconnected', async () => {
    expect((await request('PUT', '/api/hosts/server/projects', { connected: false })).status).toBe(200);
    expect((await request('GET', '/api/usage')).json.subscriptionNote).toBe(SHARED_SUBSCRIPTION_NOTE);
  });
});
