// Narrow-width evidence for a control-toki run: the driver has no viewport command, and a CDP viewport override ends
// when its session detaches, so this sets 390x844, saves a screenshot and an ARIA snapshot, and restores 1400x900 in
// one session. Usage (repo root): node docs/verify/phase1-ui/scripts/narrow.mjs <run root> <out path without ext>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [root, out] = process.argv.slice(2);
if (!root || !out) throw new Error('usage: narrow.mjs <run root> <out path without extension>');
const s = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
const hubReq = createRequire(path.resolve('packages/hub/package.json'));
const req = createRequire(hubReq.resolve('@playwright/mcp/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright-core')).href).then((m) => m.default ?? m);
const browser = await pw.chromium.connectOverCDP('http://127.0.0.1:' + s.ports.cdp, { timeout: 10_000 });
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith(s.webUrl));
if (!page) throw new Error('no app tab');
const outer = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
fs.mkdirSync(path.dirname(out), { recursive: true });
await page.screenshot({ path: out + '.png' });
fs.writeFileSync(out + '.aria.yml', await page.locator('body').ariaSnapshot());
console.log('narrow 390x844 saved', out + '.png', out + '.aria.yml', 'was', outer.w + 'x' + outer.h);
await page.setViewportSize({ width: outer.w, height: outer.h });
await browser.close();
