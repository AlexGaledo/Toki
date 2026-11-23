// Reads the colour/shape tokens (CSS custom properties) of one surface, per theme. Used by the token-parity
// and contrast tests (scripts/*.test.mjs); not a general CSS parser.
//
// A declaration counts when its rule's selector is exactly one of THEME_SELECTORS and the rule sits at the top
// level or inside `@media (prefers-color-scheme: dark)`. Anything else (`:root[data-font=...]`, `@media print`,
// component rules) is not a theme token and is skipped.
import fs from 'node:fs';

const THEME_SELECTORS = {
  ':root': 'light',
  '.dark': 'dark',
  ':root:not([data-theme="light"])': 'light', // only means dark inside the dark media query (see below)
  ':root[data-theme="dark"]': 'dark',
};

/** CSS text of a file; for .html, the contents of its <style> blocks. */
export function cssOf(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  if (!file.endsWith('.html')) return text;
  return [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
}

/** `{ light: Map<name, value>, dark: Map<name, value> }`. A later declaration of the same name wins, as in CSS. */
export function themeTokens(css) {
  const out = { light: new Map(), dark: new Map() };
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const stack = [];
  let buf = '';
  const flushDecl = () => {
    const decl = buf.trim();
    buf = '';
    const m = /^(--[\w-]+)\s*:\s*([\s\S]+)$/.exec(decl);
    if (!m) return;
    const theme = themeOf(stack);
    if (theme) out[theme].set(m[1], normalize(m[2]));
  };
  for (const ch of src) {
    if (ch === '{') {
      stack.push(buf.trim().replace(/\s+/g, ' '));
      buf = '';
    } else if (ch === '}') {
      flushDecl();
      stack.pop();
    } else if (ch === ';') {
      flushDecl();
    } else {
      buf += ch;
    }
  }
  return out;
}

function themeOf(stack) {
  if (stack.length === 0) return null;
  const selector = stack[stack.length - 1];
  const outer = stack.slice(0, -1);
  if (!(selector in THEME_SELECTORS)) return null;
  if (outer.length === 0) return selector === ':root:not([data-theme="light"])' ? null : THEME_SELECTORS[selector];
  if (outer.length === 1 && /^@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/.test(outer[0])) return 'dark';
  return null;
}

/** Lower case, single spaces, `.06` → `0.06`, so formatting alone never counts as a difference. */
export function normalize(value) {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/(^|[\s(,])\.(\d)/g, '$10.$2')
    .toLowerCase();
}

/** `#rgb`/`#rrggbb` → [r, g, b] in 0..255, or null for anything that is not a plain hex colour. */
export function hexToRgb(value) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** WCAG 2.x contrast ratio of two hex colours. */
export function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = hexToRgb(hex).map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
