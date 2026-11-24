/**
 * Game tools (spec toki-local-first-gamedev §2): what the PC hub detects for Blender, uv, the pinned Blender MCP
 * tools and Roblox Studio, and the fixed one-click steps. Every `reason` is a fixed word, never a tool's own text.
 */

export const GAME_TOOL_FIXES = ['install-uv', 'install-blender-mcp', 'blender-reset', 'studio-mcp-setting'] as const;
export type GameToolFix = (typeof GAME_TOOL_FIXES)[number];

export interface GameToolsBlender {
  ok: boolean;
  reason: 'found' | 'not-installed' | 'unsupported';
  exe: string | null;
  /** From `blender -b --factory-startup --version`; null when that did not answer. */
  version: string | null;
  /** Blender itself is never installed by Toki: the UI links to blender.org. */
  fix: null;
}

export interface GameToolsUv {
  ok: boolean;
  /** `system`: uv.exe on PATH. `toki`: Toki's own pinned copy under `<data>/tools/uv/`. */
  reason: 'system' | 'toki' | 'not-installed' | 'unsupported';
  path: string | null;
  version: string | null;
  /** The version `install-uv` installs. */
  pinned: string;
  fix: 'install-uv' | null;
}

export interface GameToolsBlenderMcp {
  ok: boolean;
  /** `addon-mismatch`: the add-on's sha256 differs from the one recorded at install. */
  reason: 'installed' | 'not-installed' | 'incomplete' | 'addon-mismatch' | 'unsupported';
  version: string;
  addonSha256: string | null;
  fix: 'install-blender-mcp' | null;
}

export interface GameToolsBlenderProcess {
  /** `other`: a blender.exe Toki did not start. `crashing`: the restart cap is hit until `blender-reset`. */
  state: 'stopped' | 'starting' | 'running' | 'other' | 'crashing' | 'unsupported';
  project: string | null;
  pid: number | null;
  port: number | null;
  idleMs: number | null;
  /** The other Blender's image name, for "Another Blender is running". */
  exe: string | null;
  crashes: number;
  /** `<data>/run/blender/last-crash.log` exists: "Open log" reads `GET /api/game-tools/blender/crash-log`. */
  crashLog: boolean;
  fix: 'blender-reset' | null;
}

export interface GameToolsStudio {
  ok: boolean;
  /** First failing check, in order: mcp.bat, StudioMCP.exe, the `mcp-server` setting, the process. */
  reason: 'ready' | 'no-mcp-bat' | 'no-studio-mcp' | 'setting-off' | 'setting-unknown' | 'not-running' | 'unsupported';
  mcpBat: boolean;
  studioMcp: boolean;
  setting: 'on' | 'off' | 'unknown' | 'missing';
  running: boolean;
  /** False until S2 checks the live Studio steps. */
  verified: boolean;
  fix: 'studio-mcp-setting' | null;
}

export interface GameToolsStatus {
  supported: boolean;
  blender: GameToolsBlender;
  uv: GameToolsUv;
  blenderMcp: GameToolsBlenderMcp;
  blenderProcess: GameToolsBlenderProcess;
  studio: GameToolsStudio;
}

/** `POST /api/game-tools/fix/:step`. `result` is a fixed word. */
export interface GameToolFixResult {
  ok: boolean;
  step: GameToolFix;
  result: string;
  /** Files or folders the step changed, for the audit row and the UI. */
  changed: string[];
  status: GameToolsStatus;
}
