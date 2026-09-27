// Headless smoke test: loads the built game in Chromium, plays scripted waves through the
// window.DH debug handle, and reports console errors + run stats. Also saves screenshots.
//
//   node tools/smoke.mjs [path/to/game.html] [--waves N] [--shots]
//
// Exit code 1 if any page error / console.error occurred.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const globalRoot = execSync('npm root -g').toString().trim();
const { chromium } = require(path.join(globalRoot, 'playwright'));

const args = process.argv.slice(2);
const file = path.resolve(args.find(a => a.endsWith('.html')) || 'index.html');
const waves = Number((args[args.indexOf('--waves') + 1]) || 3) || 3;
const shots = args.includes('--shots');
const outDir = path.resolve('build');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + (e.stack || e.message)));
page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

await page.goto('file://' + file);
await page.waitForFunction(() => window.DH && window.DH.S, null, { timeout: 10000 });
if (shots) await page.screenshot({ path: path.join(outDir, 'smoke-title.png') });

const result = await page.evaluate(async (waves) => {
  const { Game, Build, S: _s } = window.DH;
  Game.newRun();
  const S = window.DH.S;
  const log = [];
  // A simple starter build: a few walls, some traps and monsters near the middle.
  const my = S.heart.y;
  const tryPlace = (cat, id, x, y) => { const r = Build.place(cat, id, x, y); return r && r.ok; };
  for (let y = 1; y < S.rows - 1; y++) if (y !== my - 3) tryPlace('wall', 'wall', 7, y);
  for (let y = 1; y < S.rows - 1; y++) if (y !== my + 3) tryPlace('wall', 'wall', 12, y);
  tryPlace('trap', 'spike', 7, my - 3);
  tryPlace('trap', 'slime', 9, my);
  tryPlace('trap', 'arrow', 12, my);
  tryPlace('trap', 'pit', 12, my + 3);
  tryPlace('monster', 'skeleton', 10, my + 1);
  tryPlace('monster', 'goblin', 14, my);
  tryPlace('object', 'chest', 4, 2);
  tryPlace('object', 'torch', 9, my - 2);
  log.push(`built: structs=${S.structs.length} gold=${S.gold}`);
  for (let w = 0; w < waves; w++) {
    if (window.DH.S.phase !== 'build') break;
    Game.startWave();
    let steps = 0;
    while (window.DH.S.phase === 'wave' && steps < 60 * 240) { window.DH.step(1); steps++; }
    const s = window.DH.S;
    log.push(`wave ${s.wave}: phase=${s.phase} steps=${steps} heart=${s.heartHp}/${s.heartMax} gold=${s.gold} kills=${s.stats.kills} escaped=${s.stats.escaped}`);
    if (s.phase === 'reward') {
      const btn = document.querySelector('[data-perk]');
      const choice = (s.lastSummary && window.DH.Perks) ? null : null;
      Game.pickPerk(btn ? btn.getAttribute('data-perk') : null);
    } else break;
  }
  return log;
}, waves);

if (shots) {
  await page.evaluate(() => { const { Game } = window.DH; if (window.DH.S.phase === 'build') Game.startWave(); });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(outDir, 'smoke-wave.png') });
}

console.log(result.join('\n'));
if (errors.length) {
  console.log('\nERRORS (' + errors.length + '):');
  for (const e of [...new Set(errors)].slice(0, 30)) console.log(' - ' + e);
}
await browser.close();
process.exit(errors.length ? 1 : 0);
