import type { GameToolFix, GameToolsBlenderProcess, GameToolsStatus } from '@pocketrocket/shared';

/** Settings › Game tools and the game room strip (spec toki-local-first-gamedev §2, D1). Status is always words too. */
export type GameTone = 'ok' | 'warn' | 'bad' | 'muted';

export type GameToolAction =
  | { kind: 'fix'; step: GameToolFix; label: string }
  | { kind: 'link'; href: string; label: string }
  | { kind: 'open-studio'; label: string }
  /** The step exists but cannot run now: a disabled button with the reason beside it. */
  | { kind: 'wait'; label: string; why: string };

export interface GameToolRow {
  id: 'blender' | 'uv' | 'blenderMcp' | 'studio';
  name: string;
  tone: GameTone;
  status: string;
  version: string | null;
  detail: string | null;
  /** Studio's live steps are unchecked until S2. */
  unverified: boolean;
  action: GameToolAction | null;
}

export const BLENDER_DOWNLOAD = 'https://www.blender.org/download/';
export const STUDIO_DOWNLOAD = 'https://create.roblox.com/';
export const STUDIO_MENU_PATH = 'In Roblox Studio, open the Assistant, open its settings, and turn on the MCP server option. Then restart Studio.';
export const CLOSE_STUDIO = 'Close Roblox Studio first. Toki changes this setting only while Studio is closed.';

export const FIX_LABEL: Record<GameToolFix, string> = {
  'install-uv': 'Install uv',
  'install-blender-mcp': 'Install Blender tools',
  'blender-reset': 'Try again',
  'studio-mcp-setting': 'Turn on Studio MCP',
};

/**
 * Whether a fix may be sent now. `studio-mcp-setting` rewrites Studio's own settings file, which Studio overwrites
 * while it runs: never while `studio.running`.
 */
export function canRunFix(s: GameToolsStatus, step: GameToolFix): boolean {
  if (!s.supported) return false;
  switch (step) {
    case 'install-uv': return s.uv.fix === step;
    case 'install-blender-mcp': return s.blenderMcp.fix === step && s.uv.ok;
    case 'blender-reset': return s.blenderProcess.fix === step;
    case 'studio-mcp-setting': return s.studio.fix === step && !s.studio.running;
  }
}

/**
 * Runs a fix only if a fresh status still allows it, so a stale page (Studio opened since it loaded) can never send
 * `studio-mcp-setting` while Studio runs. Returns the status it refused on, or the fix's own reply.
 */
