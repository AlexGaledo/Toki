import { describe, expect, it } from 'vitest';
import { approvalCode } from './approvalCode';

const LUAU = 'local part = Instance.new("Part")\npart.Anchored = true\n\tpart.Parent = workspace\nprint("TAIL_OK")';

describe('approvalCode', () => {
  it('reads the field from toolInput.input on an outside-server card', () => {
    const r = approvalCode({ codeField: 'code', toolInput: { server: 'roblox-studio', tool: 'execute_luau', input: { code: LUAU, studio_id: 's1' } } });
    expect(r).toEqual({ field: 'code', code: LUAU, fields: [['studio_id', 's1']] });
    expect(r?.code.split('\n')).toHaveLength(4);
  });

  it('reads the field from toolInput itself on a normal card', () => {
    const r = approvalCode({ codeField: 'code', toolInput: { code: 'import bpy\nbpy.ops.mesh.primitive_cube_add()', user_prompt: 'a cube' } });
    expect(r?.code).toBe('import bpy\nbpy.ops.mesh.primitive_cube_add()');
    expect(r?.fields).toEqual([['user_prompt', 'a cube']]);
  });

  it('does not take a top-level field of the same name over the tool input', () => {
    const r = approvalCode({ codeField: 'code', toolInput: { server: 's', tool: 't', code: 'wrong', input: { code: 'right' } } });
    expect(r?.code).toBe('right');
  });

  it('shows non-string fields as compact JSON', () => {
    const r = approvalCode({ codeField: 'code', toolInput: { code: 'x', timeout: 30, opts: { a: [1] } } });
    expect(r?.fields).toEqual([['timeout', '30'], ['opts', '{"a":[1]}']]);
  });

  // Studio's multi_edit: `edits: [{old_string, new_string, replace_all?}]`, applied in order.
  it('shows a multi_edit edits list as old and new lines, in order', () => {
    const r = approvalCode({
      codeField: 'edits',
      toolInput: { server: 'roblox-studio', tool: 'multi_edit', input: {
        file_path: 'game.ServerScriptService.TokiEdit',
        edits: [{ old_string: 'local a = 1\nprint(a)', new_string: 'local a = 2\nprint(a)' }, { old_string: 'a', new_string: 'b', replace_all: true }],
        studio_id: 's1',
      } },
    });
    expect(r?.field).toBe('edits');
    expect(r?.code).toBe('edit 1 of 2\n- local a = 1\n- print(a)\n+ local a = 2\n+ print(a)\n\nedit 2 of 2, every match\n- a\n+ b');
    expect(r?.fields).toEqual([['file_path', 'game.ServerScriptService.TokiEdit'], ['studio_id', 's1']]);
  });

  it('shows a new script (empty old_string) as added lines only', () => {
    const r = approvalCode({ codeField: 'edits', toolInput: { edits: [{ old_string: '', new_string: 'print("hi")' }], className: 'Script' } });
    expect(r?.code).toBe('edit 1 of 1\n+ print("hi")');
  });

  it('is null for an edits list that is empty or holds a non-text edit', () => {
    expect(approvalCode({ codeField: 'edits', toolInput: { edits: [] } })).toBeNull();
    expect(approvalCode({ codeField: 'edits', toolInput: { edits: [{ old_string: 'a', new_string: 1 }] } })).toBeNull();
    expect(approvalCode({ codeField: 'edits', toolInput: { edits: ['a'] } })).toBeNull();
  });

  it('is null without a codeField, or when the field is missing or not text', () => {
    expect(approvalCode({ toolInput: { code: 'x' } })).toBeNull();
    expect(approvalCode({ codeField: 'code', toolInput: { script: 'x' } })).toBeNull();
    expect(approvalCode({ codeField: 'code', toolInput: { code: 42 } })).toBeNull();
    expect(approvalCode({ codeField: 'code', toolInput: 'code' })).toBeNull();
  });
});
