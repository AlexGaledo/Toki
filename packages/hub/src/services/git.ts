import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const URL_RE = /^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/)[^\s]+$/i;
const SCP_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/;

export type GitSource = { kind: 'url'; value: string } | { kind: 'path'; value: string };

export function parseGitSource(raw: string): GitSource | string {
  const s = raw.trim();
  if (!s) return 'Empty source';
  if (s.length > 500) return 'Source is too long';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return 'Source contains control characters';
  if (s.startsWith('-')) return 'Source may not start with "-"';
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(s)) return 'Git remote helpers (such as ext::) are not allowed';
  if (URL_RE.test(s) || SCP_RE.test(s)) return { kind: 'url', value: s };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return 'Unsupported URL scheme (use https://, ssh://, git://, file:// or git@host:path)';
  if (!path.isAbsolute(s)) return 'A local source must be an absolute path';
  if (/^\\/.test(s)) return 'Network (UNC) paths are not supported';
  let st: fs.Stats;
  try {
    st = fs.statSync(s);
  } catch {
    return 'No such folder: ' + s;
  }
  if (!st.isDirectory()) return 'Not a folder: ' + s;
  return { kind: 'path', value: path.resolve(s) };
}

/** Env for git: what it needs to find itself, HOME (config, ssh keys) and an ssh agent. Never the hub token. */
function gitEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'LANG', 'SSH_AUTH_SOCK', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE'];
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (keep.some((n) => n.toLowerCase() === k.toLowerCase())) env[k] = v;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return env;
}

export type GitRunner = (args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<string>;

export const GIT_SAFE_CONFIG = ['-c', 'protocol.ext.allow=never', '-c', 'protocol.fd.allow=never', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null')];

export const runGit: GitRunner = (args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_SAFE_CONFIG, ...args],
      { cwd: opts.cwd, env: gitEnv(), timeout: opts.timeoutMs ?? 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(0, 400);
          reject(new Error(tail || 'git failed'));
        } else resolve(String(stdout));
      },
    );
  });