export async function runFix<R>(
  step: GameToolFix,
  deps: { status: () => Promise<GameToolsStatus>; fix: (step: GameToolFix) => Promise<R> },
): Promise<{ sent: true; reply: R } | { sent: false; status: GameToolsStatus }> {
  const fresh = await deps.status();
  if (!canRunFix(fresh, step)) return { sent: false, status: fresh };
  return { sent: true, reply: await deps.fix(step) };
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/** Blender's process line in Settings. There is no "Open Blender": Toki's Blender is headless (decision 7). */
export function blenderStateText(p: GameToolsBlenderProcess): string {
  switch (p.state) {
    case 'stopped': return 'Stopped. It starts headless when a game room needs it.';
    case 'starting': return 'Starting headless.';
    case 'running': return 'Running for ' + (p.project ?? 'a project') + (p.idleMs !== null && p.idleMs >= 60_000 ? ', idle ' + minutes(p.idleMs) + ' min' : '') + '.';
    case 'other': return 'Another Blender is running on this PC (' + (p.exe ?? 'blender.exe') + (p.pid !== null ? ', pid ' + p.pid : '') + '). Try again when it finishes.';
    case 'crashing': return 'Blender keeps crashing, so Toki stopped restarting it. Open the log, then try again.';
    case 'unsupported': return '';
  }
}

export function gameToolRows(s: GameToolsStatus, opts: { studioLauncher: boolean }): GameToolRow[] {
  const off = (id: GameToolRow['id'], name: string): GameToolRow =>
    ({ id, name, tone: 'muted', status: 'Not supported here', version: null, detail: null, unverified: false, action: null });
  if (!s.supported) return [off('blender', 'Blender'), off('uv', 'uv'), off('blenderMcp', 'Blender MCP tools'), off('studio', 'Roblox Studio')];

  const p = s.blenderProcess;
  const blender: GameToolRow = s.blender.ok
    ? {
      id: 'blender', name: 'Blender', version: s.blender.version, detail: blenderStateText(p), unverified: false,
      tone: p.state === 'crashing' ? 'bad' : p.state === 'other' ? 'warn' : 'ok',
      status: p.state === 'crashing' ? 'Keeps crashing' : p.state === 'other' ? 'Another Blender running' : p.state === 'running' ? 'Running' : 'Installed',
      action: p.fix ? { kind: 'fix', step: p.fix, label: FIX_LABEL[p.fix] } : null,
    }
    : { id: 'blender', name: 'Blender', tone: 'bad', status: 'Not installed', version: null, detail: 'Install Blender, then come back here.', unverified: false, action: { kind: 'link', href: BLENDER_DOWNLOAD, label: 'Get Blender' } };

  const uv: GameToolRow = s.uv.ok
    ? { id: 'uv', name: 'uv', tone: 'ok', status: 'Installed', version: s.uv.version, detail: s.uv.reason === 'toki' ? "Toki's own copy." : 'Found on your PATH.', unverified: false, action: null }
    : {
      id: 'uv', name: 'uv', tone: 'warn', status: 'Not installed', version: null, unverified: false,
      detail: 'Needed to install the Blender tools. Toki installs uv ' + s.uv.pinned + ' in its own folder.',
      action: s.uv.fix ? { kind: 'fix', step: s.uv.fix, label: FIX_LABEL[s.uv.fix] } : null,
    };

  const m = s.blenderMcp;
  const mcpStatus = m.reason === 'installed' ? 'Installed' : m.reason === 'incomplete' ? 'Incomplete' : m.reason === 'addon-mismatch' ? 'Add-on changed' : 'Not installed';
  const blenderMcp: GameToolRow = {
    id: 'blenderMcp', name: 'Blender MCP tools', version: m.version, unverified: false, status: mcpStatus,
    tone: m.ok ? 'ok' : m.reason === 'addon-mismatch' ? 'bad' : 'warn',
    detail: m.reason === 'addon-mismatch' ? 'The add-on differs from the one Toki installed. Reinstall to restore it.' : m.ok ? null : 'Lets bots model in Toki\'s headless Blender.',
    action: !m.fix ? null : !s.uv.ok ? { kind: 'wait', label: FIX_LABEL[m.fix], why: 'Install uv first.' } : { kind: 'fix', step: m.fix, label: FIX_LABEL[m.fix] },
  };

  const st = s.studio;
  const unverified = !st.verified;
  const studioBase = { id: 'studio' as const, name: 'Roblox Studio', version: null, unverified };
  let studio: GameToolRow;
  switch (st.reason) {
    case 'ready':
      studio = { ...studioBase, tone: 'ok', status: 'Open and ready', detail: null, action: null };
      break;
    case 'not-running':
      studio = { ...studioBase, tone: 'muted', status: 'Not open', detail: opts.studioLauncher ? null : 'Open Roblox Studio to use it.', action: opts.studioLauncher ? { kind: 'open-studio', label: 'Open Studio' } : null };
      break;
    case 'setting-off':
      studio = {
        ...studioBase, tone: 'warn', status: 'MCP setting off', detail: st.running ? CLOSE_STUDIO : 'Bots reach Studio through its MCP server.',
        action: !st.fix ? null : st.running ? { kind: 'wait', label: FIX_LABEL[st.fix], why: CLOSE_STUDIO } : { kind: 'fix', step: st.fix, label: FIX_LABEL[st.fix] },
      };
      break;
    case 'setting-unknown':
      studio = { ...studioBase, tone: 'warn', status: 'MCP setting unknown', detail: STUDIO_MENU_PATH, action: null };
      break;
    case 'no-mcp-bat':
    case 'no-studio-mcp':
      studio = { ...studioBase, tone: 'bad', status: 'Studio MCP not found', detail: 'Install or update Roblox Studio.', action: { kind: 'link', href: STUDIO_DOWNLOAD, label: 'Get Roblox Studio' } };
      break;
    case 'unsupported':
      studio = off('studio', 'Roblox Studio');
      break;
  }
  return [blender, uv, blenderMcp, studio];
}

export interface StripItem { tone: GameTone; text: string }

/** The game room's compact line, e.g. "Blender idle 3 min · Studio not open (unverified)". */
export function gameStrip(s: GameToolsStatus): { blender: StripItem; studio: StripItem; needsFix: boolean } | null {
  if (!s.supported) return null;
  const p = s.blenderProcess;
  const blender: StripItem = !s.blender.ok ? { tone: 'bad', text: 'Blender not installed' }
    : !s.blenderMcp.ok ? { tone: 'warn', text: 'Blender tools missing' }
      : p.state === 'crashing' ? { tone: 'bad', text: 'Blender keeps crashing' }
        : p.state === 'other' ? { tone: 'warn', text: 'Another Blender running' }
          : p.state === 'starting' ? { tone: 'muted', text: 'Blender starting' }
            : p.state === 'running' ? (p.idleMs !== null && p.idleMs >= 60_000 ? { tone: 'muted', text: 'Blender idle ' + minutes(p.idleMs) + ' min' } : { tone: 'ok', text: 'Blender working' })
              : { tone: 'muted', text: 'Blender stopped' };
  const st = s.studio;
  const word: StripItem = st.reason === 'ready' ? { tone: 'ok', text: 'Studio open' }
    : st.reason === 'not-running' ? { tone: 'muted', text: 'Studio not open' }
      : st.reason === 'setting-off' ? { tone: 'warn', text: 'Studio MCP off' }
        : st.reason === 'setting-unknown' ? { tone: 'warn', text: 'Studio MCP setting unknown' }
          : { tone: 'bad', text: 'Studio MCP not found' };
  const studio = { ...word, text: word.text + (st.verified ? '' : ' (unverified)') };
  return { blender, studio, needsFix: [blender, word].some((i) => i.tone === 'bad' || i.tone === 'warn') };
}

const NAME: Record<GameToolFix, string> = {
  'install-uv': 'uv', 'install-blender-mcp': 'Blender tools', 'blender-reset': 'Blender', 'studio-mcp-setting': 'Studio MCP',
};

/** A fix's fixed result word, in words. */
export function fixResultText(step: GameToolFix, result: string, detail?: string): string {
  switch (result) {
    case 'installed': return NAME[step] + ' installed.';
    case 'already-installed': return NAME[step] + ' is already installed.';
    case 'enabled': return 'Studio MCP is on. It takes effect when Studio next opens.';
    case 'already-on': return 'Studio MCP is already on.';
    case 'reset': return 'Blender will start again on the next Blender call.';
    case 'download-failed': return 'The download failed. Check the connection and try again.';
    case 'too-large':
    case 'hash-mismatch': return 'The download did not match the pinned file, so nothing was installed.';
    case 'unpack-failed': return 'uv could not be unpacked. Nothing was changed.';
    case 'uv-missing': return 'Install uv first.';
    case 'requirements-missing': return 'This Toki build is missing its Blender requirements file. Reinstall Toki.';
    case 'studio-running': return CLOSE_STUDIO;
    case 'menu-path': return detail ?? STUDIO_MENU_PATH;
    case 'busy': return 'Another game tools step is running. Try again when it finishes.';
    case 'unsupported': return 'Game tools run on a Windows PC hub only.';
    default: return 'That step failed (' + result + ').';
  }
}

/** In-app confirm text for steps that download or change files outside Toki. */
export function fixConfirm(step: GameToolFix, s: GameToolsStatus): { title: string; body: string; confirmLabel: string } | null {
  switch (step) {
    case 'install-uv': return { title: 'Install uv?', body: 'Toki downloads uv ' + s.uv.pinned + ' from GitHub, checks it against a pinned hash, and unpacks it into its own data folder. Your PATH is not changed.', confirmLabel: 'Install' };
    case 'install-blender-mcp': return { title: 'Install the Blender tools?', body: 'Toki uses uv to install the pinned Blender MCP tools (' + s.blenderMcp.version + ') into its own data folder, checking every package against a pinned hash. Your own Blender and its add-ons are not touched.', confirmLabel: 'Install' };
    case 'studio-mcp-setting': return { title: 'Turn on Studio MCP?', body: "Toki backs up Roblox Studio's assistant settings, then turns on only the MCP server option. Nothing else changes.", confirmLabel: 'Turn on' };
    case 'blender-reset': return null;
  }
}
