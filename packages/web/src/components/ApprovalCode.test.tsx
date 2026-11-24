import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { approvalCode } from '../lib/approvalCode';
import { ApprovalCodeView } from './ApprovalCode';

const LUAU = 'local part = Instance.new("Part")\npart.Anchored = true\nprint("TAIL_OK")';

describe('ApprovalCodeView', () => {
  const c = approvalCode({ codeField: 'code', toolInput: { server: 'roblox-studio', tool: 'execute_luau', input: { code: LUAU, studio_id: 's1' } } });
  if (!c) throw new Error('no code picked');
  const html = renderToStaticMarkup(<ApprovalCodeView code={c} label="code for execute_luau" />);

  it('renders the script with real line breaks, not escaped \\n', () => {
    expect(html).toContain('<code>local part = Instance.new(&quot;Part&quot;)\npart.Anchored = true\nprint(&quot;TAIL_OK&quot;)</code>');
    expect(html).not.toContain('\\n');
  });

  it('is monospace, in a taller keyboard-scrollable area', () => {
    const pre = /<pre[^>]*>/.exec(html)?.[0] ?? '';
    expect(pre).toContain('font-mono');
    expect(pre).toContain('max-h-[60vh]');
    expect(pre).toContain('overflow-auto');
    expect(pre).toContain('tabindex="0"');
    expect(pre).toContain('aria-label="code for execute_luau"');
  });

  it('lists the other fields as key-value pairs, not the code again', () => {
    expect(html).toContain('<dt class="font-mono text-muted">studio_id</dt>');
    expect(html.match(/TAIL_OK/g)).toHaveLength(1);
  });
});
