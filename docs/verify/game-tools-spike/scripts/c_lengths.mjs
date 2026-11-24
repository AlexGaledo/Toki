// (c) Lengths of real execute_luau / multi_edit inputs from local Claude Code transcripts.
// Prints only sizes and tool names, never the code. Usage: node c_lengths.mjs <file-list> <projectsDir>
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const [list, base] = process.argv.slice(2);
const files = fs.readFileSync(list, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const rows = [];
for (const f of files) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(base, f)) });
  for await (const line of rl) {
    if (!/__(execute_luau|multi_edit)"/.test(line)) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const content = j?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== 'tool_use' || !/__(execute_luau|multi_edit)$/.test(b.name)) continue;
      const json = JSON.stringify(b.input ?? {});
      rows.push({ tool: b.name.replace(/^mcp__/, ''), jsonChars: json.length, at: j.timestamp ?? '' });
    }
  }
}
rows.sort((a, b) => (a.at < b.at ? 1 : -1));
const lim = 8000;
const pick = rows; // all, newest first
console.log(`calls found: ${rows.length} in ${files.length} transcripts`);
for (const r of pick) console.log(`${r.at.slice(0, 19)}  ${r.tool.padEnd(40)} input JSON ${String(r.jsonChars).padStart(6)} chars${r.jsonChars > lim ? '  > 8000 (hub refuses)' : ''}`);
const s = rows.map((r) => r.jsonChars).sort((a, b) => a - b);
const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
if (s.length) console.log(`min ${s[0]}  median ${q(0.5)}  p90 ${q(0.9)}  max ${s.at(-1)}  over 8000: ${s.filter((x) => x > lim).length}  over 32000: ${s.filter((x) => x > 32000).length}`);
