/* =============================================================================
 *  31 MONSTERS — the Dungeon Master's minions and dungeon bosses.
 *
 *    Guard AI   idle at the post (tiny wander) → chase a visible hero inside the
 *               guard radius → attack in range → return when the target stays
 *               out of sight for 2s or the leash snaps; regenerate at home.
 *    Kits       Skeleton reassembles · Goblin pilfers · Orc knocks back ·
 *               Spider webs · Imp kites with fire bolts · Wraith phases & drains ·
 *               Mimic ambushes from its chest disguise.
 *    Bosses     Minotaur Charge · Lich Raise Dead (+ shadow bolts) · Dragon Fire Breath.
 *    Extras     summon() for Necromancy / Legion / Lich / lairs, alarm() for runes.
 *
 *  Walkers treat walls, rock, standing barricades and the Heart tile as solid
 *  (only the Wraith phases through); sight and projectiles pass over barricades.
 *  Module-private runtime state of an entity lives in `m.ai` (see makeAI); other
 *  modules only read the documented entity fields (SPEC §3.3).
 * ========================================================================== */
const Monsters = (() => {
  /* ---------------------------------------------------------------------------
   * 1. TUNING & PALETTES
   * ------------------------------------------------------------------------ */
  const SUMMON_CAP = 40;          // max living temp summons at once
  const SUMMON_GUARD = 8;         // hunt radius around the spawn point for post-less summons
  const SUMMON_LEASH = 11;
  const LOSE_T = 2;               // seconds a target may stay out of sight before we give up
  const SCAN_T = 0.2;             // target-scan cadence (staggered per monster)
  const LOS_T = 0.15;             // line-of-sight re-check cadence for the current target
  const REPATH_T = 0.35;          // min seconds between A* repaths toward a moving goal
  const SKIP_T = 3;               // ignore a hero we could not reach for this long (unless the grid changes)
  const STRAND_T = 1.5;           // how often a monster cut off from home re-checks the way back
  const WANDER_R = 0.8;           // idle wander radius around the post
  const RETURN_SLACK = 1.4;       // idle monsters farther than this from their anchor walk back
  const REGEN = 0.05;             // fraction of max HP regenerated per second at home
  const STAND_MELEE = 0.7;        // melee monsters close to this distance (≤ 0.9 blocks the hero)
  const STAND_BOSS = 0.8;
  const SEP_R = 0.55, SEP_R_BOSS = 0.8, SEP_K = 5; // monster–monster separation
  const ORC_KNOCK = 0.6;
  const KITE_LO = 2.5, KITE_HI = 4; // imps keep their target inside this distance band
  const CHARGE = { speed: 9, windup: 0.3, hitR: 0.8, stun: 1, knock: 0.9, recover: 0.45 };
  // Fire Breath: 35° half-angle cone; everything within `near` is engulfed regardless of angle.
  // While the breath is ≤ `holdT` s from ready, the dragon rears up instead of closing to melee.
  const BREATH = { half: 35 * Math.PI / 180, near: 1.3, windup: 0.45, dur: 0.75, burnDps: 8, burnDur: 3, holdT: 1.2 };
  const RAISE_CAST = 0.8;
  const MIMIC = { triggerR: 1.1, calmR: 3, calmT: 5, root: 1, stagger: 0.55 };
  const ELEM = { imp: 'fire', wraith: 'magic', lich: 'magic' }; // everything else hits 'phys'

  const PAL = {
    blood: ['#a01020', '#d02030', '#ff5a5a'],
    bone: ['#e8e2cc', '#c8c0a8', '#fffbe8', '#9a927c'],
    dust: ['#8a7a66', '#6b5e4f', '#a89880', '#c9b99a'],
    fire: ['#fff3a0', '#ffe066', '#ffb347', '#ff6a1f', '#ff3a10'],
    smoke: ['#5a5a5a', '#7a7a7a', '#3e3e3e'],
    shadow: ['#d0b0ff', '#b98cff', '#6a3aa0', '#2a0f4a'],
    necro: ['#39ff88', '#9dffb0', '#b98cff', '#7a3ad0'],
    web: ['#ffffff', '#e4e4ee', '#b8b8c8'],
    ghost: ['#e8f6ff', '#bfe8ff', '#8fc8ff'],
    wood: ['#8a5a2a', '#b07a40', '#5a3818', '#ffd84a'],
    heal: ['#7dff8a', '#c8ffd0'],
    rage: ['#ff4040', '#ff9a3c', '#ffd84a'],
  };
  const BOSS_FX = {
    minotaur: ['#8a5a2a', '#c07a3a', '#ffcf8a', '#5a1a0a'],
    lich: ['#39ff88', '#b98cff', '#2a0f4a', '#e8f6ff'],
    dragon: ['#ff3a10', '#ffb347', '#a01020', '#ffe066'],
  };
  // Reused option objects for effects emitted every tick (no per-tick garbage).
  const FX_BREATH = { n: 6, dir: [1, 0], spread: BREATH.half * 1.8, speed: 12, drag: 0.9, life: 0.6, size: 3.4, colors: PAL.fire, glow: true, jitter: 0.3 };
  const FX_TRAIL = { n: 2, dir: [-1, 0], spread: 1.2, colors: PAL.dust, speed: 1.4, life: 0.45, size: 2.4 };
  const SPOT = { x: 0, y: 0 };    // scratch result for openSpot()

  /* ---------------------------------------------------------------------------
   * 2. DEFINITIONS & STATS
   * ------------------------------------------------------------------------ */
  /** Content definition for a monster or boss type. */
  const defOf = type => MONSTERS[type] || BOSSES[type] || null;
  const r1 = v => Math.round(v * 10) / 10;
  const pct = v => Math.round(v * 100) + '%';

  function chestCount() {
    let n = 0;
    for (const s of S.structs) if (s.cat === 'object' && s.id === 'chest') n++;
    return n;
  }
  /** Dragon's Hoard: +10% dragon damage per Treasure Chest owned. */
  const hoardMul = () => (hasPerk('dragons_hoard') ? 1 + 0.1 * Math.min(5, chestCount()) : 1);
  /** Adrenaline: +35% damage and speed while the Heart is below half HP. */
  const adrenalineOn = () => hasPerk('adrenaline') && S.heartHp < S.heartMax * 0.5;

  /** Every number for a type at a level, with the current perks applied. */
  function calcStats(type, level) {
    const d = defOf(type);
    if (!d) return null;
    const L = clamp(Math.round(level) || 1, 1, 3);
    const mul = CFG.levelStatMul[L];
    const k = {
      type, name: d.name, level: L, boss: !!BOSSES[type], ranged: !!d.ranged,
      undead: !!d.undead, phasing: !!d.phasing, elem: ELEM[type] || 'phys',
      hp: Math.round(d.hp * mul), dmg: r1(d.dmg * mul), atkCd: d.atkCd, range: d.range,
      speed: d.speed, guard: d.guard, leash: d.leash, burnDps: 0, burnDur: 0,
    };
    switch (type) {
      case 'skeleton': k.respawn = hasPerk('bone_yard') ? 4 : d.respawn; break;
      case 'goblin': k.pilfer = hasPerk('sticky_fingers') ? 2 : 0; break;
      case 'orc': k.knockback = ORC_KNOCK; break;
      case 'spider': {
        const ww = hasPerk('web_weaver');
        k.webCd = d.webCd; k.webRange = d.webRange; k.webSlow = d.webSlow; k.webDur = d.webDur;
        k.webRoot = ww ? 1 : 0; k.webSplash = ww ? 1 : 0;
        break;
      }
      case 'imp':
        if (hasPerk('infernal_pact')) { k.range += 1; k.burnDps = 4; k.burnDur = 3; }
        break;
      case 'wraith': k.drain = d.drain; k.fearChance = hasPerk('spectral_host') ? 0.25 : 0; k.fearDur = 1.5; break;
      case 'mimic': k.ambushDmg = r1(d.ambushDmg * mul * (hasPerk('mimicry') ? 1.5 : 1)); break;
      case 'minotaur': k.chargeDmg = r1(d.chargeDmg * mul); k.chargeRange = d.chargeRange; break;
      case 'lich': k.raiseCount = d.raiseCount + (hasPerk('dark_pact') ? 1 : 0); k.raiseRange = d.raiseRange; break;
      case 'dragon':
        k.breathDmg = r1(d.breathDmg * mul); k.breathLen = d.breathLen;
        k.burnDps = BREATH.burnDps; k.burnDur = BREATH.burnDur; k.hoardMul = r1(hoardMul() * 100) / 100;
        break;
    }
    if (k.boss) {
      k.ability = d.ability;
      k.abilityCd = r1(d.abilityCd * (type === 'minotaur' && hasPerk('labyrinth_lord') ? 0.65 : 1));
    }
    k.dps = r1(k.dmg / k.atkCd);
    return k;
  }

  /** Living monsters (any, incl. disguised mimics) within 2 tiles of m, capped at 4. */
  function packCount(m) {
    let n = 0;
    for (const o of S.monsters) {
      if (o === m || o.dead || o.removed) continue;
      const dx = o.x - m.x, dy = o.y - m.y;
      if (dx * dx + dy * dy <= 4 && ++n >= 4) break;
    }
    return n;
  }
  /** Situational damage multiplier: Pack Tactics, Adrenaline, Dragon's Hoard. */
  function perkDmgMul(m) {
    let mul = 1;
    if (hasPerk('pack_tactics')) mul *= 1 + 0.12 * packCount(m);
    if (adrenalineOn()) mul *= 1.35;
    if (m.type === 'dragon') mul *= hoardMul();
    return mul;
  }
  /** Final damage of a blow: base (already level-scaled) × enrage buff × perks. */
  const hitDamage = (m, base) => base * Status.dmgMul(m) * perkDmgMul(m);
  /** Current movement speed in tiles/s (0 while stunned or rooted). */
  const moveSpeed = m => m.speed * Status.speedMul(m) * (adrenalineOn() ? 1.35 : 1);

  /* ---------------------------------------------------------------------------
   * 3. SMALL HELPERS — validity, anchors, geometry, movement
   * ------------------------------------------------------------------------ */
  /** A hero monsters may target (alive, in the dungeon, not invisible). */
  const validHero = h => !!h && !h.dead && !h.removed && !h.escaped && !(h.st && h.st.invisT > 0);
  /** A hero physically present (area effects also hit invisible heroes). */
  const heroHere = h => !!h && !h.dead && !h.removed && !h.escaped;
  const busy = m => m.state === 'charge' || m.state === 'breath' || m.state === 'cast' || m.state === 'ambush';
  /** Accept either an entity or a Structure (UI may pass the selected struct). */
  const entOf = x => (!x ? null : x.team === 'dm' ? x : x.ent || null);

  function angDiff(a, b) {
    const d = Math.abs(a - b) % (Math.PI * 2);
    return d > Math.PI ? Math.PI * 2 - d : d;
  }

  // The point a monster guards right now: its alarm rune while alarmed; the spot where it was
  // cut off while its home is unreachable; else home.
  const anchorX = m => (m.ai.alarmT > 0 ? m.ai.ax : m.ai.stranded ? m.ai.sx : m.homeX);
  const anchorY = m => (m.ai.alarmT > 0 ? m.ai.ay : m.ai.stranded ? m.ai.sy : m.homeY);
  function leashOf(m) {
    const base = m.post ? m.ai.k.leash : SUMMON_LEASH;
    return m.ai.alarmT > 0 ? Math.max(base, m.ai.alarmR) + 1.5 : base;
  }
  const guardOf = m => (m.post ? m.ai.k.guard : Math.max(SUMMON_GUARD, m.ai.k.guard));

  /** A tile a walking monster may not enter: walls, rock, the Heart, standing barricades. */
  function blockedTile(tx, ty) {
    if (Grid.isSolid(tx, ty)) return true;
    const t = S.tiles[ty * S.cols + tx];
    if (t.type === T.HEART) return true;
    const s = t.s;
    return !!s && s.cat === 'object' && s.id === 'barricade' && !s.broken;
  }
  /** May a walker standing on tile (cx,cy) move to world point (x,y)? (its own tile is always allowed) */
  function canStep(cx, cy, x, y) {
    const tx = Math.floor(x), ty = Math.floor(y);
    return (tx === cx && ty === cy) || !blockedTile(tx, ty);
  }
  /** Move to (nx,ny), sliding along obstacles; false when fully blocked. */
  function tryMove(e, nx, ny) {
    const cx = Math.floor(e.x), cy = Math.floor(e.y);
    if (canStep(cx, cy, nx, ny)) { e.x = nx; e.y = ny; return true; }
    if (canStep(cx, cy, nx, e.y)) { e.x = nx; return true; }
    if (canStep(cx, cy, e.x, ny)) { e.y = ny; return true; }
    return false;
  }

  // A* cost for walkers: 1 per open tile, Infinity through obstacles. The goal tile is exempt from
  // the non-solid blockers so a monster can still path *toward* a foe standing by the Heart.
  let pathGoal = -1;
  function walkCost(x, y, i) {
    const t = S.tiles[i];
    if (t.type === T.WALL || t.type === T.ROCK) return Infinity;
    if (i !== pathGoal && blockedTile(x, y)) return Infinity;
    return 1;
  }
  function findPath(sx, sy, gtx, gty) {
    pathGoal = Grid.inb(gtx, gty) ? gty * S.cols + gtx : -1;
    const p = Path.astar(sx, sy, gtx, gty, walkCost);
    pathGoal = -1;
    return p;
  }

  /** Does segment A→B pass through the box [x0,x1]×[y0,y1]? (slab test) */
  function segHitsBox(ax, ay, bx, by, x0, y0, x1, y1) {
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dy = by - ay;
    if (Math.abs(dx) < 1e-9) { if (ax < x0 || ax > x1) return false; }
    else {
      let ta = (x0 - ax) / dx, tb = (x1 - ax) / dx;
      if (ta > tb) { const q = ta; ta = tb; tb = q; }
      if ((t0 = Math.max(t0, ta)) > (t1 = Math.min(t1, tb))) return false;
    }
    if (Math.abs(dy) < 1e-9) return ay >= y0 && ay <= y1;
    let ta = (y0 - ay) / dy, tb = (y1 - ay) / dy;
    if (ta > tb) { const q = ta; ta = tb; tb = q; }
    return Math.max(t0, ta) <= Math.min(t1, tb);
  }
  /**
   * Is a standing barricade (or the Heart) in the way of A→B, widened by `margin`?
   * Walls are covered by Grid.los; the start and end tiles are ignored.
   */
  function blockerBetween(ax, ay, bx, by, margin) {
    const sx = Math.floor(ax), sy = Math.floor(ay), ex = Math.floor(bx), ey = Math.floor(by);
    const x0 = Math.floor(Math.min(ax, bx) - margin), x1 = Math.floor(Math.max(ax, bx) + margin);
    const y0 = Math.floor(Math.min(ay, by) - margin), y1 = Math.floor(Math.max(ay, by) + margin);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if ((x === sx && y === sy) || (x === ex && y === ey) || !Grid.inb(x, y) || Grid.isSolid(x, y) || !blockedTile(x, y)) continue;
      if (segHitsBox(ax, ay, bx, by, x - margin, y - margin, x + 1 + margin, y + 1 + margin)) return true;
    }
    return false;
  }

  /** Steer straight toward (gx,gy), stopping `stop` short. Returns true once arrived. */
  function steer(m, gx, gy, step, stop, ghost) {
    const dx = gx - m.x, dy = gy - m.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= stop + 1e-3) return true;
    if (step <= 0) return false;
    if (dx > 0.02) m.face = 1; else if (dx < -0.02) m.face = -1;
    const s = Math.min(step, d - stop);
    const nx = m.x + dx / d * s, ny = m.y + dy / d * s;
    if (ghost) { m.x = nx; m.y = ny; } else if (!tryMove(m, nx, ny)) { m.ai.blocked = true; return false; }
    return d - s <= stop + 1e-3;
  }

  /** Can a walker go straight from a to b without clipping walls or barricades? (centre line + both shoulders) */
  function clearWalk(ax, ay, bx, by) {
    if (!Grid.los(ax, ay, bx, by)) return false;
    const dx = bx - ax, dy = by - ay, d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.05) return true;
    const ox = -dy / d * 0.28, oy = dx / d * 0.28;
    return Grid.los(ax + ox, ay + oy, bx + ox, by + oy) && Grid.los(ax - ox, ay - oy, bx - ox, by - oy) &&
      !blockerBetween(ax, ay, bx, by, 0.28);
  }

  /**
   * Walk toward world point (gx,gy): straight when the way is short and clear,
   * else along a cached A* path to its tile (repathed on goal-tile change with a
   * throttle, immediately on S.pathVersion change). Wraiths drift straight
   * through walls. Returns false while the goal is unreachable.
   */
  function approach(m, gx, gy, dt, stop) {
    const ai = m.ai;
    let step = moveSpeed(m) * dt;
    if (step <= 0) return true;
    if (m.phasing) { steer(m, gx, gy, step, stop, true); return true; }
    const dx = gx - m.x, dy = gy - m.y, d2 = dx * dx + dy * dy;
    if (d2 <= stop * stop) return true;
    if (d2 < 6.25 && clearWalk(m.x, m.y, gx, gy)) {
      m.path = null; ai.unreach = false;
      steer(m, gx, gy, step, stop, false);
      return true;
    }
    const gtx = Math.floor(gx), gty = Math.floor(gy);
    const verChanged = ai.pathVer !== S.pathVersion;
    const goalMoved = ai.goalTx !== gtx || ai.goalTy !== gty;
    const exhausted = !!m.path && m.pathIdx >= m.path.length && goalMoved; // walked the old route, goal moved on
    const fresh = !m.path && !ai.unreach;                 // no route yet (failed searches retry on the timer)
    if (fresh || verChanged || exhausted || ((goalMoved || ai.blocked || !m.path) && ai.repathT <= 0)) {
      ai.pathVer = S.pathVersion; ai.goalTx = gtx; ai.goalTy = gty; ai.blocked = false;
      ai.repathT = REPATH_T + Math.random() * 0.25;
      m.path = findPath(m.x, m.y, gtx, gty);
      m.pathIdx = 0;
      ai.unreach = !m.path;
    }
    if (!m.path) return false;
    // Follow tile centres, carrying leftover movement across waypoints.
    const path = m.path;
    while (step > 1e-6 && m.pathIdx < path.length) {
      const wp = path[m.pathIdx];
      if (wp.x !== ai.goalTx || wp.y !== ai.goalTy ? blockedTile(wp.x, wp.y) : Grid.isSolid(wp.x, wp.y)) {
        ai.blocked = true; m.path = null; return true; // the route closed (Collapse etc.)
      }
      const wx = wp.x + 0.5, wy = wp.y + 0.5;
      const ddx = wx - m.x, ddy = wy - m.y, d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (ddx > 0.02) m.face = 1; else if (ddx < -0.02) m.face = -1;
      if (d <= step) { m.x = wx; m.y = wy; step -= d; m.pathIdx++; continue; }
      if (!tryMove(m, m.x + ddx / d * step, m.y + ddy / d * step)) ai.blocked = true;
      step = 0;
    }
    if (step > 1e-6 && m.pathIdx >= path.length) steer(m, gx, gy, step, stop, false);
    return true;
  }

  // Knockback may not push into walls/rock, barricades, the Heart or the Entrance.
  function shoveBlocked(x, y) {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (Grid.isSolid(tx, ty)) return true;
    const t = S.tiles[ty * S.cols + tx];
    return t.type === T.HEART || t.type === T.ENTRANCE || !!Grid.barricadeAt(tx, ty);
  }
  /** Push an entity up to `amt` tiles along (dx,dy), sliding along obstacles. Returns distance moved. */
  function shove(e, dx, dy, amt) {
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-6 || amt <= 0) return 0;
    const ux = dx / d, uy = dy / d, n = Math.max(1, Math.ceil(amt / 0.1)), inc = amt / n;
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const nx = e.x + ux * inc, ny = e.y + uy * inc;
      if (!shoveBlocked(nx, ny)) { e.x = nx; e.y = ny; moved += inc; }
      else if (Math.abs(ux) > 0.2 && !shoveBlocked(nx, e.y)) { e.x = nx; moved += inc * Math.abs(ux); }
      else if (Math.abs(uy) > 0.2 && !shoveBlocked(e.x, ny)) { e.y = ny; moved += inc * Math.abs(uy); }
      else break;
    }
    if (moved > 0.05 && e.team === 'hero') e.path = null; // force the hero to re-route from its new spot
    return moved;
  }

  /** Nearest open tile to (x,y) (the point itself if open) → SPOT. False if none within 3 tiles. */
  function openSpot(x, y) {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (Grid.inb(tx, ty) && !blockedTile(tx, ty)) { SPOT.x = x; SPOT.y = y; return true; }
    let best = Infinity;
    for (let r = 1; r <= 3 && best === Infinity; r++) {
      for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
        if (Math.max(Math.abs(ox), Math.abs(oy)) !== r || blockedTile(tx + ox, ty + oy)) continue;
        const cx = tx + ox + 0.5, cy = ty + oy + 0.5, d = dist(x, y, cx, cy);
        if (d < best) { best = d; SPOT.x = cx; SPOT.y = cy; }
      }
    }
    return best < Infinity;
  }

  function summonCount() {
    let n = 0;
    for (const m of S.monsters) if (m.temp && !m.dead && !m.removed) n++;
    return n;
  }

  /* ---------------------------------------------------------------------------
   * 4. PER-ENTITY AI STATE & TARGETING
   * ------------------------------------------------------------------------ */
  function makeAI(m) {
    const kind = m.isBoss ? 'boss' : 'monster';
    return {
      k: null,                                                   // calcStats() for the current level
      src: { team: 'dm', kind, id: m.type, ent: m, elem: ELEM[m.type] || 'phys' },
      srcFire: { team: 'dm', kind, id: m.type, ent: m, elem: 'fire' },
      scanT: Math.random() * SCAN_T, losT: 0, seen: false, reach: false, lostT: 0, ignoreT: 0, alertT: 0,
      skipUid: 0, skipT: 0, skipVer: -1,                         // a hero we could not reach
      stranded: false, sx: 0, sy: 0, strandT: 0, strandVer: -1,  // cut off from home: guard (sx,sy)
      unreach: false, blocked: false, repathT: 0, pathVer: -1, goalTx: -1, goalTy: -1,
      wanderT: Math.random() * 2, wx: m.x, wy: m.y, wax: m.x, way: m.y, // wander point & the anchor it belongs to
      alarmT: 0, ax: 0, ay: 0, alarmR: 0,
      webT: 0.5 + Math.random(), kiteT: 0, kx: NaN, ky: NaN,
      calmT: 0, lastHp: m.hp, regenFxT: 0, ambT: Math.random() * 2, hold: false,
      // boss ability runtime
      phase: 0, abT: 0, abScanT: 0, recoverT: 0, dirX: 1, dirY: 0, angle: 0,
      laneX: 0, laneY: 0, travel: 0, dashLen: 0, hits: [], corpses: [], cand: [],
    };
  }
  function initAI(m) { m.ai = makeAI(m); return m.ai; }

  /** Lock onto a hero ('!' callout the first time; bosses roar). */
  function engage(m, h) {
    const ai = m.ai, fresh = !m.target;
    m.target = h; ai.lostT = 0; ai.losT = LOS_T; ai.unreach = false; ai.repathT = 0; m.path = null;
    updateSight(m, h);
    if (!busy(m)) m.state = 'chase';
    if (fresh && ai.alertT <= 0) {
      ai.alertT = 4;
      FX.text(m.x, m.y - (m.isBoss ? 1.15 : 0.8), '!', m.isBoss ? '#ff7040' : '#ff5a5a', { size: m.isBoss ? 16 : 12, life: 0.6, vy: -0.6 });
      if (m.isBoss) { SFX.play('roar'); FX.shake(2); }
    }
  }

  /** Stop chasing and head back (after a snapped leash, ignore heroes for a moment). */
  function giveUp(m, leashed) {
    const ai = m.ai;
    if (ai.unreach && m.target) { ai.skipUid = m.target.uid; ai.skipT = SKIP_T; ai.skipVer = S.pathVersion; }
    m.target = null; m.path = null; ai.lostT = 0; ai.unreach = false; ai.repathT = 0; m.state = 'return';
    if (leashed) ai.ignoreT = 1.5;
  }

  /** Refresh sight (walls block) and melee reach (barricades & the Heart block too; wraiths ignore them). */
  function updateSight(m, t) {
    const ai = m.ai;
    ai.seen = Grid.los(m.x, m.y, t.x, t.y);
    ai.reach = ai.seen && (m.phasing || dist(m.x, m.y, t.x, t.y) > 2 || !blockerBetween(m.x, m.y, t.x, t.y, 0));
  }

  /**
   * Look for the nearest visible hero inside the guard zone (around home; around
   * the monster itself while alarmed or when just hit from afar). Summons hunt
   * without needing line of sight; wraiths sense through walls.
   */
  function acquire(m, provoked) {
    const ai = m.ai;
    if (ai.ignoreT > 0 && !provoked) return;
    const ax = anchorX(m), ay = anchorY(m), L = leashOf(m) - 0.3;
    if ((m.x - ax) * (m.x - ax) + (m.y - ay) * (m.y - ay) > L * L) return; // too far out to start a fight
    const g = guardOf(m);
    let cx = ai.stranded ? ai.sx : m.homeX, cy = ai.stranded ? ai.sy : m.homeY, r = g;
    if (provoked) { cx = m.x; cy = m.y; r = Math.max(g + 2, 6); }
    else if (ai.alarmT > 0) { cx = m.x; cy = m.y; r = g + 1; }
    const r2 = r * r, needLos = !m.phasing && !!m.post;
    let best = null, bd = Infinity;
    const skip = ai.skipT > 0 && ai.skipVer === S.pathVersion ? ai.skipUid : 0;
    for (const h of S.heroes) {
      if (!validHero(h) || h.uid === skip) continue;
      const hx = h.x - cx, hy = h.y - cy;
      if (hx * hx + hy * hy > r2) continue;
      const mx = h.x - m.x, my = h.y - m.y, d2 = mx * mx + my * my;
      if (d2 >= bd) continue;
      if (needLos && !Grid.los(m.x, m.y, h.x, h.y)) continue;
      best = h; bd = d2;
    }
    if (!best || best === m.target) return;
    const cur = m.target;
    if (cur && validHero(cur)) {
      const dc = dist(m.x, m.y, cur.x, cur.y);
      if (dc <= m.range + 0.3 || Math.sqrt(bd) > dc - 1) return; // stay on the current foe
    }
    engage(m, best);
  }

  /** Drop the target when it died/vanished, the leash snapped, or it stayed lost for LOSE_T. */
  function keepTarget(m, dt) {
    const t = m.target, ai = m.ai;
    if (!t) return;
    if (!validHero(t)) { m.target = null; ai.lostT = 0; ai.scanT = 0; ai.unreach = false; ai.repathT = 0; return; }
    const ax = anchorX(m), ay = anchorY(m), L = leashOf(m);
    if ((m.x - ax) * (m.x - ax) + (m.y - ay) * (m.y - ay) > L * L) { giveUp(m, true); return; }
    if ((ai.losT -= dt) <= 0) { ai.losT = LOS_T; updateSight(m, t); }
    // Placed walkers lose foes they cannot see; anyone loses foes they cannot reach
    // (ranged ones only if they cannot shoot them either).
    const shootable = ai.k.ranged && ai.seen && dist(m.x, m.y, t.x, t.y) <= m.range;
    const lost = (ai.unreach && !shootable) || (!ai.seen && !!m.post && !m.phasing);
    if (!lost) ai.lostT = 0;
    else if ((ai.lostT += dt) >= LOSE_T) giveUp(m, false);
  }

  /* ---------------------------------------------------------------------------
   * 5. ATTACKS — melee blows with kit effects, bolts, webs
   * ------------------------------------------------------------------------ */
  /** A melee blow plus the monster's on-hit kit. */
  function melee(m, t) {
    const ai = m.ai, k = ai.k;
    m.atkT = m.atkCd; m.animT = m.isBoss ? 0.4 : 0.3;
    m.face = t.x >= m.x ? 1 : -1;
    const dealt = Combat.damage(t, hitDamage(m, m.dmg), ai.src);
    FX.burst(t.x, t.y - 0.1, {
      n: m.isBoss ? 10 : 5, colors: k.elem === 'magic' ? PAL.ghost : PAL.blood,
      speed: m.isBoss ? 3 : 2, life: 0.35, size: m.isBoss ? 2.6 : 2, grav: 4,
    });
    SFX.play(m.type === 'spider' || m.type === 'mimic' || m.type === 'dragon' ? 'bite' : 'hit');
    if (m.isBoss) FX.shake(3);
    if (dealt <= 0) return;
    switch (m.type) {
      case 'goblin':
        if (k.pilfer) Econ.gain(k.pilfer, m.x, m.y - 0.8);
        break;
      case 'orc':
        if (!t.dead && shove(t, t.x - m.x, t.y - m.y, t.boss ? ORC_KNOCK * 0.5 : ORC_KNOCK) > 0.05) {
          FX.burst(t.x, t.y + 0.3, { n: 6, colors: PAL.dust, speed: 1.6, life: 0.4, size: 2.2 });
          FX.shake(2.5);
        }
        break;
      case 'wraith': {
        const healed = Combat.heal(m, dealt * k.drain, false);
        FX.beam(t.x, t.y - 0.15, m.x, m.y - 0.2, { color: '#9fe0ff', width: 2, life: 0.25 });
        if (healed > 0) FX.text(m.x, m.y - 0.75, '+' + healed, '#9fe0ff', { size: 9 });
        if (k.fearChance && !t.dead && Math.random() < k.fearChance &&
            Status.apply(t, 'fear', { dur: k.fearDur, x: m.x, y: m.y })) {
          FX.text(t.x, t.y - 0.95, 'Terrified!', '#c8a8ff', { size: 10 });
          FX.ring(t.x, t.y, { color: '#b98cff', r0: 0.2, r1: 1, life: 0.4, width: 2 });
          SFX.play('fear');
        }
        break;
      }
    }
  }

  /** Imp fire bolt / Lich shadow bolt (homing projectile). */
  function shoot(m, t) {
    const ai = m.ai, k = ai.k, lich = m.type === 'lich';
    m.atkT = m.atkCd; m.animT = 0.3; m.face = t.x >= m.x ? 1 : -1;
    const ox = m.x + m.face * 0.25, oy = m.y - (lich ? 0.45 : 0.3);
    Proj.spawn({
      kind: lich ? 'shadow' : 'fire', x: ox, y: oy, team: 'dm', target: t, speed: lich ? 6.5 : 7.5,
      dmg: hitDamage(m, m.dmg), range: k.range + 3, radius: 0.35, src: ai.src,
      burnDps: k.burnDps, burnDur: k.burnDur, onHit: onBoltHit, onEnd: onBoltEnd,
    });
    FX.burst(ox, oy, { n: 4, colors: lich ? PAL.shadow : PAL.fire, speed: 1.2, life: 0.25, size: 1.8, glow: true });
    SFX.play(lich ? 'magic' : 'fire');
  }
  function onBoltHit(e, p) {
    Combat.damage(e, p.dmg, p.src);
    if (p.burnDps > 0 && !e.dead) Status.apply(e, 'burn', { dps: p.burnDps, dur: p.burnDur, src: p.src });
  }
  function onBoltEnd(p) { // after a hit, on a wall, or at max range
    FX.burst(p.x, p.y, { n: 8, colors: p.kind === 'shadow' ? PAL.shadow : PAL.fire, speed: 2, life: 0.4, size: 2.2, glow: true });
  }

  /** Spider: on cooldown, web the nearest fresh (un-slowed, not already in melee) visible hero. */
  function trySpiderWeb(m) {
    const ai = m.ai, k = ai.k;
    if (ai.webT > 0) return;
    const r2 = k.webRange * k.webRange;
    let best = null, bs = Infinity;
    for (const h of S.heroes) {
      if (!validHero(h)) continue;
      const dx = h.x - m.x, dy = h.y - m.y, d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const score = Math.sqrt(d2) + (h.st.slowT > 0.5 ? 5 : 0) + (h.st.rootT > 0 ? 5 : 0) + (d2 < 1.2 ? 2.5 : 0);
      if (score >= bs || !Grid.los(m.x, m.y, h.x, h.y)) continue;
      best = h; bs = score;
    }
    if (!best) { ai.webT = 0.3; return; }
    ai.webT = k.webCd; m.animT = 0.35; m.face = best.x >= m.x ? 1 : -1;
    Proj.spawn({
      kind: 'web', x: m.x + m.face * 0.2, y: m.y - 0.15, team: 'dm', target: best, speed: 7, dmg: 0,
      range: k.webRange + 2, radius: 0.4, src: ai.src,
      webSlow: k.webSlow, webDur: k.webDur, webRoot: k.webRoot, webSplash: k.webSplash,
      onHit: onWebHit, onEnd: onWebEnd,
    });
    SFX.play('web');
  }
  function applyWeb(h, p) {
    Status.apply(h, 'slow', { amt: p.webSlow, dur: p.webDur });
    if (p.webRoot > 0) Status.apply(h, 'root', { dur: p.webRoot });
    FX.text(h.x, h.y - 0.75, p.webRoot > 0 ? 'Webbed!' : 'Slowed', '#e8e8f0', { size: 9 });
  }
  function onWebHit(e, p) {
    applyWeb(e, p);
    if (p.webSplash > 0) {
      const r2 = p.webSplash * p.webSplash;
      for (const h of S.heroes) {
        if (h === e || !heroHere(h)) continue;
        const dx = h.x - p.x, dy = h.y - p.y;
        if (dx * dx + dy * dy <= r2) applyWeb(h, p);
      }
      FX.ring(p.x, p.y, { color: '#e8e8f0', r0: 0.2, r1: p.webSplash, life: 0.4, width: 2 });
    }
  }
  function onWebEnd(p) {
    FX.burst(p.x, p.y, { n: 10, colors: PAL.web, speed: 1.8, life: 0.5, size: 2 });
  }

  /* ---------------------------------------------------------------------------
   * 6. BEHAVIOURS — melee fighter, ranged kiter, idle/return/alarm
   * ------------------------------------------------------------------------ */
  /** Melee: close in to blocking distance and strike on cooldown (webbing first for spiders). */
  function fightMelee(m, t, dt) {
    const ai = m.ai;
    if (m.type === 'spider') trySpiderWeb(m);
    const dx = t.x - m.x, dy = t.y - m.y, d = Math.sqrt(dx * dx + dy * dy);
    const stand = m.isBoss ? STAND_BOSS : STAND_MELEE;
    const onOpen = !m.phasing || !blockedTile(Math.floor(m.x), Math.floor(m.y)); // wraiths never fight from inside a wall
    // Dragon: with the breath about to be ready, rear up at range so the cone catches the whole group.
    ai.hold = m.type === 'dragon' && m.abilityT > 0 && m.abilityT <= BREATH.holdT && ai.seen &&
      d > m.range && d <= ai.k.breathLen;
    if (ai.hold) { m.state = 'chase'; m.face = dx >= 0 ? 1 : -1; return; }
    if (d <= m.range && ai.reach && onOpen) {
      m.state = 'attack';
      if (d > stand) steer(m, t.x, t.y, moveSpeed(m) * dt, stand, false); // no phasing while striking
      if (m.atkT <= 0) melee(m, t);
    } else {
      m.state = 'chase';
      approach(m, t.x, t.y, dt, ai.reach && onOpen ? stand : (m.phasing ? 0.3 : 0));
    }
  }

  /** Nearest valid hero within r of m (the threat a kiter backs away from). */
  function nearestHero(m, r) {
    let best = null, bd = r * r;
    for (const h of S.heroes) {
      if (!validHero(h)) continue;
      const dx = h.x - m.x, dy = h.y - m.y, d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = h; }
    }
    return best;
  }

  /** Ranged (Imp, Lich): keep the target inside a distance band, shoot whenever it is in range & sight. */
  function fightRanged(m, t, dt) {
    const ai = m.ai, k = ai.k;
    const d = dist(m.x, m.y, t.x, t.y);
    const lo = m.isBoss ? 2.2 : KITE_LO;
    const hi = Math.max(lo + 0.6, Math.min(k.range - 0.3, m.isBoss ? 4.6 : KITE_HI));
    if (d <= m.range && ai.seen && m.atkT <= 0) shoot(m, t);
    const threat = nearestHero(m, lo);
    if (threat) { m.state = 'attack'; kite(m, threat, dt, lo); }
    else if (!ai.seen || d > hi) { m.state = 'chase'; ai.kx = NaN; approach(m, t.x, t.y, dt, ai.seen ? hi - 0.2 : 0); }
    else { m.state = 'attack'; ai.kx = NaN; }
    m.face = t.x >= m.x ? 1 : -1;
  }

  /** Back away from `t` to the best neighbouring tile (keeps sight lines and the leash). */
  function kite(m, t, dt, lo) {
    const ai = m.ai;
    if ((ai.kiteT -= dt) <= 0 || Number.isNaN(ai.kx)) {
      ai.kiteT = 0.25;
      const tx = Math.floor(m.x), ty = Math.floor(m.y);
      const ax = anchorX(m), ay = anchorY(m), L = leashOf(m) - 0.5;
      let bestS = dist(m.x, m.y, t.x, t.y) + 0.15, bx = NaN, by = NaN;
      for (let i = 0; i < 8; i++) {
        const ox = DIRS8[i][0], oy = DIRS8[i][1], nx = tx + ox, ny = ty + oy;
        if (blockedTile(nx, ny)) continue;
        if (ox && oy && (blockedTile(tx + ox, ty) || blockedTile(tx, ty + oy))) continue; // no corner cutting
        const cx = nx + 0.5, cy = ny + 0.5;
        if (dist(cx, cy, ax, ay) > L) continue;
        let s = Math.min(dist(cx, cy, t.x, t.y), lo + 1);
        if (!Grid.los(cx, cy, t.x, t.y)) s -= 1.5;
        if (s > bestS) { bestS = s; bx = cx; by = cy; }
      }
      ai.kx = bx; ai.ky = by;
    }
    if (!Number.isNaN(ai.kx) && steer(m, ai.kx, ai.ky, moveSpeed(m) * dt, 0.05, false)) ai.kx = NaN;
  }

  function regen(m, dt) {
    if (m.hp >= m.maxHp) return;
    m.hp = Math.min(m.maxHp, m.hp + m.maxHp * REGEN * dt);
    m.ai.lastHp = m.hp;
    if ((m.ai.regenFxT -= dt) <= 0) {
      m.ai.regenFxT = 0.9;
      FX.burst(m.x, m.y - 0.3, { n: 2, colors: PAL.heal, speed: 0.6, life: 0.6, size: 1.6, grav: -2 });
    }
  }

  function pickWander(m, ax, ay) {
    const ai = m.ai;
    ai.wanderT = randRange(1.6, 3.8);
    const r = randRange(0.15, WANDER_R) * (m.isBoss ? 0.6 : 1), a = Math.random() * Math.PI * 2;
    const px = ax + Math.cos(a) * r, py = ay + Math.sin(a) * r;
    const tx = Math.floor(px), ty = Math.floor(py);
    if (!blockedTile(tx, ty) && clearWalk(ax, ay, px, py)) { ai.wx = px; ai.wy = py; }
    else { ai.wx = ax; ai.wy = ay; }
  }

  /** Home is out of reach (walled/barricaded off): guard the current spot instead of pacing. */
  function strand(m) {
    const ai = m.ai;
    ai.stranded = true; ai.sx = m.x; ai.sy = m.y; ai.strandT = STRAND_T; ai.strandVer = S.pathVersion;
    m.state = 'idle'; m.path = null; ai.unreach = false;
  }
  /** Periodically (and whenever the grid changes) check whether the way home has reopened. */
  function recheckHome(m, dt) {
    const ai = m.ai;
    if ((ai.strandT -= dt) > 0 && ai.strandVer === S.pathVersion) return;
    ai.strandT = STRAND_T; ai.strandVer = S.pathVersion;
    if (findPath(m.x, m.y, Math.floor(m.homeX), Math.floor(m.homeY))) {
      ai.stranded = false; m.state = 'return'; m.path = null; ai.repathT = 0;
    }
  }

  /** No foe: rush to an alarm, walk back to the anchor, or idle there (wander + regen at home). */
  function idleBehaviour(m, dt) {
    const ai = m.ai;
    if (ai.stranded && !m.phasing) recheckHome(m, dt);
    const ax = anchorX(m), ay = anchorY(m), alarmed = ai.alarmT > 0;
    const d = dist(m.x, m.y, ax, ay);
    if (alarmed && d > 0.9) {
      m.state = 'chase';
      if (!approach(m, ax, ay, dt, 0.6) && ai.goalTx === Math.floor(ax) && ai.goalTy === Math.floor(ay)) ai.alarmT = 0; // rune out of reach: stay on guard (still enraged)
      return;
    }
    if (m.state === 'chase' || m.state === 'attack') m.state = 'return';
    const inWall = m.phasing && blockedTile(Math.floor(m.x), Math.floor(m.y));
    if (inWall || d > RETURN_SLACK || (m.state === 'return' && d > (alarmed ? 0.6 : 0.12))) {
      m.state = 'return';
      // Only a failed search for this very anchor means we are cut off (not a stale failure).
      if (!approach(m, ax, ay, dt, 0.05) && ai.goalTx === Math.floor(ax) && ai.goalTy === Math.floor(ay)) strand(m);
      return;
    }
    if (m.state !== 'idle' || ai.wax !== ax || ai.way !== ay) { // (re)settling, or the anchor moved: wander afresh
      m.state = 'idle'; ai.wax = ax; ai.way = ay; ai.wx = ax; ai.wy = ay; ai.wanderT = randRange(0.8, 2);
    }
    if (!alarmed && !ai.stranded && d <= WANDER_R + 0.1) regen(m, dt);
    if (m.type === 'mimic') { steer(m, ax, ay, moveSpeed(m) * dt, 0.01, false); return; } // mimics sit still
    if ((ai.wanderT -= dt) <= 0) pickWander(m, ax, ay);
    steer(m, ai.wx, ai.wy, moveSpeed(m) * 0.35 * dt, 0.02, m.phasing);
  }

  /** Small ambient flourishes that make bosses feel alive (smoke, soul-fire, snorts). */
  function ambient(m, dt) {
    if (!m.isBoss) return;
    const ai = m.ai;
    if ((ai.ambT -= dt) > 0) return;
    ai.ambT = randRange(0.9, 1.7);
    if (m.type === 'dragon') FX.burst(m.x + m.face * 0.6, m.y - 0.45, { n: 3, colors: PAL.smoke, speed: 0.6, life: 0.9, size: 2.2, grav: -1.5 });
    else if (m.type === 'lich') FX.burst(m.x, m.y - 0.75, { n: 3, colors: PAL.necro, speed: 0.5, life: 0.7, size: 1.6, grav: -2, glow: true });
    else if (m.type === 'minotaur' && m.target) FX.burst(m.x + m.face * 0.45, m.y - 0.25, { n: 3, colors: ['#e8e8e8', '#cfcfcf'], speed: 0.9, life: 0.4, size: 1.6 });
  }

  /* ---------------------------------------------------------------------------
   * 7. MIMIC — ambush from the chest disguise, re-disguise when calm
   * ------------------------------------------------------------------------ */
  function mimicDisguised(m, dt, provoked) {
    m.state = 'idle'; m.target = null;
    m.x = m.homeX; m.y = m.homeY;
    regen(m, dt);
    if (!Status.canAct(m)) return;
    const r = provoked ? 2.5 : MIMIC.triggerR; // struck while disguised: lash out a little farther
    let victim = null, bd = r * r;
    for (const h of S.heroes) {
      if (!validHero(h)) continue;
      const dx = h.x - m.x, dy = h.y - m.y, d2 = dx * dx + dy * dy;
      if (d2 > bd || !Grid.los(m.x, m.y, h.x, h.y) || blockerBetween(m.x, m.y, h.x, h.y, 0)) continue;
      bd = d2; victim = h;
    }
    if (victim) ambush(m, victim);
    else if (provoked) { m.disguised = false; FX.text(m.x, m.y - 0.8, '!', '#ff5a5a', { size: 12 }); }
  }

  /** Spring the trap: devastating bite + 1 s root, roar, then fight normally. */
  function ambush(m, h) {
    const ai = m.ai;
    m.disguised = false; m.state = 'ambush'; m.target = h; m.face = h.x >= m.x ? 1 : -1;
    m.animT = MIMIC.stagger; m.atkT = m.atkCd;
    ai.abT = MIMIC.stagger; ai.calmT = 0; ai.lostT = 0; ai.seen = ai.reach = true; ai.losT = LOS_T; ai.alertT = 4;
    Combat.damage(h, hitDamage(m, ai.k.ambushDmg), ai.src);
    Status.apply(h, 'root', { dur: MIMIC.root });
    FX.burst(m.x, m.y, { n: 16, colors: PAL.wood, speed: 3, life: 0.6, size: 2.6, grav: 6 });
    FX.burst(h.x, h.y - 0.1, { n: 14, colors: PAL.blood, speed: 2.8, life: 0.5, size: 2.4, grav: 5 });
    FX.ring(m.x, m.y, { color: '#ff5a3a', r0: 0.3, r1: 1.6, life: 0.4, width: 3 });
    FX.text(m.x, m.y - 1, 'AMBUSH!', '#ff5a3a', { size: 14, life: 1.1 });
    FX.shake(6);
    SFX.play('bite'); SFX.play('roar');
  }

  /** Re-disguise after MIMIC.calmT s with no hero within 3 tiles, once back on its post. */
  function mimicCalm(m, dt) {
    const ai = m.ai, r2 = MIMIC.calmR * MIMIC.calmR;
    let near = !!m.target;
    if (!near) for (const h of S.heroes) {
      if (!validHero(h)) continue;
      const dx = h.x - m.x, dy = h.y - m.y;
      if (dx * dx + dy * dy <= r2) { near = true; break; }
    }
    ai.calmT = near ? 0 : ai.calmT + dt;
    if (ai.calmT >= MIMIC.calmT && m.state === 'idle' && dist(m.x, m.y, m.homeX, m.homeY) < 0.2) {
      m.disguised = true; m.x = m.homeX; m.y = m.homeY; ai.calmT = 0;
      FX.burst(m.x, m.y, { n: 8, colors: PAL.dust, speed: 1, life: 0.5, size: 2 });
      FX.text(m.x, m.y - 0.7, '…', '#c9b99a', { size: 11 });
    }
  }

  /* ---------------------------------------------------------------------------
   * 8. BOSS ABILITIES — only started when they will actually hit something
   * ------------------------------------------------------------------------ */
  function tryAbility(m, dt) {
    const ai = m.ai;
    if (m.abilityT > 0 || (ai.abScanT -= dt) > 0) return false;
    ai.abScanT = 0.2;
    switch (m.type) {
      case 'minotaur': return startCharge(m);
      case 'lich': return startRaise(m);
      case 'dragon': return startBreath(m);
    }
    return false;
  }

  // ---- Minotaur: Charge ------------------------------------------------------
  function laneBlocked(x, y) {
    if (Grid.isSolid(x, y) || Grid.barricadeAt(x, y)) return true;
    return S.tiles[y * S.cols + x].type === T.HEART;
  }

  /** Pick the row/column direction with the most heroes in an open lane; start the wind-up. */
  function startCharge(m) {
    const ai = m.ai, k = ai.k;
    const tx = Math.floor(m.x), ty = Math.floor(m.y);
    if (Grid.isSolid(tx, ty)) return false;
    const ax = anchorX(m), ay = anchorY(m), L = leashOf(m) + 1, maxS = Math.floor(k.chargeRange);
    let best = -1, bestN = 0, bestNear = Infinity, bestLen = 0, bestT = null;
    for (let di = 0; di < 4; di++) {
      const dx = DIRS4[di][0], dy = DIRS4[di][1];
      let len = 0;
      for (let s = 1; s <= maxS; s++) {
        const x = tx + dx * s, y = ty + dy * s;
        if (laneBlocked(x, y) || dist(x + 0.5, y + 0.5, ax, ay) > L) break;
        len = s;
      }
      if (!len) continue;
      let n = 0, near = Infinity, nearH = null;
      for (const h of S.heroes) {
        if (!validHero(h)) continue;
        const hx = Math.floor(h.x), hy = Math.floor(h.y);
        const s = dx ? (hy === ty ? (hx - tx) * dx : -1) : (hx === tx ? (hy - ty) * dy : -1);
        if (s < 0 || s > len) continue;
        const along = (h.x - m.x) * dx + (h.y - m.y) * dy;
        if (along < 0.2) continue; // beside/behind: the dash would not pass through it
        n++;
        if (along < near) { near = along; nearH = h; }
      }
      if (n > bestN || (n && n === bestN && near < bestNear)) { best = di; bestN = n; bestNear = near; bestLen = len; bestT = nearH; }
    }
    if (best < 0) return false;
    const dx = DIRS4[best][0], dy = DIRS4[best][1];
    ai.dirX = dx; ai.dirY = dy; ai.phase = 0; ai.abT = CHARGE.windup; ai.travel = 0; ai.hits.length = 0;
    ai.laneX = tx + 0.5; ai.laneY = ty + 0.5;
    ai.dashLen = (tx + 0.5 + dx * bestLen - m.x) * dx + (ty + 0.5 + dy * bestLen - m.y) * dy;
    m.state = 'charge'; m.target = bestT; m.path = null; m.animT = CHARGE.windup;
    if (dx) m.face = dx;
    FX.text(m.x, m.y - 1.2, 'CHARGE!', '#ffb347', { size: 14 });
    FX.burst(m.x, m.y + 0.35, { n: 10, colors: PAL.dust, speed: 1.6, life: 0.5, size: 2.4 });
    SFX.play('roar');
    return true;
  }

  function tickCharge(m, dt) {
    const ai = m.ai;
    if (!Status.canAct(m)) { endCharge(m, false); return; }
    if (ai.phase === 0) {
      // Wind-up: square up to the lane and paw the ground.
      const f = Math.min(1, dt * 14);
      if (ai.dirX) m.y += (ai.laneY - m.y) * f; else m.x += (ai.laneX - m.x) * f;
      if (Math.random() < 0.35) FX.burst(m.x - ai.dirX * 0.3, m.y + 0.4, { n: 1, colors: PAL.dust, speed: 1, life: 0.4, size: 2 });
      if ((ai.abT -= dt) > 0) return;
      ai.phase = 1;
      if (ai.dirX) m.y = ai.laneY; else m.x = ai.laneX;
      m.abilityT = m.abilityCd;
      SFX.play('charge'); FX.shake(3);
      FX.ring(m.x, m.y, { color: '#ffb347', r0: 0.3, r1: 1.3, life: 0.3, width: 3 });
      return;
    }
    const want = Math.min(CHARGE.speed * dt, ai.dashLen - ai.travel);
    if (want > 0) {
      const nx = m.x + ai.dirX * want, ny = m.y + ai.dirY * want;
      if (laneBlocked(Math.floor(nx), Math.floor(ny))) { endCharge(m, true); return; } // lane changed mid-dash
      m.x = nx; m.y = ny; ai.travel += want;
    }
    m.animT = 0.2;
    FX_TRAIL.dir[0] = -ai.dirX; FX_TRAIL.dir[1] = -ai.dirY;
    FX.burst(m.x - ai.dirX * 0.45, m.y + 0.35 - ai.dirY * 0.3, FX_TRAIL);
    // Trample everything in the way (each hero once per charge).
    const r2 = CHARGE.hitR * CHARGE.hitR;
    for (const h of S.heroes) {
      if (!heroHere(h)) continue;
      const dx = h.x - m.x, dy = h.y - m.y;
      if (dx * dx + dy * dy > r2 || ai.hits.indexOf(h.uid) >= 0) continue;
      ai.hits.push(h.uid);
      trample(m, h);
    }
    if (ai.travel >= ai.dashLen - 1e-4) endCharge(m, true);
  }

  function trample(m, h) {
    const ai = m.ai;
    Combat.damage(h, hitDamage(m, ai.k.chargeDmg), ai.src);
    if (!h.dead) {
      Status.apply(h, 'stun', { dur: CHARGE.stun });
      // Fling sideways out of the lane (or onward if the corridor is too narrow).
      const perp = ai.dirX ? h.y - m.y : h.x - m.x;
      const side = Math.abs(perp) < 0.08 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(perp);
      if (shove(h, ai.dirX ? 0 : side, ai.dirX ? side : 0, CHARGE.knock) < 0.3) shove(h, ai.dirX, ai.dirY, CHARGE.knock * 0.7);
      FX.text(h.x, h.y - 0.95, 'Trampled!', '#ffb347', { size: 10 });
    }
    FX.burst(h.x, h.y, { n: 14, colors: PAL.blood, speed: 3.2, life: 0.5, size: 2.6, grav: 6 });
    FX.burst(h.x, h.y + 0.3, { n: 8, colors: PAL.dust, speed: 2.4, life: 0.5, size: 2.4 });
    FX.shake(6);
    SFX.play('hit');
  }

  function endCharge(m, crashed) {
    const ai = m.ai;
    m.state = 'idle'; ai.phase = 0; m.path = null;
    if (!crashed) return; // stunned out of it (a wind-up interruption keeps the ability ready)
    ai.recoverT = CHARGE.recover;
    const wall = laneBlocked(Math.floor(m.x + ai.dirX * 0.7), Math.floor(m.y + ai.dirY * 0.7));
    FX.burst(m.x + ai.dirX * 0.5, m.y + ai.dirY * 0.5, { n: wall ? 22 : 10, colors: PAL.dust, speed: wall ? 3 : 1.6, life: 0.6, size: 2.6, grav: 5 });
    if (wall) { FX.shake(5); SFX.play('collapse'); }
  }

  // ---- Lich: Raise Dead ------------------------------------------------------
  /** Reserve the nearest corpses in range and begin the incantation. */
  function startRaise(m) {
    const ai = m.ai, k = ai.k;
    if (!S.corpses.length || summonCount() >= SUMMON_CAP || !S.heroes.some(validHero)) return false;
    const picks = ai.corpses, r2 = k.raiseRange * k.raiseRange;
    picks.length = 0;
    for (let c = 0; c < k.raiseCount; c++) {
      let best = null, bd = r2;
      for (const cp of S.corpses) {
        if (picks.indexOf(cp) >= 0) continue;
        const dx = cp.x - m.x, dy = cp.y - m.y, d2 = dx * dx + dy * dy;
        if (d2 <= bd) { bd = d2; best = cp; }
      }
      if (!best) break;
      picks.push(best);
    }
    if (!picks.length) return false;
    m.state = 'cast'; ai.abT = RAISE_CAST; m.animT = RAISE_CAST; m.path = null;
    m.abilityT = m.abilityCd;
    FX.text(m.x, m.y - 1.25, 'Raise Dead!', '#9dffb0', { size: 14 });
    FX.ring(m.x, m.y, { color: '#39ff88', r0: 0.3, r1: 1.7, life: 0.6, width: 3 });
    for (const cp of picks) {
      FX.beam(m.x, m.y - 0.6, cp.x, cp.y, { color: '#39ff88', width: 2, life: RAISE_CAST, jag: true });
      FX.ring(cp.x, cp.y, { color: '#b98cff', r0: 0.7, r1: 0.1, life: RAISE_CAST, width: 2 });
    }
    SFX.play('raise');
    return true;
  }

  function tickCast(m, dt) {
    const ai = m.ai;
    if (!Status.canAct(m)) { // interrupted: the spell fizzles, retry soon
      ai.corpses.length = 0; m.state = 'idle'; m.abilityT = Math.min(m.abilityT, 2);
      return;
    }
    for (const cp of ai.corpses) if (Math.random() < 0.4) FX.burst(cp.x, cp.y, { n: 1, colors: PAL.necro, speed: 0.8, life: 0.6, size: 2, grav: -3, glow: true });
    if (Math.random() < 0.5) FX.burst(m.x, m.y - 0.6, { n: 1, colors: PAL.necro, speed: 1, life: 0.5, size: 1.8, grav: -2, glow: true });
    if ((ai.abT -= dt) > 0) return;
    let raised = 0;
    for (const cp of ai.corpses) {
      const i = S.corpses.indexOf(cp);
      if (i < 0) continue;                                     // decayed during the cast
      const s = API.summon('skeleton', cp.x, cp.y, { temp: true, risen: true });
      if (!s) break;                                           // summon cap reached
      S.corpses.splice(i, 1);
      raised++;
      FX.burst(cp.x, cp.y, { n: 18, colors: PAL.necro, speed: 2.4, life: 0.8, size: 2.4, grav: -1, glow: true });
      FX.text(cp.x, cp.y - 0.9, 'Rise!', '#b98cff', { size: 11 });
    }
    ai.corpses.length = 0;
    m.state = 'idle'; ai.recoverT = 0.2;
    if (raised) FX.shake(3); else m.abilityT = Math.min(m.abilityT, 1.5); // nothing left: try again soon
  }

  // ---- Dragon: Fire Breath ---------------------------------------------------
  /** Aim at the direction covering the most heroes (ties: the closer group) and inhale. */
  function startBreath(m) {
    const ai = m.ai, k = ai.k, L = k.breathLen + 0.3, L2 = L * L;
    const cand = ai.cand;
    cand.length = 0;
    for (const h of S.heroes) {
      if (!validHero(h)) continue;
      const dx = h.x - m.x, dy = h.y - m.y;
      if (dx * dx + dy * dy > L2 || !Grid.los(m.x, m.y, h.x, h.y)) continue;
      cand.push(h);
    }
    if (!cand.length) return false;
    let bestA = 0, bestScore = -Infinity;
    for (const h of cand) {
      const a = Math.atan2(h.y - m.y, h.x - m.x);
      let score = 0;
      for (const o of cand) {
        const dx = o.x - m.x, dy = o.y - m.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d <= BREATH.near || angDiff(Math.atan2(dy, dx), a) <= BREATH.half) score += 100 + (L - d);
      }
      if (score > bestScore) { bestScore = score; bestA = a; }
    }
    cand.length = 0;
    ai.angle = bestA; ai.dirX = Math.cos(bestA); ai.dirY = Math.sin(bestA);
    ai.phase = 0; ai.abT = BREATH.windup; ai.hits.length = 0;
    m.state = 'breath'; m.path = null; m.face = ai.dirX >= 0 ? 1 : -1; m.animT = BREATH.windup + BREATH.dur;
    m.abilityT = m.abilityCd;
    const mx = m.x + ai.dirX * 0.6, my = m.y - 0.2 + ai.dirY * 0.6;
    FX.text(m.x, m.y - 1.3, 'Fire Breath!', '#ff8a2a', { size: 14 });
    FX.ring(mx, my, { color: '#ffb347', r0: 1.6, r1: 0.1, life: BREATH.windup, width: 3 }); // inhale
    SFX.play('roar');
    return true;
  }

  /** Scorch-mark every open tile inside the cone (tile flashes). */
  function flashCone(m, L) {
    const x0 = Math.floor(m.x - L), x1 = Math.floor(m.x + L), y0 = Math.floor(m.y - L), y1 = Math.floor(m.y + L);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (Grid.isSolid(x, y)) continue;
      const dx = x + 0.5 - m.x, dy = y + 0.5 - m.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d > L || (d > BREATH.near && angDiff(Math.atan2(dy, dx), m.ai.angle) > BREATH.half)) continue;
      if (!Grid.los(m.x, m.y, x + 0.5, y + 0.5)) continue;
      FX.flashTile(x, y, '#ff6a1a', 0.7);
    }
  }

  function tickBreath(m, dt) {
    const ai = m.ai, k = ai.k;
    if (!Status.canAct(m)) { // choked mid-inhale: the ability is refunded
      if (ai.phase === 0) m.abilityT = Math.min(m.abilityT, 1.5);
      m.state = 'idle'; ai.phase = 0;
      return;
    }
    const mx = m.x + ai.dirX * 0.6, my = m.y - 0.2 + ai.dirY * 0.6;
    if (ai.phase === 0) {
      if (Math.random() < 0.6) FX.burst(mx, my, { n: 1, colors: PAL.fire, speed: 0.6, life: 0.3, size: 1.8, glow: true });
      if ((ai.abT -= dt) > 0) return;
      ai.phase = 1; ai.abT = BREATH.dur;
      SFX.play('breath'); FX.shake(9); FX.flash('#ff7a1a', 0.12);
      flashCone(m, k.breathLen);
      FX.ring(m.x, m.y, { color: '#ff8a2a', r0: 0.4, r1: BREATH.near, life: 0.35, width: 4 }); // point-blank wash
      FX.burst(m.x, m.y, { n: 30, colors: PAL.fire, speed: 3.2, life: 0.45, size: 3, glow: true });
    }
    // The roaring cone of fire.
    FX_BREATH.dir[0] = ai.dirX; FX_BREATH.dir[1] = ai.dirY;
    FX.burst(mx, my, FX_BREATH);
    if (Math.random() < 0.3) FX.burst(mx + ai.dirX * 2, my + ai.dirY * 2, { n: 2, colors: PAL.smoke, speed: 1, life: 0.9, size: 3, grav: -1.5 });
    // Burn every hero inside the cone once.
    const L = k.breathLen + 0.3, L2 = L * L;
    for (const h of S.heroes) {
      if (!heroHere(h) || ai.hits.indexOf(h.uid) >= 0) continue;
      const dx = h.x - m.x, dy = h.y - m.y, d2 = dx * dx + dy * dy;
      if (d2 > L2) continue;
      if (d2 > BREATH.near * BREATH.near && angDiff(Math.atan2(dy, dx), ai.angle) > BREATH.half) continue;
      if (!Grid.los(m.x, m.y, h.x, h.y)) continue;
      ai.hits.push(h.uid);
      Combat.damage(h, hitDamage(m, k.breathDmg), ai.srcFire);
      if (!h.dead) Status.apply(h, 'burn', { dps: BREATH.burnDps, dur: BREATH.burnDur, src: ai.srcFire });
      FX.burst(h.x, h.y - 0.1, { n: 10, colors: PAL.fire, speed: 2.2, life: 0.5, size: 2.4, glow: true, grav: -2 });
    }
    if ((ai.abT -= dt) <= 0) { m.state = 'idle'; ai.phase = 0; ai.recoverT = 0.25; }
  }

  /* ---------------------------------------------------------------------------
   * 9. SKELETON REASSEMBLY
   * ------------------------------------------------------------------------ */
  function tickRespawn(m, dt) {
    m.state = 'respawn';
    const before = m.respawnT;
    m.respawnT -= dt;
    // Bones rattle back together at the post during the final second.
    if (m.respawnT < 1 && Math.floor(before * 8) !== Math.floor(m.respawnT * 8)) {
      FX.burst(m.homeX, m.homeY + 0.25, { n: 3, colors: PAL.bone, speed: 0.9, life: 0.35, size: 2, grav: -3 });
    }
    if (m.respawnT <= 0) reassemble(m);
  }

  function reassemble(m) {
    if (m.post && S.structs.indexOf(m.post) < 0) { m.removed = true; return; } // its post is gone
    initAI(m);
    refreshStatsOf(m);
    m.respawnT = 0; m.dead = false; m.deadT = 0; m.hp = m.maxHp; m.ai.lastHp = m.hp;
    m.x = m.homeX; m.y = m.homeY;
    Object.assign(m.st, makeStatus());
    m.state = 'idle'; m.target = null; m.path = null; m.animT = 0.5; m.atkT = 0.5;
    FX.burst(m.x, m.y, { n: 18, colors: PAL.bone, speed: 2.2, life: 0.6, size: 2.4, grav: -2 });
    FX.ring(m.x, m.y, { color: '#e8e2cc', r0: 0.2, r1: 1, life: 0.45, width: 2 });
    FX.text(m.x, m.y - 0.85, 'Reassembled!', '#e8e2cc', { size: 10 });
    SFX.play('raise');
  }

  /* ---------------------------------------------------------------------------
   * 10. SEPARATION — light pushing so monsters don't stack
   * ------------------------------------------------------------------------ */
  const canNudge = m => !m.dead && !m.removed && !m.disguised && m.state !== 'charge' && m.state !== 'breath' && m.state !== 'cast';
  function nudge(m, ox, oy) {
    const cx = Math.floor(m.x), cy = Math.floor(m.y), nx = m.x + ox, ny = m.y + oy;
    if (canStep(cx, cy, nx, ny)) { m.x = nx; m.y = ny; } else if (canStep(cx, cy, nx, m.y)) m.x = nx; else if (canStep(cx, cy, m.x, ny)) m.y = ny;
  }
  function separate(dt) {
    const arr = S.monsters, n = arr.length;
    for (let i = 0; i < n; i++) {
      const a = arr[i];
      if (!canNudge(a)) continue;
      for (let j = i + 1; j < n; j++) {
        const b = arr[j];
        if (!canNudge(b)) continue;
        const R = a.isBoss || b.isBoss ? SEP_R_BOSS : SEP_R;
        let dx = b.x - a.x, dy = b.y - a.y;
        if (dx > R || dx < -R || dy > R || dy < -R) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 >= R * R) continue;
        let d = Math.sqrt(d2);
        const push = (R - d) * SEP_K * dt;
        if (d < 1e-3) { const ang = ((a.uid * 7 + b.uid * 13) % 628) / 100; dx = Math.cos(ang); dy = Math.sin(ang); d = 1; }
        const ux = dx / d, uy = dy / d;
        const wa = a.isBoss === b.isBoss ? 0.5 : a.isBoss ? 0.15 : 0.85; // bosses barely budge
        nudge(a, -ux * push * wa, -uy * push * wa);
        nudge(b, ux * push * (1 - wa), uy * push * (1 - wa));
      }
    }
  }

  /* ---------------------------------------------------------------------------
   * 11. THE PER-TICK BRAIN
   * ------------------------------------------------------------------------ */
  function think(m, dt) {
    const ai = m.ai;
    if (m.atkT > 0) m.atkT -= dt;
    if (m.isBoss && m.abilityT > 0) m.abilityT -= dt;
    if (ai.webT > 0) ai.webT -= dt;
    if (ai.ignoreT > 0) ai.ignoreT -= dt;
    if (ai.skipT > 0) ai.skipT -= dt;
    if (ai.alertT > 0) ai.alertT -= dt;
    if (ai.repathT > 0) ai.repathT -= dt;
    if (ai.alarmT > 0) ai.alarmT = Math.max(0, ai.alarmT - dt);
    const provoked = m.hp < ai.lastHp - 0.01; // took damage since last tick
    ai.lastHp = m.hp;

    // Abilities in progress own the monster until they finish.
    if (m.state === 'charge') { tickCharge(m, dt); return; }
    if (m.state === 'breath') { tickBreath(m, dt); return; }
    if (m.state === 'cast') { tickCast(m, dt); return; }
    if (m.disguised) { mimicDisguised(m, dt, provoked); return; }
    keepTarget(m, dt);
    if (!Status.canAct(m)) return;                     // stunned: frozen in place
    if (m.state === 'ambush') { if ((ai.abT -= dt) > 0) return; m.state = 'attack'; }
    if (ai.recoverT > 0) { ai.recoverT -= dt; return; } // staggered after a charge / breath

    if ((ai.scanT -= dt) <= 0 || (provoked && !m.target)) {
      ai.scanT = SCAN_T + Math.random() * 0.08;
      acquire(m, provoked && !m.target);
    }
    if (m.isBoss && tryAbility(m, dt)) return;

    if (m.target) {
      if (ai.k.ranged) fightRanged(m, m.target, dt); else fightMelee(m, m.target, dt);
    } else idleBehaviour(m, dt);

    if (m.type === 'mimic') mimicCalm(m, dt);
    ambient(m, dt);
  }

  /** Recompute stats from the post level (or m.level) and perks, keeping the HP ratio. */
  function refreshStatsOf(m) {
    if (!m.ai) initAI(m);
    const level = m.post ? (m.post.level || 1) : (m.level || 1);
    const k = calcStats(m.type, level);
    if (!k) return;
    const ratio = m.maxHp > 0 ? clamp(m.hp / m.maxHp, 0, 1) : 1;
    m.level = k.level; m.maxHp = k.hp;
    if (!m.dead) m.hp = Math.max(1, k.hp * ratio);
    m.dmg = k.dmg; m.atkCd = k.atkCd; m.range = k.range; m.speed = k.speed;
    m.undead = k.undead || !!m.risen; m.phasing = k.phasing;
    if (m.isBoss) {
      m.abilityName = k.ability; m.abilityCd = k.abilityCd;
      m.abilityT = m.abilityT >= 0 ? Math.min(m.abilityT, m.abilityCd) : 2;
    }
    m.ai.k = k; m.ai.lastHp = m.hp;
  }

  /** Full reset to the post: alive, full HP, statuses cleared (wave start & end). */
  function resetForWave(m) {
    if (m.post) { m.homeX = m.post.x + 0.5; m.homeY = m.post.y + 0.5; }
    initAI(m);
    refreshStatsOf(m);
    m.dead = false; m.deadT = 0; m.hp = m.maxHp; m.ai.lastHp = m.hp;
    m.x = m.homeX; m.y = m.homeY; m.face = 1;
    Object.assign(m.st, makeStatus());
    m.state = 'idle'; m.target = null; m.path = null; m.pathIdx = 0;
    m.respawnT = 0; m.animT = 0; m.flashT = 0; m.atkT = Math.random() * 0.4;
    m.disguised = m.type === 'mimic';
    if (m.isBoss) m.abilityT = 2;
  }

  /* ---------------------------------------------------------------------------
   * 12. TOOLTIP TEXT
   * ------------------------------------------------------------------------ */
  function kitLines(k, out, m) {
    switch (k.type) {
      case 'skeleton': out.push(`Reassembles ${k.respawn}s after being destroyed` + (hasPerk('bone_yard') ? ' (Bone Yard)' : '')); break;
      case 'goblin': out.push(k.pilfer ? `Sticky Fingers: +${k.pilfer} gold per hit` : 'Fast: runs down stragglers'); break;
      case 'orc': out.push(`Blows knock heroes back ${k.knockback} tiles`); break;
      case 'spider':
        out.push(`Web every ${k.webCd}s (range ${k.webRange}): −${pct(k.webSlow)} speed for ${k.webDur}s`);
        if (k.webRoot) out.push(`Web Weaver: roots ${k.webRoot}s, splashes ${k.webSplash} tile`);
        break;
      case 'imp':
        out.push(`Fire bolts, keeps ${KITE_LO}–${KITE_HI} tiles away`);
        if (k.burnDps) out.push(`Infernal Pact: bolts burn ${k.burnDps}/s for ${k.burnDur}s`);
        break;
      case 'wraith':
        out.push(`Phases through walls · drains ${pct(k.drain)} of damage dealt`);
        if (k.fearChance) out.push(`Spectral Host: ${pct(k.fearChance)} chance to Fear for ${k.fearDur}s`);
        break;
      case 'mimic': out.push(`Ambush bite: ${Math.round(k.ambushDmg)} damage + ${MIMIC.root}s root` + (hasPerk('mimicry') ? ' (Mimicry)' : '')); break;
      case 'minotaur': out.push(`Charge every ${k.abilityCd}s: ${Math.round(k.chargeDmg)} + ${CHARGE.stun}s stun + knockback, ${k.chargeRange}-tile lane`); break;
      case 'lich': out.push(`Shadow bolts · Raise Dead every ${k.abilityCd}s: up to ${k.raiseCount} corpses within ${k.raiseRange}`); break;
      case 'dragon':
        out.push(`Fire Breath every ${k.abilityCd}s: ${Math.round(k.breathDmg)} + burn ${BREATH.burnDps}/s in a ${k.breathLen}-tile cone (engulfs all within ${BREATH.near})`);
        if (hasPerk('dragons_hoard')) out.push(`Dragon’s Hoard: +${Math.round((k.hoardMul - 1) * 100)}% damage (${chestCount()} chests)`);
        break;
    }
    if (m && k.boss && S.phase === 'wave' && !m.dead) out.push(m.abilityT > 0 ? `${k.ability}: ready in ${m.abilityT.toFixed(1)}s` : `${k.ability}: ready`);
  }

  /* ---------------------------------------------------------------------------
   * 13. PUBLIC API
   * ------------------------------------------------------------------------ */
  const API = {
    SUMMON_CAP,

    /** Create the guard entity for a monster/boss Structure at its post; pushes it into S.monsters. */
    create(s) {
      const d = defOf(s.id);
      if (!d) return null;
      const m = makeEntity('dm', s.id, s.x + 0.5, s.y + 0.5);
      m.name = d.name;
      m.post = s; m.homeX = m.x; m.homeY = m.y; m.level = s.level || 1;
      m.isBoss = s.cat === 'boss' || !!BOSSES[s.id];
      m.temp = false; m.risen = false; m.respawnT = 0;
      m.undead = !!d.undead; m.phasing = !!d.phasing; m.disguised = s.id === 'mimic';
      if (m.isBoss) { m.abilityName = d.ability; m.abilityCd = d.abilityCd; m.abilityT = 2; }
      initAI(m);
      refreshStatsOf(m);
      m.hp = m.maxHp; m.ai.lastHp = m.hp;
      S.monsters.push(m);
      return m;
    },

    /**
     * Summon a temporary monster (level 1 unless opts.level) for the rest of the wave.
     * opts: { temp, risen, lair, level }. Returns the entity, or null (not a wave,
     * unknown type, no open ground, or SUMMON_CAP living summons reached).
     */
    summon(type, x, y, opts = {}) {
      if (!S || S.phase !== 'wave' || !MONSTERS[type]) return null;
      if (summonCount() >= SUMMON_CAP || !openSpot(x, y)) return null;
      const d = MONSTERS[type];
      const m = makeEntity('dm', type, SPOT.x, SPOT.y);
      m.name = d.name;
      m.post = null; m.homeX = m.x; m.homeY = m.y; m.level = clamp(opts.level || 1, 1, 3);
      m.isBoss = false; m.temp = true; m.risen = !!opts.risen; m.respawnT = 0;
      if (opts.lair) m.lair = opts.lair;
      m.undead = !!d.undead || m.risen; m.phasing = !!d.phasing; m.disguised = false;
      initAI(m);
      refreshStatsOf(m);
      m.hp = m.maxHp; m.ai.lastHp = m.hp; m.ai.scanT = 0;
      m.atkT = 0.4; m.animT = 0.4; m.face = Math.random() < 0.5 ? -1 : 1;
      S.monsters.push(m);
      if (m.risen) {
        FX.burst(m.x, m.y, { n: 14, colors: PAL.necro, speed: 2, life: 0.7, size: 2.2, grav: -2, glow: true });
        FX.ring(m.x, m.y, { color: '#b98cff', r0: 0.2, r1: 1, life: 0.45, width: 2 });
        SFX.play('raise');
      } else {
        FX.burst(m.x, m.y, { n: 12, colors: opts.lair ? PAL.smoke : PAL.shadow, speed: 1.8, life: 0.6, size: 2.2, grav: -1 });
      }
      return m;
    },

    /** Re-derive stats after an upgrade or perk change (keeps the HP ratio). Accepts an entity or its Structure. */
    refreshStats(x) { const m = entOf(x); if (m) refreshStatsOf(m); },

    /** Wave-phase AI for every monster (called once per simulation step). */
    update(dt) {
      if (!S || S.phase !== 'wave') return;
      const list = S.monsters;
      for (let i = 0; i < list.length; i++) { // summons may be appended mid-loop (they act at once)
        const m = list[i];
        if (m.removed) continue;
        if (!m.ai) { initAI(m); refreshStatsOf(m); }
        m.bob += dt;
        if (m.dead) { if (m.respawnT > 0) tickRespawn(m, dt); continue; }
        think(m, dt);
      }
      separate(dt);
    },

    /** Build/title/reward phases: keep everyone snapped to their posts, just breathing. */
    idle(dt) {
      if (!S) return;
      for (const m of S.monsters) {
        if (m.removed) continue;
        if (!m.ai) { initAI(m); refreshStatsOf(m); }
        if (m.post) { m.homeX = m.post.x + 0.5; m.homeY = m.post.y + 0.5; }
        m.x = m.homeX; m.y = m.homeY;
        m.bob += dt;
        if (m.animT > 0) m.animT -= dt;
        if (m.flashT > 0) m.flashT -= dt;
        if (m.isBoss && !m.dead) ambient(m, dt);
      }
    },

    /** All placed monsters alive, healed and at their posts; bosses ready in 2 s; mimics disguised. */
    onWaveStart() {
      S.monsters = S.monsters.filter(m => !m.temp && !m.removed);
      for (const m of S.monsters) resetForWave(m);
    },

    /** Remove this wave's summons; revive and heal placed monsters at their posts. */
    onWaveEnd() {
      for (const m of S.monsters) if (m.temp) m.removed = true;
      S.monsters = S.monsters.filter(m => !m.removed);
      for (const m of S.monsters) resetForWave(m);
    },

    /** Called by core Combat.kill: skeleton reassembly timer, boss death fanfare. */
    onDeath(m, src) {
      if (!m) return;
      const ai = m.ai || initAI(m);
      m.target = null; m.path = null; m.disguised = false;
      ai.corpses.length = 0; ai.phase = 0; ai.recoverT = 0;
      if (m.type === 'skeleton' && !m.temp && m.post) {
        m.respawnT = hasPerk('bone_yard') ? 4 : MONSTERS.skeleton.respawn;
        m.state = 'respawn';
        FX.burst(m.x, m.y, { n: 10, colors: PAL.bone, speed: 3, life: 0.9, size: 2.8, grav: 8 });
      } else m.state = 'idle';
      if (m.risen) FX.burst(m.x, m.y - 0.2, { n: 10, colors: PAL.shadow, speed: 1.4, life: 0.8, size: 2, grav: -2, glow: true });
      if (m.isBoss) {
        const name = defOf(m.type).name;
        const by = src && src.ent && src.ent.name ? ` by ${src.ent.name}` : '';
        FX.shake(14); FX.flash('#ff3030', 0.25);
        FX.burst(m.x, m.y, { n: 90, colors: BOSS_FX[m.type] || PAL.blood, speed: 5.5, life: 1.5, size: 3.6, grav: 3 });
        FX.ring(m.x, m.y, { color: '#ff5a5a', r0: 0.4, r1: 4, life: 0.9, width: 5 });
        FX.text(m.x, m.y - 1.3, `${name} falls!`, '#ff5a5a', { size: 15, life: 1.6 });
        SFX.play('boss');
        if (typeof UI !== 'undefined' && UI.toast) UI.toast(`Your ${name} was slain${by}! It will rise again after the wave.`, 'bad');
      }
    },

    /** Alarm Rune: enrage monsters within r (+50% dmg, +30% speed) and send them to (x,y). Returns count. */
    alarm(x, y, radius, dur) {
      if (!S) return 0;
      let n = 0;
      const r2 = radius * radius;
      for (const m of S.monsters) {
        if (m.dead || m.removed) continue;
        const dx = m.x - x, dy = m.y - y;
        if (dx * dx + dy * dy > r2) continue;
        if (!m.ai) { initAI(m); refreshStatsOf(m); }
        Status.apply(m, 'buff', { dmg: 1.5, spd: 1.3, dur });
        n++;
        FX.ring(m.x, m.y, { color: '#ff4a4a', r0: 0.2, r1: 0.9, life: 0.45, width: 2 });
        FX.burst(m.x, m.y - 0.3, { n: 5, colors: PAL.rage, speed: 1.4, life: 0.5, size: 2, grav: -2 });
        FX.text(m.x, m.y - 0.9, 'Enraged!', '#ff6a4a', { size: 10 });
        if (m.disguised) continue; // mimics stay in ambush (but enraged)
        const ai = m.ai;
        ai.alarmT = dur; ai.ax = x; ai.ay = y; ai.alarmR = radius; ai.ignoreT = 0; ai.unreach = false; ai.repathT = 0;
        if (!m.target && !busy(m)) { m.state = 'chase'; m.path = null; }
      }
      return n;
    },

    /** Friendly one-line state for tooltips. Accepts an entity or its Structure. */
    stateLabel(x) {
      const m = entOf(x);
      if (!m) return '';
      if (m.dead) return m.respawnT > 0 ? `Reassembling (${Math.ceil(m.respawnT)}s)` : 'Slain';
      if (m.disguised) return 'Disguised as a chest';
      if (S.phase !== 'wave') return 'Guarding its post';
      const ai = m.ai || {};
      const enr = m.st.buffT > 0 ? ' (enraged)' : '';
      if (m.st.stunT > 0) return 'Stunned';
      if (ai.recoverT > 0) return 'Recovering';
      const who = m.target && m.target.name ? m.target.name : 'a hero';
      switch (m.state) {
        case 'chase':
          if (ai.hold && m.target) return 'Rearing up to breathe fire';
          return (m.target ? `Chasing ${who}` : ai.alarmT > 0 ? 'Rushing to the alarm' : 'Hunting') + enr;
        case 'attack': return (m.target ? `Fighting ${who}` : 'Fighting') + enr;
        case 'return': return ai.alarmT > 0 ? 'Heading to the alarm' : 'Returning to post';
        case 'ambush': return 'Ambush!';
        case 'charge': return ai.phase ? 'Charging!' : 'Lowering its horns';
        case 'breath': return ai.phase ? 'Breathing fire!' : 'Drawing breath';
        case 'cast': return 'Raising the dead';
        case 'respawn': return 'Reassembling';
        default:
          if (ai.alarmT > 0) return 'Holding the alarm point' + enr;
          if (ai.stranded) return 'Cut off from its post' + enr;
          return (m.post ? 'Guarding' : 'Prowling') + enr;
      }
    },

    /** Tooltip / inspector lines. Accepts an entity or its Structure. */
    describe(x) {
      const m = entOf(x);
      const k = m ? calcStats(m.type, m.level) : x && x.id ? calcStats(x.id, x.level) : null;
      if (!k) return [];
      const out = [];
      if (m) out.push(`HP: ${Math.ceil(m.hp)} / ${m.maxHp}`); else out.push(`HP: ${k.hp}`);
      out.push(`Damage: ${Math.round(k.dmg)} every ${k.atkCd}s (${k.dps} DPS)`);
      out.push(`${k.ranged ? 'Range' : 'Reach'}: ${k.range} · Speed: ${k.speed}`);
      const summoned = m && !m.post;
      out.push(`Guard: ${summoned ? Math.max(SUMMON_GUARD, k.guard) : k.guard} tiles · Leash: ${summoned ? SUMMON_LEASH : k.leash}`);
      kitLines(k, out, m);
      if (m && S.phase === 'wave' && !m.dead) {
        if (hasPerk('pack_tactics')) { const p = packCount(m); if (p) out.push(`Pack Tactics: +${p * 12}% damage now`); }
        if (adrenalineOn()) out.push('Adrenaline: +35% damage and speed');
        if (m.st.buffT > 0) out.push(`Enraged: +50% damage, +30% speed (${Math.ceil(m.st.buffT)}s)`);
      }
      if (m && m.temp) out.push(m.risen ? 'Risen from the dead for this wave' : 'Summoned for this wave');
      return out;
    },

    /** Stats of a type at a level with current perks (UI cards / upgrade previews). */
    stats(type, level = 1) { return calcStats(type, level) || {}; },
  };
  return API;
})();
