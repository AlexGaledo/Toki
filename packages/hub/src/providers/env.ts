/**
 * Environment allowlist for provider children: a prompt injection that gets a shell (`env`, `node -e
 * "process.env"`) must find neither the hub's bearer token nor another provider's API key.
 */

export type ProviderKind = 'claude' | 'codex' | 'opencode' | 'grok' | 'gemini';

/** Names every child gets when the hub has them. Matched case-insensitively (Windows env is case-blind). */
const BASE_NAMES = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'ComSpec',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'LANG', 'TERM', 'SHELL', 'DISPLAY', 'NODE_NO_WARNINGS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE',
];
const BASE_PREFIXES = ['XDG_', 'LC_'];

const PROVIDER_NAMES: Record<ProviderKind, string[]> = {
  // The Agent SDK reads ANTHROPIC_API_KEY; CLAUDE_* covers CLAUDE_CODE_*, CLAUDE_CONFIG_DIR, ...
  claude: ['ANTHROPIC_API_KEY'],
  codex: ['OPENAI_API_KEY', 'CODEX_HOME', 'POCKETROCKET_MCP_TOKEN'],
  // OpenCode is a multi-provider front end and reads all three vendor keys itself.
  opencode: ['XAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
  grok: ['XAI_API_KEY'],
  // agy: only the API key; its Google login lives in the user's profile dirs (HOME/APPDATA). The hub MCP bearer goes
  // in the ACP session request, not the environment.
  gemini: ['GEMINI_API_KEY'],
};
const PROVIDER_PREFIXES: Record<ProviderKind, string[]> = {
  claude: ['CLAUDE_'],
  codex: [],
  opencode: ['OPENCODE_'],
  grok: ['GROK_', 'POCKETROCKET_MCP_'],
  gemini: [],
};

/** Never forwarded, whatever a prefix says: the hub token above all. */
const DENY = new Set(['pocketrocket_token']);

function allowed(key: string, provider: ProviderKind): boolean {
  const k = key.toLowerCase();
  if (DENY.has(k)) return false;
  if (BASE_NAMES.some((n) => n.toLowerCase() === k)) return true;
  if (BASE_PREFIXES.some((p) => k.startsWith(p.toLowerCase()))) return true;
  if (PROVIDER_NAMES[provider].some((n) => n.toLowerCase() === k)) return true;
  return PROVIDER_PREFIXES[provider].some((p) => k.startsWith(p.toLowerCase()));
}

export function childEnv(
  provider: ProviderKind,
  extra: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === 'string' && allowed(k, provider)) out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}
