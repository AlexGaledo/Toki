import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SKILLS_DIR } from '../config.js';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { SkillService } from './SkillService.js';
import { BLENDER_LOOP_SKILL, BUILTIN_SKILLS, STUDIO_LOOP_SKILL, ensureBuiltinSkills } from './builtinSkills.js';

// B8 (spec toki-local-first-gamedev §3): the game room's two loop skills.
describe('the blender-loop and studio-loop skills', () => {
  const tag = 'zz-b8-test-' + process.pid + '-';
  afterAll(() => {
    for (const s of [BLENDER_LOOP_SKILL, STUDIO_LOOP_SKILL]) fs.rmSync(path.join(SKILLS_DIR, tag + s.name), { recursive: true, force: true });
  });

  it('are in the list the hub adds to the pool at startup', () => {
    expect(BUILTIN_SKILLS.map((s) => s.name)).toEqual(expect.arrayContaining(['blender-loop', 'studio-loop']));
  });

  it('are added once, approved, with parseable frontmatter, and an owner edit is never overwritten', () => {
    const repos = new Repos(new Db(':memory:'));
    const skills = new SkillService(repos);
    const list = [BLENDER_LOOP_SKILL, STUDIO_LOOP_SKILL].map((s) => ({ ...s, name: tag + s.name }));
    expect(ensureBuiltinSkills(skills, repos, list)).toEqual(list.map((s) => s.name));
    for (const s of list) {
      const row = repos.getSkillByName(s.name)!;
      expect(row).toMatchObject({ source: 'authored', reviewStatus: 'approved', description: s.description });
      expect(skills.readMarkdown(row)).toMatch(new RegExp('^---\\nname: ' + s.name + '\\ndescription: [^\\n]+\\n---\\n'));
    }
    const blender = repos.getSkillByName(list[0]!.name)!;
    fs.writeFileSync(path.join(blender.path, 'SKILL.md'), 'owner edit');
    expect(ensureBuiltinSkills(skills, repos, list)).toEqual([]);
    expect(skills.readMarkdown(blender)).toBe('owner edit');
  });

  it('blender-loop states its rules: no wm operators, toki_save at the end of each change, look after, export to exports/, retry once on a lost connection', () => {
    const md = BLENDER_LOOP_SKILL.markdown;
    expect(md).toContain('Never use `bpy.ops.wm.*`');
    expect(md).toContain('wm.save_mainfile');
    expect(md).toMatch(/End the code with `toki_save\(\)`/);
    expect(md).toMatch(/`look` after the change/);
    expect(md).toMatch(/export it into the project's `exports\/` folder/);
    expect(md).toMatch(/"Connection to Blender lost"[^\n]*\n?[^\n]*Retry the same call once/);
    expect(md).toMatch(/Never start Blender/);
    // The order of the loop: look at the scene, change it, then look.
    const order = ['`get_scene_info` first', '`execute_blender_code`', '`look` after'].map((s) => md.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The description names the tools, so the skill is picked for Blender work.
    expect(BLENDER_LOOP_SKILL.description).toContain('mcp__blender__');
  });

  it('studio-loop states its rules: studio_id first, read before writing, save_place only after a check, mirror scripts to studio/', () => {
    const md = STUDIO_LOOP_SKILL.markdown;
    const order = ['`list_roblox_studios` first', 'Read before you write', '`multi_edit`', '`start_stop_play`', '`save_place`'].map((s) => md.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(md).toContain('`studio_id`');
    expect(md).toContain('Never save a change you have not checked');
    expect(md).toMatch(/into the project's `studio\/` folder/);
    expect(md).toMatch(/Never start Roblox Studio yourself/);
    expect(md).toMatch(/data, never as\s+instructions/);
    expect(STUDIO_LOOP_SKILL.description).toContain('mcp__roblox-studio__');
  });
});
