/**
 * Bridge P7 (spec 6.4, layer 2): a bubblewrap sandbox around each Claude turn's tools.
 *
 * Without it every bot runs as the one Linux user that owns the hub, so a Bash call in room A can `cat` project B's
 * folder, the vault key, the hub token or another bot's home. With `settings.sandbox = 'on'` the Claude CLI (and so its
 * Bash, Read, Write and the Playwright MCP it starts) is spawned as
 *
 *   bwrap <mounts> -- claude ...
 *
 * and the child sees only what is listed here: read-only system dirs, its own bot home, the room/project folders it is
 * a member of, the shared workspace, a private `~/.claude`, and the network (shared on purpose: the Browser tool
 * reaches the bot's own Chrome on 127.0.0.1:<cdp port>). The data folder root, `vault.key`, `hub-token`, the database
 * and every other bot's or project's folder are simply not mounted, so they do not exist inside.
 *
 * Off by default. `on` fails closed: if bubblewrap is missing or cannot make a user namespace the turn errors with the
 * reason instead of running unsandboxed. Only Claude turns are wrapped (the Codex/Grok/OpenCode adapters are dev-only).
 *
 * `sandboxArgv` is pure (the filesystem is passed in) so the mount sets are unit tested on any OS; the integration
 * test and `deploy/sandbox-check.sh` run the real thing on a Linux box.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { posix as path } from 'node:path';
import type { SandboxStatus } from '@pocketrocket/shared';
import { settings } from '../services/SettingsStore.js';

export interface SandboxFs {
  exists(p: string): boolean;
  readlink(p: string): string | null;
  realpath(p: string): string;
}

export const realFs: SandboxFs = {
  exists: (p) => fs.existsSync(p),
  readlink: (p) => { try { return fs.readlinkSync(p); } catch { return null; } },
  realpath: (p) => { try { return fs.realpathSync(p); } catch { return p; } },
};

export interface SandboxSpec {
  dataDir: string;
  home: string;
  cwd: string;
  botHome: string;
  writable: readonly string[];
  readOnly: readonly string[];
  executable: string;
  credentials?: string;
  env: NodeJS.ProcessEnv;
}

export function botClaudeDir(botHome: string): string {
  return path.join(botHome, '.claude-sandbox');
}

export function transcriptDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

const SYSTEM_LINKS = ['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32'];
const ETC = [
  'resolv.conf', 'hosts', 'nsswitch.conf', 'host.conf', 'gai.conf', 'passwd', 'group', 'localtime', 'timezone',
  'ld.so.cache', 'ld.so.conf', 'ld.so.conf.d', 'ssl', 'ca-certificates', 'alternatives', 'mime.types',
];
const ENV_DENY = /^(POCKETROCKET_TOKEN|POCKETROCKET_MCP_TOKEN)$/i;
const ENV_DROP = /^(TMPDIR|TEMP|TMP|DISPLAY|XAUTHORITY|XDG_.*|DBUS_.*|SSH_.*)$/i;

function within(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Throws when `mount` would expose something the sandbox exists to hide: the filesystem root, the hub user's home, the
 * data folder, or any folder that CONTAINS one of the hub's private paths (the data root, the bots/projects/rooms/
 * computers roots, the secret files). Paths inside the data folder that are not on that list (one bot's home, one
 * project's folder) are the legitimate mounts.
 */
export function assertMountable(mount: string, spec: Pick<SandboxSpec, 'dataDir' | 'home'>, fsx: SandboxFs = realFs): void {
  const real = fsx.realpath(mount);
  const d = spec.dataDir;
  const hidden = [
    spec.home,
    d,
    ...['bots', 'projects', 'rooms', 'computers', 'media', 'attachments', 'desktop-home'].map((n) => path.join(d, n)),
    ...['vault.key', 'hub-token', 'pocketrocket.db', 'pocketrocket.db-wal', 'pocketrocket.db-shm', 'claudebot.db', 'credentials.json', 'secrets.json',
      'integrations.json', 'mcp-servers.json', 'pc-runner.json', 'account.json', 'vapid.json'].map((n) => path.join(d, n)),
  ];
  for (const m of new Set([path.resolve(mount), real])) {
    if (m === path.parse(m).root) throw new Error('sandbox: refusing to mount the filesystem root');
    for (const h of hidden) {
      if (within(m, h)) throw new Error('sandbox: refusing to mount ' + mount + ' (it contains ' + h + ')');
    }
  }
}

interface Bind { mode: 'ro' | 'rw'; src: string; dest: string }

