#!/usr/bin/env node
// control-toki: launch a throwaway Toki (hub + web + headless Chromium), drive it like a user, keep evidence.
//
// Modelled on Lauren Tan's pstack `create-verification-skill` / `verify-<app>` pattern
// (https://github.com/cursor/plugins/tree/main/pstack, MIT © Lauren Tan). Clean-room code for this repo.
//
//   node scripts/control-toki.mjs --help
//
// Safety rules this script enforces (see .claude/skills/verify-toki/SKILL.md):
// - Every run lives under os.tmpdir(). The hub gets its own POCKETROCKET_DATA there; inherited POCKETROCKET_*,
//   PORT, HUB_URL, SCREEN_URL and DOTENV_* are dropped, so a .env or a shell export can never point it at the
//   real data dir or a VPS.
// - Ports are picked free on 127.0.0.1. Nothing binds anything but loopback.
// - `stop` kills only the pids this run recorded, and only while their port still answers as ours.
// - The hub token is generated here, kept in the state file, and never printed.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB_DIR = path.join(REPO_ROOT, 'packages', 'hub');
const WEB_DIR = path.join(REPO_ROOT, 'packages', 'web');
const SELF = 'node scripts/control-toki.mjs';

export const HELP = `control-toki: drive a throwaway local Toki and capture evidence.

Usage: ${SELF} <command> [args] [--flags]

Lifecycle
  launch [--onboarding] [--keep-routines] [--web vite|dist] [--headed] [--browser <exe>] [--root <dir>]
                        Start hub + web + Chromium on free loopback ports with a fresh data dir under
                        os.tmpdir(). Returns once the UI is signed in and usable. --onboarding keeps the
                        first-run setup (default: marked done via PUT /api/settings so the app is usable).
                        Seeded routines are paused unless --keep-routines (a run must not spend quota).
  doctor                Read-only: pids alive, ports answer, hub data dir is ours, auth enforced,
                        page loaded and signed in. Exit 1 on any FAIL.
  stop [--keep-data]    Stop only what launch started, delete the run's data and browser profile,
                        keep evidence/ and logs/. Prints the evidence dir.
  status                Print the run state (never the token).
  install-browser       Download the Chromium build that the repo's playwright-core expects.

Drive (the browser tab launch opened)
  snapshot [--path <file>]                   ARIA snapshot of the page; saved to evidence and printed.
  click --role <role> --name <name> [--exact] [--nth <n>] [--in <role>:<name>]
  fill  --role <role> --name <name> --value <text> [--exact] [--nth <n>] [--in <role>:<name>]
                                             --in scopes the lookup, e.g. --in tabpanel:Skills
  click --text <text> [--exact]              Fallback for controls without a role (a <details> summary)
  press --key <key>                          e.g. Enter, Escape, Control+k
  wait  (--role <role> --name <name> | --text <text>) [--gone] [--timeout <ms>]
  goto <path>                                Same-origin path, e.g. /  (the token stays in the tab)
  screenshot <path> [--full]                 Relative paths land in the evidence dir.

Hub
  api <METHOD> <path> [json]                 Authenticated call straight to the hub, e.g.
                                             api GET /api/rooms    api POST /api/rooms '{"kind":"group",...}'

Global flags
  --root <dir>    Run root (must be inside os.tmpdir()). Default: <tmp>/toki-verify-<hash of repo path>,
                  or TOKI_VERIFY_ROOT. Evidence goes to <root>/evidence/<launch timestamp>/.
`;

// ---------------------------------------------------------------------------------------------- pure helpers

const BOOLEAN_FLAGS = new Set(['help', 'onboarding', 'keep-routines', 'headed', 'exact', 'full', 'gone', 'keep-data']);

/**
 * `argv` (without node and the script) -> { cmd, positional, flags }. `--k v` and `--k=v` both work; flags in
 * BOOLEAN_FLAGS never swallow the next word. A bare `--` ends flag parsing.
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (rest || !a.startsWith('--') || a === '-') {
      positional.push(a);
      continue;
    }
    if (a === '--') {
      rest = true;
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (!key) throw new Error('empty flag: ' + a);
    if (eq > 0) flags[key] = a.slice(eq + 1);
    else if (BOOLEAN_FLAGS.has(key)) flags[key] = true;
    else {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith('--') && v !== '--')) throw new Error('--' + key + ' needs a value');
      flags[key] = v;
      i++;
    }
  }
  const [cmd = 'help', ...pos] = positional;
  return { cmd, positional: pos, flags };
}

/** One port that 127.0.0.1 accepts a listener on right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** `n` distinct free ports, none in `avoid` (the defaults a real hub uses, so a dev hub never collides). */
export async function pickFreePorts(n, avoid = [7788, 7789, 5173, 9222]) {
  const out = new Set();
  for (let tries = 0; out.size < n; tries++) {
    if (tries > n * 20) throw new Error('could not find ' + n + ' free ports');
    const p = await freePort();
    if (!avoid.includes(p)) out.add(p);
  }
  return [...out];
}

