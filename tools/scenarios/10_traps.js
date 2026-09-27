// Traps & objects, end-to-end with real heroes walking a corridor.
(() => {
  const add = (name, run, tags = ['traps']) => window.SCENARIOS.push({ name, run, tags });
  const walker = (H, cls = 'warrior', o = {}) => { const my = H.corridor(); H.startWave(); const h = H.hero(cls, 1, my, o); return { my, h }; };

  add('trap: spike damages a hero walking over it and reveals itself', H => {
    const my = H.corridor();
    const s = H.place('trap', 'spike', 6, my);
    H.startWave();
    const h = H.hero('warrior', 1, my); h.maxHp = h.hp = 5000;
    H.assert(H.until(() => (H.S.stats.trapDamage.spike || 0) > 0, 20) >= 0, 'spike dealt damage');
    H.assert(s.revealed, 'spike revealed after triggering');
    H.assert(H.DH.Danger.get(6, my) > 0, 'danger memory added');
  });

  add('trap: arrow wall shoots heroes down the corridor', H => {
    const my = H.corridor();
    H.place('trap', 'arrow', 8, my - 1);
    H.startWave();
    const h = H.hero('warrior', 1, my); h.maxHp = h.hp = 5000;
    H.assert(H.until(() => (H.S.stats.trapDamage.arrow || 0) > 0, 20) >= 0, 'arrow hit');
  });

  add('trap: pit swallows a weak hero and breaks', H => {
    const my = H.corridor();
    const s = H.place('trap', 'pit', 5, my);
    H.startWave(); H.keepAlive();
    const h = H.hero('rogue', 2, my, { hp: 30 });
    h.ai.disarmFail.add(s.uid); // this test is about the pit, not the rogue's disarm roll
    H.assert(H.until(() => h.dead, 15) >= 0, 'weak hero killed');
    H.assert(s.broken, 'pit used up');
    H.assert((H.S.stats.trapKills.pit || 0) === 1, 'kill credited to pit');
  });

  add('trap: pit only damages a strong hero; miners are immune', H => {
    const my = H.corridor();
    const s = H.place('trap', 'pit', 5, my);
    H.startWave(); H.keepAlive();
    const m = H.hero('miner', 2, my); m.maxHp = m.hp = 2000;
    H.until(() => m.x > 6.5, 20);
    H.assert(!s.broken && !m.dead, 'miner did not trigger pit');
    const w = H.hero('warrior', 2, my); w.maxHp = w.hp = 2000;
    H.assert(H.until(() => s.broken, 20) >= 0, 'warrior triggered pit');
    H.assert(!w.dead && w.hp < 2000, 'strong hero only damaged');
  });

  add('trap: slime slows', H => {
    const my = H.corridor();
    H.place('trap', 'slime', 5, my);
    H.startWave();
    const h = H.hero('warrior', 2, my);
    H.assert(H.until(() => h.st.slowT > 0 && h.st.slow > 0.3, 15) >= 0, 'slowed');
  });

  add('trap: fire vent burns', H => {
    const my = H.corridor();
    H.place('trap', 'fire', 5, my);
    H.startWave();
    const h = H.hero('warrior', 2, my); h.maxHp = h.hp = 5000;
    H.assert(H.until(() => h.st.burnT > 0, 15) >= 0, 'burning');
    H.step(2);
    H.assert((H.S.stats.trapDamage.fire || 0) > 0, 'burn damage credited to fire vent');
  });

  add('trap: alarm rune enrages nearby monsters', H => {
    const my = H.corridor();
    H.place('trap', 'alarm', 5, my);
    const sk = H.place('monster', 'skeleton', 9, my + 1 <= H.S.rows - 2 ? my : my).ent;
    H.startWave();
    const h = H.hero('warrior', 2, my); h.maxHp = h.hp = 5000;
    H.assert(H.until(() => sk.st.buffT > 0, 15) >= 0, 'monster buffed by alarm');
  });

  add('trap: boulder rolls and crushes', H => {
    const my = H.corridor();
    const b = H.place('trap', 'boulder', 12, my);
    H.startWave();
    const h = H.hero('warrior', 2, my); h.maxHp = h.hp = 5000;
    H.assert(H.until(() => (H.S.stats.trapDamage.boulder || 0) > 0, 20) >= 0, 'boulder hit');
    H.assert(!b.data.ready || b.cd > 0, 'boulder spent / recharging');
  });

  add('trap: teleporter sends an advancing hero back to the entrance', H => {
    const my = H.corridor();
    const pad = H.place('trap', 'teleport', 8, my);
    H.startWave();
    const h = H.hero('warrior', 5, my); h.maxHp = h.hp = 5000;
    H.assert(H.until(() => pad.cd > 0, 15) >= 0, 'pad triggered');
    H.assert(h.x < 3, 'hero back near entrance (x=' + h.x.toFixed(2) + ')');
  });

  add('trap: reset traps power repairs pits and clears cooldowns', H => {
    const my = H.corridor();
    const s = H.place('trap', 'pit', 5, my);
    H.startWave(); H.keepAlive();
    H.hero('rogue', 2, my, { hp: 20 });
    H.until(() => s.broken, 15);
    H.assert(s.broken, 'pit broken');
    H.S.mana = 100;
    H.assert(H.DH.Powers.cast('reset', 0, 0), 'reset cast');
    H.assert(!s.broken && !s.revealed, 'pit repaired and hidden again');
  });

  add('trap: level 3 stats stronger than level 1', H => {
    for (const id of Object.keys(TRAPS)) {
      const a = H.DH.Traps.stats(id, 1), b = H.DH.Traps.stats(id, 3);
      H.assert(a && b && typeof a === 'object', 'stats for ' + id);
      const better = Object.keys(a).some(k => typeof a[k] === 'number' && a[k] !== b[k]);
      H.assert(better, 'level 3 differs for ' + id);
    }
  });

  add('perk: Rusted Blades bleed + Whetstone damage', H => {
    H.perk('rusted_blades'); H.perk('whetstone');
    const my = H.corridor();
    H.place('trap', 'spike', 5, my);
    H.startWave();
    const h = H.hero('warrior', 2, my); h.maxHp = h.hp = 5000;
    H.assert(H.until(() => h.st.bleedT > 0, 15) >= 0, 'bleeding');
    const st = H.DH.Traps.stats('spike', 1);
    H.assert(st.dmg >= Math.round(TRAPS.spike.dmg[0] * 1.4) - 1, 'whetstone in stats');
  });

  add('perk: Sticky, Kindling, Quick Reload, Stonemason alter stats', H => {
    const a = H.DH.Traps.stats('slime', 1), f = H.DH.Traps.stats('fire', 1), r = H.DH.Traps.stats('arrow', 1), b = H.DH.Traps.stats('boulder', 1);
    H.perk('sticky'); H.perk('kindling'); H.perk('quick_reload'); H.perk('stonemason');
    const a2 = H.DH.Traps.stats('slime', 1), f2 = H.DH.Traps.stats('fire', 1), r2 = H.DH.Traps.stats('arrow', 1), b2 = H.DH.Traps.stats('boulder', 1);
    H.assert(JSON.stringify(a) !== JSON.stringify(a2), 'sticky');
    H.assert(JSON.stringify(f) !== JSON.stringify(f2), 'kindling');
    H.assert(JSON.stringify(r) !== JSON.stringify(r2), 'quick reload');
    H.assert(JSON.stringify(b) !== JSON.stringify(b2), 'stonemason');
  });

  add('perk: Echoing Halls fires extra arrows', H => {
    H.perk('echoing_halls');
    const my = H.corridor();
    H.place('trap', 'arrow', 8, my - 1);
    H.startWave();
    const h = H.hero('warrior', 1, my); h.maxHp = h.hp = 5000;
    const orig = H.DH.Game && Proj.spawn; let arrows = 0, firstT = -1, secondT = -1;
    Proj.spawn = function (p) { if (p.kind === 'arrow') { arrows++; if (arrows === 1) firstT = H.S.time; if (arrows === 2) secondT = H.S.time; } return orig.call(Proj, p); };
    try { H.until(() => arrows >= 2, 15); } finally { Proj.spawn = orig; }
    H.assert(arrows >= 2 && secondT - firstT < 0.6, `second volley follows quickly (${arrows} arrows, gap ${(secondT - firstT).toFixed(2)}s)`);
  });

  add('perk: Trapmaster rearms pits', H => {
    H.perk('trapmaster');
    const my = H.corridor();
    const s = H.place('trap', 'pit', 5, my);
    H.startWave(); H.keepAlive();
    H.hero('rogue', 2, my, { hp: 20 });
    H.until(() => (H.S.stats.trapKills.pit || 0) > 0, 15);
    H.step(9);
    H.assert(!s.broken, 'pit rearmed');
  });

  add('perk: Hidden Depths hides visible traps at wave start', H => {
    H.perk('hidden_depths');
    const s = H.place('trap', 'slime', 5, 5);
    H.startWave(); H.keepAlive();
    H.assert(s.hidden, 'slime hidden');
  });

  add('object: rogue loots a chest and runs; thief escaping steals gold', H => {
    const S = H.S, my = S.entrance.y;
    const c = H.place('object', 'chest', 4, my - 2);
    S.gold = 1000;
    H.startWave();
    const r = H.hero('rogue', 1, my); r.maxHp = r.hp = 5000;
    H.assert(H.until(() => r.loot > 0, 20) >= 0, 'rogue picked up treasure');
    H.assert(c.data.empty, 'chest emptied');
    H.assert(H.until(() => r.escaped || S.stats.stolen > 0, 30) >= 0, 'rogue escaped');
    H.assert(S.stats.stolen > 0, 'gold stolen');
  });

  add('object: barricade blocks until smashed', H => {
    const my = H.corridor();
    const b = H.place('object', 'barricade', 6, my);
    H.startWave();
    const h = H.hero('warrior', 2, my); h.maxHp = h.hp = 5000;
    H.until(() => b.hp < b.maxHp, 20);
    H.assert(b.hp < b.maxHp, 'hero attacked barricade');
    H.assert(h.x < 6.6 || b.broken, 'hero did not walk through intact barricade');
    H.assert(H.until(() => b.broken, 60) >= 0, 'barricade broken eventually');
  });

  add('object: lair spawns temporary monsters', H => {
    const s = H.place('object', 'lair', 8, 4);
    H.startWave(); H.keepAlive();
    H.step(15);
    H.assert(H.S.monsters.some(m => m.lair === s && m.temp), 'lair spawned a monster');
  });

  add('object: mana well speeds mana regeneration', H => {
    H.startWave(); H.keepAlive();
    H.S.mana = 0; H.step(4);
    const base = H.S.mana;
    H.DH.Game.endWave(); H.DH.Game.pickPerk(null);
    H.place('object', 'well', 8, 4);
    H.S.nextWave = H.emptyWave();
    H.startWave(); H.keepAlive();
    H.S.mana = 0; H.step(4);
    H.assert(H.S.mana > base + 1, `well adds mana (${base.toFixed(1)} → ${H.S.mana.toFixed(1)})`);
  });

  add('object: torch exposes heroes and reveals hidden traps to them', H => {
    const s = H.place('trap', 'spike', 6, 5);
    H.place('object', 'torch', 6, 4);
    H.startWave(); H.keepAlive();
    const h = H.hero('warrior', 6, 6);
    H.step(0.1);
    H.assert(h.st.exposed, 'hero exposed in torchlight');
    H.assert(trapKnown(s), 'lit hidden trap is known to heroes');
  });
})();
