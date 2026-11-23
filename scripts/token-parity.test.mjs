// node --test scripts/*.test.mjs  (also part of `pnpm test`)
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cssOf, themeTokens } from './css-tokens.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = 'packages/web/src/index.css';
const COPIES = ['packages/desktop/ui/index.html', 'packages/site/styles.css'];

/**
 * Tokens a copy deliberately sets to a different value than the web app. Keyed `<file> <--name>`, both themes.
 * Adding an entry is a design decision: give the reason, so the next person can tell it from drift.
 */
export const PARITY_ALLOW = {
  'packages/desktop/ui/index.html --shadow-lg':
    'the splash has one connection card floating on an empty window, so it uses a wider, softer lift than the app dialog shadow',
  'packages/site/styles.css --shadow':
    'the marketing page puts its own soft shadow under feature cards and screenshots; not the composer/menu shadow of the app',
  'packages/site/styles.css --shadow-lg':
    'the site product shot sits on a large band and needs a deeper, wider shadow than an app dialog',
  'packages/site/styles.css --font-display':
    'the site loads static Nunito/Figtree from Google Fonts; the app bundles "Nunito Variable" via @fontsource over --app-font',
};

/** Effective tokens per theme: dark inherits every light value it does not override, as in the browser. */
function effective(file) {
  const t = themeTokens(cssOf(path.join(root, file)));
  return { light: t.light, dark: new Map([...t.light, ...t.dark]) };
}

describe('pr-design-system.md: "Token parity: the splash page and the site copy these tokens. If you change a token, update all three surfaces or say why not."', () => {
  const web = effective(WEB);

  for (const file of COPIES) {
    test(`${file} matches ${WEB} on every token they share, in both themes`, () => {
      const copy = effective(file);
      const drift = [];
      for (const theme of ['light', 'dark']) {
        for (const [name, value] of copy[theme]) {
          if (!web[theme].has(name) || web[theme].get(name) === value) continue;
          if (`${file} ${name}` in PARITY_ALLOW) continue;
          drift.push(`  ${theme} ${name}: ${WEB} has "${web[theme].get(name)}", ${file} has "${value}"`);
        }
      }
      assert.deepEqual(
        drift,
        [],
        `Token drift between surfaces:\n${drift.join('\n')}\n` +
          'Update the same token on all three surfaces (web index.css, desktop splash, site styles.css). If the ' +
          'difference is on purpose, add `"<file> <--name>": "<why>"` to PARITY_ALLOW in scripts/token-parity.test.mjs.',
      );
    });

    test(`every PARITY_ALLOW entry for ${file} is still needed`, () => {
      const copy = effective(file);
      const stale = Object.keys(PARITY_ALLOW)
        .filter((k) => k.startsWith(file + ' '))
        .map((k) => k.slice(file.length + 1))
        .filter((name) => !['light', 'dark'].some((t) => copy[t].has(name) && web[t].has(name) && copy[t].get(name) !== web[t].get(name)));
      assert.deepEqual(stale, [], `These tokens match again (or are gone); remove them from PARITY_ALLOW: ${stale.join(', ')}`);
    });
  }

  test('the copies are parsed at all (guards against a parser that silently finds nothing)', () => {
    for (const file of COPIES) {
      const copy = effective(file);
      for (const name of ['--bg', '--fg', '--muted', '--accent']) {
        assert.ok(copy.light.has(name) && copy.dark.has(name), `${file}: no ${name} found in light and dark`);
      }
      assert.notEqual(copy.light.get('--bg'), copy.dark.get('--bg'), `${file}: dark --bg was not read`);
    }
  });
});
