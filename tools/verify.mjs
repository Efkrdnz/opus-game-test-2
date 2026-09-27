// Integration verification runner: injects tools/scenarios/_harness.js + every
// tools/scenarios/*.js file into the built game and runs the scenarios headlessly.
//
//   node tools/verify.mjs [game.html] [--filter text] [--list]
//
// Exit code 1 if any scenario fails or any page error / console.error occurs.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const file = path.resolve(args.find(a => a.endsWith('.html')) || 'index.html');
const filter = opt('--filter', null);
const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'scenarios');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== '_harness.js').sort();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + (e.stack || e.message)));
page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
await page.goto('file://' + file);
await page.waitForFunction(() => window.DH && window.DH.S, null, { timeout: 15000 });
await page.addScriptTag({ path: path.join(dir, '_harness.js') });
for (const f of files) await page.addScriptTag({ path: path.join(dir, f) });

if (args.includes('--list')) {
  const names = await page.evaluate(() => window.SCENARIOS.map(s => s.name));
  console.log(names.join('\n'));
  await browser.close();
  process.exit(0);
}

const results = await page.evaluate(f => window.runScenarios(f), filter);
let fails = 0;
for (const r of results) {
  if (!r.pass) fails++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(48)} ${String(r.ms).padStart(5)}ms  ${r.detail ? '— ' + r.detail : ''}`);
}
console.log(`\n${results.length - fails}/${results.length} scenarios passed.`);
if (errors.length) {
  console.log('\nPAGE ERRORS (' + errors.length + '):');
  for (const e of [...new Set(errors)].slice(0, 30)) console.log(' - ' + e);
}
await browser.close();
process.exit(fails || errors.length ? 1 : 0);
