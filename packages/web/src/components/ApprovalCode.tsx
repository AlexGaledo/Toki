import type { ApprovalCode } from '../lib/approvalCode';

/**
 * D5: a card's script as code, with real line breaks, in a scroll area up to 60% of the viewport that the keyboard can
 * scroll (it takes focus after the card's text and before its buttons). The other fields are a short key-value list.
 */
export function ApprovalCodeView({ code: c, label }: { code: ApprovalCode; label: string }) {
  return (
    <div className="mx-4 mb-3 space-y-2">
      {c.fields.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-hint">
          {c.fields.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-muted">{k}</dt>
              <dd className="line-clamp-3 font-mono [overflow-wrap:anywhere]">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <pre
        tabIndex={0}
        role="region"
        aria-label={label}
        className="max-h-[60vh] min-h-24 overflow-auto whitespace-pre-wrap rounded-md bg-card2 p-3 font-mono text-hint leading-relaxed text-fg [overflow-wrap:anywhere] [tab-size:2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      ><code>{c.code}</code></pre>
    </div>
  );
}
