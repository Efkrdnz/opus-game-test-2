// Waves, perks and Dungeon Master powers.
(() => {
  const add = (name, run, tags = ['director']) => window.SCENARIOS.push({ name, run, tags });
  const tough = h => { h.maxHp = h.hp = 5000; return h; };

  add('waves: deterministic previews and a sane size curve', H => {
    const S = H.S;
    const a = JSON.stringify(H.DH.Waves.generate(7)), b = JSON.stringify(H.DH.Waves.generate(7));
    H.assert(a === b, 'deterministic');
    const sizes = [];
    for (const n of [1, 2, 3, 5, 10, 15, 20, 30]) {
      S.wave = n;
      const w = H.DH.Waves.generate(n);
      const total = w.parties.reduce((t, p) => t + p.members.length, 0);
      H.assert(total === w.total, 'total matches members for wave ' + n);
      sizes.push(n + ':' + total + (w.boss ? '(' + w.boss + ')' : ''));
      if (n === 1) H.assert(total >= 2 && total <= 4 && w.parties.every(p => p.members.every(m => ['warrior', 'rogue'].includes(m.cls))), 'wave 1 gentle');
      if (n % 5 === 0) H.assert(w.boss && w.parties[0].members.some(m => m.boss === w.boss), 'boss wave ' + n);
      for (const p of w.parties) for (const m of p.members) H.assert(HERO_CLASSES[m.cls].minWave <= n, `${m.cls} not allowed at ${n}`);
    }
    return sizes.join(' ');
  });

  add('waves: spawns every scheduled hero, then done()', H => {
    const S = H.S;
    S.wave = 3;
    S.nextWave = H.DH.Waves.generate(3);
    H.DH.Game.startWave();
    const total = S.nextWave.total;
    H.until(() => H.DH.Waves.done(), 60);
    H.assert(H.DH.Waves.done() && S.ws.spawned === total, `spawned ${S.ws.spawned}/${total}`);
  });

  add('waves: the Guild counters a trap-heavy dungeon', H => {
    const S = H.S;
    const mix = () => { const c = {}; for (let s = 0; s < 6; s++) { S.seed = 1000 + s; const w = H.DH.Waves.generate(14); for (const k in w.counts) c[k] = (c[k] || 0) + w.counts[k]; } return c; };
    S.wave = 14;
    const base = mix();
    for (let x = 3; x < S.heart.x - 1; x++) for (const y of [2, 4, 6, 8, 10]) { const t = H.DH.Grid.tile(x, y); if (t && t.type === 0 && !t.s) H.place('trap', x % 2 ? 'spike' : 'fire', x, y); }
    const trappy = mix();
    const share = c => ((c.rogue || 0) + (c.ranger || 0)) / Object.values(c).reduce((a, b) => a + b, 0);
    H.assert(share(trappy) > share(base), `rogue+ranger share ${share(base).toFixed(2)} → ${share(trappy).toFixed(2)}`);
    const notes = H.DH.Waves.generate(14).guildNotes || [];
    H.assert(notes.length > 0, 'guild notes explain the counter');
    return notes.join(' | ');
  });

  add('perks: roll offers only valid perks', H => {
    const S = H.S;
    H.fresh({ unlockAll: false });
    H.perk('architect');
    for (let i = 0; i < 300; i++) {
      const c = H.DH.Perks.roll(3);
      H.assert(c.length === 3 && new Set(c).size === 3, 'three distinct');
      H.assert(!c.includes('architect'), 'owned non-repeatable excluded');
      for (const id of c) {
        const p = PERK_BY_ID[id];
        if (p.req) H.assert(H.DH.Build.isUnlocked(p.req[0], p.req[1]), id + ' req met');
        if (p.unlocks) H.assert(p.unlocks.some(([a, b]) => !H.DH.Build.isUnlocked(a, b)), id + ' still unlocks something');
      }
    }
  });

  add('perks: immediate effects (treasury, mend, glass cannon, reinforced, unlocks)', H => {
    const S = H.S;
    S.phase = 'reward';
    let g = S.gold; H.DH.Perks.take('treasury'); H.assert(S.gold === g + 150, 'treasury');
    S.heartHp = 50; const m0 = S.heartMax; H.DH.Perks.take('mend'); H.assert(S.heartMax === m0 + 10 && S.heartHp === 85, 'mend');
    const m1 = S.heartMax; H.DH.Perks.take('glass_cannon'); H.assert(S.heartMax === Math.round(m1 * 0.7) && S.heartHp <= S.heartMax, 'glass cannon max hp');
    S.phase = 'build';
    const b = H.place('object', 'barricade', 6, 6); const bh = b.maxHp;
    S.phase = 'reward'; H.DH.Perks.take('reinforced'); H.assert(b.maxHp === bh * 2, 'existing barricade doubled');
    H.fresh({ unlockAll: false }); H.S.phase = 'reward';
    H.DH.Perks.take('arcane_circuitry');
    H.assert(H.DH.Build.isUnlocked('trap', 'teleport') && H.DH.Build.isUnlocked('trap', 'alarm'), 'arcane circuitry unlocks');
    H.DH.Perks.take('summoning_circle');
    H.assert(H.DH.Build.isUnlocked('object', 'lair') && H.DH.Build.isUnlocked('object', 'well'), 'summoning circle unlocks');
    H.DH.Perks.take('stonemason');
    H.assert(H.DH.Build.isUnlocked('trap', 'boulder'), 'stonemason unlocks');
    H.assert(H.S.perkOrder.length === 3, 'perks recorded');
  });

  add('powers: refuse outside waves, spend mana, respect cooldown', H => {
    const S = H.S;
    H.assert(!H.DH.Powers.canCast('lightning').ok, 'not in build phase');
    H.startWave(); H.keepAlive();
    const h = tough(H.hero('warrior', 8, 5));
    S.mana = 100;
    H.assert(H.DH.Powers.cast('lightning', h.x, h.y), 'lightning cast');
    H.assert(S.mana === 100 - H.DH.Powers.cost('lightning'), 'mana spent');
    H.assert(h.hp < 5000, 'damage dealt');
    H.assert(!H.DH.Powers.canCast('lightning').ok, 'on cooldown');
    S.mana = 5;
    H.step(4);
    H.assert(!H.DH.Powers.canCast('lightning').ok && /mana/i.test(H.DH.Powers.canCast('lightning').reason), 'not enough mana reason');
  });

  add('powers: fear, collapse, reset', H => {
    const S = H.S;
    const spike = H.place('trap', 'spike', 4, 9);
    H.startWave(); H.keepAlive();
    spike.cd = 1.5; spike.revealed = true; // something for Reset Traps to do
    S.mana = 100;
    const h = tough(H.hero('warrior', 9, 5));
    H.assert(H.DH.Powers.cast('fear', h.x, h.y), 'fear cast');
    H.assert(h.st.fearT > 0, 'feared');
    const p = tough(H.hero('paladin', 9, 7));
    const m = S.mana;
    H.assert(!H.DH.Powers.cast('fear', p.x, p.y) && S.mana === m, 'paladin immune, no mana spent');
    S.mana = 100;
    H.assert(H.DH.Powers.cast('collapse', 12.5, 3.5), 'collapse');
    H.assert(H.DH.Grid.tile(12, 3).type === T.WALL, 'rubble');
    S.mana = 100;
    H.assert(H.DH.Powers.cast('reset', 0, 0), 'reset (a spike exists to rearm)');
  });

  add('perks: Overcharge, Mana Spring, Chain Lightning, Soul Harvest', H => {
    const S = H.S;
    const c0 = H.DH.Powers.cost('lightning');
    H.perk('overcharge');
    H.assert(H.DH.Powers.cost('lightning') === Math.round(c0 * 0.7), 'overcharge');
    H.startWave(); H.keepAlive();
    S.mana = 0; H.step(2); const r0 = S.mana;
    H.perk('mana_spring');
    S.mana = 0; H.step(2);
    H.assert(S.mana > r0 * 1.3, 'mana spring');
    H.perk('chain_lightning');
    const hs = [[6, 5], [8, 5], [6, 7], [8, 7]].map(([x, y]) => tough(H.hero('warrior', x, y)));
    S.mana = 100; S.powerCd = {};
    H.DH.Powers.cast('lightning', hs[0].x, hs[0].y);
    H.step(1.2); // arcs hop one after another
    H.assert(hs.filter(h => h.hp < 5000).length >= 4, 'chained to 3 others (' + hs.filter(h => h.hp < 5000).length + ')');
    H.perk('soul_harvest');
    S.mana = 10;
    const v = H.hero('rogue', 5, 3); H.DH.Combat.damage(v, 9999, { team: 'dm', kind: 'power', id: 'x' });
    H.assert(S.mana >= 13.9, 'soul harvest mana');
  });

  add('perks: Interest pays out at wave end', H => {
    const S = H.S;
    H.perk('interest');
    S.gold = 500;
    H.startWave();
    const g = S.gold;
    H.DH.Game.endWave();
    H.assert(S.lastSummary.interest === 50, 'interest 10% (got ' + S.lastSummary.interest + ')');
  });

  add('perks: Heart of Thorns doubles the pulse', H => {
    const S = H.S;
    H.startWave(); H.keepAlive();
    // maxHp 100 keeps the %-of-max-HP part small; hp is huge so nobody dies. Exactly one pulse per window.
    const a = H.hero('warrior', S.heart.x - 1, S.heart.y); a.maxHp = 100; a.hp = 1e6; a.speed = 0; a.st.rootT = 99; a.heartDmg = 0;
    S.heartPulseT = 0.01; H.step(0.5); const d1 = 1e6 - a.hp;
    H.perk('thorns');
    a.hp = 1e6;
    S.heartPulseT = 0.01; H.step(0.5); const d2 = 1e6 - a.hp;
    H.assert(d1 > 0 && d2 === d1 * 2, `thorns doubles the pulse ${d1} → ${d2}`);
  });
})();
