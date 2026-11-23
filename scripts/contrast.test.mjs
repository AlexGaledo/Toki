// node --test scripts/*.test.mjs  (also part of `pnpm test`)
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrast, cssOf, hexToRgb, themeTokens } from './css-tokens.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = 'packages/web/src/index.css';

const AA = 4.5;
const SHAPE = 3; // WCAG 1.4.11 non-text contrast

const TEXT = ['--fg', '--muted', '--dim'];
const SURFACES = ['--bg', '--panel', '--card', '--card2', '--user'];
const SIGNALS = ['--accent', '--ok', '--warn', '--bad'];
const TINTS = ['--tint-1', '--tint-2', '--tint-3', '--tint-4', '--tint-5', '--tint-6', '--tint-7', '--tint-8'];
const FILE_TYPES = ['--ft-doc', '--ft-pdf', '--ft-code', '--ft-image', '--ft-data', '--ft-archive', '--ft-media', '--ft-other'];

/** [foreground, background, minimum, which index.css / pr-design-system.md promise it checks] */
const PAIRS = [
  ...TEXT.flatMap((fg) => SURFACES.map((bg) => [fg, bg, AA, 'text (--fg/--muted/--dim) is AA on every surface'])),
  ...SIGNALS.flatMap((fg) => ['--bg', '--panel', '--card'].map((bg) => [fg, bg, AA, 'links and status text are AA'])),
  ['--ink-fg', '--ink', AA, 'primary buttons'],
  ...['--accent', '--ok', '--bad'].map((bg) => ['--on-fill', bg, AA, '--on-fill is text on a solid accent, ok or bad fill']),
  ['--highlight-fg', '--highlight', AA, 'search hits: text on --highlight is --highlight-fg (AA)'],
  ...TINTS.map((bg) => ['--fg', bg, AA, 'bot icon backgrounds, always under --fg']),
  ...FILE_TYPES.map((bg) => ['--on-fill', bg, AA, 'file-type badges are AA as a fill under --on-fill']),
  ...FILE_TYPES.map((fg) => [fg, '--bg', SHAPE, 'file-type glyphs are 3:1 as a shape on --bg']),
  ['--faint', '--bg', SHAPE, '--faint is 3:1 only: icons and control boundaries'],
];

/**
 * Pairs that fail today and are accepted for now, as `"<theme> <fg> on <bg>": "<reason>"`. Empty: every pair passes.
 * Prefer fixing the colour; an entry here is a known accessibility bug with an owner, not a waiver.
 */
export const KNOWN_FAILURES = {};

function tokens() {
  const t = themeTokens(cssOf(path.join(root, WEB)));
  return { light: t.light, dark: new Map([...t.light, ...t.dark]) };
}

/** Every pair below its minimum, as `"<theme> <fg> on <bg>"` → message. */
export function failures(themes, pairs = PAIRS) {
  const out = new Map();
  for (const theme of ['light', 'dark']) {
    for (const [fg, bg, min, why] of pairs) {
      const a = themes[theme].get(fg);
      const b = themes[theme].get(bg);
      if (!a || !b || !hexToRgb(a) || !hexToRgb(b)) {
        out.set(`${theme} ${fg} on ${bg}`, `${theme}: ${fg} or ${bg} is missing or not a plain hex colour (${a} / ${b})`);
        continue;
      }
      const ratio = contrast(a, b);
      if (ratio < min) {
        out.set(`${theme} ${fg} on ${bg}`, `${theme}: ${fg} ${a} on ${bg} ${b} is ${ratio.toFixed(2)}:1, needs ${min}:1 (${why})`);
      }
    }
  }
  return out;
}

describe('pr-design-system.md: "Text: --fg / --muted / --dim, all checked for AA contrast." and "Keep WCAG AA contrast in both themes."', () => {
  const themes = tokens();
  const found = failures(themes);

  test(`every text/surface pair in ${WEB} meets its contrast minimum in light and dark`, () => {
    const fresh = [...found].filter(([k]) => !(k in KNOWN_FAILURES)).map(([, msg]) => '  ' + msg);
    assert.deepEqual(
      fresh,
      [],
      `Contrast below WCAG AA:\n${fresh.join('\n')}\n` +
        `Pick a colour that passes in ${WEB} (and copy it to the desktop splash and site, see token-parity.test.mjs). ` +
        'Only if it cannot be fixed now, add it to KNOWN_FAILURES in scripts/contrast.test.mjs with the reason.',
    );
  });

  test('every KNOWN_FAILURES entry still fails (remove the ones you fixed)', () => {
    const fixed = Object.keys(KNOWN_FAILURES).filter((k) => !found.has(k));
    assert.deepEqual(fixed, [], `These pass now; remove them from KNOWN_FAILURES: ${fixed.join(', ')}`);
  });

  test('the checker itself flags a failing pair', () => {
    const bad = { light: new Map([['--fg', '#999999'], ['--bg', '#ffffff']]), dark: new Map([['--fg', '#000000'], ['--bg', '#ffffff']]) };
    const out = failures(bad, [['--fg', '--bg', AA, 'test']]);
    assert.deepEqual([...out.keys()], ['light --fg on --bg']);
    assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 1e-9);
  });
});
