// D1 on the real server's page with no window on the owner's screen: a headless browser through a private
// `ssh -L 127.0.0.1:7797 -> server 127.0.0.1:7788` (the desktop's own tunnel is 7790; this one is separate and closed after).
// The server's hub token comes in through HUB_TOKEN (read over ssh by the caller, never printed) and is handed to the page
// the way the desktop shell does (`#token=`, stripped by web/src/lib/auth.ts). Read-only: menu, tab and Escape presses.
//   HUB_TOKEN=... node d1_server_headless.mjs <private-dir> <repo-out-file>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import url from 'node:url';

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const { chromium } = require(path.join(REPO, 'node_modules', '.pnpm', 'playwright-core@1.63.0-alph_366827a5428b9a0886a8dc7ca3b95a5e', 'node_modules', 'playwright-core'));
const [privDir, repoOut] = process.argv.slice(2);
const token = process.env.HUB_TOKEN;
if (!privDir || !repoOut || !token) throw new Error('usage: HUB_TOKEN=... d1_server_headless.mjs <private-dir> <repo-out-file>');
const ORIGIN = 'http://127.0.0.1:7797';
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((f) => fs.existsSync(f));
const browser = await chromium.launch({ headless: true, executablePath: exe });
const p = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await p.goto(ORIGIN + '/#token=' + encodeURIComponent(token));
await p.waitForLoadState('domcontentloaded');
console.log('page: ' + p.url().replace(/#.*/, '') + ' (token fragment stripped: ' + !p.url().includes('token=') + ')');
await p.getByRole('button', { name: /^Menu for / }).first().click({ timeout: 30_000 });
await p.getByRole('menuitem', { name: 'Settings' }).click();
const dlg = p.getByRole('dialog', { name: 'Settings' });
await dlg.getByRole('tab', { name: 'Game tools' }).click();
const panel = dlg.getByRole('tabpanel', { name: 'Game tools' });
await panel.waitFor();
await p.waitForTimeout(1500);
const full = await dlg.ariaSnapshot();
const only = await panel.ariaSnapshot();
fs.mkdirSync(privDir, { recursive: true });
fs.writeFileSync(path.join(privDir, '14-d1-server-game-tools-headless.aria.yml'), full + '\n');
await p.screenshot({ path: path.join(privDir, '14-d1-server-game-tools-headless.png') });
if (/@|alex|galedo/i.test(only)) throw new Error('the tabpanel snapshot holds a name or email; not writing it to the repo');
fs.writeFileSync(repoOut, '# D1 on the real server hub (headless browser, private ssh -L 7797 -> server 7788), ' + new Date().toISOString() + '\n'
  + '# Settings > Game tools: the tabpanel only (the full snapshot and screenshot are kept off the repo)\n' + only + '\n');
console.log(only);
await browser.close();
