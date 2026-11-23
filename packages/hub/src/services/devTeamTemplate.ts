export const DEV_TEAM_TEMPLATE = {
  version: 3,
  roles: [
    { source: 'lead-engineer', suffix: 'lead', coordinator: true },
    { source: 'software-engineer', suffix: 'engineer', coordinator: false },
    { source: 'quality-engineer', suffix: 'quality', coordinator: false },
  ],
  skills: ['safe-shipping', 'project-map', 'prove-it'],
  rules: [
    "Never revert, discard, stash away or overwrite changes you did not make, even to tidy up. If someone else's work is in the way, say so and leave it.",
    'Never commit to or push the default branch. Work on a branch and open a pull request for the owner to review.',
    'Back up before changing anything live, and ask before anything destructive or hard to undo.',
    'Say what you verified and what you did not. "It should work" is not a result.',
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