const norm = (p) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const inside = (child, parent) => {
  const rel = path.relative(norm(parent), norm(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** The real data dirs a run must never touch: the dev hub's <repo>/data, an inherited POCKETROCKET_DATA. */
export function realDataDirs(env = process.env, repoRoot = REPO_ROOT) {
  const dirs = [path.join(repoRoot, 'data')];
  if (env.POCKETROCKET_DATA) dirs.push(path.resolve(env.POCKETROCKET_DATA));
  return dirs;
}

/**
 * Throws unless `root` is a strict subfolder of `tmp` and neither is, contains, nor sits inside a real data dir
 * or the repo. Returns the resolved root.
 */
export function assertThrowawayRoot(root, { tmp = os.tmpdir(), env = process.env, repoRoot = REPO_ROOT } = {}) {
  const r = path.resolve(root);
  if (!inside(r, tmp)) throw new Error('run root must be inside ' + tmp + ' (got ' + r + ')');
  for (const d of [...realDataDirs(env, repoRoot), repoRoot]) {
    if (norm(d) === norm(r) || inside(r, d) || inside(d, r)) throw new Error('run root overlaps ' + d + '; refusing');
  }
  return r;
}

/** Default run root: one per checkout, so two worktrees never share a run. */
export function defaultRoot(env = process.env, tmp = os.tmpdir(), repoRoot = REPO_ROOT) {
  if (env.TOKI_VERIFY_ROOT) return path.resolve(env.TOKI_VERIFY_ROOT);
  const h = crypto.createHash('sha1').update(norm(repoRoot)).digest('hex').slice(0, 8);
  return path.join(tmp, 'toki-verify-' + h);
}

/**
 * The hub's environment: the parent's, minus anything that could aim it at real data, a real token, a VPS or
 * a .env file, plus this run's values.
 */
export function buildHubEnv(base, { dataDir, port, workspacePort, token, webDist, dotenvPath }) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^(POCKETROCKET_|DOTENV_)/i.test(k)) continue;
    if (/^(PORT|WORKSPACE_WEB_PORT|HUB_URL|HUB|SCREEN_URL)$/i.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    POCKETROCKET_DATA: dataDir,
    PORT: String(port),
    WORKSPACE_WEB_PORT: String(workspacePort),
    POCKETROCKET_TOKEN: token,
    DOTENV_CONFIG_PATH: dotenvPath,
    DOTENV_CONFIG_QUIET: 'true',
    NODE_NO_WARNINGS: '1',
  });
  if (webDist) env.POCKETROCKET_WEB_DIST = webDist;
  return env;
}

/** `yyyymmdd-hhmmss` in local time, safe for a folder name. */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/** Relative evidence paths land in the run's evidence dir; absolute ones are kept. */
export function evidencePath(evidenceDir, p) {
  return path.isAbsolute(p) ? p : path.join(evidenceDir, p);
}

/**
 * Git Bash (MSYS) rewrites a leading-slash argument such as `/api/rooms` into `C:/Program Files/Git/api/rooms`.
 * Undo that so `api GET /api/rooms` and `goto /` work from Git Bash without MSYS_NO_PATHCONV=1.
 */
export function unmangleMsysPath(p) {
  if (typeof p !== 'string') return p;
  const m = /^[A-Za-z]:[\\/](?:.*?[\\/])?Git([\\/].*)?$/.exec(p);
  return m ? (m[1] ?? '/').replace(/\\/g, '/') : p;
}

