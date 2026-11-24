// Start StudioMCP.exe over stdio, ask tools/list, print multi_edit's schema and every tool name. Studio need not be open.
import { spawn } from 'node:child_process';
const exe = 'C:/Users/alex/AppData/Local/Roblox/Versions/version-8d7a1009c17e4ff8/StudioMCP.exe';
const p = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
const done = (code) => { try { p.kill(); } catch {} process.exit(code); };
setTimeout(() => { console.log('timeout; stderr/partial:', buf.slice(0, 500)); done(2); }, 20000);
p.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); console.log('server: ' + JSON.stringify(m.result?.serverInfo)); }
    if (m.id === 2) {
      const tools = m.result?.tools ?? [];
      console.log('tools (' + tools.length + '): ' + tools.map((t) => t.name).join(', '));
      for (const t of tools.filter((t) => /edit|script/i.test(t.name))) console.log('\n## ' + t.name + '\n' + (t.description ?? '') + '\n' + JSON.stringify(t.inputSchema, null, 2));
      done(0);
    }
  }
});
p.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d.toString('utf8').slice(0, 300)));
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'schema-probe', version: '0' } } });
