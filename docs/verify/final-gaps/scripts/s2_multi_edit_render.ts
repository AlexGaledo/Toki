/**
 * S2, the browser half: reopen the throwaway data dir that `s2_multi_edit.ts` used (no model turn, no Studio) and
 * capture the two real `multi_edit` cards that turn stored, as this branch's web renders them. The cards are answered
 * (status `allow`), and an answered card keeps the same `ApprovalCodeView`.
 * From packages/hub, with POCKETROCKET_DATA = that data dir and POCKETROCKET_WEB_DIST set:
 *   npx tsx ../../docs/verify/final-gaps/scripts/s2_multi_edit_render.ts <evidence-dir> <chromium-exe>
 * The hub token is never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createHub } from '../../../../packages/hub/src/hub.js';
import { DATA_DIR, WEB_DIST } from '../../../../packages/hub/src/config.js';

const TOKEN = crypto.randomBytes(24).toString('base64url');
const [outArg, exe] = process.argv.slice(2);
const OUT = path.resolve(outArg ?? '.');
const REPO = path.resolve(process.cwd(), '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const { chromium } = require(path.join(REPO, 'node_modules', '.pnpm', 'playwright-core@1.63.0-alph_366827a5428b9a0886a8dc7ca3b95a5e', 'node_modules', 'playwright-core'));
const log = (s: string) => console.log(new Date().toTimeString().slice(0, 8) + ' ' + s);

async function main() {
  if (!DATA_DIR.startsWith(path.resolve(process.env.TEMP ?? '/tmp')) || !fs.existsSync(path.join(DATA_DIR, 'pocketrocket.db'))) throw new Error('POCKETROCKET_DATA must be the throwaway dir under %TEMP%');
  fs.mkdirSync(OUT, { recursive: true });
  const hub = createHub({ port: 0, token: TOKEN, seedBots: false });
  const port = await hub.listen();
  log('throwaway hub (same data dir, restarted) on 127.0.0.1:' + port + '; web dist ' + WEB_DIST);
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
    await page.goto('http://127.0.0.1:' + port + '/?project=studio-edit#token=' + TOKEN, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    log('page: ' + page.url().replace(/#.*/, '#<fragment>'));
    const regions = page.getByRole('region', { name: 'edits for multi_edit' });
    await regions.first().waitFor({ timeout: 45_000 });
    const n = await regions.count();
    log('code regions "edits for multi_edit": ' + n);
    for (let i = 0; i < n; i++) {
      const region = regions.nth(i);
      await region.scrollIntoViewIfNeeded();
      const card = region.locator('xpath=ancestor::*[.//*[contains(normalize-space(), "Needs your OK")]][1]');
      const aria = await card.ariaSnapshot();
      const name = 's2-multi-edit-card' + (i + 1);
      fs.writeFileSync(path.join(OUT, name + '.aria.yml'), '# throwaway hub 127.0.0.1:' + port + ', real multi_edit card ' + (i + 1) + ' of ' + n + ' from the Studio turn, ' + new Date().toISOString() + '\n' + aria + '\n');
      await card.screenshot({ path: path.join(OUT, name + '.png') });
      log(name + ' code:\n' + (await region.innerText()).split('\n').map((l: string) => '      | ' + l).join('\n'));
      console.log(aria.split('\n').map((l: string) => '      ' + l).join('\n'));
    }
    await page.screenshot({ path: path.join(OUT, 's2-multi-edit-room.png') });
    log('saved ' + n + ' card shots, ARIA files and s2-multi-edit-room.png');
  } finally {
    await browser.close().catch(() => {});
    await hub.shutdown();
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