/** Blank every JSON string value whose key looks secret (token, secret, password, apiKey...) before printing. */
export function redactSecrets(text) {
  return String(text).replace(/("[A-Za-z_]*(?:token|secret|password|apikey|api_key)[A-Za-z_]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"<redacted>"');
}

/** Strip any `#token=...` from a string before it is printed or logged. */
export function redactToken(s, token) {
  let out = String(s).replace(/#token=[^\s"']*/g, '#token=<redacted>');
  if (token) out = out.split(token).join('<token>');
  return out;
}

// ---------------------------------------------------------------------------------------------- state

function statePaths(root) {
  return { state: path.join(root, 'state.json'), run: path.join(root, 'run'), logs: path.join(root, 'logs'), evidence: path.join(root, 'evidence') };
}

function readState(root) {
  try {
    return JSON.parse(fs.readFileSync(statePaths(root).state, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(root, s) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(statePaths(root).state, JSON.stringify(s, null, 2), { mode: 0o600 });
}

function needState(root) {
  const s = readState(root);
  if (!s) throw new Error('no run at ' + root + '. Start one with: ' + SELF + ' launch');
  return s;
}

function logAction(s, entry) {
  try {
    fs.mkdirSync(s.evidenceDir, { recursive: true });
    fs.appendFileSync(path.join(s.evidenceDir, 'actions.jsonl'), redactToken(JSON.stringify({ at: new Date().toISOString(), ...entry }), s.token) + '\n');
  } catch {
    /* evidence log is best-effort; the command result still prints */
  }
}

// ---------------------------------------------------------------------------------------------- processes

const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function startDetached(cmd, args, { cwd, env, log }) {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'a');
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  child.unref();
  fs.closeSync(fd);
  return child.pid;
}

/** Kill a pid and its children. Windows: taskkill /T on that pid only. POSIX: its process group (detached). */
function killTree(pid) {
  if (!alive(pid)) return false;
  if (isWin) spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    }
  }
  return true;
}

async function fetchStatus(url, init = {}, ms = 3000) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    const text = await r.text();
    return { status: r.status, text };
  } catch (e) {
    return { status: 0, text: String(e.message ?? e) };
  }
}

async function waitFor(what, fn, { timeout = 90_000, every = 500 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  throw new Error('timed out waiting for ' + what);
}

// ---------------------------------------------------------------------------------------------- browser

function requireFromHub() {
  // playwright-core is the repo's own copy (hub -> @playwright/mcp -> playwright-core, patched in package.json).
  const hubReq = createRequire(path.join(HUB_DIR, 'package.json'));
  return createRequire(hubReq.resolve('@playwright/mcp/package.json'));
}

async function loadPlaywright() {
  const req = requireFromHub();
  return import(pathToFileURL(req.resolve('playwright-core')).href).then((m) => m.default ?? m);
}

/** A Chromium to run: --browser, TOKI_VERIFY_BROWSER, playwright's own build, any ms-playwright build, Chrome, Edge. */
async function findBrowser(flag) {
  const tried = [];
  const ok = (p) => {
    tried.push(p);
    return p && fs.existsSync(p);
  };
  if (flag) {
    if (ok(flag)) return flag;
    throw new Error('--browser not found: ' + flag);
  }
  if (ok(process.env.TOKI_VERIFY_BROWSER)) return process.env.TOKI_VERIFY_BROWSER;
  try {
    const pw = await loadPlaywright();
    const p = pw.chromium.executablePath();
    if (ok(p)) return p;
  } catch {
    /* playwright-core missing: fall through to installed browsers */
  }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (isWin ? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright') : path.join(os.homedir(), '.cache', 'ms-playwright'));
  try {
    const builds = fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const b of builds) {
      for (const rel of [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe'], ['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome'], ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']]) {
        const p = path.join(cache, b, ...rel);
        if (ok(p)) return p;
      }
    }
  } catch {
    /* no cache dir */
  }
  const system = isWin
    ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
       path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  for (const p of system) if (ok(p)) return p;
  throw new Error('no Chromium found. Run: ' + SELF + ' install-browser   (or pass --browser <exe>)');
}

/** Connect to the run's browser and return { browser, page }. Never opens a new tab. */
async function attach(s) {
  const pw = await loadPlaywright();
  const browser = await pw.chromium.connectOverCDP('http://127.0.0.1:' + s.ports.cdp, { timeout: 10_000 });
  const ctx = browser.contexts()[0];
  const pages = ctx?.pages() ?? [];
  const page = pages.find((p) => p.url().startsWith(s.webUrl)) ?? pages[0];
  if (!page) throw new Error('the run browser has no tab; relaunch');
  page.setDefaultTimeout(10_000);
  return { browser, page };
}

/** `--in tabpanel:Skills` -> { role: 'tabpanel', name: 'Skills' }; the name may itself contain colons. */
export function parseScope(raw) {
  if (raw === undefined) return null;
  const i = String(raw).indexOf(':');
  if (i <= 0) throw new Error('--in takes role:name, e.g. --in tabpanel:Skills or --in "dialog:New group chat"');
  return { role: raw.slice(0, i), name: raw.slice(i + 1) };
}

function locatorFor(page, flags) {
  if (!flags.role) throw new Error('--role is required (button, link, textbox, tab, dialog, ...)');
  const opts = {};
  if (flags.name !== undefined) opts.name = flags.name;
  if (flags.exact) opts.exact = true;
  const scope = parseScope(flags.in);
  const base = scope ? page.getByRole(scope.role, { name: scope.name, exact: true }) : page;
  let loc = base.getByRole(flags.role, opts);
  if (flags.nth !== undefined) loc = loc.nth(Number(flags.nth));
  return loc;
}

/** One line describing what the page shows now: url, title, open dialogs. The "resulting state" half of a proof. */
async function pageState(page, token) {
  const dialogs = await page.getByRole('dialog').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || (e.getAttribute('aria-labelledby') && document.getElementById(e.getAttribute('aria-labelledby'))?.textContent) || '(dialog)')).catch(() => []);
  return redactToken('url=' + page.url() + ' title=' + JSON.stringify(await page.title()) + (dialogs.length ? ' dialogs=' + JSON.stringify(dialogs) : ''), token);
}

