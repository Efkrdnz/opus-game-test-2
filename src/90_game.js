/* =============================================================================
 *  90 GAME — the phase state machine and persistence.
 *
 *    title ──newRun──▶ build ──startWave──▶ wave ──(all heroes gone)──▶ reward
 *                        ▲                    │                            │
 *                        └────────pickPerk────┼────────────────────────────┘
 *                                             └──(Heart destroyed)──▶ gameover
 * ========================================================================== */

/* -----------------------------------------------------------------------------
 * 1. SAVE — best run & settings in localStorage (always wrapped in try/catch).
 * -------------------------------------------------------------------------- */
const Save = {
  KEY: 'dungeonHeart.save.v1',
  data: { bestWave: 0, bestKills: 0, runs: 0, muted: false, bestRun: null },
  load() {
    try {
      const raw = window.localStorage.getItem(this.KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && typeof d === 'object') Object.assign(this.data, d);
      }
    } catch (e) { /* storage unavailable (private mode, file:// quirks) — play on without saving */ }
  },
  write() {
    try { window.localStorage.setItem(this.KEY, JSON.stringify(this.data)); } catch (e) { /* ignore */ }
  },
  /** Record a finished run. @returns true if it is a new best. */
  recordRun(r) {
    this.data.runs = (this.data.runs || 0) + 1;
    const better = r.wavesSurvived > this.data.bestWave ||
      (r.wavesSurvived === this.data.bestWave && r.kills > this.data.bestKills);
    if (better) {
      this.data.bestWave = r.wavesSurvived;
      this.data.bestKills = r.kills;
      this.data.bestRun = {
        wavesSurvived: r.wavesSurvived, kills: r.kills, goldEarned: r.goldEarned,
        favoriteTrap: r.favoriteTrap ? r.favoriteTrap.name : null,
        perks: r.perks.map(p => p.name), date: new Date().toISOString().slice(0, 10),
      };
    }
    this.write();
    return better;
  },
};

/* -----------------------------------------------------------------------------
 * 2. GAME FLOW
 * -------------------------------------------------------------------------- */
