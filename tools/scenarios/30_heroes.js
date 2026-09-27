// Adventurer AI, end-to-end.
(() => {
  const add = (name, run, tags = ['heroes']) => window.SCENARIOS.push({ name, run, tags });
  const tough = h => { h.maxHp = h.hp = 5000; return h; };
  const wallCount = S => S.tiles.filter(t => t.type === T.WALL).length;

  add('hero: walks to the Heart and damages it', H => {
    H.startWave();
    const h = tough(H.hero('warrior'));
    const hp = H.S.heartHp;
    H.assert(H.until(() => H.S.heartHp < hp, 40) >= 0, 'heart damaged');
    H.assert(h.state === 'heart' || h.state === 'rush', 'state at heart: ' + h.state);
  });

  add('hero: never stands inside a wall while walking a maze', H => {
    const S = H.S;
    let flip = false;
    for (let c = 3; c <= S.heart.x - 3; c += 3) { const gap = flip ? S.rows - 2 : 1; flip = !flip; for (let y = 1; y < S.rows - 1; y++) if (y !== gap) { const t = H.DH.Grid.tile(c, y); if (t.type === 0 && !t.s) H.wall(c, y); } }
    H.startWave();
    const hs = H.party([{ cls: 'warrior' }, { cls: 'rogue' }, { cls: 'ranger' }, { cls: 'cleric' }]).map(tough);
    let bad = 0;
    for (let i = 0; i < 60 * 40; i += 5) { H.DH.step(5); for (const h of hs) if (!h.dead && H.DH.Grid.isSolid(Math.floor(h.x), Math.floor(h.y)) && h.type !== 'miner') bad++; }
    H.assert(bad === 0, 'no hero inside walls (' + bad + ' samples)');
    H.assert(hs.some(h => h.state === 'heart' || h.state === 'rush') || H.S.heartHp < H.S.heartMax, 'party made progress through the maze');
  });

  add('hero: smart heroes route around a known trap', H => {
    const S = H.S, my = S.entrance.y;
    S.wave = 15;
    // Two parallel lanes (rows my and my-2) separated by a wall row; trap on lane my.
    H.fillWalls((x, y) => !(y === my || y === my - 2 || (x === 2 || x === S.heart.x - 1) && y >= my - 2 && y <= my) && !(x >= S.heart.x - 1 && Math.abs(y - my) <= 1));
    const trap = H.place('trap', 'slime', 8, my);
    H.startWave(); H.keepAlive();
    trap.revealed = true; trap.hidden = false;
    const h = tough(H.hero('mage', 2, my));
    H.step(1.5);
    const onTrap = (h.path || []).some(p => p.x === 8 && p.y === my);
    let crossed = false;
    H.until(() => { if (Math.floor(h.x) === 8 && Math.floor(h.y) === my) crossed = true; return h.x > 10; }, 30);
    H.assert(!onTrap && !crossed, 'mage avoided the known trap lane');
  });

  add('hero: danger memory reroutes later heroes', H => {
    const S = H.S, my = S.entrance.y;
    S.wave = 15;
    H.fillWalls((x, y) => !(y === my || y === my - 2 || (x === 2 || x === S.heart.x - 1) && y >= my - 2 && y <= my) && !(x >= S.heart.x - 1 && Math.abs(y - my) <= 1));
    for (let x = 5; x < 12; x++) H.DH.Danger.add(x, my, 8, 0);
    H.startWave(); H.keepAlive();
    const h = tough(H.hero('cleric', 2, my));
    let used = false;
    H.until(() => { if (Math.floor(h.y) === my && h.x > 5 && h.x < 12) used = true; return h.x > 13; }, 30);
    H.assert(!used, 'cleric avoided the remembered kill-zone');
  });

  add('hero: rogue detects and disarms hidden traps', H => {
    const S = H.S, my = H.corridor();
    const s = H.place('trap', 'spike', 7, my);
    const old = { d: HERO_CLASSES.rogue.detect, a: HERO_CLASSES.rogue.disarm };
    HERO_CLASSES.rogue.detect = 1; HERO_CLASSES.rogue.disarm = 1;
    try {
      H.startWave();
      tough(H.hero('rogue', 3, my));
      H.assert(H.until(() => s.revealed, 10) >= 0, 'detected');
      H.assert(H.until(() => s.disarmed, 10) >= 0, 'disarmed');
    } finally { HERO_CLASSES.rogue.detect = old.d; HERO_CLASSES.rogue.disarm = old.a; }
  });

  add('hero: ranger reveals hidden traps nearby', H => {
    const my = H.corridor();
    const s = H.place('trap', 'fire', 9, my);
    H.startWave();
    tough(H.hero('ranger', 3, my));
    H.assert(H.until(() => s.revealed, 15) >= 0, 'revealed by ranger');
  });

  add('hero: mage blasts a wall to shortcut a long maze', H => {
    const S = H.S;
    S.wave = 10;
    let flip = false;
    for (let c = 3; c <= S.heart.x - 3; c += 2) { const gap = flip ? S.rows - 2 : 1; flip = !flip; for (let y = 1; y < S.rows - 1; y++) if (y !== gap) { const t = H.DH.Grid.tile(c, y); if (t.type === 0 && !t.s) H.wall(c, y); } }
    const w0 = wallCount(S);
    H.startWave();
    tough(H.hero('mage', 2, S.entrance.y));
    H.assert(H.until(() => wallCount(S) < w0, 40) >= 0, 'a wall was blasted');
  });

  add('hero: dwarf miner digs through walls', H => {
    const S = H.S, my = S.entrance.y;
    for (let y = 1; y < S.rows - 1; y++) if (y !== 1) H.wall(8, y);
    const w0 = wallCount(S);
    H.startWave();
    tough(H.hero('miner', 5, my));
    H.assert(H.until(() => wallCount(S) < w0, 30) >= 0, 'miner dug a tunnel');
  });

  add('hero: cleric heals an injured ally', H => {
    H.startWave();
    const [c, w] = H.party([{ cls: 'cleric' }, { cls: 'warrior' }]);
    w.hp = Math.round(w.maxHp * 0.4);
    const hp = w.hp;
    H.assert(H.until(() => w.hp > hp, 10) >= 0, 'healed');
  });

  add('hero: paladin Lay on Hands saves a dying ally once', H => {
    H.startWave(); H.keepAlive();
    const [p, r] = H.party([{ cls: 'paladin' }, { cls: 'rogue' }]);
    H.DH.Combat.damage(r, 9999, { team: 'dm', kind: 'power', id: 'x' });
    H.assert(!r.dead && r.hp > 0, 'saved');
    H.DH.Combat.damage(r, 9999, { team: 'dm', kind: 'power', id: 'x' });
    H.assert(r.dead, 'only once per wave');
  });

  add('hero: low HP hero retreats', H => {
    const S = H.S;
    H.startWave(); H.keepAlive();
    const h = H.hero('ranger', 8, S.entrance.y);
    h.hp = Math.round(h.maxHp * 0.2);
    H.step(1);
    H.assert(h.state === 'retreat' || h.escaped, 'retreating (state=' + h.state + ')');
  });

  add('hero: feared hero flees toward the entrance', H => {
    const S = H.S;
    H.startWave(); H.keepAlive();
    const h = tough(H.hero('warrior', 10, S.entrance.y));
    H.DH.Status.apply(h, 'fear', { dur: 3, x: h.x + 1, y: h.y });
    const x0 = h.x;
    H.step(2);
    H.assert(h.x < x0 - 1, 'moved away (' + x0.toFixed(1) + ' → ' + h.x.toFixed(1) + ')');
  });

  add('hero: party stays together', H => {
    H.startWave();
    const hs = H.party([{ cls: 'warrior' }, { cls: 'rogue' }, { cls: 'cleric' }, { cls: 'ranger' }]).map(tough);
    // Cohesion rule: nobody runs more than ~3 tiles ahead of the leader (by walking distance to the Heart).
    let worstLead = 0;
    for (let i = 0; i < 8; i++) {
      H.step(1);
      const lead = hs.find(h => h.leader && !h.dead);
      if (!lead) continue;
      const ld = H.DH.Path.heartDist(lead.x, lead.y);
      for (const h of hs) if (!h.dead && h !== lead) worstLead = Math.max(worstLead, ld - H.DH.Path.heartDist(h.x, h.y));
    }
    H.assert(worstLead <= 6, 'max lead over the leader ' + worstLead.toFixed(1) + ' tiles'); // members wait at most 4s, then may drift
  });

  add('hero boss: Champion Shield Bash stuns monsters', H => {
    const S = H.S, my = S.entrance.y;
    const m = H.place('monster', 'orc', 6, my).ent; m.maxHp = m.hp = 5000;
    H.startWave();
    const b = H.hero('warrior', 4, my, { boss: 'champion' });
    H.assert(H.until(() => m.st.stunT > 0, 15) >= 0, 'orc stunned by bash');
  });

  add('hero boss: Archmage Blinks through walls', H => {
    const S = H.S, my = S.entrance.y;
    for (let y = 1; y < S.rows - 1; y++) if (y !== 1) H.wall(7, y);
    H.startWave();
    const b = tough(H.hero('mage', 5, my, { boss: 'archmage' }));
    let jumped = false, lastX = b.x;
    H.until(() => { if (b.x - lastX > 1.5) jumped = true; lastX = b.x; return jumped; }, 20);
    H.assert(jumped, 'blinked forward');
  });

  add('hero boss: Saint Sanctuary heals allies', H => {
    H.startWave(); H.keepAlive();
    const [s, w] = H.party([{ cls: 'cleric', boss: 'saint' }, { cls: 'warrior' }]);
    w.hp = 10;
    H.assert(H.until(() => w.hp >= 40, 12) >= 0, 'big heal');
  });

  add('hero boss: Shadow disarms traps and turns invisible', H => {
    const my = H.corridor();
    const t = H.place('trap', 'spike', H.S.heart.x - 3, my); // far enough that Shadowstep is off cooldown
    H.startWave();
    const b = tough(H.hero('rogue', 2, my, { boss: 'shadow' }));
    H.assert(H.until(() => t.disarmed && b.st.invisT > 0, 15) >= 0, 'disarmed + invisible');
  });

  add('perk: Time Warp slows heroes; Midas adds HP; Cursed Gold slows thieves', H => {
    H.startWave(); H.keepAlive();
    const a = tough(H.hero('warrior', 2, H.S.entrance.y));
    const hp0 = H.hero('warrior').maxHp;
    H.step(2); const d1 = a.x;
    H.perk('time_warp'); H.perk('midas');
    const b = tough(H.hero('warrior', 2, H.S.entrance.y));
    H.step(2); const d2 = b.x;
    H.assert(d2 < d1 - 0.1, `time warp slower (${d1.toFixed(2)} vs ${d2.toFixed(2)})`);
    const c = H.hero('warrior');
    H.assert(c.maxHp >= Math.round(hp0 * 1.19), 'midas HP');
  });

  add('perk: Paranoia — heroes ignore danger for the first 10s', H => {
    H.startWave(); H.keepAlive();
    H.S.wave = 15;
    const h = H.hero('mage', 3, 3);
    const idx = H.DH.Grid.idx(6, 6);
    H.S.danger[idx] = 20;
    const c0 = H.DH.Heroes.costFn(h)(6, 6, idx);
    H.perk('paranoia');
    H.S.time = 2;
    const c1 = H.DH.Heroes.costFn(h)(6, 6, idx);
    H.S.time = 12;
    const c2 = H.DH.Heroes.costFn(h)(6, 6, idx);
    H.assert(c1 < c0 && H.near(c2, c0, 0.001), `paranoia costs ${c0} / ${c1} / ${c2}`);
  });

  add('perk: Orcish Warcry taunts heroes', H => {
    H.perk('warcry');
    const my = H.S.entrance.y;
    const orc = H.place('monster', 'orc', 7, my + 1).ent; orc.maxHp = orc.hp = 9999;
    H.place('monster', 'goblin', 6, my - 1);
    H.startWave();
    const r = tough(H.hero('ranger', 6, my));
    H.assert(H.until(() => r.target === orc, 8) >= 0, 'ranger targets the taunting orc');
  });

  add('perk: Greedy Gods doubles lure radius', H => {
    const r = Lures.radius();
    H.perk('greedy_gods');
    H.assert(Lures.radius() === r * 2, 'radius doubled');
  });

  add('hero: stress — 40 heroes + 30 monsters at 4x stays fast', H => {
    const S = H.S;
    for (let i = 0; i < 30; i++) { const x = 4 + (i % 12), y = 2 + Math.floor(i / 12) * 4; const t = H.DH.Grid.tile(x, y); if (t.type === 0 && !t.s) H.place('monster', i % 2 ? 'skeleton' : 'goblin', x, y); }
    H.startWave();
    for (let i = 0; i < 10; i++) H.party([{ cls: 'warrior' }, { cls: 'rogue' }, { cls: 'mage' }, { cls: 'cleric' }]);
    const t0 = performance.now();
    H.DH.step(240);
    const ms = (performance.now() - t0) / 240;
    H.assert(ms < 4, 'ms per step ' + ms.toFixed(2));
    return 'ms/step ' + ms.toFixed(2);
  });
})();
