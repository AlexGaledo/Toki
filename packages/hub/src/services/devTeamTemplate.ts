export const DEV_TEAM_TEMPLATE = {
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
} as const;

const SETUP_HEADING = 'When the owner mentions you to create an agent';

export function cloneDescription(sourceDescription: string, projectName: string, dir: string): string {
  const at = sourceDescription.indexOf(SETUP_HEADING);
  const role = (at >= 0 ? sourceDescription.slice(0, at) : sourceDescription).trim();
  return [
    role,
    'You work on the project ' + projectName + '. Its shared folder is ' + dir + ': read current.md there first, and keep it true when facts change. TEMPLATE.md there says which team template you came from.',
    'Rules:\n' + DEV_TEAM_TEMPLATE.rules.map((r) => '- ' + r).join('\n'),
  ].join('\n\n');
}

export function templateRecord(projectName: string, today: string, skillsByHandle: Record<string, string[]>): string {
  return [
    '---', 'status: current', 'updated: ' + today, '---', '',
    '# Team template for ' + projectName, '',
    'Cloned from dev team template v' + DEV_TEAM_TEMPLATE.version + ' on ' + today + '. General practice comes from the template; what is true about this project belongs in current.md.', '',
    '## Team', '',
    ...Object.entries(skillsByHandle).map(([handle, skills]) => '- @' + handle + ': ' + (skills.length ? skills.join(', ') : 'no skills')),
    '', '## Rules', '',
    ...DEV_TEAM_TEMPLATE.rules.map((r) => '- ' + r),
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
