export interface TeamTemplate {
  id: 'dev' | 'game';
  /** As TEMPLATE.md says it: "Cloned from <label> template v<version>". */
  label: string;
  version: number;
  /** Stored as projects.kind. 'game' mounts Toki's headless Blender in the project's room. */
  kind: 'game' | null;
  roles: readonly { source: string; suffix: string; coordinator: boolean }[];
  skills: readonly string[];
  rules: readonly string[];
  /** Made inside the project folder, each with a .gitkeep so git keeps it. */
  folders: readonly string[];
  /** The project folder becomes a git repo with one first commit. */
  git: boolean;
}

export const DEV_TEAM_TEMPLATE = {
  id: 'dev',
  label: 'dev team',
  kind: null,
  folders: [],
  git: false,
  version: 5,
  roles: [
    { source: 'lead-engineer', suffix: 'lead', coordinator: true },
    { source: 'software-engineer', suffix: 'engineer', coordinator: false },
    { source: 'quality-engineer', suffix: 'quality', coordinator: false },
  ],
  skills: ['safe-shipping', 'project-map', 'prove-it'],
  rules: [
    "Never revert, discard, stash away or overwrite changes you did not make, even to tidy up. If someone else's work is in the way, say so and leave it.",
    'Never commit to or push the default branch. Work on a branch, open a pull request, and merge it yourself once its checks pass; the hub refuses a merge before that.',
    'Back up before changing anything live, and ask before anything destructive or hard to undo.',
    'Say what you verified and what you did not. "It should work" is not a result.',
    'Call each part of the product by the name in features/. When you add or change something a user can see or do, update its feature file in the same piece of work.',
  ],
} as const satisfies TeamTemplate;

/** Phase 2 of docs/specs/toki-local-first-gamedev.md: a lead, a Roblox Studio builder and a headless Blender artist. */
export const GAME_TEAM_TEMPLATE = {
  id: 'game',
  label: 'game team',
  kind: 'game',
  folders: ['art', 'exports', 'studio', 'places'],
  git: true,
  version: 1,
  roles: [
    { source: 'lead-engineer', suffix: 'lead', coordinator: true },
    { source: 'roblox-builder', suffix: 'builder', coordinator: false },
    { source: 'blender-artist', suffix: 'artist', coordinator: false },
  ],
  skills: ['safe-shipping', 'project-map', 'prove-it', 'studio-loop', 'blender-loop'],
  rules: [
    "Never revert, discard, stash away or overwrite changes you did not make, even to tidy up. If someone else's work is in the way, say so and leave it.",
    "Game files stay in this project folder: art/ holds the one Blender scene Toki opens for you, exports/ the .fbx and .glb files for Studio, studio/ text copies of the place's scripts, and places/ any .rbxl the owner saves.",
    'Blender runs headless and never on screen. Never use bpy.ops.wm.*; end each Blender change with toki_save().',
    "After a verified change, commit a checkpoint of art/, exports/ and studio/ in this folder's git repo. Say so when the .blend is over 50 MB.",
    'Back up before changing anything live, and ask before anything destructive or hard to undo.',
    'Say what you verified and what you did not. "It should work" is not a result; a look or a screen capture is.',
  ],
} as const satisfies TeamTemplate;

export const TEAM_TEMPLATES = { dev: DEV_TEAM_TEMPLATE, game: GAME_TEAM_TEMPLATE } as const satisfies Record<TeamTemplate['id'], TeamTemplate>;

const SETUP_HEADING = 'When the owner mentions you to create an agent';

export function cloneDescription(sourceDescription: string, projectName: string, dir: string, template: TeamTemplate = DEV_TEAM_TEMPLATE): string {
  const at = sourceDescription.indexOf(SETUP_HEADING);
  const role = (at >= 0 ? sourceDescription.slice(0, at) : sourceDescription).trim();
  return [
    role,
    'You work on the project ' + projectName + '. Its shared folder is ' + dir + ': read current.md there first, and keep it true when facts change. TEMPLATE.md there says which team template you came from.',
    'Rules:\n' + template.rules.map((r) => '- ' + r).join('\n'),
  ].join('\n\n');
}

export function templateRecord(projectName: string, today: string, skillsByHandle: Record<string, string[]>, template: TeamTemplate = DEV_TEAM_TEMPLATE): string {
  return [
    '---', 'status: current', 'updated: ' + today, '---', '',
    '# Team template for ' + projectName, '',
    'Cloned from ' + template.label + ' template v' + template.version + ' on ' + today + '. General practice comes from the template; what is true about this project belongs in current.md.', '',
    '## Team', '',
    ...Object.entries(skillsByHandle).map(([handle, skills]) => '- @' + handle + ': ' + (skills.length ? skills.join(', ') : 'no skills')),
    '', '## Rules', '',
    ...template.rules.map((r) => '- ' + r),
    '',
  ].join('\n');
}

export const FEATURES_README = [
  '# Feature map', '',
  'One file per part of the product a user can see or use, so the owner and every bot call it by the same name.',
  'Name files after the part (`checkout.md`, `sign-in.md`). Keep implementation details out.', '',
  'Each file: an H1 with the name, one paragraph on what the user can do, then exactly these four sections:', '',
  '## Sub-features', '',
  'The smaller parts, by the names the screen shows.', '',
  '## How to get to it (user POV)', '',
  'The clicks or steps from a fresh start.', '',
  '## How to prove it works', '',
  'Preconditions, then each action with the command or steps and what you should see. This is the evidence to show before saying done.', '',
  '## Gotchas', '',
  'What surprised someone before: required data, slow parts, things that look broken but are not.', '',
].join('\n');