/** Signed in = no token/sign-in dialog and no "Connecting to the hub" card, and the app shell rendered. */
async function signedIn(page) {
  return page.evaluate(() => {
    const t = document.getElementById('token-prompt-title');
    const body = document.body?.innerText ?? '';
    const root = document.getElementById('root');
    return !t && !/Connecting to the hub/i.test(body) && !!root && root.childElementCount > 0 && body.trim().length > 0;
  });
}

// ---------------------------------------------------------------------------------------------- commands

async function cmdLaunch(root, flags) {
  root = assertThrowawayRoot(root);
  const existing = readState(root);
  if (existing && [existing.pids?.hub, existing.pids?.web, existing.pids?.browser].some(alive)) {
    throw new Error('a run is already up at ' + root + ' (hub pid ' + existing.pids.hub + '). Use it, or ' + SELF + ' stop');
  }
  const webMode = flags.web ?? 'vite';
  if (!['vite', 'dist'].includes(webMode)) throw new Error('--web must be vite or dist');
  const P = statePaths(root);
  fs.rmSync(P.run, { recursive: true, force: true });
  const dataDir = path.join(P.run, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const ts = stamp();
  const evidenceDir = path.join(P.evidence, ts);
  fs.mkdirSync(evidenceDir, { recursive: true });

  const [hubPort, workspacePort, webPort, cdpPort] = await pickFreePorts(4);
  const token = crypto.randomBytes(16).toString('hex');
  const webDist = webMode === 'dist' ? path.join(WEB_DIR, 'dist') : undefined;
  if (webDist && !fs.existsSync(path.join(webDist, 'index.html'))) throw new Error('--web dist needs a build: pnpm --filter @pocketrocket/web build');
  const hubUrl = 'http://127.0.0.1:' + hubPort;
  const webUrl = webMode === 'dist' ? hubUrl : 'http://127.0.0.1:' + webPort;

  const s = {
    version: 1, root, repo: REPO_ROOT, startedAt: new Date().toISOString(), web: webMode,
    dataDir, evidenceDir, logs: P.logs, hubUrl, webUrl,
    ports: { hub: hubPort, workspace: workspacePort, web: webMode === 'vite' ? webPort : null, cdp: cdpPort },
    pids: {}, token,
  };
  writeState(root, s);

  const tsxCli = path.join(HUB_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsxCli)) throw new Error('tsx missing; run pnpm install first');
  const env = buildHubEnv(process.env, { dataDir, port: hubPort, workspacePort, token, webDist, dotenvPath: path.join(P.run, 'no.env') });
  s.pids.hub = startDetached(process.execPath, [tsxCli, path.join(HUB_DIR, 'src', 'index.ts')], { cwd: HUB_DIR, env, log: path.join(P.logs, 'hub.log') });
  writeState(root, s);
  console.log('hub      pid ' + s.pids.hub + '  ' + hubUrl + '  data ' + dataDir);

  if (webMode === 'vite') {
    const viteCli = path.join(WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
    const webEnv = { ...buildHubEnv(process.env, { dataDir, port: hubPort, workspacePort, token, dotenvPath: path.join(P.run, 'no.env') }), HUB_URL: hubUrl };
    delete webEnv.POCKETROCKET_TOKEN; // the dev server never needs it
    s.pids.web = startDetached(process.execPath, [viteCli, '--port', String(webPort), '--strictPort', '--host', '127.0.0.1'], { cwd: WEB_DIR, env: webEnv, log: path.join(P.logs, 'web.log') });
    writeState(root, s);
    console.log('web      pid ' + s.pids.web + '  ' + webUrl + ' (vite dev, proxies to the hub)');
  }

  const auth = { authorization: 'Bearer ' + token };
  await waitFor('hub /api/health', async () => (await fetchStatus(hubUrl + '/api/health', { headers: auth })).status === 200, { timeout: 120_000 });
  if (!flags.onboarding) {
    const r = await fetchStatus(hubUrl + '/api/settings', { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ onboarded: true, userName: 'Verifier' }) });
    if (r.status !== 200) throw new Error('could not mark onboarding done: ' + r.status + ' ' + r.text.slice(0, 200));
  }
  if (!flags['keep-routines']) {
    // Seeded bots come with a nightly routine. A throwaway hub must never spend Claude quota on its own.
    const list = await fetchStatus(hubUrl + '/api/routines', { headers: auth });
    const routines = list.status === 200 ? JSON.parse(list.text) : [];
    for (const r of routines.filter((x) => x.enabled)) {
      const p = await fetchStatus(hubUrl + '/api/routines/' + encodeURIComponent(r.id), { method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
      if (p.status !== 200) throw new Error('could not pause routine ' + r.name + ': ' + p.status);
    }
    if (routines.length) console.log('routines paused ' + routines.filter((x) => x.enabled).map((x) => JSON.stringify(x.name)).join(', '));
  }
  await waitFor('web ' + webUrl, async () => {
    const r = await fetchStatus(webUrl + '/', {}, 5000);
    return r.status === 200 && /<div id="root"/.test(r.text);
  }, { timeout: 120_000 });

  const exe = await findBrowser(flags.browser);
  const profile = path.join(P.run, 'profile');
  const bargs = [
    '--remote-debugging-port=' + cdpPort, '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--mute-audio',
    '--window-size=1400,900', ...(flags.headed ? [] : ['--headless=new']), 'about:blank',
  ];
  s.pids.browser = startDetached(exe, bargs, { cwd: P.run, env: process.env, log: path.join(P.logs, 'browser.log') });
  s.browserExe = exe;
  writeState(root, s);
  console.log('browser  pid ' + s.pids.browser + '  cdp 127.0.0.1:' + cdpPort + '  ' + exe);
  await waitFor('browser CDP', async () => (await fetchStatus('http://127.0.0.1:' + cdpPort + '/json/version')).status === 200, { timeout: 30_000 });

  const { browser, page } = await attach(s);
  try {
    // The token rides the fragment once (lib/auth.ts moves it into sessionStorage and strips the hash).
    await page.goto(webUrl + '/#token=' + token, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await waitFor('UI signed in', () => signedIn(page).catch(() => false), { timeout: 90_000 });
    if (!flags.onboarding) {
      // Ready means usable: the sidebar's "New" menu (start a room or bot) is there and enabled.
      await page.getByRole('button', { name: 'New', exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
    }
    console.log('ready    ' + (await pageState(page, token)));
  } finally {
    await browser.close().catch(() => undefined); // closes the CDP connection only; the browser keeps running
  }
  logAction(s, { cmd: 'launch', web: webMode, onboarding: !!flags.onboarding, ports: s.ports });
  console.log('evidence ' + evidenceDir);
}

async function cmdDoctor(root) {
  const s = needState(root);
  let fail = 0;
  const line = (ok, what, detail = '') => {
    if (!ok) fail++;
    console.log((ok ? 'PASS ' : 'FAIL ') + what + (detail ? '  ' + detail : ''));
  };
  line(assertThrowawayRoot(s.root) === s.root, 'run root is throwaway', s.root);
  for (const [k, pid] of Object.entries(s.pids)) line(alive(pid), k + ' process alive', 'pid ' + pid);
  const auth = { authorization: 'Bearer ' + s.token };
  const h = await fetchStatus(s.hubUrl + '/api/health', { headers: auth });
  let health = {};
  try { health = JSON.parse(h.text); } catch { /* not json */ }
  line(h.status === 200, 'hub /api/health', 'status ' + h.status + (health.version ? ' v' + health.version : '') + (health.provider ? ' provider ' + health.provider : '') + (h.status === 200 ? ' claude exe ' + (health.ok ? 'ok' : 'missing: ' + health.error) : ''));
  // /api/health is token-exempt by design (the desktop app polls it first); /api/settings is not.
  const anon = await fetchStatus(s.hubUrl + '/api/settings');
  line(anon.status === 401, 'hub refuses calls without the token', 'GET /api/settings status ' + anon.status);
  let log = '';
  try { log = fs.readFileSync(path.join(s.logs, 'hub.log'), 'utf8'); } catch { /* no log */ }
  const m = [...log.matchAll(/data (.+?) · http:\/\/127\.0\.0\.1:(\d+)/g)].pop();
  line(!!m && path.resolve(m[1]) === path.resolve(s.dataDir) && Number(m[2]) === s.ports.hub, 'hub on our port uses our throwaway data dir', m ? m[1] + ' :' + m[2] : 'start line not in hub.log');
  const w = await fetchStatus(s.webUrl + '/', {}, 5000);
  line(w.status === 200 && /<div id="root"/.test(w.text), 'web serves the app', s.webUrl + ' status ' + w.status);
  if (s.web === 'vite') {
    const via = await fetchStatus(s.webUrl + '/api/health', { headers: auth }, 5000);
    line(via.status === 200, 'web proxies /api to our hub', 'status ' + via.status);
  }
  const cdp = await fetchStatus('http://127.0.0.1:' + s.ports.cdp + '/json/version');
  line(cdp.status === 200, 'browser CDP answers', ':' + s.ports.cdp);
  if (cdp.status === 200) {
    try {
      const { browser, page } = await attach(s);
      try {
        line(page.url().startsWith(s.webUrl), 'tab is on the app', redactToken(page.url(), s.token));
        line(await signedIn(page), 'UI signed in (no sign-in dialog, not "Connecting to the hub")');
      } finally {
        await browser.close().catch(() => undefined);
      }
    } catch (e) {
      line(false, 'attach to the tab', e.message);
    }
  }
  console.log(fail ? fail + ' check(s) failed' : 'doctor: all checks passed');
  if (fail) process.exitCode = 1;
}

async function withPage(root, fn) {
  const s = needState(root);
  const { browser, page } = await attach(s);
  try {
    return await fn(s, page);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function cmdSnapshot(root, flags) {
  await withPage(root, async (s, page) => {
    const aria = await page.locator('body').ariaSnapshot();
    const file = evidencePath(s.evidenceDir, flags.path ?? 'snapshot-' + stamp() + '-' + crypto.randomBytes(2).toString('hex') + '.aria.yml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const header = '# ' + (await pageState(page, s.token)) + '\n';
    fs.writeFileSync(file, header + aria + '\n');
    process.stdout.write(header + aria + '\n');
    console.log('saved ' + file);
    logAction(s, { cmd: 'snapshot', file });
  });
}

async function cmdClick(root, flags) {
  await withPage(root, async (s, page) => {
    // --text is the fallback for controls with no role, such as a <details> summary ("Other apps").
    const loc = flags.text !== undefined && !flags.role ? page.getByText(flags.text, { exact: !!flags.exact }).first() : locatorFor(page, flags);
    await loc.click();
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await sleep(300);
    const after = await pageState(page, s.token);
    const what = flags.role ? flags.role + ' "' + (flags.name ?? '') + '"' : 'text ' + JSON.stringify(flags.text);
    console.log('clicked ' + what + ' -> ' + after);
    logAction(s, { cmd: 'click', role: flags.role, name: flags.name, text: flags.text, after });
  });
}

async function cmdFill(root, flags) {
  if (flags.value === undefined) throw new Error('--value is required');
  await withPage(root, async (s, page) => {
    const loc = locatorFor(page, flags);
    await loc.fill(String(flags.value));
    const value = await loc.inputValue().catch(() => loc.innerText());
    console.log('filled ' + flags.role + ' "' + (flags.name ?? '') + '" value=' + JSON.stringify(value));
    logAction(s, { cmd: 'fill', role: flags.role, name: flags.name, value });
  });
}

async function cmdPress(root, flags) {
  if (!flags.key) throw new Error('--key is required');
  await withPage(root, async (s, page) => {
    await page.keyboard.press(flags.key);
    await sleep(300);
    const after = await pageState(page, s.token);
    console.log('pressed ' + flags.key + ' -> ' + after);
    logAction(s, { cmd: 'press', key: flags.key, after });
  });
}

async function cmdWait(root, flags) {
  const timeout = Number(flags.timeout ?? 15_000);
  await withPage(root, async (s, page) => {
    const loc = flags.text !== undefined ? page.getByText(flags.text).first() : locatorFor(page, flags).first();
    await loc.waitFor({ state: flags.gone ? 'hidden' : 'visible', timeout });
    const what = flags.text !== undefined ? 'text ' + JSON.stringify(flags.text) : flags.role + ' "' + (flags.name ?? '') + '"';
    console.log((flags.gone ? 'gone: ' : 'visible: ') + what);
    logAction(s, { cmd: 'wait', what, gone: !!flags.gone });
  });
}

async function cmdGoto(root, positional) {
  const p = unmangleMsysPath(positional[0]);
  if (!p || !p.startsWith('/')) throw new Error('goto takes a same-origin path starting with /');
  await withPage(root, async (s, page) => {
    await page.goto(s.webUrl + p, { waitUntil: 'domcontentloaded' });
    await waitFor('UI signed in', () => signedIn(page).catch(() => false), { timeout: 30_000 });
    const after = await pageState(page, s.token);
    console.log('at ' + after);
    logAction(s, { cmd: 'goto', path: p, after });
  });
}

async function cmdScreenshot(root, positional, flags) {
  const p = positional[0] ?? flags.path;
  if (!p) throw new Error('screenshot <path>');
  await withPage(root, async (s, page) => {
    const file = evidencePath(s.evidenceDir, p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: !!flags.full });
    console.log('saved ' + file + '  (' + (await pageState(page, s.token)) + ')');
    logAction(s, { cmd: 'screenshot', file });
  });
}

async function cmdApi(root, positional) {
  const s = needState(root);
  const [method, raw, body] = positional;
  const p = unmangleMsysPath(raw);
  if (!method || !p || !p.startsWith('/api/')) throw new Error('api <METHOD> </api/...> [json]');
  if (body !== undefined) JSON.parse(body); // fail before sending malformed JSON
  const r = await fetchStatus(s.hubUrl + p, {
    method: method.toUpperCase(),
    headers: { authorization: 'Bearer ' + s.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body,
  }, 30_000);
  let out = r.text;
  try { out = JSON.stringify(JSON.parse(r.text), null, 2); } catch { /* not json */ }
  console.log(method.toUpperCase() + ' ' + p + ' -> ' + r.status);
  console.log(redactSecrets(redactToken(out, s.token)));
  logAction(s, { cmd: 'api', method: method.toUpperCase(), path: p, status: r.status });
  if (r.status < 200 || r.status >= 300) process.exitCode = 1;
}

/** Send CDP `Browser.close` on the browser-level socket and resolve when it answers or the socket closes. */
async function cdpBrowserClose(wsUrl) {
  const { default: WebSocket } = await import('ws');
  await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const done = () => { clearTimeout(t); try { ws.terminate(); } catch { /* closed */ } resolve(); };
    const t = setTimeout(done, 5000);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
    ws.on('message', done);
    ws.on('close', done);
    ws.on('error', done);
  });
}

async function cmdStop(root, flags) {
  root = assertThrowawayRoot(root);
  const s = readState(root);
  if (!s) {
    console.log('nothing to stop at ' + root);
    return;
  }
  // Only kill a recorded pid while its port still answers: a pid whose service is gone may have been reused.
  const auth = { authorization: 'Bearer ' + s.token };
  const hubOurs = (await fetchStatus(s.hubUrl + '/api/health', { headers: auth })).status === 200;
  if (hubOurs) {
    await fetchStatus(s.hubUrl + '/api/maintenance/stop', { method: 'POST', headers: auth });
    await waitFor('hub to exit', async () => (await fetchStatus(s.hubUrl + '/api/health', { headers: auth }, 1000)).status === 0, { timeout: 12_000 }).catch(() => undefined);
  }
  const cdp = await fetchStatus('http://127.0.0.1:' + s.ports.cdp + '/json/version');
  const owns = {
    browser: cdp.status === 200,
    web: s.ports.web ? (await fetchStatus('http://127.0.0.1:' + s.ports.web + '/', {}, 2000)).status > 0 : false,
    hub: hubOurs,
  };
  // Chromium on Windows does not always die cleanly under taskkill /F; ask it to quit over CDP first.
  if (owns.browser) {
    await cdpBrowserClose(JSON.parse(cdp.text).webSocketDebuggerUrl).catch(() => undefined);
    await waitFor('browser to exit', async () => !alive(s.pids?.browser), { timeout: 10_000 }).catch(() => undefined);
  }
  for (const k of ['browser', 'web', 'hub']) {
    const pid = s.pids?.[k];
    if (!pid) continue;
    if (!alive(pid)) console.log('stopped ' + k + ' pid ' + pid);
    else if (owns[k]) {
      killTree(pid);
      await waitFor(k + ' to exit', async () => !alive(pid), { timeout: 10_000 }).catch(() => undefined);
      console.log((alive(pid) ? 'STILL RUNNING ' : 'stopped ') + k + ' pid ' + pid);
    } else console.log('skip ' + k + ' pid ' + pid + ': its port no longer answers, so it is not provably ours');
  }
  const left = Object.entries(s.pids ?? {}).filter(([, pid]) => alive(pid));
  if (left.length) {
    // Keep state.json so `stop` can be re-run; nothing of ours is deleted while a process still holds it.
    process.exitCode = 1;
    console.log('still running: ' + left.map(([k, pid]) => k + ' pid ' + pid).join(', ') + '. Re-run stop in a few seconds.');
    console.log('evidence kept: ' + s.evidenceDir);
    return;
  }
  logAction(s, { cmd: 'stop', keepData: !!flags['keep-data'] });
  const P = statePaths(root);
  if (!flags['keep-data']) {
    for (let i = 0; i < 20; i++) {
      try {
        fs.rmSync(P.run, { recursive: true, force: true });
        break;
      } catch {
        await sleep(500); // Windows keeps file handles a moment after the process dies
      }
    }
    console.log(fs.existsSync(P.run) ? 'could not fully remove ' + P.run : 'removed ' + P.run);
  }
  fs.rmSync(P.state, { force: true });
  console.log('evidence kept: ' + s.evidenceDir);
  console.log('logs kept:     ' + s.logs);
}

function cmdStatus(root) {
  const s = readState(root);
  if (!s) return console.log('no run at ' + root);
  const { token, ...rest } = s;
  for (const k of Object.keys(rest.pids ?? {})) rest.pids[k] = rest.pids[k] + (alive(rest.pids[k]) ? ' (alive)' : ' (gone)');
  console.log(JSON.stringify({ ...rest, token: token ? '<set>' : null }, null, 2));
}

function cmdInstallBrowser() {
  const cli = path.join(path.dirname(requireFromHub().resolve('playwright-core/package.json')), 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
}

export async function main(argv = process.argv.slice(2)) {
  const { cmd, positional, flags } = parseArgs(argv);
  if (flags.help || cmd === 'help') return console.log(HELP);
  const root = flags.root ? path.resolve(flags.root) : defaultRoot();
  switch (cmd) {
    case 'launch': return cmdLaunch(root, flags);
    case 'doctor': return cmdDoctor(root);
    case 'snapshot': return cmdSnapshot(root, flags);
    case 'click': return cmdClick(root, flags);
    case 'fill': return cmdFill(root, flags);
    case 'press': return cmdPress(root, flags);
    case 'wait': return cmdWait(root, flags);
    case 'goto': return cmdGoto(root, positional);
    case 'screenshot': return cmdScreenshot(root, positional, flags);
    case 'api': return cmdApi(root, positional);
    case 'stop': return cmdStop(root, flags);
    case 'status': return cmdStatus(root);
    case 'install-browser': return cmdInstallBrowser();
    default: throw new Error('unknown command: ' + cmd + '\n\n' + HELP);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => {
    let token;
    try { token = readState(defaultRoot())?.token; } catch { /* no state */ }
    console.error('control-toki: ' + redactToken(e?.message ?? e, token));
    try {
      const st = readState(defaultRoot());
      if (st) logAction(st, { cmd: process.argv[2], args: process.argv.slice(3), error: String(e?.message ?? e).split(/\r?\n/)[0] });
    } catch { /* no run */ }
    process.exitCode = 1;
  });
}
