import { describe, expect, it } from 'vitest';
import type { ApprovalPayload, Message } from '@pocketrocket/shared';
import { approvalSummary } from './approvalWords';
import { selectInbox } from './inbox';

/** B4's outside-tool card payload, as phase1-ui's seeder raised it (docs/verify/phase1-ui/README.md). */
const LUAU = '\n  -- build the start pad\nlocal part = Instance.new("Part")\npart.Anchored = true\nprint("TAIL_LUAU_3K_OK")';
const luauCard = (input: unknown, codeField: string | undefined = 'code') => ({
  toolName: 'mcp__roblox-studio__execute_luau',
  toolInput: { server: 'roblox-studio', tool: 'execute_luau', input },
  ...(codeField ? { codeField } : {}),
});

describe('approvalSummary (follow-up c)', () => {
  it('reads "<server> · <tool>" plus the first line of the code field, not escaped JSON', () => {
    const s = approvalSummary(luauCard({ code: LUAU, studio_id: 's1' }));
    expect(s).toBe('roblox-studio · execute_luau: -- build the start pad');
    expect(s).not.toMatch(/\\n|[{}"]/);
  });

  it('reads an older card whose input is a JSON string the same way', () => {
    expect(approvalSummary(luauCard(JSON.stringify({ code: 'import bpy\nbpy.ops.mesh.primitive_cube_add()' }), 'code')))
      .toBe('roblox-studio · execute_luau: import bpy');
  });

  it('shows just "<server> · <tool>" when there is no code field', () => {
    expect(approvalSummary({ toolName: 'mcp__blender__look', toolInput: { server: 'blender', tool: 'look', input: { view: 'front' } } }))
      .toBe('blender · look');
    expect(approvalSummary(luauCard({ code: '   \n  ' }))).toBe('roblox-studio · execute_luau');
  });

  it('keeps one short line', () => {
    const s = approvalSummary(luauCard({ code: 'x'.repeat(500) }));
    expect(s.length).toBe(160);
    expect(s.startsWith('roblox-studio · execute_luau: xxx')).toBe(true);
  });

  it('leaves the other cards as they were', () => {
    expect(approvalSummary({ toolName: 'Bash', toolInput: { command: 'pnpm   test', description: 'run' } })).toBe('pnpm test');
    expect(approvalSummary({ toolName: 'handoff', toolInput: { task: 'Fix the login', context: 'x' } })).toBe('Fix the login');
    expect(approvalSummary({ toolName: 'Write', toolInput: { file_path: 'a.md' } })).toBe('{ "file_path": "a.md" }');
  });
});

describe('Needs you rows carry the code field', () => {
  it('passes codeField from the card to the row, so the preview can find the code', () => {
    const m: Message = {
      id: 'm1', roomId: 'r1', seq: 1, authorType: 'bot', authorId: 'b1', kind: 'approval', text: '', causeId: null, hop: 0, turnId: null, createdAt: 1,
      payload: { approvalId: 'a1', reason: 'run Luau', danger: false, status: 'pending', ...luauCard({ script: LUAU }, 'script') } as ApprovalPayload,
    };
    const [row] = selectInbox({ openApprovals: [], messages: { r1: [m] }, control: {}, skills: [] });
    expect(row.approval && approvalSummary(row.approval)).toBe('roblox-studio · execute_luau: -- build the start pad');
  });
});
