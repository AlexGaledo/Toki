import path from 'node:path';
import { CLAUDE_EXE, DATA_DIR, KNOWLEDGE_DIR, PROJECTS_DIR, ROOMS_DIR, WORKSPACE_DIR, botHome, computerFilesDir } from './config.js';
import { prepareSandbox } from './providers/sandbox.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  process.stderr.write(msg + '\n');
  process.exit(2);
}

if (process.argv[2] !== 'print-argv') fail('usage: sandboxCli print-argv --bot <botId> [--project <slug>] [--room <roomId>]');
const bot = arg('bot');
if (!bot || !SAFE_ID.test(bot)) fail('--bot <botId> is required');
const project = arg('project');
const room = arg('room');
if (project && !SAFE_ID.test(project)) fail('bad --project');
if (room && !SAFE_ID.test(room)) fail('bad --room');

const writable = [
  ...(project ? [path.join(PROJECTS_DIR, project)] : []),
  ...(room ? [path.join(ROOMS_DIR, room)] : []),
  computerFilesDir(bot),
];
const { argv } = prepareSandbox(
  { cwd: WORKSPACE_DIR, botHome: botHome(bot), writable, readOnly: [KNOWLEDGE_DIR] },
  { dataDir: DATA_DIR },
  CLAUDE_EXE,
  { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
);
process.stdout.write(argv.join('\0') + '\0');