const Game = {
  /** Decorative dungeon behind the title screen. */
  toTitle() {
    S = makeState();
    Path.reset();
    Grid.init(CFG.gridSizes[0][0], CFG.gridSizes[0][1]);
    FX.clear();
    S.phase = 'title';
    UI.showTitle();
  },

  newRun() {
    S = makeState();
    Path.reset();
    FX.clear();
    Grid.init(CFG.gridSizes[0][0], CFG.gridSizes[0][1]);
    Light.recompute();
    this.checkUnlocks(true);
    S.nextWave = Waves.generate(S.wave);
    this.setPhase('build');
    if (typeof Render !== 'undefined' && Render.resize) Render.resize();
    UI.toast('Build your dungeon, then press Start Wave. Heroes enter from the left.', 'info');
  },

  setPhase(p) {
    S.phase = p;
    S.ui.power = null;
    if (p !== 'build') { S.ui.tool = null; }
    UI.onPhase(p);
  },

  /** Unlock every item whose milestone wave has been reached. */
  checkUnlocks(silent) {
    const fresh = [];
    const scan = (cat, table) => {
      for (const id of Object.keys(table)) {
        const key = cat + ':' + id;
        if (!S.unlocked.has(key) && table[id].unlock <= S.wave) { S.unlocked.add(key); fresh.push(table[id].name); }
      }
    };
    scan('trap', TRAPS); scan('monster', MONSTERS); scan('boss', BOSSES); scan('object', OBJECTS);
    if (fresh.length && !silent) {
      UI.toast('Unlocked: ' + fresh.join(', '), 'good');
      SFX.play('unlock');
    }
    return fresh;
  },

  /** Unlock a specific item (perks). */
  unlock(cat, id) {
    const key = cat + ':' + id;
    if (S.unlocked.has(key)) return false;
    S.unlocked.add(key);
    return true;
  },

  startWave() {
    if (S.phase !== 'build') return;
    if (!Path.reachable()) { UI.toast('The Heart is sealed off — open a path first!', 'bad'); return; }
    S.phase = 'wave';
    S.time = 0;
    S.mana = Math.min(S.manaMax, CFG.manaStart);
    S.undyingUsed = false;
    S.waveEndT = -1;
    S.endingT = -1;
    S.powerCd = {};
    S.corpses = [];
    S.projectiles = [];
    S.heroes = [];
    S.parties = [];
    S.ui.selected = null;
    S.ws = {
      wave: S.wave, kills: 0, spawned: 0, escaped: 0, stolen: 0, heartDmg: 0, gold: 0,
      trapKills: {}, boss: S.nextWave && S.nextWave.boss ? S.nextWave.boss : null, bossKilled: false,
      heartAtStart: S.heartHp,
    };
    Traps.onWaveStart();
    Objects.onWaveStart();
    Monsters.onWaveStart();
    Heroes.onWaveStart();
    Powers.onWaveStart();
    Waves.begin(S.nextWave);
    this.setPhase('wave');
    SFX.play(S.ws.boss ? 'boss' : 'waveStart');
    UI.toast(S.ws.boss ? `Boss wave! ${HERO_BOSSES[S.ws.boss].name} approaches!` : `Wave ${S.wave} — the heroes are coming!`, S.ws.boss ? 'bad' : 'info');
  },

  /** One fixed simulation step. */
  update(dt) {
    if (!S) return;
    if (S.phase === 'wave') {
      S.time += dt;
      for (const h of S.heroes) if (!h.dead) Status.tick(h, dt);
      for (const m of S.monsters) if (!m.dead) Status.tick(m, dt);
      Waves.update(dt);
      Powers.update(dt);
      Heroes.update(dt);
      Monsters.update(dt);
      Traps.update(dt);
      Objects.update(dt);
      Proj.update(dt);
      Heart.update(dt);
      for (const c of S.corpses) c.t -= dt;
      S.corpses = S.corpses.filter(c => c.t > 0);
      for (const h of S.heroes) if (h.dead) h.deadT += dt;
      S.heroes = S.heroes.filter(h => !h.removed && !h.escaped && !(h.dead && h.deadT > 0.7));
      for (const m of S.monsters) if (m.dead) m.deadT += dt;
      S.monsters = S.monsters.filter(m => !m.removed && !(m.temp && m.dead && m.deadT > 0.7));
      if (S.endingT >= 0) {
        S.endingT -= dt;
        if (S.endingT <= 0) { S.endingT = -1; this.gameOver(); }
      } else if (Waves.done() && !S.heroes.some(h => !h.dead)) {
        if (S.waveEndT < 0) S.waveEndT = 1.2;
        S.waveEndT -= dt;
        if (S.waveEndT <= 0) this.endWave();
      }
    } else if (S.phase === 'build' || S.phase === 'title' || S.phase === 'reward') {
      if (Monsters.idle) Monsters.idle(dt);
    }
    FX.update(dt);
  },

  /** Called by Heroes when a hero walks out of the entrance alive. */
  heroEscaped(h) {
    if (h.escaped || h.dead) return;
    h.escaped = true;
    S.stats.escaped++;
    if (S.ws) S.ws.escaped++;
    if (h.loot > 0) Econ.steal(h.loot, h.x + 0.5, h.y - 0.5);
    else if (hasPerk('blood_money')) Econ.steal(Math.round(HERO_CLASSES[h.type].gold * (1 + CFG.bountyPerWave * (S.wave - 1))), h.x + 0.5, h.y - 0.5); // ×3 inside steal()
    else FX.text(h.x + 0.6, h.y - 0.5, 'Fled', '#cccccc', { size: 10 });
    h.loot = 0;
  },

  endWave() {
    const ws = S.ws;
    // Interest is paid on the gold you held going into the payout (before wave income).
    let interest = 0;
    if (hasPerk('interest')) interest = Math.min(75, Math.floor(S.gold * 0.1));
    const income = Econ.waveIncome();
    Econ.gain(income);
    if (interest > 0) Econ.gain(interest);
    const healed = Math.min(CFG.heartRegenPerWave, S.heartMax - S.heartHp);
    S.heartHp += healed;
    Danger.decay();
    Traps.onWaveEnd();
    Objects.onWaveEnd();
    Monsters.onWaveEnd();
    if (Heroes.onWaveEnd) Heroes.onWaveEnd();
    S.projectiles = [];
    S.corpses = [];
    S.heroes = [];
    S.stats.wavesSurvived = S.wave;
    const summary = {
      wave: S.wave, kills: ws.kills, spawned: ws.spawned, escaped: ws.escaped, stolen: ws.stolen,
      heartDmg: ws.heartDmg, goldFromKills: ws.gold - income - interest, income, interest, heartHealed: healed,
      boss: ws.boss, bossKilled: ws.bossKilled, trapKills: ws.trapKills,
      repairCost: Build.totalRepairCost(), broken: S.structs.filter(s => s.broken).length,
      expandsNext: S.wave % 10 === 0 && Math.floor(S.wave / 10) < CFG.gridSizes.length,
    };
    S.lastSummary = summary;
    const choices = Perks.roll(3);
    this.setPhase('reward');
    SFX.play('waveEnd');
    UI.showReward(summary, choices);
  },

  pickPerk(id) {
    if (S.phase !== 'reward') return;
    if (id) { Perks.take(id); SFX.play('perk'); }
    S.wave++;
    const tier = Math.min(CFG.gridSizes.length - 1, Math.floor((S.wave - 1) / 10));
    const [c, r] = CFG.gridSizes[tier];
    if (c > S.cols || r > S.rows) {
      Grid.expand(c, r);
      if (typeof Render !== 'undefined' && Render.resize) Render.resize();
      UI.toast('The dungeon expands! A new antechamber lies before your old entrance — your maze is untouched. Sell old outer walls (free) to open more space.', 'good');
    }
    this.checkUnlocks(false);
    S.nextWave = Waves.generate(S.wave);
    this.setPhase('build');
  },

  heartDestroyed() {
    if (S.endingT >= 0 || S.phase !== 'wave') return;
    S.endingT = 2.2;
    const x = Heart.cx(), y = Heart.cy();
    FX.shake(18); FX.flash('#ff2050', 0.6);
    FX.burst(x, y, { n: 140, colors: ['#ff2d55', '#ff9aa8', '#7a0020', '#ffd0d8'], speed: 6, life: 1.8, size: 4, grav: 3 });
    FX.ring(x, y, { color: '#ff2d55', r0: 0.3, r1: 7, life: 1.2, width: 6 });
    SFX.play('collapse'); SFX.play('boss');
    UI.toast('The Dungeon Heart shatters!', 'bad');
  },

  /** Build the end-of-run report. */
  report() {
    const st = S.stats;
    let fav = null;
    const ids = new Set([...Object.keys(st.trapKills), ...Object.keys(st.trapDamage)]);
    for (const id of ids) {
      const k = st.trapKills[id] || 0, d = st.trapDamage[id] || 0;
      if (!fav || k > fav.kills || (k === fav.kills && d > fav.damage)) fav = { id, name: TRAPS[id].name, kills: k, damage: Math.round(d) };
    }
    return {
      wave: S.wave, wavesSurvived: Math.max(0, S.wave - 1), kills: st.kills, elitesKilled: st.elitesKilled,
      bossKills: st.bossKills, goldEarned: st.goldEarned, stolen: st.stolen, escaped: st.escaped,
      heartDamage: st.heartDamage, favoriteTrap: fav, killsBy: Object.assign({}, st.killsBy),
      perks: S.perkOrder.map(id => PERK_BY_ID[id]).filter(Boolean),
      structures: S.structs.length,
    };
  },

  gameOver() {
    if (S.phase === 'gameover') return;
    const r = this.report();
    r.newBest = Save.recordRun(r);
    r.best = Object.assign({}, Save.data);
    this.setPhase('gameover');
    SFX.play('gameover');
    UI.showGameOver(r);
  },
};
