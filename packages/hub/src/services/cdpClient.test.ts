import { describe, expect, it } from 'vitest';
import { browserWsUrl } from './cdpClient.js';

const aborted = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

describe('browserWsUrl', () => {
  it('asks again when a busy browser times out, and pins the loopback host and port', async () => {
    let calls = 0;
    const url = await browserWsUrl('http://127.0.0.1:9333', async () => {
      calls++;
      if (calls < 3) throw aborted();
      return { webSocketDebuggerUrl: 'ws://localhost:1/devtools/browser/x' };
    });
    expect(calls).toBe(3);
    expect(url).toBe('ws://127.0.0.1:9333/devtools/browser/x');
  });

  it('gives up after three timeouts', async () => {
    let calls = 0;
    await expect(browserWsUrl('http://127.0.0.1:9333', async () => { calls++; throw aborted(); })).rejects.toThrow('aborted');
    expect(calls).toBe(3);
  });

  it('fails at once when nothing is listening', async () => {
    let calls = 0;
    await expect(browserWsUrl('http://127.0.0.1:9333', async () => { calls++; throw new Error('connect ECONNREFUSED'); })).rejects.toThrow('ECONNREFUSED');
    expect(calls).toBe(1);
  });
});