export function sandboxArgv(spec: SandboxSpec, fsx: SandboxFs = realFs): string[] {
  const out: string[] = ['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--new-session'];

  // System: read-only. /bin and friends are symlinks into /usr on current distros; otherwise bind the real dirs.
  out.push('--ro-bind', '/usr', '/usr');
  for (const l of SYSTEM_LINKS) {
    const target = fsx.readlink(l);
    if (target !== null) out.push('--symlink', target, l);
    else if (fsx.exists(l)) out.push('--ro-bind', l, l);
  }
  for (const f of ETC) if (fsx.exists('/etc/' + f)) out.push('--ro-bind', '/etc/' + f, '/etc/' + f);
  out.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', spec.home);

  const binds: Bind[] = [];
  const add = (mode: Bind['mode'], src: string, dest = src, check = true) => {
    if (check) assertMountable(src, spec, fsx);
    if (!fsx.exists(src)) return;
    if (!binds.some((b) => b.dest === dest)) binds.push({ mode, src, dest });
  };
  const gitconfig = path.join(spec.home, '.gitconfig');
  if (fsx.exists(gitconfig)) add('ro', gitconfig, gitconfig, false);
  const exe = fsx.realpath(spec.executable);
  if (!within('/usr', exe)) add('ro', exe, exe, false);
  for (const p of spec.readOnly) add('ro', p);
  for (const p of [spec.cwd, spec.botHome, ...spec.writable]) add('rw', p);
  const claudeDest = path.join(spec.home, '.claude');
  add('rw', botClaudeDir(spec.botHome), claudeDest, false);
  // The login file. Writable because the CLI refreshes its OAuth token in place; a read-only copy would make every
  // turn after the first expiry fail (and a rotated refresh token that could not be saved would log the server out).
  if (spec.credentials) add('rw', spec.credentials, path.join(claudeDest, '.credentials.json'), false);

  binds.sort((a, b) => a.dest.length - b.dest.length || (a.dest < b.dest ? -1 : 1));
  for (const b of binds) out.push(b.mode === 'ro' ? '--ro-bind' : '--bind', b.src, b.dest);

  out.push('--chdir', spec.cwd, '--clearenv');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.env)) {
    if (typeof v === 'string' && !ENV_DENY.test(k) && !ENV_DROP.test(k)) env[k] = v;
  }
  env.HOME = spec.home;
  env.TMPDIR = '/tmp';
  env.PATH ??= '/usr/local/bin:/usr/bin:/bin';
  for (const k of Object.keys(env).sort()) out.push('--setenv', k, env[k]);
  return out;
}

export interface BwrapProbe { ok: boolean; reason: string }

const APPARMOR_HINT =
  ' On Ubuntu 24.04 this is the AppArmor rule that blocks unprivileged user namespaces: install deploy/apparmor/pocketrocket-bwrap (deploy/setup-vps.sh does it).';

export function realProbe(): BwrapProbe {
  if (process.platform !== 'linux') return { ok: false, reason: 'Bot sandboxing needs a Linux server with bubblewrap.' };
  // /usr/bin/true needs the loader under /lib64 (a symlink into /usr on current distros), so link /lib and friends the
  // same way the real argv does; without them the probe failed with 'execvp /usr/bin/true: No such file or directory'.
  const links: string[] = [];
  for (const l of SYSTEM_LINKS) {
    try { links.push('--symlink', fs.readlinkSync(l), l); } catch { if (fs.existsSync(l)) links.push('--ro-bind', l, l); }
  }
  const r = spawnSync('bwrap', ['--ro-bind', '/usr', '/usr', ...links, '--proc', '/proc', '--dev', '/dev', '--unshare-pid', '--', '/usr/bin/true'], {
    timeout: 5000, encoding: 'utf8', env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
  });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return { ok: false, reason: 'bubblewrap (bwrap) is not installed. Run: apt-get install bubblewrap (deploy/setup-vps.sh does this).' };
  }
  if (r.status === 0) return { ok: true, reason: '' };
  const err = String(r.stderr || r.error?.message || 'exit ' + r.status).trim().split('\n')[0].slice(0, 200);
  return { ok: false, reason: 'bubblewrap cannot make a sandbox here (' + err + ').' + (/uid map|namespace|Operation not permitted|Permission denied/i.test(err) ? APPARMOR_HINT : '') };
}

let probeFn: () => BwrapProbe = realProbe;
let cache: { at: number; res: BwrapProbe } | null = null;
const OK_MS = 60_000;
const FAIL_MS = 5_000;

export function setSandboxProbeForTests(fn?: () => BwrapProbe) {
  probeFn = fn ?? realProbe;
  cache = null;
}

