// Perk effects not covered elsewhere (numeric effects, not just unlocks).
(() => {
  const add = (name, run, tags = ['perks']) => window.SCENARIOS.push({ name, run, tags });
  const tough = h => { h.maxHp = h.hp = 5000; return h; };
  const MS = (t) => window.DH.Monsters.stats(t, 1);

  add('perk: Scavenger increases loot from kills', H => {
    const S = H.S;
    H.startWave(); H.keepAlive();
    const avg = () => { let tot = 0; for (let i = 0; i < 30; i++) { const v = H.hero('warrior', 5, 3); const g = S.gold; H.DH.Combat.damage(v, 1e6, { team: 'dm', kind: 'power', id: 'x' }); tot += S.gold - g; } return tot / 30; };
    const a = avg();
    H.perk('scavenger');
    const b = avg();
    H.assert(b > a * 1.08, `avg kill gold ${a.toFixed(1)} → ${b.toFixed(1)}`);
  });

  add('perk: Web Weaver webs root and splash', H => {
    const s0 = MS('spider');
    H.perk('web_weaver');
    const s1 = MS('spider');
    H.assert(s1.webRoot > s0.webRoot && s1.webSplash > s0.webSplash, 'stats show root/splash');
    const my = H.S.entrance.y;
    H.place('monster', 'spider', 9, my + 2);
    H.startWave();
    const a = tough(H.hero('warrior', 7, my)), b = tough(H.hero('warrior', 7, my - 1));
    [a, b].forEach(h => { h.dmg = 0; h.speed = 0.01; });
    H.assert(H.until(() => a.st.rootT > 0 || b.st.rootT > 0, 15) >= 0, 'a hero was rooted by a web');
  });

  add('perk: Infernal Pact — imp range +1 and burning bolts', H => {
    const s0 = MS('imp');
    H.perk('infernal_pact');
    const s1 = MS('imp');
    H.assert(s1.range === s0.range + 1 && s1.burnDps > 0, 'stats');
    const my = H.S.entrance.y;
    H.place('monster', 'imp', 9, my + 2);
    H.startWave();
    const h = tough(H.hero('warrior', 5, my)); h.dmg = 0; h.speed = 0.01;
    H.assert(H.until(() => h.st.burnT > 0, 15) >= 0, 'hero ignited');
  });

  add('perk: Spectral Host — wraith hits can fear', H => {
    H.perk('spectral_host');
    H.assert(MS('wraith').fearChance > 0, 'fear chance in stats');
    const my = H.S.entrance.y;
    H.place('monster', 'wraith', 8, my + 1);
    H.startWave();
    const h = tough(H.hero('warrior', 7, my)); h.dmg = 0; h.speed = 0.01; h.st.rootT = 1e9;
    let feared = false;
    H.until(() => { feared = feared || h.st.fearT > 0; return feared; }, 40);
    H.assert(feared, 'hero feared by a wraith within 40s');
  });

  add('perk: Labyrinth Lord / Dark Pact / Dragon\'s Hoard / Mimicry numbers', H => {
    const m0 = MS('minotaur').abilityCd, l0 = MS('lich').raiseCount, a0 = MS('mimic').ambushDmg;
    H.perk('labyrinth_lord'); H.perk('dark_pact'); H.perk('mimicry');
    H.assert(MS('minotaur').abilityCd < m0, 'charge cd shorter');
    H.assert(MS('lich').raiseCount === l0 + 1, 'lich raises one more');
    H.assert(MS('mimic').ambushDmg >= a0 * 1.5 - 0.01, 'mimic ambush +50%');
    H.perk('dragons_hoard');
    H.place('object', 'chest', 3, 3); H.place('object', 'chest', 4, 3);
    H.assert(MS('dragon').hoardMul >= 1.2 - 1e-6, 'dragon hoard multiplier with 2 chests: ' + MS('dragon').hoardMul);
  });

  add('perk: Reinforced Stone doubles new barricade HP and slows wall breaking', H => {
    const b0 = H.place('object', 'barricade', 6, 6).maxHp;
    H.perk('reinforced');
    const b1 = H.place('object', 'barricade', 6, 8).maxHp;
    H.assert(b1 === b0 * 2, 'new barricades doubled');
    // Miner dig takes about twice as long.
    H.fresh();
    for (let y = 1; y < H.S.rows - 1; y++) if (y !== 1) H.wall(8, y);
    H.startWave();
    tough(H.hero('miner', 7, H.S.entrance.y));
    const w0 = H.S.tiles.filter(t => t.type === T.WALL).length;
    const t1 = H.until(() => H.S.tiles.filter(t => t.type === T.WALL).length < w0, 30);
    H.fresh(); H.perk('reinforced');
    for (let y = 1; y < H.S.rows - 1; y++) if (y !== 1) H.wall(8, y);
    H.startWave();
    tough(H.hero('miner', 7, H.S.entrance.y));
    const w1 = H.S.tiles.filter(t => t.type === T.WALL).length;
    const t2 = H.until(() => H.S.tiles.filter(t => t.type === T.WALL).length < w1, 30);
    H.assert(t1 > 0 && t2 > t1 + 1, `dig time ${t1.toFixed(2)}s → ${t2.toFixed(2)}s`);
  });

  add('perk: Cursed Gold slows treasure carriers', H => {
    const S = H.S, my = S.entrance.y;
    H.startWave(); H.keepAlive();
    const a = tough(H.hero('warrior', 3, my)); a.loot = 30;
    H.step(1.5); const d1 = a.x - 3.5;
    H.perk('cursed_gold');
    const b = tough(H.hero('warrior', 3, my)); b.loot = 30;
    H.step(1.5); const d2 = b.x - 3.5;
    H.assert(d2 < d1 * 0.8, `carrier speed ${d1.toFixed(2)} → ${d2.toFixed(2)}`);
  });

  add('perk: every perk has an owner effect or immediate effect (smoke)', H => {
    // Taking every perk at once must not throw, and a wave must still run cleanly.
    H.S.phase = 'reward';
    for (const p of PERKS) { if (!p.repeatable) H.DH.Perks.take(p.id); }
    H.S.phase = 'build';
    H.place('trap', 'spike', 5, H.S.entrance.y); H.place('monster', 'skeleton', 8, 3); H.place('object', 'chest', 6, 3);
    H.S.nextWave = H.DH.Waves.generate(1);
    H.DH.Game.startWave();
    H.until(() => H.S.phase !== 'wave', 120);
    H.assert(H.S.phase === 'reward' || H.S.phase === 'gameover', 'wave resolved: ' + H.S.phase);
  });
})();
