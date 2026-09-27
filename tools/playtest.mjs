// Automated bot playtest for balance & stability.
// A scripted "Dungeon Master" (default strategy 'human') grows a baffle maze, lines the predicted hero route with
// traps, guards choke points with monsters, upgrades/repairs, picks perks and casts powers.
//
//   node tools/playtest.mjs [game.html] [--waves 30] [--runs 1] [--strategy human|maze|traps|monsters|mixed] [--seed N] [--shots]
//
// Prints one line per wave plus a summary; exit code 1 on page errors.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const file = path.resolve(args.find(a => a.endsWith('.html')) || 'index.html');
const maxWaves = Number(opt('--waves', 30));
const runs = Number(opt('--runs', 1));
const strategy = opt('--strategy', 'human');
const shots = args.includes('--shots');
fs.mkdirSync('build', { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + (e.stack || e.message)));
page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
await page.goto('file://' + file);
await page.waitForFunction(() => window.DH && window.DH.S, null, { timeout: 15000 });

const all = [];
for (let run = 0; run < runs; run++) {
  const res = await page.evaluate(async ({ maxWaves, strategy, run }) => {
    const DH = window.DH;
    const { Game, Build, Path, Grid } = DH;
    Game.newRun();
    const lines = [];
    const T = { FLOOR: 0, WALL: 1, ROCK: 2 };

    /* ---------------- bot helpers ---------------- */
    const S = () => DH.S;
    const unlocked = (cat, id) => Build.isUnlocked(cat, id);
    const afford = (cat, id) => S().gold >= Build.cost(cat, id);
    const place = (cat, id, x, y) => { const r = Build.place(cat, id, x, y); return r && r.ok; };

    /** Serpentine plan: vertical wall lines every 3 columns (alternating gaps), built from the Heart side outward, within a gold budget. */
    function buildMaze(maxSpend) {
      const s = S();
      const start = s.gold;
      const hx = s.heart.x;
      const cols = [];
      for (let c = 3; c <= hx - 3; c += 3) cols.push(c);
      cols.reverse(); // Heart side first: that's where the killing happens
      cols.forEach((c, k) => {
        const gapY = k % 2 ? 1 : s.rows - 2;
        for (let y = 1; y < s.rows - 1; y++) {
          if (y === gapY) continue;
          if (start - s.gold + Build.cost('wall', 'wall') > maxSpend) return;
          const t = Grid.tile(c, y);
          if (!t || t.type !== T.FLOOR || t.s) continue;
          place('wall', 'wall', c, y);
        }
      });
    }
    function routeTiles() { return Path.preview().filter(p => { const t = Grid.tile(p.x, p.y); return t && t.type === T.FLOOR && !t.s; }); }
    function placeTrapsAlongRoute(maxSpend) {
      const s = S();
      const start = s.gold;
      const route = routeTiles();
      const order = ['spike', 'fire', 'slime', 'pit', 'teleport', 'alarm'].filter(id => unlocked('trap', id));
      let i = 0, k = 0;
      for (const p of route) {
        if (start - s.gold > maxSpend) break;
        i++;
        if (i % 3 !== 0) continue; // spread out
        const id = order[k % order.length]; k++;
        if (afford('trap', id)) place('trap', id, p.x, p.y);
      }
      // Arrow walls on maze walls adjacent to the route.
      if (unlocked('trap', 'arrow')) {
        let n = 0;
        for (const p of Path.preview()) {
          if (start - s.gold > maxSpend || n > 6) break;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const t = Grid.tile(p.x + dx, p.y + dy);
            if (t && t.type === T.WALL && !t.s && Math.random() < 0.15 && afford('trap', 'arrow')) { if (place('trap', 'arrow', t.x, t.y)) n++; }
          }
        }
      }
      if (unlocked('trap', 'boulder') && afford('trap', 'boulder')) {
        const r = routeTiles(); const p = r[Math.floor(r.length * 0.6)]; if (p) place('trap', 'boulder', p.x, p.y);
      }
    }
    function placeMonsters(maxSpend) {
      const s = S();
      const start = s.gold;
      const route = Path.preview();
      const ids = ['orc', 'skeleton', 'spider', 'imp', 'goblin', 'wraith'].filter(id => unlocked('monster', id));
      let k = 0;
      // Guard the last third of the route and near the Heart.
      for (let i = route.length - 3; i > route.length / 3; i -= 4) {
        if (start - s.gold > maxSpend) break;
        const p = route[i]; if (!p) continue;
        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          const t = Grid.tile(p.x + dx, p.y + dy);
          if (t && t.type === T.FLOOR && !t.s) { const id = ids[k++ % ids.length]; if (afford('monster', id)) place('monster', id, t.x, t.y); break; }
        }
      }
      // A boss when possible.
      if (!Build.bossPlaced()) {
        for (const b of ['dragon', 'lich', 'minotaur']) {
          if (unlocked('boss', b) && afford('boss', b)) {
            const p = route[Math.max(0, route.length - 5)];
            for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
              const t = p && Grid.tile(p.x + dx, p.y + dy);
              if (t && t.type === T.FLOOR && !t.s && place('boss', b, t.x, t.y)) break;
            }
            break;
          }
        }
      }
    }
    function placeLures() {
      const s = S();
      if (s.structs.filter(x => x.id === 'chest').length >= 2) return;
      const r = routeTiles(); const p = r[Math.floor(r.length * 0.45)];
      if (!p) return;
      for (const [dx, dy] of [[0, 1], [0, -1]]) { const t = Grid.tile(p.x + dx, p.y + dy); if (t && t.type === T.FLOOR && !t.s && afford('object', 'chest')) { place('object', 'chest', t.x, t.y); break; } }
      if (unlocked('object', 'torch') && afford('object', 'torch')) { const q = r[Math.floor(r.length * 0.7)]; if (q) { const t = Grid.tile(q.x, q.y - 1); if (t && t.type === T.FLOOR && !t.s) place('object', 'torch', t.x, t.y); } }
    }
    function upgrades(maxSpend) {
      const s = S(); const start = s.gold;
      const ups = s.structs.filter(x => Build.upgradable(x)).sort((a, b) => a.level - b.level);
      for (const x of ups) { if (start - s.gold > maxSpend) break; const c = Build.upgradeCost(x); if (c <= s.gold) Build.upgrade(x.x, x.y); }
    }
    /* ---- 'human' strategy: baffle walls grown over time, traps down the back half of the route,
     *      monsters guarding the approach to the Heart, lures, upgrades, a boss when possible. ---- */
    const plan = { baffles: 0 };
    function baffle(k) {
      const s = S(), hx = s.heart.x;
      const c = hx - 4 - 3 * k;
      if (c < 3) return false;
      const gapY = k % 2 ? s.rows - 2 : 1;
      for (let y = 1; y < s.rows - 1; y++) {
        if (y === gapY) continue;
        const t = Grid.tile(c, y);
        if (t && t.type === T.FLOOR && !t.s && afford('wall', 'wall')) place('wall', 'wall', c, y);
      }
      return true;
    }
    function humanBuild() {
      const s = S();
      Build.repairAll();
      // Grow the maze: two baffles at first, then one more every other wave while affordable.
      const want = Math.min(8, 2 + Math.floor((s.wave - 1) / 2));
      for (let k = 0; k < plan.baffles; k++) baffle(k); // rebuild walls blasted/dug last wave
      while (plan.baffles < want && s.gold > 120) { if (!baffle(plan.baffles)) break; plan.baffles++; }
      const route = Path.preview();
      const open = route.filter(p => { const t = Grid.tile(p.x, p.y); return t.type === T.FLOOR && !t.s; });
      // Traps down the back 65% of the route, every other tile.
      const trapIds = ['spike', 'slime', 'fire', 'spike', 'pit', 'teleport', 'alarm'].filter(id => unlocked('trap', id));
      let k = s.structs.filter(x => x.cat === 'trap').length;
      const reserve = 40 + s.wave * 6;
      for (let i = Math.floor(open.length * 0.35); i < open.length && s.gold > reserve; i += 2) {
        const p = open[i]; const t = Grid.tile(p.x, p.y); if (t.s) continue;
        const id = trapIds[k++ % trapIds.length]; if (afford('trap', id)) place('trap', id, p.x, p.y);
      }
      // Arrow walls on baffle walls beside the route.
      if (unlocked('trap', 'arrow')) for (const p of route) {
        if (s.gold < reserve + 45 || s.structs.filter(x => x.id === 'arrow').length >= 2 + s.wave) break;
        for (const [dx, dy] of [[1, 0], [-1, 0]]) { const t = Grid.tile(p.x + dx, p.y + dy); if (t && t.type === T.WALL && !t.s && (p.y % 3 === 0)) place('trap', 'arrow', t.x, t.y); }
      }
      if (unlocked('trap', 'boulder') && !s.structs.some(x => x.id === 'boulder') && afford('trap', 'boulder')) { const p = open[open.length - 3]; if (p) place('trap', 'boulder', p.x, p.y); }
      // Boss once affordable.
      if (!Build.bossPlaced()) for (const b of ['dragon', 'lich', 'minotaur']) {
        if (!unlocked('boss', b) || !afford('boss', b)) continue;
        const p = route[Math.max(0, route.length - 4)];
        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) { const t = Grid.tile(p.x + dx, p.y + dy); if (t && t.type === T.FLOOR && !t.s && place('boss', b, t.x, t.y)) break; }
        break;
      }
      // Monsters flanking the last stretch of the route.
      const monIds = ['skeleton', 'orc', 'spider', 'imp', 'skeleton', 'wraith', 'goblin'].filter(id => unlocked('monster', id));
      let m = s.structs.filter(x => x.cat === 'monster').length;
      for (let i = route.length - 2; i > route.length * 0.5 && s.gold > reserve; i -= 2) {
        const p = route[i];
        for (const [dx, dy] of [[0, 1], [0, -1]]) { const t = Grid.tile(p.x + dx, p.y + dy); if (t && t.type === T.FLOOR && !t.s) { const id = monIds[m++ % monIds.length]; if (afford('monster', id)) place('monster', id, t.x, t.y); break; } }
      }
      if (!s.structs.some(x => x.id === 'chest') && open.length > 10) { const p = open[Math.floor(open.length * 0.55)]; const t = Grid.tile(p.x, p.y + 1); if (t && t.type === T.FLOOR && !t.s) place('object', 'chest', t.x, t.y); }
      if (unlocked('object', 'well') && !s.structs.some(x => x.id === 'well') && s.gold > 200) { for (const t of s.tiles) if (t.type === T.FLOOR && !t.s && t.x > s.heart.x - 2 && t.y < 3) { place('object', 'well', t.x, t.y); break; } }
      // Upgrades with what's left: best-performing trap types first, then monsters.
      const ups = s.structs.filter(x => Build.upgradable(x)).sort((a, b) => (a.level - b.level) || ((s.stats.trapKills[b.id] || 0) - (s.stats.trapKills[a.id] || 0)));
      for (const x of ups) { const c = Build.upgradeCost(x); if (s.gold - c > 20) Build.upgrade(x.x, x.y); }
      // Spend what's left on extra guards anywhere beside the back half of the route…
      for (let i = route.length - 2; i > route.length * 0.3 && s.gold > 30; i--) {
        const p = route[i];
        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) { const t = Grid.tile(p.x + dx, p.y + dy); if (t && t.type === T.FLOOR && !t.s) { const id = monIds[m++ % monIds.length]; if (afford('monster', id)) place('monster', id, t.x, t.y); } }
      }
      // …then any remaining upgrades, then traps on every open route tile.
      for (const x of s.structs.filter(x => Build.upgradable(x))) { const c = Build.upgradeCost(x); if (s.gold - c > 10) Build.upgrade(x.x, x.y); }
      for (const p of Path.preview()) { const t = Grid.tile(p.x, p.y); if (t.type === T.FLOOR && !t.s && s.gold > 60) { const id = trapIds[k++ % trapIds.length]; if (afford('trap', id)) place('trap', id, p.x, p.y); } }
    }
    function buildPhase() {
      const s = S();
      if (strategy === 'human') return humanBuild();
      Build.repairAll();
      const g = s.gold;
      if (strategy === 'traps') { buildMaze(g * 0.3); placeTrapsAlongRoute(s.gold); upgrades(s.gold); }
      else if (strategy === 'monsters') { placeMonsters(g); upgrades(s.gold); }
      else if (strategy === 'maze') { buildMaze(g * 0.7); placeTrapsAlongRoute(s.gold); }
      else { buildMaze(g * 0.3); placeLures(); placeTrapsAlongRoute(g * 0.35); placeMonsters(g * 0.25); upgrades(s.gold * 0.8); }
    }
    function castPowers() {
      const s = S(); const P = DH.Powers;
      const hx = s.heart.x + 0.5, hy = s.heart.y + 0.5;
      const alive = s.heroes.filter(h => !h.dead && !h.escaped);
      if (!alive.length) return;
      // Lightning on the densest cluster near the Heart.
      let best = null, bc = 0;
      for (const h of alive) {
        const d = Math.hypot(h.x - hx, h.y - hy);
        if (d > 7) continue;
        const c = alive.filter(o => Math.hypot(o.x - h.x, o.y - h.y) < 1.4).length;
        if (c > bc) { bc = c; best = h; }
      }
      if (best && P.canCast('lightning').ok) P.cast('lightning', best.x, best.y);
      const close = alive.find(h => Math.hypot(h.x - hx, h.y - hy) < 2.2 && !h.boss && h.type !== 'paladin');
      if (close && P.canCast('fear').ok) P.cast('fear', close.x, close.y);
      if (s.structs.filter(x => x.cat === 'trap' && (x.broken || x.disarmed)).length >= 3 && P.canCast('reset').ok) P.cast('reset');
    }
    function pickPerk(choices) {
      const pref = ['undying_heart', 'thorns', 'time_warp', 'legion', 'soul_harvest', 'echoing_halls', 'whetstone', 'mend', 'rusted_blades', 'interest', 'pack_tactics', 'chain_lightning', 'necromancy', 'overcharge', 'treasury'];
      for (const p of pref) if (choices.includes(p)) return p;
      const safe = choices.filter(id => !['glass_cannon', 'blood_money', 'cursed_gold', 'midas'].includes(id));
      return safe[0] || choices[0] || null;
    }

    /* ---------------- main loop ---------------- */
    let lastChoices = null;
    const origShow = DH.UI.showReward;
    DH.UI.showReward = function (summary, choices) { lastChoices = choices; return origShow.call(this, summary, choices); };
    const t0 = performance.now();
    for (let w = 0; w < maxWaves; w++) {
      if (S().phase !== 'build') break;
      buildPhase();
      const pre = { structs: S().structs.length, gold: S().gold, route: Path.preview().length, preview: S().nextWave };
      Game.startWave();
      let steps = 0, updMs = 0, maxAlive = 0;
      while (S().phase === 'wave' && steps < 60 * 600) {
        const a = performance.now();
        DH.step(1);
        updMs += performance.now() - a;
        steps++;
        if (steps % 30 === 0) castPowers();
        const alive = S().heroes.filter(h => !h.dead).length;
        if (alive > maxAlive) maxAlive = alive;
      }
      if (S().phase === 'wave') {
        const st = S();
        const near = h0 => st.monsters.filter(m => !m.dead && Math.hypot(m.x - h0.x, m.y - h0.y) < 2.5).map(m => `${m.type}@${m.x.toFixed(2)},${m.y.toFixed(2)} ${m.state} tgt=${m.target ? m.target.type : '-'}`).join('; ')
          + ' | heroes: ' + st.heroes.filter(o => o !== h0 && !o.dead && Math.hypot(o.x - h0.x, o.y - h0.y) < 2).map(o => `${o.type}@${o.x.toFixed(2)},${o.y.toFixed(2)}`).join('; ');
        for (const h0 of st.heroes.filter(h => !h.dead)) lines.push({ stuck: 'NEAR ' + h0.type + ': ' + near(h0) });
        const g = []; const hh = st.heroes.find(h => !h.dead);
        if (hh) for (let y = Math.max(0, Math.floor(hh.y) - 3); y <= Math.min(st.rows - 1, Math.floor(hh.y) + 3); y++) { let row = ''; for (let x = Math.max(0, Math.floor(hh.x) - 5); x <= Math.min(st.cols - 1, Math.floor(hh.x) + 5); x++) { const t = st.tiles[y * st.cols + x]; row += (x === Math.floor(hh.x) && y === Math.floor(hh.y)) ? '@' : t.type === 1 ? '#' : t.type === 2 ? 'R' : t.s ? t.s.id[0] : '.'; } g.push(row); }
        lines.push({ stuck: 'MAP\n       ' + g.join('\n       ') });
        lines.push({ stuck: st.heroes.filter(h => !h.dead).map(h => `${h.type}${h.boss ? '(' + h.boss + ')' : ''} @${h.x.toFixed(2)},${h.y.toFixed(2)} tile=${st.tiles[Math.floor(h.y) * st.cols + Math.floor(h.x)].type} state=${h.state} hp=${Math.round(h.hp)} path=${h.path ? h.path.length : 'null'} ch=${h.channel ? h.channel.kind : '-'} fear=${h.st.fearT.toFixed(1)} root=${h.st.rootT.toFixed(1)} stun=${h.st.stunT.toFixed(1)} tgt=${h.target ? h.target.type : '-'} next=${(h.path || []).slice(0, 4).map(p => p.x + ',' + p.y + ':' + st.tiles[p.y * st.cols + p.x].type + (st.tiles[p.y * st.cols + p.x].s ? '[' + st.tiles[p.y * st.cols + p.x].s.id + ']' : '')).join(' ')} ai=${h.ai ? JSON.stringify(Object.fromEntries(Object.entries(h.ai).filter(([k, v]) => typeof v !== 'object' && typeof v !== 'function'))) : ''}`).join('\n     ') });
      }
      const s = S();
      const sum = s.phase === 'reward' ? (s.lastSummary || {}) : { kills: s.ws.kills, escaped: s.ws.escaped, heartDmg: s.ws.heartDmg };
      lines.push({
        wave: w + 1, phase: s.phase, secs: (steps / 60).toFixed(0), heroes: pre.preview ? pre.preview.total : '?',
        boss: pre.preview && pre.preview.boss || '', kills: sum.kills ?? s.stats.kills, escaped: sum.escaped ?? '-',
        heartDmg: sum.heartDmg ?? '-', heart: `${s.heartHp}/${s.heartMax}`, gold: s.gold, structs: pre.structs, route: pre.route,
        maxAlive, msPerStep: (updMs / Math.max(1, steps)).toFixed(3), notes: (pre.preview && pre.preview.guildNotes || []).join(' | '),
      });
      if (s.phase === 'reward') Game.pickPerk(pickPerk(lastChoices || []));
      else break;
    }
    DH.UI.showReward = origShow;
    return { lines, perks: S().perkOrder.slice(), final: S().phase, wave: S().wave, realMs: performance.now() - t0 };
  }, { maxWaves, strategy, run });
  all.push(res);
  console.log(`\n=== Run ${run + 1} (${strategy}) — ended in phase "${res.final}" at wave ${res.wave} (${(res.realMs / 1000).toFixed(1)}s real) ===`);
  for (const l of res.lines) {
    if (l.stuck !== undefined) { console.log('  STUCK heroes:\n     ' + l.stuck); continue; }
    console.log(`w${String(l.wave).padStart(2)} ${l.phase.padEnd(8)} t=${String(l.secs).padStart(3)}s heroes=${String(l.heroes).padStart(2)}${l.boss ? '(' + l.boss + ')' : ''} kills=${l.kills} esc=${l.escaped} heartDmg=${l.heartDmg} heart=${l.heart} gold=${l.gold} structs=${l.structs} route=${l.route} peak=${l.maxAlive} ms/step=${l.msPerStep}${l.notes ? '  [' + l.notes + ']' : ''}`);
  }
  console.log('perks: ' + res.perks.join(', '));
  if (shots) await page.screenshot({ path: `build/playtest-${strategy}-${run}.png` });
}

if (errors.length) {
  console.log('\nERRORS (' + errors.length + '):');
  for (const e of [...new Set(errors)].slice(0, 30)) console.log(' - ' + e);
}
await browser.close();
process.exit(errors.length ? 1 : 0);
