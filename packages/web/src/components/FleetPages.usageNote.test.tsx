import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SHARED_SUBSCRIPTION_NOTE } from '@pocketrocket/shared';

// B11 on the Usage page: the hub's shared-subscription note, shown as plain text, and nothing without it.
vi.mock('../store', () => ({ useStore: () => undefined, botById: () => undefined, selectActiveRoom: () => undefined }));

let SubscriptionNote: typeof import('./FleetPages').SubscriptionNote;
beforeAll(async () => {
  ({ SubscriptionNote } = await import('./FleetPages'));
}, 60000);

const html = (note: unknown) => renderToStaticMarkup(<SubscriptionNote note={note} />);

describe('the shared-subscription note on the Usage page', () => {
  it('shows the hub\'s words', () => {
    expect(html(SHARED_SUBSCRIPTION_NOTE)).toContain('same Claude subscription');
  });

  it('NEGATIVE: shows nothing when the hub sent no note, an empty one, or not a string', () => {
    for (const note of [undefined, null, '', '   ', 42, { __html: '<b>x</b>' }, ['a']]) expect(html(note)).toBe('');
  });

  it('NEGATIVE: renders the note as text, never as HTML', () => {
    const out = html('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
});
