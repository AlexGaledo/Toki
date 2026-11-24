// Poll 127.0.0.1:9876 until the Blender add-on answers a "ping" command, then ask for get_scene_info.
// Usage: node ping9876.mjs <startEpochMs> [timeoutMs]
import net from 'node:net';

const start = Number(process.argv[2]) || Date.now();
const timeout = Number(process.argv[3]) || 90_000;
const send = (cmd) => new Promise((resolve, reject) => {
  const s = net.connect(9876, '127.0.0.1');
  let buf = '';
  s.setTimeout(10_000, () => { s.destroy(); reject(new Error('timeout')); });
  s.on('connect', () => s.write(JSON.stringify(cmd)));
  s.on('data', (d) => {
    buf += d;
    try { const j = JSON.parse(buf); s.end(); resolve(j); } catch { /* wait for more */ }
  });
  s.on('error', reject);
});

let attempts = 0;
for (;;) {
  attempts++;
  try {
    const pong = await send({ type: 'ping', params: {} });
    const t = Date.now() - start;
    console.log(`first answer after ${(t / 1000).toFixed(1)}s (attempt ${attempts}): ${JSON.stringify(pong)}`);
    const info = await send({ type: 'get_scene_info', params: {} });
    console.log('get_scene_info: ' + JSON.stringify(info).slice(0, 400));
    process.exit(0);
  } catch (e) {
    if (Date.now() - start > timeout) { console.log(`no answer within ${timeout / 1000}s (${attempts} attempts), last error: ${e.code ?? e.message}`); process.exit(1); }
    await new Promise((r) => setTimeout(r, 500));
  }
}
