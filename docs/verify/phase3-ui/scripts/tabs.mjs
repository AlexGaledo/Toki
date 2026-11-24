// Lists the run's browser tabs and closes the ones a desktop call opened (`?openproject=`, `?openfolder=`,
// `?openhost=`). In the real shell those URLs never load: the desktop app takes them. In a plain Chromium they open as
// a tab of the app, which this closes again so the driver keeps working on the first tab.
// Usage (repo root): node docs/verify/phase3-ui/scripts/tabs.mjs <run root>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [root] = process.argv.slice(2);
if (!root) throw new Error('usage: tabs.mjs <run root>');
const s = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
const hubReq = createRequire(path.resolve('packages/hub/package.json'));
const req = createRequire(hubReq.resolve('@playwright/mcp/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright-core')).href).then((m) => m.default ?? m);
const browser = await pw.chromium.connectOverCDP('http://127.0.0.1:' + s.ports.cdp, { timeout: 10_000 });
for (const page of browser.contexts().flatMap((c) => c.pages())) {
  const u = new URL(page.url());
  const call = ['openproject', 'openfolder', 'openhost', 'connecthost'].find((k) => u.searchParams.has(k));
  console.log((call ? 'closed  ' : 'kept    ') + u.pathname + u.search);
  if (call) await page.close();
}
await browser.close();
