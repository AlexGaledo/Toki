import type { Repos } from '../db/repos.js';
import type { SkillService } from './SkillService.js';

export interface BuiltinSkill { name: string; description: string; markdown: string }

export const PROJECT_MAP_SKILL: BuiltinSkill = {
  name: 'project-map',
  description: "Draw or update the project's map (map.json) when the owner asks for a map, a system map, a roadmap or a change to the map.",
  markdown: `# Project map

Use this when the owner asks you to make, regenerate or change the project's map. The app draws the map from one
file, \`map.json\`, at the top of the project's shared folder (the folder that holds \`current.md\`). You write that
file; the app lays it out. Nothing else draws the map, so if you do not write the file there is no map.

## What to read first

- \`current.md\` in the project folder.
- \`repos.json\` there, if it exists, and the repos it lists that you can read (README, the top-level folders, the
  package or build files). Do not read the whole codebase; a map is an overview.

## Which kind

- \`architecture\`: a system map of a software project. Nodes are the main parts (apps, services, stores, models,
  outside services); edges are "talks to" or "depends on".
- \`roadmap\`: for anything else, or when the owner asks for a roadmap. Nodes are milestones in order, each with a
  \`state\` of \`done\`, \`now\` or \`next\`; edges link each milestone to the next.

If the owner named a kind, use it. Otherwise use \`architecture\` when the project has a repo, else \`roadmap\`.

## The file

Write exactly this shape, as JSON (no comments, no trailing commas):

\`\`\`json
{
  "version": 1,
  "kind": "architecture",
  "generatedBy": "your-handle",
  "generatedAt": "2026-11-20",
  "nodes": [
    { "id": "web", "label": "web app", "tech": "React + Vite", "group": "client" },
    { "id": "hub", "label": "hub", "tech": "Node, SQLite", "group": "core" }
  ],
  "edges": [["web", "hub", "active"]]
}
\`\`\`

- \`generatedBy\`: your own handle. \`generatedAt\`: today's date, YYYY-MM-DD.
- Node \`id\` and \`label\`: 1-40 characters, ids unique. \`tech\`: up to 60 characters. \`group\`: up to 20, best one of
  \`client\`, \`core\`, \`data\`, \`ai\`, \`infra\`. \`state\` only on roadmap nodes.
- Edges: \`[from, to]\` or \`[from, to, "active" | "off"]\`, by node id. \`active\` marks the path being worked on now;
  \`off\` marks something planned or switched off.
- Keep it to 30 nodes or fewer (the app refuses more than 60 nodes or 120 edges, or a file over 64 KB).
- No coordinates, colours or sizes: the app places every node.
- No secrets, keys, tokens, passwords, internal URLs, file paths or personal details. Labels are what the owner reads.
- Only what you found in the files. If something is unclear, leave it out and say so in your reply.

## After writing

Replace the whole file in one write. Then reply in one or two lines: what kind of map, how many nodes, and anything you
left out. If the owner asked for a change, change only that and keep the rest of the file as it was.
`,
};

/** Adapted from Lauren Tan's pstack (MIT, (c) 2026 Lauren Tan): prove-it-works, attack-the-premise, interrogate, swarm, correct. */
export const PROVE_IT_SKILL: BuiltinSkill = {
  name: 'prove-it',
  description: 'Before you say a task is done, after a second failed fix, when you review work, and when the owner corrects you twice for the same thing.',
  markdown: `# Prove it

Adapted from Lauren Tan's pstack (MIT).

## Before you say done
Check the real thing, not a proxy. Run the tests or build, open the page and take a screenshot, read the value back.
"It compiles" and "I wrote it" are not proof. Put the command and its result, or the screenshot, in your reply.
Never hand the owner a check you could run yourself. If you changed files and ran nothing after, the app marks your
reply "unverified".

## After two failed fixes
Stop patching. Write down the one sentence every failed fix assumed. Find an observation that would come out
differently if that sentence were false, and make it. Do not start a third fix until you have.

## When you review
Report only what you reproduced: the command you ran and what it printed. Leave out style and anything you did not
run. "No findings" is a valid result. When several bots split a check, each reports PASS, ISSUES or BLOCKED with its
evidence; a missing report is a gap, never a pass.

## When the owner corrects the same mistake twice
Do not just remember it. Propose a check that makes it impossible, best first: change the code or tool so the
mistake cannot happen; else a type, lint or test whose error says what to do instead; else a permission rule. Only a
judgment call becomes a written rule. Say which you chose and why a stronger one did not fit.
`,
};

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [PROJECT_MAP_SKILL, PROVE_IT_SKILL];

export function ensureBuiltinSkills(skills: SkillService, repos: Repos, list: readonly BuiltinSkill[] = BUILTIN_SKILLS): string[] {
  const added: string[] = [];
  for (const s of list) {
    if (repos.getSkillByName(s.name)) continue;
    const body = '---\nname: ' + s.name + '\ndescription: ' + s.description + '\n---\n\n' + s.markdown;
    skills.save(s.name, s.description, body, { source: 'authored' });
    added.push(s.name);
  }
  return added;
}
