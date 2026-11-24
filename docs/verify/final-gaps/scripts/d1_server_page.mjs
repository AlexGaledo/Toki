// D1 on the real server's page: Settings › Game tools on the server hub, read-only, through the desktop's tunnel (7790).
// Toki must run with the WebView2 debug port 9339. If the window is on the PC hub it is sent to the server the way
// the tray's Open your server does (window.open('/?openhost=server'), both server::connect(Open::Home)).
//   node d1_server_page.mjs <private-dir> <repo-out-file>
// The full screenshot and ARIA snapshot show the owner's real data, so they go only to <private-dir>. The repo file gets
// the Game tools tabpanel's ARIA lines only, refused if it holds an "@" or the owner's names.
// Nothing is written to either hub: only menu, tab and Escape key presses in the page.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import url from 'node:url';

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const { chromium } = require(path.join(REPO, 'node_modules', '.pnpm', 'playwright-core@1.63.0-alph_366827a5428b9a0886a8dc7ca3b95a5e', 'node_modules', 'playwright-core'));
const [privDir, repoOut] = process.argv.slice(2);
if (!privDir || !repoOut) throw new Error('usage: d1_server_page.mjs <private-dir> <repo-out-file>');
const ts = () => new Date().toTimeString().slice(0, 8);
const log = (s) => console.log(ts() + ' ' + s);
const cut = (u) => String(u).replace(/#.*/, '#<fragment>');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9339');
const p = browser.contexts().flatMap((c) => c.pages())[0];
log('window: ' + cut(p.url()));
if (p.url().startsWith('http://127.0.0.1:7788/')) {
  await p.evaluate(() => { window.open('/?openhost=server'); });
  const t = Date.now();
  while (!p.url().startsWith('http://127.0.0.1:7790/') && Date.now() - t < 60_000) await p.waitForTimeout(250);
  log('opened the server: ' + cut(p.url()) + ' after ' + ((Date.now() - t) / 1000).toFixed(1) + ' s');
}
if (!p.url().startsWith('http://127.0.0.1:7790/')) throw new Error('not on the server page (7790)');
await p.waitForLoadState('domcontentloaded');
const host = await p.evaluate(() => sessionStorage.getItem('pocketrocket.desktopHost'));
log('page origin 127.0.0.1:7790, desktopHost=' + host);

await p.getByRole('button', { name: /^Menu for / }).first().click();
await p.getByRole('menuitem', { name: 'Settings' }).click();
const dlg = p.getByRole('dialog', { name: 'Settings' });
await dlg.getByRole('tab', { name: 'Game tools' }).click();
const panel = dlg.getByRole('tabpanel', { name: 'Game tools' });
await panel.waitFor();
await p.waitForTimeout(1500); // the panel reads GET /api/game-tools on open
const full = await dlg.ariaSnapshot();
const only = await panel.ariaSnapshot();
fs.mkdirSync(privDir, { recursive: true });
fs.writeFileSync(path.join(privDir, '13-d1-server-game-tools.aria.yml'), '# url=' + cut(p.url()) + '\n' + full + '\n');
await p.screenshot({ path: path.join(privDir, '13-d1-server-game-tools.png') });
log('private: 13-d1-server-game-tools.png and .aria.yml in ' + privDir);

const bad = /@|alex|galedo/i;
if (bad.test(only)) throw new Error('the tabpanel snapshot holds a name or email; not writing it to the repo');
fs.writeFileSync(repoOut, '# D1 on the real server hub, through the desktop tunnel (127.0.0.1:7790), ' + new Date().toISOString() + '\n'
  + '# Settings > Game tools: the tabpanel only (the full snapshot and screenshot are kept off the repo)\n' + only + '\n');
log('repo: ' + path.basename(repoOut) + ' (' + only.split('\n').length + ' lines)');
console.log(only);

await p.keyboard.press('Escape');
await p.waitForTimeout(300);
log('Settings closed: ' + !(await dlg.isVisible()) + '; window: ' + cut(p.url()));
process.exit(0);
