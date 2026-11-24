// B12 live proof: Toki's BlenderHost + the real MCP server (mcp-for-blender==2.3.1) + a real headless Blender.
// Run from packages/hub:  npx tsx ../../docs/verify/b12/scripts/live_b12.ts <tmpData> <outDir> <pinnedEnvDir>
// <pinnedEnvDir> is the mcp-for-blender 2.3.1 venv (B6 is not built yet, so the spike's uv cache env is linked in).
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [data, outDir, pinned] = process.argv.slice(2) as [string, string, string];
process.env.POCKETROCKET_DATA = data;
fs.mkdirSync(outDir, { recursive: true });
const toolsRoot = path.join(data, 'tools', 'blender-mcp', '2.3.1');
fs.mkdirSync(path.dirname(toolsRoot), { recursive: true });
if (!fs.existsSync(toolsRoot)) fs.symlinkSync(path.resolve(pinned), toolsRoot, 'junction');

const { BlenderHost, findBlenderExe, listBlenders } = await import('../../../../packages/hub/src/services/BlenderHost.ts');
const { baseChildEnv } = await import('../../../../packages/hub/src/providers/env.ts');
const req = createRequire(path.join(process.cwd(), 'package.json'));
const { Client } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);

const lines: string[] = [];
const out = (s: string) => { lines.push(s); console.log(s); };
const t0 = performance.now();
const ts = () => ((performance.now() - t0) / 1000).toFixed(2).padStart(7) + 's ';
// The throwaway data dir shows as <data>, also where JSON doubled its backslashes.
const dataAbs = path.resolve(data);
const save = () => fs.writeFileSync(path.join(outDir, 'live-run.txt'),
  lines.join('\n').split(dataAbs.replaceAll('\\', '\\\\')).join('<data>').split(dataAbs).join('<data>') + '\n');

const before = await listBlenders();
out(ts() + 'blender.exe before start: ' + JSON.stringify(before));
if (before.length) { out('another Blender is running: live proof skipped'); save(); process.exit(2); }

const exe = findBlenderExe()!;
const script = path.resolve('resources/blender/toki_blender_server.py');
const host = new BlenderHost({ dataDir: data, exe: () => exe, script, idleMs: () => 15_000, log: (l: string) => out(ts() + l) });
const project = { slug: 'b12-proof', dir: path.join(data, 'projects', 'b12-proof') };

// Sample the working set the way Task Manager shows it (tasklist), as a cross-check of the script's own peak.
let sampledPeak = 0;
const titles = new Set<string>();
const sampler = setInterval(() => {
  const s = host.status();
  if (s.state === 'stopped' || !s.pid) return;
  execFile('tasklist', ['/FI', 'PID eq ' + s.pid, '/FO', 'CSV', '/NH', '/V'], { windowsHide: true }, (_e, o) => {
    const cols = String(o).trim().split('","').map((c) => c.replace(/^"|"$/g, ''));
    if (cols.length < 9 || cols[0]!.toLowerCase() !== 'blender.exe') return;
    sampledPeak = Math.max(sampledPeak, Number(cols[4]!.replace(/[^\d]/g, '')) * 1024);
    titles.add(cols[8]!);
  });
}, 500);

// 1. The MCP server first, before Blender listens.
const entry = (await host.mcpEntry())!;
out(ts() + 'mcp entry: ' + JSON.stringify({ ...entry, command: '<data>/tools/blender-mcp/2.3.1/Scripts/' + path.basename(entry.command) }));
const stderr: string[] = [];
const transport = new StdioClientTransport({
  command: entry.command, args: entry.args, env: { ...baseChildEnv(), ...entry.env } as Record<string, string>, stderr: 'pipe',
});
transport.stderr?.on('data', (d: Buffer) => stderr.push(...String(d).split(/\r?\n/).filter(Boolean)));
const client = new Client({ name: 'toki-b12-proof', version: '0.0.0' });
await client.connect(transport);
const tools = await client.listTools();
out(ts() + 'MCP server up while Blender is NOT running: ' + tools.tools.length + ' tools listed');

async function call(name: string, args: Record<string, unknown>) {
  // What the PreToolUse hook does first for a blender tool.
  const down = await host.ensure(project);
  if (down) { out(ts() + name + ' REFUSED by ensure: ' + down); return null; }
  const s = performance.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const parts = (r.content ?? []).map((c: { type: string; text?: string; data?: string; mimeType?: string }, i: number) => {
    if (c.type === 'image') {
      const f = path.join(outDir, 'b12-look-' + i + '.png');
      fs.writeFileSync(f, Buffer.from(c.data!, 'base64'));
      return '[image ' + c.mimeType + ' ' + Buffer.from(c.data!, 'base64').length + ' bytes -> ' + path.basename(f) + ']';
    }
    return c.type === 'text' ? c.text!.replace(/\s+/g, ' ').slice(0, 400) : '[' + c.type + ']';
  });
  out(ts() + name + ' ' + ((performance.now() - s) / 1000).toFixed(2) + 's isError=' + !!r.isError + ': ' + parts.join(' | '));
  return r;
}

const COUNT = [
  'import bpy',
  "print('COUNTS', {'scenes': len(bpy.data.scenes), 'objects': len(bpy.data.objects), 'meshes': len(bpy.data.meshes), 'materials': len(bpy.data.materials)}, sorted(o.name for o in bpy.data.objects))",
  "print('MATERIALS', sorted((m.name, m.users, m.use_fake_user) for m in bpy.data.materials))",
  "print('FAKE_USERS', sorted(b.name for c in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.scenes) for b in c if b.use_fake_user))",
].join('\n');

