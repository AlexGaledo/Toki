import type { GameProjectSetup, GameToolsStatus, TeamTemplateId } from '@pocketrocket/shared';

/** Settings › Projects › New project: the template picker (D3, spec toki-local-first-gamedev §3). */
export type TemplateChoice = 'none' | TeamTemplateId;

export const TEMPLATE_CHOICES: readonly { id: TemplateChoice; title: string; adds: string }[] = [
  { id: 'none', title: 'None', adds: 'Just the shared folder. Give bots access to it below.' },
  { id: 'dev', title: 'Dev team', adds: 'Adds a lead, an engineer and a quality engineer, with a group chat.' },
  { id: 'game', title: 'Game team', adds: 'Adds a lead, a Roblox builder and a Blender artist, a group chat with game tools, game folders and git.' },
];

const IN_GAME_TOOLS = ' in Settings › Game tools first.';

/**
 * Why a template can't be picked now, or null when it can. The game team needs Blender and Toki's Blender MCP tools
 * ready (spec D3); Studio is not required, because the room works without it until Studio is open.
 */
export function templateBlocked(choice: TemplateChoice, game: { status: GameToolsStatus | null; error: string | null }): string | null {
  if (choice !== 'game') return null;
  const s = game.status;
  if (!s) return game.error ? "Couldn't check Blender. Open Settings › Game tools to see why." : 'Checking Blender…';
  if (!s.supported) return 'Game tools need the hub on a Windows PC.';
  if (!s.blender.ok) return 'Install Blender' + IN_GAME_TOOLS;
  if (s.blenderMcp.reason === 'addon-mismatch') return 'Reinstall the Blender tools' + IN_GAME_TOOLS;
  if (!s.blenderMcp.ok) return 'Install the Blender tools' + IN_GAME_TOOLS;
  return null;
}

/** `POST /api/projects`. `template` wins over the older `team` flag on the hub, so only `template` is sent. */
export function createInput(name: string, choice: TemplateChoice): { name: string; template?: TeamTemplateId } {
  return choice === 'none' ? { name: name.trim() } : { name: name.trim(), template: choice };
}

export interface SetupLine { ok: boolean; text: string }

/** The game template's `setup` reply in plain words. Each word maps to a fixed sentence; nothing from the hub is echoed. */
export function setupLines(setup: GameProjectSetup): SetupLine[] {
  const git: SetupLine = setup.git === 'created' ? { ok: true, text: 'Git: the project folder now keeps a history, starting with a first commit.' }
    : setup.git === 'exists' ? { ok: true, text: 'Git: the folder already kept a history, so Toki left it as it was.' }
      : { ok: false, text: "Git: couldn't start a history in the folder, so checkpoints won't work yet. Check that git is installed." };
  const studio: SetupLine = setup.studio === 'added' ? { ok: true, text: "Roblox Studio: its tools are on in the game chat. They work while Studio is open." }
    : setup.studio === 'no-mcp-bat' ? { ok: false, text: "Roblox Studio: not linked, because Studio's MCP launcher isn't on this PC. Install or update Studio, then check Settings › Game tools." }
      : setup.studio === 'unsupported' ? { ok: false, text: 'Roblox Studio: not linked. Studio tools need the hub on a Windows PC.' }
        : { ok: false, text: "Roblox Studio: couldn't add its tools to the game chat. Settings › Tools shows what is set up." };
  return [git, studio];
}
