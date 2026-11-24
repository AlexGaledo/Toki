// (f2) Drive the real blender MCP server (uvx mcp-for-blender==2.3.1, stdio) against a headless Blender on BLENDER_PORT.
// Usage (from the worktree root so the SDK resolves): node f2_client.mjs <port> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const req = createRequire(path.join(process.cwd(), 'packages', 'hub', 'package.json'));
const { Client } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);

const [port, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const uvx = 'C:\\Users\\alex\\AppData\\Local\\Programs\\Python\\Python313\\Scripts\\uvx.exe';
const t = () => performance.now();
const t0 = t();
const transport = new StdioClientTransport({
  command: uvx, args: ['mcp-for-blender==2.3.1'],
  env: { ...process.env, BLENDER_PORT: String(port), BLENDER_HOST: '127.0.0.1', DISABLE_TELEMETRY: 'true' },
  stderr: 'pipe',
});
const client = new Client({ name: 'toki-spike', version: '0.0.0' });
await client.connect(transport);
console.log(`connected in ${((t() - t0) / 1000).toFixed(2)}s`);

let n = 0;
async function call(name, args) {
  n++;
  const s = t();
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    const ms = t() - s;
    const parts = (r.content ?? []).map((c, i) => {
      if (c.type === 'image') {
        const f = path.join(outDir, `${n}-${name}-${i}.${c.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`);
        fs.writeFileSync(f, Buffer.from(c.data, 'base64'));
        return `[image ${c.mimeType} ${Buffer.from(c.data, 'base64').length} bytes -> ${path.basename(f)}]`;
      }
      return c.type === 'text' ? c.text.slice(0, 300).replace(/\s+/g, ' ') : `[${c.type}]`;
    });
    console.log(`${name} ${(ms / 1000).toFixed(2)}s isError=${!!r.isError}: ${parts.join(' | ')}`);
  } catch (e) {
    console.log(`${name} ${((t() - s) / 1000).toFixed(2)}s THREW: ${e.message.slice(0, 300)}`);
  }
}

await call('get_scene_info', {});
await call('execute_blender_code', { code: "import bpy\nbpy.ops.mesh.primitive_monkey_add(location=(0,0,1))\nprint('monkey', len(bpy.data.objects))" });
await call('execute_blender_code', { code: "import bpy\nprint('objects', [o.name for o in bpy.data.objects])" });
await call('look', { mode: 'camera', shading: 'rendered', max_size: 512 });
await call('look', { mode: 'camera', shading: 'solid', max_size: 512 });
await call('look', {});
await client.close();
console.log(`total ${((t() - t0) / 1000).toFixed(2)}s`);