await call('get_scene_info', {});
const listening = execFileSync('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, encoding: 'utf8' }).split(/\r?\n/).filter((l) => /LISTENING/.test(l));
out(ts() + 'listening on :9876: ' + JSON.stringify(listening.filter((l) => /:9876\s/.test(l)).map((l) => l.trim())));
out(ts() + 'listening on :' + entry.env.BLENDER_PORT + ': ' + JSON.stringify(listening.filter((l) => l.includes(':' + entry.env.BLENDER_PORT + ' ')).map((l) => l.trim().replace(/\s+/g, ' '))));
await call('execute_blender_code', {
  code: [
    'import bpy',
    'bpy.ops.mesh.primitive_cube_add(size=1.2, location=(1.8, 0.4, 0.6))',
    'cube = bpy.context.active_object',
    "cube.name = 'TokiCube'",
    "mat = bpy.data.materials.new('TokiRed')",
    'mat.diffuse_color = (0.9, 0.1, 0.1, 1.0)',
    'cube.data.materials.append(mat)',
    "print('engine', bpy.context.scene.render.engine)",
    "print('saved to', toki_save())",
  ].join('\n'),
});
await call('look', { mode: 'camera', shading: 'rendered', max_size: 512 });
const sv = host.status();
if (sv.state !== 'stopped' && sv.pid) {
  const w = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('../../docs/verify/b12/scripts/visible_windows.ps1'), String(sv.pid)], { windowsHide: true, encoding: 'utf8' });
  out(ts() + 'after the rendered look, ' + w.trim().split(/\r?\n/).join(' ; '));
}
await call('execute_blender_code', { code: COUNT });

// 2. A crash: kill Toki's own Blender, then the next call restarts it on the same port, from the saved file.
const s1 = host.status();
const peakAtKill = s1.state !== 'stopped' ? s1.peakBytes : 0;
if (s1.state !== 'stopped' && s1.pid) {
  out(ts() + "killing Toki's own Blender pid " + s1.pid + ' to simulate a crash');
  execFileSync('taskkill', ['/PID', String(s1.pid), '/F'], { windowsHide: true });
}
await new Promise((r) => setTimeout(r, 1500));
out(ts() + 'status after kill: ' + JSON.stringify(host.status()).slice(0, 160));
const said = (x: Awaited<ReturnType<typeof call>>) => JSON.stringify(x?.content ?? '');
const first = await call('execute_blender_code', { code: COUNT });
if (/Connection to Blender lost/.test(said(first))) {
  out(ts() + 'first call after the restart errored; retrying once');
  await call('execute_blender_code', { code: COUNT });
}

// 3. Idle stop (15 s here; 10 min in the hub). The script saves first.
out(ts() + 'waiting for the idle stop');
while (host.status().state !== 'stopped') await new Promise((res) => setTimeout(res, 500));
clearInterval(sampler);
await client.close();
out(ts() + 'idle-stopped: ' + JSON.stringify(host.status()).slice(0, 200));

// 4. Reopen art/<slug>.blend in a fresh -b process and count.
const blend = host.blendPath(project);
out(ts() + 'saved file: <data>/projects/b12-proof/art/' + path.basename(blend) + ' (' + fs.statSync(blend).size + ' bytes)');
const reopen = await new Promise<string>((res) => {
  const c = spawn(exe, ['-b', '--factory-startup', blend, '--python-exit-code', '1', '--python-expr', COUNT], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let o = '';
  c.stdout.on('data', (d) => (o += d));
  c.stderr.on('data', (d) => (o += d));
  c.on('exit', (code) => res(o + '\nexit ' + code));
});
out(ts() + 'reopened in a fresh -b process: ' + (reopen.split(/\r?\n/).filter((l) => /^(COUNTS|MATERIALS|FAKE_USERS)/.test(l)).join(' ; ') || '(no COUNTS line)\n' + reopen.slice(-800)));
const factory = await new Promise<string>((res) => {
  const c = spawn(exe, ['-b', '--factory-startup', '--python-exit-code', '1', '--python-expr', COUNT], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let o = '';
  c.stdout.on('data', (d) => (o += d));
  c.on('exit', () => res(o));
});
out(ts() + 'factory scene, for reference: ' + factory.split(/\r?\n/).filter((l) => /^(COUNTS|MATERIALS)/.test(l)).join(' ; '));
out(ts() + 'peak working set: script-reported ' + (peakAtKill / 1048576).toFixed(0) + ' MB (first process, at kill), '
  + (host.status().state === 'stopped' ? ((host.status() as { lastPeakBytes: number | null }).lastPeakBytes ?? 0) / 1048576 : 0).toFixed(0)
  + ' MB (restarted process); tasklist-sampled max ' + (sampledPeak / 1048576).toFixed(0) + ' MB');
out(ts() + 'window titles tasklist saw for Toki\'s Blender: ' + JSON.stringify([...titles]));
out(ts() + 'blender.exe after: ' + JSON.stringify(await listBlenders()));
out('--- MCP server stderr lines about the Blender connection ---');
for (const l of stderr.filter((x) => /connect|Blender/i.test(x)).slice(0, 20)) out(l.replace(/^\S+ \S+ - /, ''));
save();