export function bwrapUsable(now: number = Date.now()): BwrapProbe {
  if (cache && now - cache.at < (cache.res.ok ? OK_MS : FAIL_MS)) return cache.res;
  const res = probeFn();
  cache = { at: now, res };
  return res;
}

export function sandboxMode(): 'off' | 'on' {
  return settings.get().sandbox === 'on' ? 'on' : 'off';
}

export function sandboxActive(): boolean {
  return sandboxMode() === 'on' && bwrapUsable().ok;
}

export function sandboxStatus(): SandboxStatus {
  const p = bwrapUsable();
  return { available: p.ok, active: sandboxMode() === 'on' && p.ok, reason: p.reason };
}

export class SandboxUnavailable extends Error {
  constructor(reason: string) {
    super('The bot sandbox is on but unusable, so this turn was not run (it fails closed instead of running unsandboxed): ' + reason +
      ' Turn it off in Settings > Security to run without it.');
    this.name = 'SandboxUnavailable';
  }
}

export type SandboxTurn = Omit<SandboxSpec, 'env' | 'executable' | 'dataDir' | 'home' | 'credentials'> & {
  resumeToken?: string | null;
};

export function migrateTranscript(hostClaudeDir: string, botHome: string, cwd: string, sessionId: string): void {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(sessionId)) return;
  const name = transcriptDirName(cwd);
  const from = path.join(hostClaudeDir, 'projects', name);
  const to = path.join(botClaudeDir(botHome), 'projects', name);
  const file = sessionId + '.jsonl';
  if (fs.existsSync(path.join(to, file)) || !fs.existsSync(path.join(from, file))) return;
  fs.mkdirSync(to, { recursive: true });
  fs.copyFileSync(path.join(from, file), path.join(to, file));
  const side = path.join(from, sessionId);
  if (fs.existsSync(side)) fs.cpSync(side, path.join(to, sessionId), { recursive: true });
}

function which(cmd: string, pathVar: string): string {
  for (const dir of pathVar.split(path.delimiter)) {
    const p = path.join(dir, cmd);
    if (dir && fs.existsSync(p)) return p;
  }
  return cmd;
}

export interface SandboxedCommand { command: string; args: string[]; env: NodeJS.ProcessEnv }

export function prepareSandbox(
  turn: SandboxTurn,
  layout: { dataDir: string; home?: string },
  command: string,
  env: NodeJS.ProcessEnv,
): { argv: string[]; exe: string } {
  const home = layout.home ?? os.homedir();
  const hostClaude = path.join(home, '.claude');
  const claudeDir = botClaudeDir(turn.botHome);
  fs.mkdirSync(claudeDir, { recursive: true });
  const cred = path.join(hostClaude, '.credentials.json');
  const haveCred = fs.existsSync(cred);
  if (haveCred) fs.closeSync(fs.openSync(path.join(claudeDir, '.credentials.json'), 'a'));
  if (turn.resumeToken) migrateTranscript(hostClaude, turn.botHome, turn.cwd, turn.resumeToken);
  const exe = realFs.realpath(path.isAbsolute(command) ? command : which(command, env.PATH ?? process.env.PATH ?? ''));
  const argv = sandboxArgv({ ...turn, dataDir: layout.dataDir, home, executable: exe, credentials: haveCred ? cred : undefined, env });
  return { argv, exe };
}

export function sandboxCommand(
  o: { command: string; args: string[]; env: NodeJS.ProcessEnv },
  turn: SandboxTurn,
  layout: { dataDir: string; home?: string },
): SandboxedCommand | null {
  if (sandboxMode() !== 'on') return null;
  const probe = bwrapUsable();
  if (!probe.ok) throw new SandboxUnavailable(probe.reason);
  const { argv, exe } = prepareSandbox(turn, layout, o.command, o.env);
  return { command: 'bwrap', args: [...argv, '--', exe, ...o.args], env: { PATH: '/usr/local/bin:/usr/bin:/bin' } };
}

export function browserMcpRoots(cli: string, nodeExe: string = process.execPath): string[] {
  const roots: string[] = [];
  const real = realFs.realpath(cli);
  const pnpm = real.indexOf(path.sep + '.pnpm' + path.sep);
  if (pnpm >= 0) roots.push(real.slice(0, pnpm + 6));
  else {
    const nm = real.lastIndexOf(path.sep + 'node_modules' + path.sep);
    roots.push(nm >= 0 ? real.slice(0, nm + 13) : path.dirname(real));
  }
  // cli.js is reached through a symlink in the hub's node_modules, which must exist inside too.
  const scope = path.dirname(path.dirname(cli));
  if (path.basename(scope) === '@playwright') roots.push(scope);
  if (!nodeExe.startsWith('/usr/')) roots.push(nodeExe);
  return roots;
}
