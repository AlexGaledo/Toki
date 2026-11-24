// Keyboard Tab walk for a control-toki run (docs/verify/ui-gaps). The driver can press keys but cannot say what has
// focus, so this connects over the run's CDP port, puts focus on a starting control the way a click would, presses
// Tab (real key events) until focus comes back to the start or leaves the dialog, and prints one line per stop:
// role, accessible name, disabled, whether a focus ring is drawn, and whether it is inside the given tabpanel.
// Then it walks back with Shift+Tab the same way. Usage (repo root):
//   node docs/verify/ui-gaps/scripts/tab_walk.mjs <run root> <start role:name> [tabpanel name] [max stops]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [root, start, panel = 'Game tools', maxArg = '60'] = process.argv.slice(2);
if (!root || !start) throw new Error('usage: tab_walk.mjs <run root> <start role:name> [tabpanel] [max]');
const max = Number(maxArg);
const s = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
const hubReq = createRequire(path.resolve('packages/hub/package.json'));
const req = createRequire(hubReq.resolve('@playwright/mcp/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright-core')).href).then((m) => m.default ?? m);
const browser = await pw.chromium.connectOverCDP('http://127.0.0.1:' + s.ports.cdp, { timeout: 10_000 });
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith(s.webUrl));
if (!page) throw new Error('no app tab');

const [role, ...nameParts] = start.split(':');
const startEl = () => page.getByRole(role, { name: nameParts.join(':'), exact: true }).first();
await startEl().evaluate((el) => el.setAttribute('data-walk-start', ''));
await startEl().focus();

const here = () => page.evaluate((panelName) => {
  const el = document.activeElement;
  if (!el || el === document.body) return { role: 'body', name: '', disabled: false, ring: false, inPanel: false, inDialog: false };
  const cs = getComputedStyle(el);
  const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
  const label = el.getAttribute('aria-label')
    || (el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent)
    || el.textContent || el.getAttribute('title') || '';
  const tag = el.tagName.toLowerCase();
  const roleOf = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? 'textbox' : tag === 'pre' ? 'pre(region)' : tag);
  const tp = el.closest('[role="tabpanel"]');
  const tpName = tp ? (tp.getAttribute('aria-label') || (tp.getAttribute('aria-labelledby') && document.getElementById(tp.getAttribute('aria-labelledby'))?.textContent) || '') : '';
  return {
    start: el.hasAttribute('data-walk-start'), html: el.outerHTML.slice(0, 120),
    role: roleOf, name: label.replace(/\s+/g, ' ').trim().slice(0, 80), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
    ring: !!ring, inPanel: !!tp && tpName.trim() === panelName, inDialog: !!el.closest('[role="dialog"],[role="alertdialog"]'),
    visible: (() => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })(),
  };
}, panel);

async function walk(dir) {
  const out = [await here()];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(dir);
    await page.waitForTimeout(60);
    const h = await here();
    out.push(h);
    if (h.start || !h.inDialog) break;
  }
  return out;
}
const fmt = (h, i) => String(i).padStart(2) + '  ' + (h.inPanel ? 'panel ' : h.inDialog ? 'dialog' : 'OUTSIDE') + '  '
  + h.role + ' "' + h.name + '"' + (h.disabled ? ' [disabled]' : '') + (h.ring ? '' : '  NO-RING') + (h.visible === false ? '  INVISIBLE' : '') + (process.env.WALK_HTML ? '  ' + h.html : '');
console.log('# Tab from ' + start);
(await walk('Tab')).forEach((h, i) => console.log(fmt(h, i)));
await startEl().focus();
console.log('# Shift+Tab from ' + start);
(await walk('Shift+Tab')).forEach((h, i) => console.log(fmt(h, i)));
await startEl().evaluate((el) => el.removeAttribute('data-walk-start'));
await browser.close();
