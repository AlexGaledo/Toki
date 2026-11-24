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

  it('is null without a codeField, or when the field is missing or not text', () => {
    expect(approvalCode({ toolInput: { code: 'x' } })).toBeNull();
    expect(approvalCode({ codeField: 'code', toolInput: { script: 'x' } })).toBeNull();
    expect(approvalCode({ codeField: 'code', toolInput: { code: 42 } })).toBeNull();
    expect(approvalCode({ codeField: 'code', toolInput: 'code' })).toBeNull();
  });
});
