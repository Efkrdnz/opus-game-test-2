// Monsters & dungeon bosses, end-to-end.
(() => {
  const add = (name, run, tags = ['monsters']) => window.SCENARIOS.push({ name, run, tags });
  const tough = h => { h.maxHp = h.hp = 5000; return h; };

  for (const id of ['skeleton', 'goblin', 'orc', 'spider', 'imp', 'wraith']) {
    add(`monster: ${id} engages and damages a passing hero`, H => {
      const S = H.S, my = S.entrance.y;
      const m = H.place('monster', id, 8, my + 1).ent;
      H.startWave();
      const h = tough(H.hero('warrior', 4, my));
      h.dmg = 0; // don't kill the monster; we only test that it fights
      H.assert(H.until(() => h.hp < 5000, 20) >= 0, `${id} hurt the hero`);
      H.assert(!m.dead, 'monster alive');
    });
  }

  add('monster: skeleton reassembles after death (faster with Bone Yard)', H => {
    const m = H.place('monster', 'skeleton', 8, 3).ent;
    H.startWave(); H.keepAlive();
    H.DH.Combat.damage(m, 9999, { team: 'hero', kind: 'hero', id: 'warrior' });
    H.assert(m.dead, 'dead');
    const t = H.until(() => !m.dead, 15);
    H.assert(t >= 8 && t <= 12, 'respawned after ~10s (took ' + t + ')');
    H.perk('bone_yard');
    H.DH.Combat.damage(m, 9999, { team: 'hero', kind: 'hero', id: 'warrior' });
    const t2 = H.until(() => !m.dead, 10);
    H.assert(t2 >= 3 && t2 <= 5.5, 'bone yard ~4s (took ' + t2 + ')');
  });

  add('monster: non-skeletons stay dead until their post is repaired', H => {
    const s = H.place('monster', 'orc', 8, 3), m = s.ent;
    H.startWave(); H.keepAlive();
    H.DH.Combat.damage(m, 9999, { team: 'hero', kind: 'hero', id: 'warrior' });
    H.step(15);
    H.assert(m.dead, 'orc stays dead during the wave');
    H.DH.Game.endWave();
    H.assert(m.dead && s.broken, 'post broken after the wave (no free revival)');
    H.assert(H.S.monsters.includes(m), 'still registered');
    H.DH.Game.pickPerk(null);
    H.assert(H.S.phase === 'build', 'back in the build phase');
    const cost = H.DH.Build.repairCost(s), gold = H.S.gold;
    H.assert(cost === Math.ceil(s.spent * CFG.repairRate), 'repair costs 30% of the gold invested (' + cost + ')');
    H.assert(H.DH.Build.repair(8, 3), 'Build.repair succeeds');
    H.assert(!m.dead && m.hp === m.maxHp && !s.broken && H.S.gold === gold - cost, 'revived at full HP for the repair cost');
    H.assert(m.x === 8.5 && m.y === 3.5, 'back at its post');
  });

  add('monster: spider webs slow heroes', H => {
    const my = H.S.entrance.y;
    H.place('monster', 'spider', 9, my + 2);
    H.startWave();
    const h = tough(H.hero('warrior', 5, my)); h.dmg = 0;
    H.assert(H.until(() => h.st.slowT > 0 || h.st.rootT > 0, 15) >= 0, 'webbed');
  });

  add('monster: imp attacks from range', H => {
    const my = H.S.entrance.y;
    const imp = H.place('monster', 'imp', 9, my + 2).ent;
    H.startWave();
    const h = tough(H.hero('warrior', 5, my)); h.dmg = 0; h.speed = 0.01;
    let fired = false;
    H.until(() => { fired = fired || H.S.projectiles.some(p => p.kind === 'fire'); return fired; }, 10);
    H.assert(fired, 'imp fired a fire bolt');
  });

  add('monster: wraith passes through walls', H => {
    const S = H.S, my = S.entrance.y;
    // A solid wall line between the wraith and the corridor (with a gap far away).
    for (let x = 2; x < S.cols - 4; x++) if (x !== 2) { const t = H.DH.Grid.tile(x, my + 1); if (t.type === 0 && !t.s) H.wall(x, my + 1); }
    const w = H.place('monster', 'wraith', 10, my + 3).ent;
    H.startWave();
    const h = tough(H.hero('warrior', 10, my)); h.dmg = 0; h.speed = 0.01;
    H.assert(H.until(() => h.hp < 5000, 15) >= 0, 'wraith reached the hero through the wall');
  });

  add('monster: mimic hides as a chest, then ambushes', H => {
    const S = H.S, my = S.entrance.y;
    const m = H.place('monster', 'mimic', 5, my - 2).ent;
    H.startWave();
    H.assert(m.disguised, 'disguised at wave start');
    H.assert(Lures.list().some(l => l.kind === 'mimic'), 'mimic is a lure');
    const r = tough(H.hero('rogue', 1, my));
    H.assert(H.until(() => !m.disguised, 25) >= 0, 'ambush happened');
    H.assert(r.hp < 5000, 'rogue bitten');
  });

  add('boss: Minotaur charges a hero in line', H => {
    const S = H.S, my = S.entrance.y;
    const m = H.place('boss', 'minotaur', 12, my).ent;
    H.startWave();
    const h = tough(H.hero('warrior', 7, my)); h.dmg = 0;
    let charged = false;
    H.until(() => { charged = charged || m.state === 'charge'; return charged; }, 15);
    H.assert(charged, 'minotaur charged');
    H.assert(h.hp < 5000, 'charge hurt the hero');
  });

  add('boss: Lich raises corpses as skeletons', H => {
    const S = H.S, my = S.entrance.y;
    const lich = H.place('boss', 'lich', 10, my + 2).ent;
    H.startWave(); H.keepAlive();
    const v = H.hero('rogue', 8, my + 2);
    H.DH.Combat.damage(v, 9999, { team: 'dm', kind: 'power', id: 'lightning' });
    const bait = tough(H.hero('warrior', 7, my)); bait.dmg = 0; bait.speed = 0.01;
    H.assert(H.until(() => S.monsters.some(m => m.risen && m.temp && !m.dead), 20) >= 0, 'risen skeleton appeared');
  });

  add('boss: Dragon breathes fire on a group', H => {
    const S = H.S, my = S.entrance.y;
    H.place('boss', 'dragon', 11, my).ent;
    H.startWave();
    const hs = [tough(H.hero('warrior', 8, my)), tough(H.hero('warrior', 8, my - 1)), tough(H.hero('warrior', 8, my + 1))];
    hs.forEach(h => { h.dmg = 0; h.speed = 0.01; });
    H.assert(H.until(() => hs.filter(h => h.st.burnT > 0).length >= 2, 20) >= 0, 'breath burned 2+ heroes');
  });

  add('monster: returns home after losing its target', H => {
    const S = H.S, my = S.entrance.y;
    const m = H.place('monster', 'goblin', 8, my + 3).ent;
    H.startWave(); H.keepAlive();
    const h = tough(H.hero('warrior', 7, my)); h.dmg = 0;
    H.until(() => dist(m.x, m.y, m.homeX, m.homeY) > 1.5 || m.target, 10);
    H.DH.Combat.damage(h, 99999, { team: 'dm', kind: 'power', id: 'x' });
    H.assert(H.until(() => dist(m.x, m.y, m.homeX, m.homeY) < 0.6, 15) >= 0, 'back at post');
  });

  add('monster: upgrade raises stats (refreshStats)', H => {
    const s = H.place('monster', 'orc', 8, 3);
    const hp1 = s.ent.maxHp;
    H.DH.Build.upgrade(8, 3);
    H.assert(s.ent.maxHp > hp1, 'maxHp increased');
    const st1 = H.DH.Monsters.stats('orc', 1), st3 = H.DH.Monsters.stats('orc', 3);
    H.assert(st3.hp > st1.hp && st3.dmg > st1.dmg, 'stats() scale by level');
  });

  add('monster: summon cap and temp removal at wave end', H => {
    H.startWave(); H.keepAlive();
    let n = 0;
    for (let i = 0; i < 80; i++) if (H.DH.Monsters.summon('skeleton', 6.5, 5.5, { temp: true })) n++;
    H.assert(n > 0 && n <= 45, 'summons capped (' + n + ')');
    H.DH.Game.endWave();
    H.assert(!H.S.monsters.some(m => m.temp), 'temps removed');
  });

  add('perk: Sticky Fingers — goblin hits pay gold', H => {
    H.perk('sticky_fingers');
    const my = H.S.entrance.y;
    H.place('monster', 'goblin', 8, my + 1);
    H.startWave();
    const h = tough(H.hero('warrior', 5, my)); h.dmg = 0;
    const g = H.S.gold;
    H.until(() => h.hp < 5000, 15); H.step(1);
    H.assert(H.S.gold > g, 'gold gained from goblin hits');
  });

  add('perk: Mimicry unlock + stronger ambush', H => {
    H.fresh({ unlockAll: false });
    H.assert(!H.DH.Build.isUnlocked('monster', 'mimic'), 'mimic locked at start');
    H.S.phase = 'reward';
    H.DH.Perks.take('mimicry');
    H.assert(H.DH.Build.isUnlocked('monster', 'mimic'), 'mimicry unlocked it');
  });

  add('perk: Pack Tactics & Adrenaline raise monster damage', H => {
    const my = H.S.entrance.y;
    for (const x of [7, 8, 9]) H.place('monster', 'skeleton', x, my + 1);
    H.startWave();
    const h = H.hero('warrior', 8, my); h.dmg = 0; h.speed = 0; h.st.rootT = 1e9; h.maxHp = h.hp = 1e6;
    H.until(() => h.hp < 1e6, 10); H.step(2);
    let hp = h.hp; H.step(20); const base = hp - h.hp;
    H.perk('pack_tactics'); H.perk('adrenaline'); H.S.heartHp = 10;
    hp = h.hp; H.step(20); const boosted = hp - h.hp;
    H.assert(boosted > base * 1.4, `boosted damage (${base} → ${boosted})`);
  });

  add('perk: Labyrinth Lord / Dark Pact / Dragon\'s Hoard unlock bosses', H => {
    H.fresh({ unlockAll: false });
    H.S.phase = 'reward';
    for (const [p, b] of [['labyrinth_lord', 'minotaur'], ['dark_pact', 'lich'], ['dragons_hoard', 'dragon']]) {
      H.assert(!H.DH.Build.isUnlocked('boss', b), b + ' locked');
      H.DH.Perks.take(p);
      H.assert(H.DH.Build.isUnlocked('boss', b), b + ' unlocked by ' + p);
    }
  });

  add('perk: Necromancy raises slain heroes; Legion raises slain monsters', H => {
    H.perk('necromancy');
    H.startWave(); H.keepAlive();
    let risen = 0;
    for (let i = 0; i < 40; i++) {
      const v = H.hero('rogue', 5, 3);
      H.DH.Combat.damage(v, 9999, { team: 'dm', kind: 'power', id: 'x' });
    }
    risen = H.S.monsters.filter(m => m.risen).length;
    H.assert(risen >= 2 && risen <= 25, 'about 25% rose (' + risen + '/40)'); // P(outside) ≈ 1e-4
    H.perk('legion');
    H.DH.Game.endWave(); H.DH.Game.pickPerk(null);
    const orc = H.place('monster', 'orc', 9, 4).ent;
    H.S.nextWave = H.emptyWave();
    H.startWave(); H.keepAlive();
    H.DH.Combat.damage(orc, 9999, { team: 'hero', kind: 'hero', id: 'warrior' });
    H.assert(H.S.monsters.some(m => m.risen && m !== orc), 'legion skeleton');
  });
})();
