// Assembles the single-file game: src/shell.html + src/*.js (in filename order) → index.html
//
//   node build.mjs          → index.html            (release build; every module must exist)
//   node build.mjs --dev    → build/dev.html        (fills missing modules from tools/stubs.js and
//                                                    uses a bare shell if src/shell.html is missing)
//   node build.mjs --dev --only 20_heroes.js[,shell.html] [--out build/heroes.html]
//                           → core files (00/05/08/90/99) + only the listed parts; everything else stubbed
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(root, 'src');
const argv = process.argv.slice(2);
const dev = argv.includes('--dev');
const optVal = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const only = optVal('--only') ? optVal('--only').split(',').map(s => s.trim()).filter(Boolean) : null;
const CORE = /^(00|05|08|90|99)_/;
const MODULES = ['Heroes', 'Traps', 'Objects', 'Monsters', 'Waves', 'Perks', 'Powers', 'Render', 'Sprites', 'UI'];

const parts = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'))
  .filter(f => !only || CORE.test(f) || only.includes(f)).sort();
let js = parts.map(f => fs.readFileSync(path.join(srcDir, f), 'utf8').trimEnd()).join('\n\n');

const missing = MODULES.filter(m => !new RegExp(`^const ${m}\\s*=`, 'm').test(js));
if (missing.length) {
  if (!dev) throw new Error('Missing modules (use --dev to stub them): ' + missing.join(', '));
  const stubSrc = fs.readFileSync(path.join(root, 'tools', 'stubs.js'), 'utf8');
  const blocks = {};
  for (const chunk of stubSrc.split(/^\/\/@@ /m).slice(1)) {
    const name = chunk.slice(0, chunk.indexOf('\n')).trim();
    blocks[name] = chunk.slice(chunk.indexOf('\n') + 1);
  }
  const stubCode = missing.map(m => `/* ---- DEV STUB: ${m} ---- */\n` + blocks[m]).join('\n');
  // Stubs go before 90_game.js so they're defined in the same way real modules are.
  js = js + '\n\n' + stubCode;
}

if (/<\/script/i.test(js)) throw new Error('A source file contains "</script" which would break the inline script.');

let shellPath = path.join(srcDir, 'shell.html');
let shell;
if (fs.existsSync(shellPath) && (!only || only.includes('shell.html'))) shell = fs.readFileSync(shellPath, 'utf8');
else if (dev) shell = '<!doctype html><html><head><meta charset="utf-8"><title>Dungeon Heart (dev)</title></head>' +
  '<body style="background:#111;margin:0"><canvas id="board"></canvas><!--GAME_SCRIPT--></body></html>';
else throw new Error('src/shell.html is missing.');
if (!shell.includes('<!--GAME_SCRIPT-->')) throw new Error('shell.html is missing the <!--GAME_SCRIPT--> placeholder.');

const out = shell.replace('<!--GAME_SCRIPT-->', () => `<script>\n${js}\n</script>`);
const outPath = optVal('--out') ? path.resolve(root, optVal('--out')) : dev ? path.join(root, 'build', 'dev.html') : path.join(root, 'index.html');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out);
console.log(`Built ${path.relative(root, outPath)} (${(out.length / 1024).toFixed(1)} KB) from ${parts.length} scripts` +
  (missing.length ? ` + stubs for: ${missing.join(', ')}` : ''));
