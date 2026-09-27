// In-page scenario harness (injected by tools/verify.mjs). Scenario files push entries onto
// window.SCENARIOS: { name, tags:[...], run: async (H) => { ... throw/H.assert on failure } }.
// Every scenario starts from H.fresh(): a new run, all content unlocked, lots of gold, an
// empty wave preview (so only heroes the scenario spawns appear), and no natural rocks.
window.SCENARIOS = window.SCENARIOS || [];
window.H = (() => {
  const DH = window.DH;
  const H = {
    get S() { return DH.S; },
    DH,
    /** Fresh deterministic-ish sandbox run. */
    fresh(o = {}) {
      DH.Game.newRun();
      const S = DH.S;
      if (o.clearRocks !== false) {
        for (const t of S.tiles) {
          const border = t.x === 0 || t.y === 0 || t.x === S.cols - 1 || t.y === S.rows - 1;
          if (t.type === 2 && !border) t.type = 0;
        }
        DH.Path.bump();
      }
      S.gold = o.gold ?? 99999;
      if (o.unlockAll !== false) {
        for (const [cat, table] of [['trap', TRAPS], ['monster', MONSTERS], ['boss', BOSSES], ['object', OBJECTS]])
          for (const id of Object.keys(table)) S.unlocked.add(cat + ':' + id);
      }
      if (o.wave) S.wave = o.wave;
      S.nextWave = H.emptyWave();
      DH.FX.clear();
      return S;
    },
    emptyWave() { return { wave: DH.S.wave, parties: [], boss: null, counts: {}, elites: 0, total: 0, threat: 0, guildNotes: [] }; },
    perk(id) { DH.S.perks[id] = (DH.S.perks[id] || 0) + 1; if (!DH.S.perkOrder.includes(id)) DH.S.perkOrder.push(id); },
    place(cat, id, x, y) {
      const r = DH.Build.place(cat, id, x, y);
      if (!r || !r.ok) throw new Error(`place ${cat}:${id} at ${x},${y} failed: ${r && r.reason}`);
      return DH.Build.structAt(x, y);
    },
    wall(x, y) { return H.place('wall', 'wall', x, y); },
    /** Wall off everything except the given open tiles along rows y0..y1 (build corridors). */
    fillWalls(pred) {
      const S = DH.S;
      for (let y = 1; y < S.rows - 1; y++) for (let x = 1; x < S.cols - 1; x++) {
        const t = DH.Grid.tile(x, y);
        if (t.type !== 0 || t.s) continue;
        if (pred(x, y)) { t.type = 1; t.paid = 6; }
      }
      DH.Path.bump();
      if (!DH.Path.reachable()) throw new Error('fillWalls sealed the heart');
    },
    /** A straight 1-tile corridor along the entrance row; everything else walled. */
    corridor() {
      const S = DH.S, my = S.entrance.y;
      H.fillWalls((x, y) => y !== my && !(x >= S.heart.x - 1 && Math.abs(y - my) <= 1));
      return my;
    },
    startWave() {
      const S = DH.S;
      S.nextWave = S.nextWave && S.nextWave.parties && S.nextWave.parties.length === 0 ? S.nextWave : H.emptyWave();
      DH.Game.startWave();
      if (S.phase !== 'wave') throw new Error('wave did not start');
    },
    /** Spawn a hero (inside a party) and optionally move it to (x,y) tile centre. */
    hero(cls, x, y, o = {}) {
      const S = DH.S;
      const before = S.heroes.length;
      DH.Heroes.spawnParty([{ cls, elite: !!o.elite, boss: o.boss || null }]);
      const h = S.heroes[S.heroes.length - 1];
      if (S.heroes.length === before || !h) throw new Error('spawnParty did not add a hero');
      if (x !== undefined) { h.x = x + 0.5; h.y = y + 0.5; h.path = null; }
      if (o.hp !== undefined) h.hp = o.hp;
      return h;
    },
    party(specs) {
      const S = DH.S; const n = S.heroes.length;
      DH.Heroes.spawnParty(specs);
      return S.heroes.slice(n);
    },
    step(sec) { DH.step(Math.max(1, Math.round(sec * 60))); },
    /** Step until fn() is truthy (checked every 5 steps) or maxSec elapses. Returns elapsed seconds or -1. */
    until(fn, maxSec = 30) {
      const max = Math.round(maxSec * 60);
      for (let i = 0; i < max; i += 5) {
        if (fn()) return i / 60;
        DH.step(5);
        if (DH.S.phase !== 'wave' && !fn()) return -1;
      }
      return fn() ? maxSec : -1;
    },
    assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); },
    near(a, b, eps = 0.01) { return Math.abs(a - b) <= eps; },
    alive(e) { return e && !e.dead && !e.removed && !e.escaped; },
    /** Keep the wave from ending by parking an invulnerable-ish dummy hero at the entrance. */
    keepAlive() {
      const h = H.hero('warrior', DH.S.entrance.x + 1, 1);
      h.maxHp = h.hp = 1e9; h.st.rootT = 1e9; h.dmg = 0; h.heartDmg = 0; h.speed = 0;
      h._dummy = true;
      return h;
    },
  };
  return H;
})();

window.runScenarios = async function (filter) {
  const out = [];
  const list = window.SCENARIOS.filter(s => !filter || s.name.includes(filter) || (s.tags || []).includes(filter));
  for (const s of list) {
    const t0 = performance.now();
    let pass = true, detail = '';
    try {
      window.H.fresh(s.fresh || {});
      const r = await s.run(window.H);
      if (r !== undefined) detail = typeof r === 'string' ? r : JSON.stringify(r);
    } catch (e) {
      pass = false; detail = (e && e.message) || String(e);
      if (e && e.stack && !String(e.message).startsWith('ASSERT')) detail += ' @ ' + e.stack.split('\n').slice(1, 3).join(' | ');
    }
    out.push({ name: s.name, pass, detail, ms: Math.round(performance.now() - t0) });
  }
  return out;
};
