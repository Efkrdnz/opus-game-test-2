// Core rules: path validation, building economy, core-owned perks, expansion, saving, Heart.
(() => {
  const add = (name, run, tags = ['core']) => window.SCENARIOS.push({ name, run, tags });

  add('core: wall that seals the Heart is rejected', H => {
    const S = H.S, hx = S.heart.x;
    // Wall column x = hx-1 except the Heart's row, then try to close the gap.
    for (let y = 1; y < S.rows - 1; y++) if (y !== S.heart.y) H.wall(hx - 1, y);
    const gold = S.gold;
    const r = H.DH.Build.place('wall', 'wall', hx - 1, S.heart.y);
    H.assert(!r.ok && r.blocks, 'sealing wall should be rejected with blocks flag');
    H.assert(H.DH.Grid.tile(hx - 1, S.heart.y).type === T.FLOOR, 'tile must stay floor');
    H.assert(S.gold === gold, 'no gold spent');
    H.assert(H.DH.Path.reachable(), 'heart still reachable');
  });

  add('core: barricade may fill the last gap (passable)', H => {
    const S = H.S, hx = S.heart.x;
    for (let y = 1; y < S.rows - 1; y++) if (y !== S.heart.y) H.wall(hx - 1, y);
    H.place('object', 'barricade', hx - 1, S.heart.y);
    H.assert(H.DH.Path.reachable(), 'barricade does not block validation');
    const p = H.DH.Path.preview();
    H.assert(p.length > 0, 'preview route exists through barricade');
  });

  add('core: sell refunds 60% (100% with Salvager)', H => {
    const S = H.S;
    H.place('trap', 'spike', 5, 3);
    let g = S.gold; H.DH.Build.sell(5, 3);
    H.assert(S.gold - g === Math.floor(TRAPS.spike.cost * 0.6), 'sell 60%');
    H.perk('salvager');
    H.place('trap', 'spike', 5, 3);
    g = S.gold; H.DH.Build.sell(5, 3);
    H.assert(S.gold - g === TRAPS.spike.cost, 'salvager 100%');
  });

  add('core: Architect halves wall cost; Spectral Host discounts wraiths', H => {
    const c0 = H.DH.Build.cost('wall', 'wall');
    H.perk('architect');
    H.assert(H.DH.Build.cost('wall', 'wall') === Math.ceil(c0 * 0.5), 'architect');
    const w0 = H.DH.Build.cost('monster', 'wraith');
    H.perk('spectral_host');
    H.assert(H.DH.Build.cost('monster', 'wraith') < w0, 'spectral host discount');
  });

  add('core: upgrades cost more per level, Tinkerer discount, max level 3', H => {
    const s = H.place('trap', 'spike', 6, 3);
    const c1 = H.DH.Build.upgradeCost(s);
    H.DH.Build.upgrade(6, 3);
    H.assert(s.level === 2, 'level 2');
    const c2 = H.DH.Build.upgradeCost(s);
    H.assert(c2 > c1, 'L3 costs more');
    H.perk('tinkerer');
    H.assert(H.DH.Build.upgradeCost(s) < c2, 'tinkerer discount');
    H.DH.Build.upgrade(6, 3);
    H.assert(s.level === 3 && H.DH.Build.upgradeCost(s) === null, 'max level 3');
  });

  add('core: only one dungeon boss', H => {
    H.place('boss', 'minotaur', 8, 4);
    const r = H.DH.Build.canPlace('boss', 'lich', 10, 4);
    H.assert(!r.ok, 'second boss rejected');
  });

  add('core: arrow wall must be on a wall facing floor', H => {
    const S = H.S;
    H.assert(!H.DH.Build.canPlace('trap', 'arrow', 5, 5).ok, 'not on floor');
    H.wall(5, 5);
    H.assert(H.DH.Build.canPlace('trap', 'arrow', 5, 5).ok, 'ok on wall');
    H.assert(!H.DH.Build.canPlace('trap', 'arrow', 0, 0).ok, 'corner rock faces nothing');
  });

  add('core: danger memory decays between waves (faster with Mastermind)', H => {
    const S = H.S;
    H.DH.Danger.add(6, 5, 10, 0);
    const v = H.DH.Danger.get(6, 5);
    H.DH.Danger.decay();
    H.assert(H.near(H.DH.Danger.get(6, 5), v * CFG.dangerDecay, 0.01), 'normal decay');
    H.perk('mastermind');
    const v2 = H.DH.Danger.get(6, 5);
    H.DH.Danger.decay();
    H.assert(H.near(H.DH.Danger.get(6, 5), v2 * CFG.dangerDecayMastermind, 0.01), 'mastermind decay');
  });

  add('core: collapse validates the path and damages heroes', H => {
    const S = H.S, hx = S.heart.x;
    for (let y = 1; y < S.rows - 1; y++) if (y !== S.heart.y) H.wall(hx - 1, y);
    H.startWave();
    H.assert(!H.DH.Grid.canCollapse(hx - 1, S.heart.y).ok, 'cannot seal heart');
    const h = H.hero('warrior', 6, 3);
    const hp = h.hp;
    H.assert(H.DH.Grid.collapse(6, 3, 40), 'collapse ok');
    H.assert(H.DH.Grid.tile(6, 3).type === T.WALL && H.DH.Grid.tile(6, 3).rubble, 'rubble wall');
    H.assert(h.hp < hp, 'hero damaged');
    H.assert(!H.DH.Grid.isSolid(Math.floor(h.x), Math.floor(h.y)), 'hero shoved out of the wall');
  });

  add('core: Heart damage, Blood Tax, Undying Heart', H => {
    const S = H.S;
    H.startWave();
    H.keepAlive();
    H.perk('blood_tax');
    const g = S.gold, hp = S.heartHp;
    H.DH.Heart.damage(10);
    H.assert(S.heartHp === hp - 10, 'heart damaged');
    H.assert(S.gold === g + 6, 'blood tax paid');
    H.perk('undying_heart');
    const near = H.hero('rogue', S.heart.x - 1, S.heart.y);
    H.DH.Heart.damage(9999);
    H.assert(S.heartHp === Math.round(S.heartMax * 0.25) && S.undyingUsed, 'undying left the heart at 25%');
    H.assert(near.st.fearT > 0, 'fear nova');
    H.DH.Heart.damage(9999);
    H.assert(S.heartHp === 0 && S.endingT > 0, 'second lethal blow destroys it');
  });

  add('core: kill bounty, Blood Money doubles, Scavenger adds loot', H => {
    const S = H.S;
    H.startWave(); H.keepAlive();
    const a = H.hero('rogue', 5, 3);
    let g = S.gold; H.DH.Combat.damage(a, 9999, { team: 'dm', kind: 'power', id: 'lightning' });
    const base = S.gold - g;
    H.assert(a.dead && base >= H.DH.Econ.bounty(a), 'bounty + loot paid');
    H.perk('blood_money');
    const b = H.hero('rogue', 5, 4);
    g = S.gold; H.DH.Combat.damage(b, 9999, { team: 'dm', kind: 'power', id: 'lightning' });
    H.assert(S.gold - g >= base * 1.6, 'blood money ~doubles kill gold');
  });

  add('core: escaping thief steals gold (Blood Money x3, Cursed Gold x2)', H => {
    const S = H.S;
    H.startWave(); H.keepAlive();
    const h = H.hero('rogue', 1, S.entrance.y);
    h.loot = 50; S.gold = 1000;
    H.DH.Game.heroEscaped(h);
    H.assert(S.gold === 950 && S.stats.stolen === 50, 'stole 50');
    H.perk('blood_money'); H.perk('cursed_gold');
    const h2 = H.hero('rogue', 1, S.entrance.y); h2.loot = 10;
    H.DH.Game.heroEscaped(h2);
    H.assert(S.gold === 950 - 60, 'x3 x2 theft');
  });

  add('core: Glass Cannon boosts trap damage; torchlight exposes', H => {
    const S = H.S;
    H.startWave(); H.keepAlive();
    const h = H.hero('warrior', 5, 3); h.maxHp = h.hp = 5000;
    let hp = h.hp; H.DH.Combat.damage(h, 20, { team: 'dm', kind: 'trap', id: 'spike' });
    const base = hp - h.hp;
    H.perk('glass_cannon');
    hp = h.hp; H.DH.Combat.damage(h, 20, { team: 'dm', kind: 'trap', id: 'spike' });
    H.assert(hp - h.hp === Math.round(base * 1.4), 'glass cannon +40%');
    h.st.exposed = true;
    hp = h.hp; H.DH.Combat.damage(h, 20, { team: 'dm', kind: 'power', id: 'x' });
    H.assert(hp - h.hp === 25, 'exposed +25%');
  });

  add('core: full wave cycle → reward → perk → next wave', H => {
    const S = H.S;
    H.startWave();
    const h = H.hero('rogue', 3, S.entrance.y);
    H.DH.Combat.damage(h, 9999, { team: 'dm', kind: 'power', id: 'lightning' });
    const t = H.until(() => S.phase === 'reward', 10);
    H.assert(t >= 0, 'reached reward phase');
    H.assert(S.lastSummary && S.lastSummary.kills === 1, 'summary counts kill');
    H.DH.Game.pickPerk(null);
    H.assert(S.phase === 'build' && S.wave === 2, 'next build phase');
    H.assert(S.nextWave && S.nextWave.wave === 2, 'next wave previewed');
  });

  add('core: dungeon expands after wave 10 and everything shifts', H => {
    const S = H.S;
    const s = H.place('trap', 'spike', 8, 3);
    H.place('monster', 'skeleton', 9, 3);
    S.wave = 10; S.phase = 'reward';
    const oc = S.cols;
    H.DH.Game.pickPerk(null);
    H.assert(S.wave === 11 && S.cols > oc, 'grid grew');
    H.assert(H.DH.Build.structAt(s.x, s.y) === s && s.x === 8 + (S.cols - oc), 'struct shifted');
    const m = S.monsters[0];
    H.assert(Math.floor(m.x) === s.x + 1, 'monster shifted with its post');
    H.assert(H.DH.Path.reachable(), 'still reachable');
    H.assert(H.DH.Grid.tile(S.entrance.x, S.entrance.y).type === T.ENTRANCE, 'entrance at new edge');
  });

  add('core: expansion preserves the maze (route never gets shorter)', H => {
    const S = H.S;
    let flip = false;
    for (let c = 3; c <= S.heart.x - 3; c += 3) { const gap = flip ? S.rows - 2 : 1; flip = !flip; for (let y = 1; y < S.rows - 1; y++) if (y !== gap) { const t = H.DH.Grid.tile(c, y); if (t.type === 0 && !t.s) H.wall(c, y); } }
    const before = H.DH.Path.preview().length;
    S.wave = 10; S.phase = 'reward';
    H.DH.Game.pickPerk(null);
    const after = H.DH.Path.preview().length;
    H.assert(after >= before, `route ${before} → ${after}`);
  });

  add('core: game over records best run in localStorage', H => {
    const S = H.S;
    S.wave = 7;
    H.startWave();
    H.DH.Heart.damage(99999);
    const t = H.until(() => S.phase === 'gameover', 5);
    H.assert(t >= 0, 'game over reached');
    const raw = localStorage.getItem(H.DH.Save.KEY);
    H.assert(raw && JSON.parse(raw).bestWave >= 6, 'best saved');
  });

  add('core: new run fully resets state', H => {
    const S1 = H.S;
    H.place('trap', 'spike', 5, 5);
    H.perk('architect');
    H.DH.Game.newRun();
    const S2 = H.S;
    H.assert(S2 !== S1 && S2.structs.length === 0 && !S2.perks.architect && S2.wave === 1 && S2.phase === 'build', 'reset');
  });
})();
