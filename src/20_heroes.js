/* =============================================================================
 *  20 HEROES — the adventurer AI.
 *  -----------------------------------------------------------------------------
 *  Heroes arrive in parties, follow a leader and march on the Dungeon Heart.
 *  Every hero plans with weighted A* using its class's fears: remembered danger
 *  (S.danger × dangerW × smartness), KNOWN traps (× trapW × smartness) and
 *  barricades. Smartness grows with the wave number, so early heroes are naive
 *  and later ones route around the player's favourite kill-zones.
 *
 *  Private per-hero brain state lives in `h.ai` (no other module reads it).
 *  Documented hero fields other modules read: name, elite, boss, party, leader,
 *  state, loot, lure, channel {kind,t,max} (t counts UP from 0 to max),
 *  abilityT, abilityCd, heartDmg, target, face, animT, path, pathIdx.
 *
 *  Sections
 *    1. Tuning              6. Pathing               11. Channels
 *    2. Flavour tables      7. Movement & steering   12. Class kits
 *    3. Module state        8. Engagement            13. Hero-boss abilities
 *    4. Small helpers       9. Attacks & the Heart   14. The per-hero brain
 *    5. Known-trap field   10. Greed & loot          15. Public API
 * ========================================================================== */
const Heroes = (() => {
  /* ---------------------------------------------------------------------------
   * 1. TUNING
   * ------------------------------------------------------------------------ */
  const K = {
    // Pathing
    repathMin: 0.8, repathMax: 1.2,  // periodic repath interval (staggered per hero)
    chaseRepath: 0.5,                // repath interval toward a moving goal (monster / healer)
    dangerRepathGap: 0.45,           // min gap between repaths caused by new danger / known traps
    astarBudget: 12,                 // max routine A* searches per Heroes.update (spreads spikes)
    trapTileCost: 5,                 // known trap tile            (× trapW × smartness)
    lineCost: 2,                     // known Arrow Wall / Boulder firing line tile (× trapW × smartness)
    switchRatio: 0.82,               // route hysteresis: a new route must cost < 82% of the current one…
    switchRatioRecent: 0.5,          // …or < 50% within switchCooldown s of the last route switch
    switchCooldown: 3,
    switchRatioWalls: 0.97,          // walls actually changed (blast/dig/barricade): take real shortcuts
    stallWindow: 4, stallMove: 0.5,  // hard anti-stall: < 0.5 tiles net in 4 s while trying to move…
    plainTime: 5,                    // …→ follow a plain Path.baseCost route for this long
    teleportGiveUp: 3,               // teleported back this many times: a normal hero gives up and leaves
    teleportJam: 2,                  // a hero boss bounced this often jams known teleporters on its route
    jamTime: 1.5,
    rubbleCost: 25,                  // sealed in by a Collapse: claw through rubble…
    rubbleDigTime: 4,                // …taking this long per tile
    sealedWallCost: 40,              // (still sealed: hack through a player wall, never rock…
    sealedDigTime: 6,                // …even more slowly)
    watchdogWindow: 20, watchdogMove: 1.5,  // last-resort watchdog (see watchdog())
    fleeR: 3, fleeW: 3,              // feared: extra cost near the source of the terror
    // Movement
    wallMargin: 0.28,                // hero centres ease this far away from solid tile edges…
    marginEase: 0.04,                // …by at most this much per step (no snapping)
    sepR: 0.42, sepK: 0.35,          // separation radius / strength (fraction of overlap per tick)
    sepMax: 0.05,                    // max separation displacement per tick (no violent shoves)
    sepTwist: 0.42,                  // lateral bias so heroes meeting head-on slide past each other
    queueR: 0.56,                    // slow down behind a stationary ally within this distance
    rushSpeed: 1.25, chargeSpeed: 1.3, fleeSpeed: 1.1, timeWarp: 0.85, cursedGold: 0.6,
    stuckWindow: 1, stuckMove: 0.12,
    // Strategy
    rushDist: 6, rushExit: 9,        // Path.heartDist hysteresis for the final rush
    retreatPct: 0.3, recoverPct: 0.65, retreatMinDist: 6,
    healerSeekR: 8,                  // retreating heroes fall back to a Cleric this close…
    tendR: 7, tendMax: 15,           // …who holds position (≤ tendMax s) while they come to it
    heartReach: 1.3, heartReachRanged: 2.5,
    heartCrowdReach: 2.8,            // mobbed Heart: strike over allies' shoulders from this close
    slotSeekR: 3.5,                  // stalled this close to the Heart → walk round to a free side
    memberAhead: 3, memberWaitMax: 4, memberWaitCd: 1.5,
    leaderBehind: 4, leaderWaitMax: 2, leaderWaitCd: 2.5,
    // Combat
    thinkEvery: 0.2,                 // voluntary target selection interval
    blockR: 0.9,                     // a monster this close that targets us blocks movement
    leash: 3,                        // max distance a hero strays off its route to chase
    ignoreT: 3,                      // after giving up a chase, ignore that monster this long
    noDmgWindow: 6, noDmgIgnore: 8,  // in reach but it takes no net damage for 6 s (shots blocked,
                                     // out-regenerated…) → ignore it for 8 s and move on
    chaseGiveUp: 4,                  // seconds out of reach before a chase is abandoned
    attackedR: 4.5,                  // monsters targeting us within this range → fight back
    tauntR: 2,                       // Orcish Warcry taunt radius
    slipEvery: 2, slipChance: 0.5,   // rogues slip past blockers
    meleeSlack: 0.15,                // melee reach tolerance (entity radii)
    barricadeReach: 1.6,
    // Greed
    lureEvery: 0.5, lureMaxPath: 3,  // lure path may be at most radius × this long
    lootTime: 1.2, lootReach: 1.05, lureTimeout: 20,
    // Kits
    detectEvery: 1, revealEvery: 0.25, lohRange: 4,
    // Hero bosses
    bashR: 1.8, bashMul: 2.5, bashStun: 2,
    blinkR: 4, blinkMinGain: 3,
    sanctuaryR: 5, sanctuaryHeal: 40,
    shadowR: 3, shadowInvis: 3,
  };

  /* ---------------------------------------------------------------------------
   * 2. FLAVOUR TABLES
   * ------------------------------------------------------------------------ */
  const NAMES = [
    'Aldo', 'Ailsa', 'Ansel', 'Brenna', 'Bram', 'Bryn', 'Cass', 'Corin', 'Cedric', 'Dara',
    'Doran', 'Elka', 'Eamon', 'Edda', 'Faye', 'Fenn', 'Garrick', 'Gideon', 'Hale', 'Hilde',
    'Isolde', 'Ivo', 'Jory', 'Juno', 'Kael', 'Keira', 'Kestrel', 'Lyra', 'Lorcan', 'Linnea',
    'Maeve', 'Mira', 'Magnus', 'Nessa', 'Nyx', 'Orla', 'Osric', 'Oswin', 'Perrin', 'Pip',
    'Quill', 'Rowan', 'Rook', 'Runa', 'Sable', 'Sigrun', 'Stellan', 'Tamsin', 'Thea', 'Torin',
    'Tobin', 'Ulric', 'Vala', 'Vesper', 'Wren', 'Willa', 'Wystan', 'Yara', 'Ysolde', 'Zed',
  ];
  const DWARF_NAMES = [
    'Brokk', 'Durna', 'Thorek', 'Hild', 'Borli', 'Gunnar', 'Dagni', 'Kazra', 'Orrin', 'Magda',
    'Ketil', 'Brunna', 'Stoki', 'Grenna',
  ];
  /** Leadership preference (higher leads): sturdy front-liners first. */
  const LEADER_RANK = { paladin: 7, warrior: 6, miner: 5, cleric: 4, ranger: 3, rogue: 2, mage: 1 };
  const LABELS = {
    advance: 'Advancing', loot: 'Heading for treasure', fight: 'Fighting', retreat: 'Retreating',
    rush: 'Rushing the Heart!', heart: 'Attacking the Heart!', fear: 'Fleeing in terror',
    disarm: 'Disarming a trap', blast: 'Blasting a wall', dig: 'Digging through a wall',
    escape: 'Escaping with treasure!', stunned: 'Stunned',
  };

  /* ---------------------------------------------------------------------------
   * 3. MODULE STATE (reset every wave)
   * ------------------------------------------------------------------------ */
  let partySeq = 0;
  const usedNames = new Set();
  // Known-trap cost field: per-tile cost BEFORE the × trapW × smartness weighting.
  let field = null, fieldSig = NaN, fieldPathVer = -1, trapVer = 0;
  let budget = 0;              // routine A* searches left in this update
  let blastEvalFree = true;    // one mage wall-blast evaluation per update
  let lureCache = null, lureCacheT = -1;
  // Mage "what if this wall were gone?" probe: one fixed cost function, no closures per test.
  let probeIdx = -1, probeBase = null;
  const probeCost = (x, y, i) => (i === probeIdx ? 1 : probeBase(x, y, i));
  // Ranged heroes shoot the Heart with homing projectiles aimed at this pseudo-entity.
  const heartTarget = { x: 0, y: 0, dead: false, removed: false, escaped: false };
  const heartHit = (e, p) => Heart.damage(p.dmg, p.src);
  const scratch = [];          // reusable list for ability target collection
  let curHero = null;          // for the allocation-free predicates below
  const predTargetsCur = m => targetsHero(m, curHero);
  const predOrc = m => m.type === 'orc';

  /* ---------------------------------------------------------------------------
   * 4. SMALL HELPERS
   * ------------------------------------------------------------------------ */
  const alive = h => !!h && !h.dead && !h.removed && !h.escaped;
  const clsOf = h => HERO_CLASSES[h.type] || HERO_CLASSES.warrior;

  /** A monster heroes can see and fight (not dead, not a disguised mimic, not a bone pile). */
  function monsterOk(m) {
    return !!m && !m.dead && !m.removed && !m.disguised && m.hp > 0 &&
      !(m.respawnT > 0) && m.state !== 'respawn';
  }
  function targetsHero(m, h) { const t = m.target; return t != null && (t === h || t === h.uid); }
  function monsterName(m) {
    const d = m && (MONSTERS[m.type] || BOSSES[m.type]);
    return d ? d.name : 'a monster';
  }
  function onEntrance(h) { return Math.floor(h.x) === S.entrance.x && Math.floor(h.y) === S.entrance.y; }
  function faceToward(h, x) { if (x > h.x + 0.02) h.face = 1; else if (x < h.x - 0.02) h.face = -1; }
  function crowded(h) {
    for (const o of S.heroes) {
      if (o === h || !alive(o)) continue;
      const dx = o.x - h.x, dy = o.y - h.y;
      if (dx * dx + dy * dy < 0.36) return true;
    }
    return false;
  }
  function ailing(o) {
    const st = o.st;
    return st.burnT > 0 || st.bleedT > 0 || st.slowT > 0 || st.rootT > 0 || st.stunT > 0 || st.fearT > 0;
  }
  function digTimeOf(h) { return (clsOf(h).digTime || 2) * (hasPerk('reinforced') ? 2 : 1); }
  function pickName(type) {
    const pool = type === 'miner' ? DWARF_NAMES : NAMES;
    for (let i = 0; i < 8; i++) {
      const n = pick(pool);
      if (!usedNames.has(n)) { usedNames.add(n); return n; }
    }
    return pick(pool);
  }

  /* ---------------------------------------------------------------------------
   * 5. KNOWN-TRAP FIELD — rebuilt only when the set of known traps or the walls
   *    change (cheap signature check every update). Arrow Walls / Boulders taint
   *    their firing lines; floor traps taint their own tile.
   * ------------------------------------------------------------------------ */
  function refreshField() {
    const n = S.cols * S.rows;
    let sig = n, cnt = 0;
    for (const s of S.structs) {
      if (s.cat !== 'trap' || !trapKnown(s)) continue;
      sig += (Math.imul(s.uid, 2654435761) >>> 0) + s.level; cnt++;
    }
    sig += cnt * 1.1e12;
    if (field && field.length === n && sig === fieldSig && fieldPathVer === S.pathVersion) return;
    if (!field || field.length !== n) field = new Float32Array(n); else field.fill(0);
    const cols = S.cols;
    for (const s of S.structs) {
      if (s.cat !== 'trap' || !trapKnown(s)) continue;
      const def = TRAPS[s.id];
      if (!def) continue;
      if (s.id === 'arrow' || s.id === 'boulder') {
        const range = Array.isArray(def.range) ? def.range[clamp((s.level || 1) - 1, 0, def.range.length - 1)] : (def.range || 6);
        for (let d = 0; d < 4; d++) {
          const dx = DIRS4[d][0], dy = DIRS4[d][1];
          for (let k = 1; k <= range; k++) {
            const x = s.x + dx * k, y = s.y + dy * k;
            if (Grid.isSolid(x, y)) break;
            field[y * cols + x] += K.lineCost;
          }
        }
      } else if (Grid.inb(s.x, s.y) && !Grid.isSolid(s.x, s.y)) {
        field[s.y * cols + s.x] += K.trapTileCost;
      }
    }
    fieldSig = sig; fieldPathVer = S.pathVersion; trapVer++;
  }

  /**
   * One cost closure per hero (made once, never re-allocated). Its behaviour is
   * steered by the ai.c* parameters that prepCost() sets before each search.
   */
  function makeCost(h) {
    const ai = h.ai;
    return (x, y, i) => {
      const t = S.tiles[i];
      let c;
      if (t.type === T.WALL) {
        // cDig: 0 none · 1 miner tunnels · 2 sealed in: rubble only · 3 sealed in: any player wall
        if (ai.cDig === 0 || (ai.cDig === 2 && !t.rubble)) return Infinity;
        c = ai.cDig === 3 && !t.rubble ? K.sealedWallCost : ai.cDigCost;
      } else {
        c = Path.baseCost(x, y, i);                        // rock = ∞, barricades & the Heart cost extra
        if (c === Infinity) return c;
      }
      if (ai.cCareful) c += S.danger[i] * ai.cDw + field[i] * ai.cTw;
      if (ai.cFear) {
        const dx = x + 0.5 - ai.cFx, dy = y + 0.5 - ai.cFy, d2 = dx * dx + dy * dy;
        if (d2 < K.fleeR * K.fleeR) c += (K.fleeR - Math.sqrt(d2)) * K.fleeW;
      }
      return c;
    };
  }

  /** Configure a hero's cost closure for a search toward a goal of the given kind. */
  function prepCost(h, kind) {
    if (!field || field.length !== S.cols * S.rows) refreshField();
    const ai = h.ai, c = clsOf(h);
    const paranoia = hasPerk('paranoia') && S.time < 10;
    ai.cCareful = !paranoia && !ai.rushing && ai.plainT <= 0;
    ai.cDw = (c.dangerW || 0) * h.smart;
    ai.cTw = (c.trapW || 0) * h.smart;
    ai.cDig = h.type === 'miner' && kind === 'heart' ? 1 : 0;
    ai.cDigCost = 3 + digTimeOf(h) * 2;
    ai.cFear = kind === 'flee';
    ai.cFx = h.st.fearX; ai.cFy = h.st.fearY;
  }

  /* ---------------------------------------------------------------------------
   * 6. PATHING
   * ------------------------------------------------------------------------ */
  /**
   * Point the hero at a goal tile. A "soft" goal (moving target) keeps the
   * current path and lets the chase timer refresh it; a hard change replans now.
   */
  function setGoal(h, gx, gy, kind, soft) {
    const ai = h.ai;
    if (ai.gx === gx && ai.gy === gy && ai.gk === kind) return;
    const kindChanged = ai.gk !== kind;
    ai.gx = gx; ai.gy = gy; ai.gk = kind;
    if (!soft || kindChanged || !h.path) { h.path = null; ai.repathT = 0; }
  }

  function needRepath(h) {
    const ai = h.ai;
    if (!h.path || ai.pathVer !== S.pathVersion || ai.repathT <= 0) return true;
    return ai.cCareful && (ai.dangerVer !== S.dangerVersion || ai.trapVer !== trapVer) &&
      S.time - ai.lastRepath >= K.dangerRepathGap;
  }

  /** Goals that don't move: their routes get hysteresis (moving goals just re-plan). */
  const STATIC_GOALS = { heart: true, slot: true, exit: true, flee: true };

  /**
   * Sum of the hero's current cost over path[from..]; ∞ if blocked. The tile it
   * stands on and the shared goal tile are excluded so route comparisons are fair.
   */
  function pathCost(h, path, from) {
    const ai = h.ai, cost = ai.cost, cols = S.cols, cx = Math.floor(h.x), cy = Math.floor(h.y);
    let sum = 0;
    for (let k = from; k < path.length; k++) {
      const p = path[k];
      if (k === from && p.x === cx && p.y === cy) continue;
      if (k === path.length - 1 && p.x === ai.gx && p.y === ai.gy) continue;
      if (!Grid.inb(p.x, p.y)) return Infinity;
      const c = cost(p.x, p.y, p.y * cols + p.x);
      if (!(c < Infinity)) return Infinity;
      sum += c;
    }
    return sum;
  }

  /** First tile the route leads to from where the hero stands (skipping its own tile). */
  function firstStep(h, path, from) {
    const cx = Math.floor(h.x), cy = Math.floor(h.y);
    for (let k = from; k < path.length; k++) if (path[k].x !== cx || path[k].y !== cy) return path[k];
    return null;
  }

  /**
   * Weighted A* to the current goal. Respects the per-update budget (a hero with
   * no route at all always gets its search). For static goals the current route
   * is kept unless the new one is clearly cheaper (hysteresis) — heroes commit
   * instead of flip-flopping between near-equal routes as danger shifts.
   * @returns true if a search happened.
   */
  function repath(h) {
    const ai = h.ai;
    const critical = !h.path || ai.noPath;
    if (budget <= 0 && !critical) return false;
    budget--;
    const old = h.path, oldIdx = h.pathIdx, wallsChanged = ai.pathVer !== S.pathVersion;
    const sticky = !critical && STATIC_GOALS[ai.gk] && ai.plainT <= 0 && old.length > oldIdx;
    prepCost(h, ai.gk);
    let p = Path.astar(h.x, h.y, ai.gx, ai.gy, ai.cost);
    if (!p && ai.cDig !== 1) {
      // Sealed in (e.g. by a Collapse around us): claw through rubble, or failing
      // that hack through player walls (never rock) — a hero can always get out.
      ai.cDig = 2; ai.cDigCost = K.rubbleCost;
      p = Path.astar(h.x, h.y, ai.gx, ai.gy, ai.cost);
      if (!p) { ai.cDig = 3; p = Path.astar(h.x, h.y, ai.gx, ai.gy, ai.cost); }
      if (!p) ai.cDig = 0;
    }
    ai.pathVer = S.pathVersion; ai.dangerVer = S.dangerVersion; ai.trapVer = trapVer;
    ai.lastRepath = S.time;
    ai.repathT = !p ? 0.5 : STATIC_GOALS[ai.gk] ? randRange(K.repathMin, K.repathMax) : K.chaseRepath;
    if (p && sticky) {
      const oldCost = pathCost(h, old, oldIdx);
      if (oldCost < Infinity) {
        const a = firstStep(h, old, oldIdx), b = firstStep(h, p, 0);
        const turns = !!a && !!b && (a.x !== b.x || a.y !== b.y);
        if (turns) {
          const need = wallsChanged ? K.switchRatioWalls
            : S.time - ai.switchT < K.switchCooldown ? K.switchRatioRecent : K.switchRatio;
          if (pathCost(h, p, 0) > oldCost * need - 0.5) return true;   // commit to the current route
          ai.switchT = S.time;
        }
      }
    }
    h.path = p || [];
    h.pathIdx = 0;
    ai.noPath = !p;
    return true;
  }

  /* ---------------------------------------------------------------------------
   * 7. MOVEMENT & STEERING
   *    Heroes steer from tile centre to tile centre. stepTo() never lets a
   *    centre enter a solid/barricade tile (slides along walls instead), and
   *    clampMargin() keeps bodies off wall faces. Separation spreads parties.
   * ------------------------------------------------------------------------ */
  function blockedTile(h, tx, ty) {
    if (Grid.isSolid(tx, ty)) return true;
    if (tx === Math.floor(h.x) && ty === Math.floor(h.y)) return false; // already standing there
    if (Grid.barricadeAt(tx, ty)) return true;
    if (tx === S.heart.x && ty === S.heart.y) {
      // Only walk onto the Heart tile when the route genuinely passes through it.
      const wp = h.path && h.path[h.pathIdx];
      return !(wp && wp.x === tx && wp.y === ty);
    }
    return false;
  }
  function edgeBlocked(tx, ty) { return Grid.isSolid(tx, ty) || !!Grid.barricadeAt(tx, ty); }

  /**
   * Ease bodies off wall faces (soft: at most marginEase per call, so entering a
   * narrow gap slightly off-centre slides in smoothly instead of snapping).
   */
  function clampMargin(h) {
    const tx = Math.floor(h.x), ty = Math.floor(h.y), m = K.wallMargin, e = K.marginEase;
    if (h.x < tx + m && edgeBlocked(tx - 1, ty)) h.x = Math.min(tx + m, h.x + e);
    else if (h.x > tx + 1 - m && edgeBlocked(tx + 1, ty)) h.x = Math.max(tx + 1 - m, h.x - e);
    if (h.y < ty + m && edgeBlocked(tx, ty - 1)) h.y = Math.min(ty + m, h.y + e);
    else if (h.y > ty + 1 - m && edgeBlocked(tx, ty + 1)) h.y = Math.max(ty + 1 - m, h.y - e);
  }

  /** Move toward (nx, ny) without entering blocked tiles. @returns true if the hero moved. */
  function stepTo(h, nx, ny) {
    const ox = h.x, oy = h.y;
    const cx = Math.floor(ox), cy = Math.floor(oy);
    const tx = Math.floor(nx), ty = Math.floor(ny);
    if (tx === cx && ty === cy) { h.x = nx; h.y = ny; }
    else if (!blockedTile(h, tx, ty) &&
      (tx === cx || ty === cy || !blockedTile(h, tx, cy) || !blockedTile(h, cx, ty))) {
      h.x = nx; h.y = ny;                          // (diagonal moves may not squeeze between two walls)
    } else {
      if (!blockedTile(h, tx, cy)) h.x = nx;       // slide along the blocking edge
      if (!blockedTile(h, Math.floor(h.x), ty)) h.y = ny;
    }
    clampMargin(h);
    return h.x !== ox || h.y !== oy;
  }

  /** Never stand inside a wall (Collapse, blink edge cases): pop to the nearest open tile. */
  function ensureOpen(h) {
    const tx = Math.floor(h.x), ty = Math.floor(h.y);
    if (!Grid.isSolid(tx, ty)) return false;
    let bx = 0, by = 0, bd = Infinity;
    for (let r = 1; r <= 8 && bd === Infinity; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx, y = ty + dy;
        if (Grid.isSolid(x, y) || Grid.barricadeAt(x, y)) continue;
        const d = dist(h.x, h.y, x + 0.5, y + 0.5);
        if (d < bd) { bd = d; bx = x; by = y; }
      }
    }
    if (bd < Infinity) { h.x = bx + 0.5; h.y = by + 0.5; }
    h.path = null;
    if (h.ai) h.ai.repathT = 0;
    return true;
  }

  function speedOf(h, mul) {
    let s = h.speed * Status.speedMul(h) * mul;
    if (h.ai.rushing) s *= K.rushSpeed;
    if (hasPerk('time_warp')) s *= K.timeWarp;
    if (h.loot > 0 && hasPerk('cursed_gold')) s *= K.cursedGold;
    return s;
  }

  /**
   * Queueing: when a stationary ally (fighting, channeling, waiting) stands right
   * in front of us, slow to a halt behind it instead of shoving into it.
   * After ~1.5 s of queueing, push through for a moment (never deadlock).
   */
  function queueScale(h, wx, wy) {
    const ai = h.ai;
    if (ai.pushT > 0) return 1;
    const dx = wx - h.x, dy = wy - h.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-3) return 1;
    const ux = dx / d, uy = dy / d, R = K.queueR;
    let scale = 1;
    for (const o of S.heroes) {
      if (o === h || !o.ai || !o.ai.anchored || !alive(o)) continue;
      const ox = o.x - h.x, oy = o.y - h.y;
      if (ox > R || ox < -R || oy > R || oy < -R) continue;
      const od = Math.sqrt(ox * ox + oy * oy);
      if (od > R || od < 1e-4 || (ox * ux + oy * uy) / od < 0.5) continue;
      const s = (od - 0.3) / (R - 0.3);
      if (s < scale) scale = s < 0 ? 0 : s;
    }
    return scale;
  }

  /** Walk along h.path, carrying leftover distance through plain waypoints (no stutter). */
  function moveAlong(h, spd, dt) {
    const path = h.path, x0 = h.x, y0 = h.y;
    let left = spd * dt;
    for (let guard = 0; guard < 3 && left > 1e-6 && h.pathIdx < path.length; guard++) {
      const wp = path[h.pathIdx];
      const tx = wp.x + 0.5, ty = wp.y + 0.5;
      const dx = tx - h.x, dy = ty - h.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d <= left) {
        if (!stepTo(h, tx, ty) && d > 1e-4) break;
        left -= d;
        h.pathIdx++;
        const nx = path[h.pathIdx];
        if (!nx || Grid.isSolid(nx.x, nx.y) || Grid.barricadeAt(nx.x, nx.y) ||
          (h.type === 'rogue' && Grid.tile(nx.x, nx.y).s)) break; // let follow() inspect special tiles
      } else {
        stepTo(h, h.x + dx / d * left, h.y + dy / d * left);
        left = 0;
      }
    }
    const mdx = h.x - x0;
    if (mdx > 1e-4) h.face = 1; else if (mdx < -1e-4) h.face = -1;
    h.moving = h.x !== x0 || h.y !== y0;
  }

  /**
   * Follow the planned route toward ai's goal. Handles tile-entry events:
   * walls ahead (dig or replan), barricades (smash), rogue disarming.
   * mode: 'walk' (normal) | 'exit' (retreat/escape) | 'flee' | 'chase'.
   */
  function follow(h, spd, dt, mode) {
    const ai = h.ai;
    if (needRepath(h)) repath(h);
    const path = h.path;
    if (!path || h.pathIdx >= path.length) return;
    const cx = Math.floor(h.x), cy = Math.floor(h.y);
    // A waypoint that is the tile we already stand on (near its centre) is done: pop it so
    // we head straight for the next tile instead of dithering around this centre.
    while (h.pathIdx + 1 < path.length && path[h.pathIdx].x === cx && path[h.pathIdx].y === cy &&
      Math.abs(h.x - cx - 0.5) < 0.3 && Math.abs(h.y - cy - 0.5) < 0.3) h.pathIdx++;
    const wp = path[h.pathIdx];
    const man = Math.abs(wp.x - cx) + Math.abs(wp.y - cy);
    if (man > 2) { h.path = null; ai.repathT = 0; return; }       // shoved off the route: replan
    if (man === 1) {
      if (Grid.isSolid(wp.x, wp.y)) {
        if (mode !== 'flee' && canDig(h, wp.x, wp.y)) { startDig(h, wp.x, wp.y); return; }
        h.path = null; ai.repathT = 0; return;                      // walls changed under us
      }
      if (h.type === 'rogue' && mode !== 'flee' && tryDisarm(h, wp.x, wp.y)) return;
      if (h.boss && ai.teleports >= K.teleportJam && mode !== 'flee' && tryJam(h, wp.x, wp.y)) return;
    }
    const bar = barricadeAhead(h, path, cx, cy);
    if (bar) { smash(h, bar); return; }
    if (spd <= 0) return;                                           // rooted: can't move, not stuck
    let scale = 1;
    if (mode === 'walk' && (ai.gk === 'heart' || ai.gk === 'slot')) {
      scale = queueScale(h, wp.x + 0.5, wp.y + 0.5);
      if (scale < 0.2) {
        ai.queueT += dt;
        if (ai.queueT > 1.5) { ai.queueT = 0; ai.pushT = 1; }
      } else ai.queueT = 0;
    }
    ai.wantMove = scale > 0.05;
    if (scale > 0) moveAlong(h, spd * scale, dt);
  }

  /** Separation between heroes (O(n²) with cheap rejects; n ≤ ~60). */
  function separate() {
    const hs = S.heroes, n = hs.length, R = K.sepR, R2 = R * R;
    for (let i = 0; i < n; i++) { const a = hs[i].ai; if (a) { a.sx = 0; a.sy = 0; } }
    for (let i = 0; i < n; i++) {
      const a = hs[i];
      if (!a.ai || !alive(a)) continue;
      for (let j = i + 1; j < n; j++) {
        const b = hs[j];
        const dx = b.x - a.x; if (dx >= R || dx <= -R) continue;
        const dy = b.y - a.y; if (dy >= R || dy <= -R) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 >= R2 || !b.ai || !alive(b)) continue;
        let d = Math.sqrt(d2), nx, ny;
        if (d < 1e-4) { const ang = a.uid * 2.399 + b.uid * 0.713; nx = Math.cos(ang); ny = Math.sin(ang); d = 0; }
        else { nx = dx / d; ny = dy / d; }
        // Twist the normal so heroes meeting head-on in a corridor slide past each other.
        const px = nx - ny * K.sepTwist, py = ny + nx * K.sepTwist;
        const wa = a.ai.anchored ? 0.25 : 1, wb = b.ai.anchored ? 0.25 : 1;
        const w = (R - d) * K.sepK / (wa + wb);
        a.ai.sx -= px * w * wa; a.ai.sy -= py * w * wa;
        b.ai.sx += px * w * wb; b.ai.sy += py * w * wb;
      }
    }
    for (let i = 0; i < n; i++) {
      const h = hs[i], ai = h.ai;
      if (!ai || (ai.sx === 0 && ai.sy === 0) || !alive(h)) continue;
      const m2 = ai.sx * ai.sx + ai.sy * ai.sy;
      if (m2 > K.sepMax * K.sepMax) { const k = K.sepMax / Math.sqrt(m2); ai.sx *= k; ai.sy *= k; }
      stepTo(h, h.x + ai.sx, h.y + ai.sy);
    }
  }

  /** Detect "trying to move but going nowhere" (corner snags) and recover. */
  function stuckCheck(h, dt) {
    const ai = h.ai;
    ai.stuckWin += dt;
    if (ai.wantMove) ai.stuckAcc += dt;
    if (ai.stuckWin < K.stuckWindow) return;
    const moved = Math.hypot(h.x - ai.lastPX, h.y - ai.lastPY);
    if (ai.stuckAcc >= 0.8 * ai.stuckWin && moved < K.stuckMove && !crowded(h)) {
      ai.stuckN++;
      h.path = null; ai.repathT = 0;
      if (ai.stuckN >= 2) { h.x = Math.floor(h.x) + 0.5; h.y = Math.floor(h.y) + 0.5; }
    } else ai.stuckN = 0;
    ai.stuckWin = 0; ai.stuckAcc = 0; ai.lastPX = h.x; ai.lastPY = h.y;
  }

  /**
   * Hard anti-stall: trying to move for most of a 4 s window yet < 0.5 tiles of
   * net progress (ping-ponging between routes, shoved back and forth, …) →
   * follow a plain Path.baseCost route (no danger, no traps, no hysteresis) for a while.
   */
  function stallCheck(h, dt) {
    const ai = h.ai;
    // A deliberate change of intent (held ≥ 1.5 s: e.g. advance → retreat) starts a fresh
    // window; rapid flip-flopping does not, so it still gets caught.
    ai.intentT += dt;
    if (h.state !== ai.intentState || ai.gk !== ai.intentGk) {
      if (ai.intentT >= 1.5) { ai.stallWin = 0; ai.stallT = 0; ai.stallX = h.x; ai.stallY = h.y; }
      ai.intentState = h.state; ai.intentGk = ai.gk; ai.intentT = 0;
    }
    ai.stallWin += dt;
    if (ai.wantMove && !ai.engage && !h.channel && !ai.atHeart) ai.stallT += dt;
    if (ai.stallWin < K.stallWindow) return;
    if (ai.stallT >= 0.75 * ai.stallWin && Math.hypot(h.x - ai.stallX, h.y - ai.stallY) < K.stallMove) {
      ai.plainT = K.plainTime;
      ai.stalls++;
      ai.slot = null;
      h.path = null; ai.repathT = 0;
    }
    ai.stallWin = 0; ai.stallT = 0; ai.stallX = h.x; ai.stallY = h.y;
  }

  /**
   * Last-resort watchdog for states the stall check can't see (no route at all,
   * standing by a healer that never heals, endless waiting…): outside fights,
   * channels, barricade smashing and the Heart, < 1.5 tiles of net progress in
   * 20 s (and not simply queued in a crowd) → drop every soft goal and walk a
   * plain route; a second strike makes a normal hero give up and leave.
   */
  function watchdog(h, dt) {
    const ai = h.ai;
    if (ai.engage || h.channel || ai.atHeart || ai.smash) { ai.wdT = 0; ai.wdX = h.x; ai.wdY = h.y; return; }
    if ((ai.wdT += dt) < K.watchdogWindow) return;
    const moved = Math.hypot(h.x - ai.wdX, h.y - ai.wdY);
    ai.wdT = 0; ai.wdX = h.x; ai.wdY = h.y;
    if (moved >= K.watchdogMove) { ai.wdStrikes = 0; return; }
    if (ai.queueT > 0 || crowded(h)) return;              // just waiting its turn behind allies
    ai.wdStrikes++;
    releaseLure(h);
    ai.healer = null; ai.noHealer = true; ai.slot = null;
    ai.plainT = K.plainTime * 2; ai.waitCd = K.watchdogWindow;
    h.path = null; ai.repathT = 0;
    if (ai.wdStrikes >= 2 && !h.boss && !ai.gaveUp) {
      ai.gaveUp = true;
      FX.text(h.x + 0.6, h.y - 1, 'Enough of this!', '#ffd0a0', { size: 10 });
    }
  }

  /** Bounced back to the entrance (Teleporter Pad). Normal heroes give up after a few bounces. */
  function onTeleported(h) {
    const ai = h.ai;
    ai.teleports++;
    ai.atHeart = false; ai.rushing = false; ai.slot = null;
    ai.stallWin = 0; ai.stallT = 0; ai.stallX = h.x; ai.stallY = h.y;
    h.path = null; ai.repathT = 0;
    if (!h.boss && !ai.gaveUp && ai.teleports >= K.teleportGiveUp) {
      ai.gaveUp = true;
      releaseLure(h);
      clearEngage(h);
      cancelChannel(h);
      FX.text(h.x + 0.6, h.y - 1, 'This maze is cursed!', '#ffd0a0', { size: 10 });
    }
  }

  /* ---------------------------------------------------------------------------
   * 8. ENGAGEMENT — who (if anyone) this hero is fighting.
   *    kinds: 'taunt' (Orc warcry, forced) · 'block' (a monster in our face) ·
   *    'attacked' (fight back) · 'charge' (Warrior/Paladin) · 'range' (snipe) ·
   *    'melee' (something within reach)
   * ------------------------------------------------------------------------ */
  /** Nearest fightable, non-ignored monster within r (optionally in line of sight). */
  function nearestMonster(h, r, pred, needLos) {
    let best = null, bd = r * r;
    for (const m of S.monsters) {
      if (!monsterOk(m) || (pred && !pred(m))) continue;
      const dx = m.x - h.x, dy = m.y - h.y, d2 = dx * dx + dy * dy;
      if (d2 > bd || ignored(h, m)) continue;
      if (needLos && !Grid.los(h.x, h.y, m.x, m.y)) continue;
      bd = d2; best = m;
    }
    return best;
  }

  function findBlocker(h) {
    if (h.st.invisT > 0) return null;       // monsters can't see (or block) an invisible hero
    let best = null, bd = K.blockR * K.blockR;
    for (const m of S.monsters) {
      if (!monsterOk(m) || !targetsHero(m, h) || ignored(h, m)) continue;   // (one we can't hurt can't pin us)
      const dx = m.x - h.x, dy = m.y - h.y, d2 = dx * dx + dy * dy;
      if (d2 <= bd) { bd = d2; best = m; }
    }
    return best;
  }

  function setEngage(h, m, kind) {
    const ai = h.ai;
    if (!ai.engage) { ai.anchorX = h.x; ai.anchorY = h.y; }   // leash is measured from the route
    if (ai.engage !== m) { ai.lostT = 0; ai.losT = 0; }
    ai.engage = m; ai.engageKind = kind; h.target = m;
    if (kind === 'charge' && h.animT <= 0) FX.text(h.x, h.y - 0.9, '!', '#ffb060', { size: 13 });
  }
  function clearEngage(h) {
    const ai = h.ai;
    ai.engage = null; ai.engageKind = ''; h.target = null; ai.lostT = 0;
  }
  function ignoreMonster(h, m, dur) { h.ai.ignore.set(m.uid, S.time + (dur || K.ignoreT)); }
  const ignored = (h, m) => h.ai.ignore.size > 0 && (h.ai.ignore.get(m.uid) || 0) > S.time;

  /** Is the current engagement still worth pursuing? */
  function keepEngage(h, c, m) {
    const ai = h.ai, kind = ai.engageKind;
    const d = dist(h.x, h.y, m.x, m.y);
    if (d > 9) return false;
    if (kind === 'range') return d <= h.range + 0.5 && ai.lostT < 1;
    if (kind === 'block') {
      if (ai.rushing || (h.type === 'rogue' && ai.slip)) return false;
      if (!targetsHero(m, h) && d > h.range + K.meleeSlack) return false;
      return true;
    }
    if (ai.rushing || ai.retreating || ai.escaping || ai.gaveUp) return false;
    if (h.type === 'rogue' && ai.slip && kind !== 'taunt') return false;   // slipped away
    const reach = h.range + (c.ranged ? 0 : K.meleeSlack);
    if ((d > reach && dist(h.x, h.y, ai.anchorX, ai.anchorY) > K.leash) || ai.lostT > K.chaseGiveUp) {
      ignoreMonster(h, m);
      return false;
    }
    return true;
  }

  function engageTick(h, c) {
    const ai = h.ai;
    let m = ai.engage;
    if (m && !monsterOk(m)) { clearEngage(h); m = null; }
    // Orcish Warcry: heroes near an Orc MUST fight it.
    if (hasPerk('warcry')) {
      const orc = nearestMonster(h, K.tauntR, predOrc, false);
      if (orc) {
        if (m !== orc || ai.engageKind !== 'taunt') { cancelChannel(h); ai.atHeart = false; setEngage(h, orc, 'taunt'); }
        return;
      }
      if (ai.engageKind === 'taunt') { clearEngage(h); m = null; }
    }
    if (ai.atHeart) { if (m) clearEngage(h); return; }
    // A monster standing in our face and targeting us blocks the way.
    if (!ai.rushing && !(h.type === 'rogue' && ai.slip)) {
      const b = findBlocker(h);
      if (b) {
        if (m !== b && !(m && ai.engageKind === 'block' && monsterOk(m) && dist(h.x, h.y, m.x, m.y) <= K.blockR)) {
          cancelChannel(h);
          setEngage(h, b, 'block');
        }
        return;
      }
    }
    if (m) { if (!keepEngage(h, c, m)) clearEngage(h); return; }
    if (ai.thinkT > 0) return;
    ai.thinkT = K.thinkEvery;
    if (ai.rushing || ai.retreating || ai.escaping || ai.gaveUp || h.channel) return;  // no voluntary fights
    if (h.type === 'rogue' && ai.slip) return;                           // slipping past (re-rolled every 2 s)
    curHero = h;
    let t = nearestMonster(h, K.attackedR, predTargetsCur, true);         // fight back
    if (t) { setEngage(h, t, 'attacked'); return; }
    if (c.engageR) {                                                        // Warrior/Paladin charge
      t = nearestMonster(h, c.engageR, null, true);
      if (t) { setEngage(h, t, 'charge'); return; }
    }
    t = nearestMonster(h, h.range + (c.ranged ? 0 : K.meleeSlack), null, !!c.ranged);
    if (t) setEngage(h, t, c.ranged ? 'range' : 'melee');
  }

  /** Fight the engaged monster: attack in reach, otherwise close in (direct or pathed). */
  function fightTick(h, c, dt) {
    const ai = h.ai, m = ai.engage;
    const d = dist(h.x, h.y, m.x, m.y);
    const reach = h.range + (c.ranged ? 0 : K.meleeSlack);
    if ((ai.losT -= dt) <= 0) { ai.losT = 0.2; ai.los = Grid.los(h.x, h.y, m.x, m.y); }
    if (d <= reach && (!c.ranged || ai.los || d < 1.1)) {
      ai.anchored = true; ai.lostT = 0;
      faceToward(h, m.x);
      // Fight watchdog: a target that takes no net damage while we pound it is a stalemate.
      if (ai.chkTarget !== m) { ai.chkTarget = m; ai.chkT = 0; ai.chkHp = m.hp; }
      if ((ai.chkT += dt) >= K.noDmgWindow) {
        if (m.hp >= ai.chkHp - 0.5) { ignoreMonster(h, m, K.noDmgIgnore); clearEngage(h); ai.chkTarget = null; return; }
        ai.chkT = 0; ai.chkHp = m.hp;
      }
      if (h.atkT <= 0 && Status.canAct(h)) attack(h, c, m);
      return;
    }
    ai.lostT += dt;
    if (ai.engageKind === 'range') return;          // snipers don't chase; keepEngage drops it
    const charge = ai.engageKind === 'charge';
    ai.charging = charge;
    const spd = speedOf(h, charge ? K.chargeSpeed : 1);
    const mtx = Math.floor(m.x), mty = Math.floor(m.y);
    if (Grid.isSolid(mtx, mty)) { ai.anchored = true; return; }   // phasing in a wall: wait for it
    if (ai.los && d < 5) {
      const step = Math.min(spd * dt, d - reach * 0.85);
      if (step > 0) {
        stepTo(h, h.x + (m.x - h.x) / d * step, h.y + (m.y - h.y) / d * step);
        ai.wantMove = true; h.moving = true;
      }
      faceToward(h, m.x);
    } else {
      setGoal(h, mtx, mty, 'fight', true);
      follow(h, spd, dt, 'chase');
    }
  }

  /* ---------------------------------------------------------------------------
   * 9. ATTACKS & THE HEART
   * ------------------------------------------------------------------------ */
  function attack(h, c, m) {
    h.atkT = h.atkCd;
    h.animT = 0.3;
    faceToward(h, m.x);
    const dmg = h.dmg * Status.dmgMul(h);
    if (c.ranged) {
      const bolt = c.proj === 'bolt';
      Proj.spawn({
        kind: c.proj || 'arrow', x: h.x, y: h.y, team: 'hero', target: m,   // from the LOS-checked centre
        speed: bolt ? 7.5 : 10, dmg, src: h.ai.src, radius: 0.3, range: h.range + 4,
      });
      SFX.play(bolt ? 'magic' : 'arrow');
    } else {
      Combat.damage(m, dmg, h.ai.src);
      FX.burst(m.x, m.y - 0.15, { n: 4, colors: c.holy ? ['#fff3a0', '#ffffff'] : ['#ffffff', '#c8c8c8'], speed: 1.8, life: 0.25, size: 1.8 });
      SFX.play('heroHit');
    }
  }

  /** Opportunistic swing/shot at anything in reach while doing something else. */
  function opportunistic(h, c) {
    const ai = h.ai;
    if (h.atkT > 0 || ai.scanT > 0 || !Status.canAct(h)) return;
    const reach = h.range + (c.ranged ? 0 : K.meleeSlack);
    const m = nearestMonster(h, reach, null, !!c.ranged);
    if (m) attack(h, c, m);
    else ai.scanT = 0.15;
  }

  function heartReachOf(h, c, d) {
    if (c.ranged && d <= K.heartReachRanged && Grid.los(h.x, h.y, Heart.cx(), Heart.cy())) return K.heartReachRanged;
    return K.heartReach;
  }

  function heartTick(h, c) {
    const ai = h.ai;
    const hx = Heart.cx(), hy = Heart.cy(), d = dist(h.x, h.y, hx, hy);
    if (d > ai.heartR + 0.3) { ai.atHeart = false; return; }
    ai.anchored = true;
    faceToward(h, hx);
    if (h.atkT > 0 || !Status.canAct(h)) return;
    h.atkT = h.atkCd;
    h.animT = 0.3;
    if (c.ranged && d > 1.4) {
      heartTarget.x = hx; heartTarget.y = hy;
      Proj.spawn({
        kind: c.proj || 'arrow', x: h.x, y: h.y, team: 'hero', target: heartTarget,
        speed: c.proj === 'bolt' ? 7.5 : 10, dmg: h.heartDmg, src: ai.src, radius: 0.3, range: 8, onHit: heartHit,
      });
      SFX.play(c.proj === 'bolt' ? 'magic' : 'arrow');
    } else {
      Heart.damage(h.heartDmg, ai.src);
      FX.burst(hx - (hx - h.x) * 0.4, hy - (hy - h.y) * 0.4, { n: 5, colors: ['#ffffff', '#ff9aa8'], speed: 2, life: 0.3, size: 2 });
    }
  }

  /* ---------------------------------------------------------------------------
   * 10. GREED & LOOT
   * ------------------------------------------------------------------------ */
  function getLures() {
    if (!lureCache || S.time - lureCacheT > 0.25 || S.time < lureCacheT) { lureCache = Lures.list(); lureCacheT = S.time; }
    return lureCache;
  }
  const lureKey = L => (L.kind === 'chest' ? L.struct.uid : L.ent.uid);

  function mimicTaken(m, h) {
    for (const o of S.heroes) if (o !== h && alive(o) && o.lure && o.lure.ent === m) return true;
    return false;
  }

  function releaseLure(h) {
    const L = h.lure;
    if (!L) return;
    if (L.kind === 'chest' && L.struct && L.struct.data && L.struct.data.claimedBy === h.uid) L.struct.data.claimedBy = null;
    h.lure = null;
    h.ai.lureTime = 0;
    h.path = null;
  }

  function lureValid(h, L) {
    if (L.kind === 'chest') {
      const s = L.struct, t = s && Grid.tile(s.x, s.y);
      return !!t && t.s === s && !s.broken && !s.data.empty && s.data.claimedBy === h.uid;
    }
    const m = L.ent;
    return !!m && !m.dead && !m.removed;
  }

  /** Roll greed once per hero per lure that comes within Lures.radius(). @returns true if lured. */
  function greedTick(h, c) {
    const ai = h.ai;
    if (ai.lureT > 0) return false;
    ai.lureT = K.lureEvery;
    if (h.boss || h.loot > 0 || !(c.greed > 0)) return false;
    const lures = getLures();
    if (!lures.length) return false;
    const r = Lures.radius(), r2 = r * r;
    for (const L of lures) {
      const key = lureKey(L);
      if (ai.rolled.has(key)) continue;
      const dx = L.x + 0.5 - h.x, dy = L.y + 0.5 - h.y;
      if (dx * dx + dy * dy > r2) continue;
      if (L.kind === 'chest' ? (L.struct.data.claimedBy || L.struct.data.empty) : (!L.ent.disguised || mimicTaken(L.ent, h))) continue;
      if (budget <= 0) { ai.lureT = 0.05; return false; }   // try again next tick
      ai.rolled.add(key);
      if (!chance(c.greed)) continue;
      budget--;
      prepCost(h, 'lure');
      const p = Path.astar(h.x, h.y, L.x, L.y, ai.cost);
      if (!p || p.length > r * K.lureMaxPath + 2) continue;
      // Commit: claim it and adopt the route we just computed.
      h.lure = L;
      if (L.kind === 'chest') L.struct.data.claimedBy = h.uid;
      ai.lureTime = 0;
      ai.gx = L.x; ai.gy = L.y; ai.gk = 'lure';
      h.path = p; h.pathIdx = 0;
      ai.pathVer = S.pathVersion; ai.dangerVer = S.dangerVersion; ai.trapVer = trapVer;
      ai.lastRepath = S.time; ai.repathT = randRange(K.repathMin, K.repathMax);
      FX.text(h.x, h.y - 0.9, '$', '#ffd84a', { size: 13 });
      return true;
    }
    return false;
  }

  function lureTick(h, c, dt) {
    const ai = h.ai, L = h.lure;
    ai.lureTime += dt;
    if (!lureValid(h, L) || ai.lureTime > K.lureTimeout) { releaseLure(h); return; }
    if (L.kind === 'mimic' && !L.ent.disguised) {        // it was a Mimic all along!
      const m = L.ent;
      releaseLure(h);
      if (monsterOk(m)) setEngage(h, m, 'attacked');
      return;
    }
    const lx = L.kind === 'mimic' ? L.ent.x : L.x + 0.5, ly = L.kind === 'mimic' ? L.ent.y : L.y + 0.5;
    if (dist(h.x, h.y, lx, ly) <= K.lootReach) {
      if (L.kind === 'chest') startChannel(h, 'loot', K.lootTime, L.x, L.y, L.struct);
      else releaseLure(h);                               // the "chest" never opened: move on
      return;
    }
    setGoal(h, Math.floor(lx), Math.floor(ly), 'lure', L.kind === 'mimic');
    follow(h, speedOf(h, 1), dt, 'walk');
    opportunistic(h, c);
  }

  function lootChest(h, s) {
    const ai = h.ai;
    const v = Math.max(0, Math.round(Objects.loot(s, h) || 0));
    if (s.data) s.data.claimedBy = null;
    h.lure = null; ai.lureTime = 0; h.path = null;
    if (v <= 0) return;
    h.loot = (h.loot || 0) + v;
    if (h.type === 'rogue') {
      ai.escaping = true; ai.retreating = false; ai.rushing = false;
      FX.text(h.x, h.y - 1.1, 'Mine!', '#ffd84a', { size: 11 });
    }
  }

  /* ---------------------------------------------------------------------------
   * 11. CHANNELS — loot / disarm / blast / dig. The hero stands still, a bar
   *     fills (channel.t counts up to channel.max); stuns, fear, blockers and
   *     taunts interrupt.
   * ------------------------------------------------------------------------ */
  function startChannel(h, kind, max, x, y, s) {
    h.channel = { kind, t: 0, max: Math.max(0.1, max), x, y, s: s || null, fxT: 0 };
    h.ai.anchored = true;
    faceToward(h, x + 0.5);
    if (kind === 'blast') SFX.play('magic');
  }

  function cancelChannel(h) {
    const ch = h.channel;
    if (!ch) return;
    h.channel = null;
    if (ch.kind === 'blast') h.ai.blastT = Math.min(h.ai.blastT, 2.5);   // re-evaluate soon
  }

  function channelValid(h, ch) {
    const t = Grid.tile(ch.x, ch.y);
    if (!t) return false;
    switch (ch.kind) {
      case 'loot': return !!h.lure && t.s === ch.s && !ch.s.broken && !ch.s.data.empty;
      case 'disarm': return t.s === ch.s && !ch.s.broken && !ch.s.disarmed;
      case 'blast': case 'dig': return t.type === T.WALL;
      default: return false;
    }
  }

  function channelFx(h, ch) {
    const wx = ch.x + 0.5, wy = ch.y + 0.5;
    switch (ch.kind) {
      case 'dig':
        FX.burst(wx - (wx - h.x) * 0.45, wy - (wy - h.y) * 0.45, { n: 5, colors: ['#8a8296', '#6b6378', '#c9b99a'], speed: 1.8, life: 0.45, size: 2, grav: 6 });
        SFX.play('dig');
        h.animT = 0.2;
        break;
      case 'blast':
        FX.beam(h.x, h.y - 0.3, wx, wy, { color: '#8f9bff', width: 1.5, life: 0.18 });
        FX.burst(wx, wy, { n: 6, colors: ['#8f9bff', '#c6ccff', '#ffffff'], speed: 1.4, life: 0.4, size: 2, glow: true });
        break;
      case 'disarm':
        FX.burst(wx, wy, { n: 3, colors: ['#ffe28a', '#ffffff'], speed: 1.2, life: 0.3, size: 1.5 });
        h.animT = 0.15;
        break;
      case 'loot':
        FX.burst(wx, wy - 0.1, { n: 3, colors: ['#ffd84a', '#fff2a0'], speed: 1, life: 0.4, size: 1.8, grav: -2 });
        break;
    }
  }

  function channelTick(h, c, dt) {
    const ch = h.channel;
    if (!channelValid(h, ch)) {
      h.channel = null;
      if (ch.kind === 'loot') releaseLure(h);
      return;
    }
    h.ai.anchored = true;
    faceToward(h, ch.x + 0.5);
    ch.t += dt;
    ch.fxT -= dt;
    if (ch.fxT <= 0) { ch.fxT = ch.kind === 'dig' ? 0.35 : 0.25; channelFx(h, ch); }
    if (ch.t < ch.max) return;
    h.channel = null;
    switch (ch.kind) {
      case 'loot': lootChest(h, ch.s); break;
      case 'disarm':
        Traps.disarm(ch.s, h);
        h.ai.disarmOk.delete(ch.s.uid);
        if (ch.jam) FX.text(ch.x + 0.5, ch.y, 'Jammed!', '#ffd27a', { size: 11 });
        break;
      case 'blast':
        FX.beam(h.x, h.y - 0.3, ch.x + 0.5, ch.y + 0.5, { color: '#b8c0ff', width: 4, life: 0.3 });
        if (Grid.destroyWall(ch.x, ch.y, 'a Mage')) {
          FX.burst(ch.x + 0.5, ch.y + 0.5, { n: 24, colors: ['#8f9bff', '#c6ccff', '#ffffff', '#6a6cf0'], speed: 3.5, life: 0.7, size: 2.5, glow: true });
          FX.ring(ch.x + 0.5, ch.y + 0.5, { color: '#8f9bff', r0: 0.2, r1: 1.4, life: 0.4, width: 3 });
          FX.text(ch.x + 0.5, ch.y, 'BLAST!', '#b8c0ff', { size: 12 });
          FX.shake(5);
          SFX.play('blast');
        }
        h.ai.blastT = c.blastCd || 12;
        break;
      case 'dig':
        if (Grid.destroyWall(ch.x, ch.y, ch.rubble ? 'trapped heroes' : 'a Dwarf Miner')) SFX.play('dig');
        break;
    }
    h.path = null;
  }

  /* ---------------------------------------------------------------------------
   * 12. CLASS KITS
   * ------------------------------------------------------------------------ */
  function canDig(h, x, y) {
    const t = Grid.tile(x, y), ai = h.ai;
    if (!t || t.type !== T.WALL) return false;
    return ai.cDig === 1 || ai.cDig === 3 || (ai.cDig === 2 && t.rubble);
  }

  function startDig(h, x, y) {
    const mode = h.ai.cDig, rubble = Grid.tile(x, y).rubble;
    const time = mode === 1 ? digTimeOf(h) : rubble ? K.rubbleDigTime : K.sealedDigTime;
    startChannel(h, 'dig', time * (mode !== 1 && hasPerk('reinforced') ? 2 : 1), x, y, null);
    h.channel.rubble = mode !== 1;          // "clawing out" rather than a miner's tunnel
  }

  /** Rogue: known armed trap on the next tile → roll once; success = channel a disarm. */
  function tryDisarm(h, x, y) {
    const t = Grid.tile(x, y), s = t && t.s, ai = h.ai;
    if (!s || s.cat !== 'trap' || s.broken || s.disarmed || !trapKnown(s)) return false;
    if (ai.disarmFail.has(s.uid)) return false;          // fumbled the roll: just walk (it may trigger)
    if (!ai.disarmOk.has(s.uid)) {
      if (!chance(clsOf(h).disarm || 0)) {
        ai.disarmFail.add(s.uid);
        FX.text(h.x, h.y - 0.9, '?', '#ffb0b0', { size: 12 });
        return false;
      }
      ai.disarmOk.add(s.uid);
    }
    startChannel(h, 'disarm', clsOf(h).disarmTime || 1.5, x, y, s);
    return true;
  }

  /**
   * A hero boss that keeps being bounced back to the entrance jams the known
   * Teleporter Pad in its way (bosses never give up, so this breaks the loop).
   */
  function tryJam(h, x, y) {
    const t = Grid.tile(x, y), s = t && t.s;
    if (!s || s.cat !== 'trap' || s.id !== 'teleport' || s.broken || s.disarmed || !trapKnown(s)) return false;
    startChannel(h, 'disarm', K.jamTime, x, y, s);
    h.channel.jam = true;
    return true;
  }

  function smash(h, b) {
    const ai = h.ai;
    ai.smash = b; ai.anchored = true;
    faceToward(h, b.x + 0.5);
    if (h.atkT > 0 || !Status.canAct(h)) return;
    h.atkT = h.atkCd;
    h.animT = 0.3;
    Combat.hitStruct(b, h.dmg * Status.dmgMul(h), ai.src);
    SFX.play('hit');
  }

  function barricadeAhead(h, path, cx, cy) {
    for (let k = h.pathIdx; k < h.pathIdx + 2 && k < path.length; k++) {
      const wp = path[k];
      if (wp.x === cx && wp.y === cy) continue;
      const b = Grid.barricadeAt(wp.x, wp.y);
      if (b && dist(h.x, h.y, wp.x + 0.5, wp.y + 0.5) <= K.barricadeReach) return b;
    }
    return null;
  }

  /** Rogue: each second, a chance to spot each hidden trap nearby. */
  function rogueDetect(h, c) {
    const p = (c.detect || 0) * (hasPerk('hidden_depths') ? 0.5 : 1);
    const r2 = (c.detectR || 2) * (c.detectR || 2);
    for (const s of S.structs) {
      if (s.cat !== 'trap' || !s.hidden || s.revealed || s.broken || s.disarmed) continue;
      const dx = s.x + 0.5 - h.x, dy = s.y + 0.5 - h.y;
      if (dx * dx + dy * dy <= r2 && chance(p)) Traps.reveal(s, h);
    }
  }

  /** Ranger: hidden traps within revealR are simply noticed. */
  function rangerReveal(h, c) {
    const r2 = (c.revealR || 3) * (c.revealR || 3);
    for (const s of S.structs) {
      if (s.cat !== 'trap' || !s.hidden || s.revealed || s.broken || s.disarmed) continue;
      const dx = s.x + 0.5 - h.x, dy = s.y + 0.5 - h.y;
      if (dx * dx + dy * dy <= r2) Traps.reveal(s, h);
    }
  }

  /** Cleric: heal the most-injured ally (≤ 90% HP) in range and sight. @returns true if healed. */
  function clericHeal(h, c) {
    const r2 = c.healR * c.healR;
    let best = null, br = 0.9;
    for (const o of S.heroes) {
      if (!alive(o)) continue;
      const ratio = o.hp / o.maxHp;
      if (ratio > br || (best && ratio === br)) continue;
      const dx = o.x - h.x, dy = o.y - h.y;
      if (dx * dx + dy * dy > r2) continue;
      if (o !== h && !Grid.los(h.x, h.y, o.x, o.y)) continue;
      best = o; br = ratio;
    }
    if (!best) return false;
    if (Combat.heal(best, h.healAmt) <= 0) return false;
    if (best !== h) FX.beam(h.x, h.y - 0.35, best.x, best.y - 0.2, { color: '#fff3a0', width: 3, life: 0.35 });
    FX.burst(best.x, best.y - 0.1, { n: 8, colors: ['#fff3a0', '#7dff8a', '#ffffff'], speed: 1.2, life: 0.6, size: 2, grav: -3, glow: true });
    SFX.play('heal');
    h.animT = 0.3;
    return true;
  }

  /**
   * Mage: when the route is long, would blasting a nearby player wall shorten
   * it by ≥ blastMinGain tiles? (A* with that wall's cost = 1 vs the current
   * route.) If so, channel a blast on the best wall. @returns true if started.
   */
  function tryBlast(h, c) {
    const ai = h.ai;
    blastEvalFree = false;
    const hx = Math.floor(h.x), hy = Math.floor(h.y);
    const direct = Math.abs(hx - S.heart.x) + Math.abs(hy - S.heart.y);
    const remain = h.path && h.path.length ? h.path.length - h.pathIdx : Infinity;
    if (remain < direct + c.blastMinGain) { ai.blastT = 1.5; return false; }   // route isn't long
    prepCost(h, 'heart');
    const base = Path.astar(hx, hy, S.heart.x, S.heart.y, ai.cost);
    const L0 = base ? base.length : Infinity;
    probeBase = ai.cost;
    let bestGain = 0, bx = -1, by = -1;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if ((dx === 0 && dy === 0) || dx * dx + dy * dy > 4.5) continue;       // within 1–2 tiles
      const x = hx + dx, y = hy + dy, t = Grid.tile(x, y);
      if (!t || t.type !== T.WALL) continue;                                   // player walls only (not rock)
      probeIdx = y * S.cols + x;
      const p = Path.astar(hx, hy, S.heart.x, S.heart.y, probeCost);
      if (!p) continue;
      const gain = L0 - p.length;
      if (gain >= c.blastMinGain && gain > bestGain) { bestGain = gain; bx = x; by = y; }
    }
    probeIdx = -1; probeBase = null;
    if (bx < 0) { ai.blastT = 3; return false; }
    startChannel(h, 'blast', (c.blastTime || 1.2) * (hasPerk('reinforced') ? 2 : 1), bx, by, null);
    return true;
  }

  /**
   * Retreating heroes look for a Cleric (any party) that is not deeper in the
   * dungeon than they are, and fall back to it to be healed.
   */
  function findHealer(h, r) {
    let best = null, bd = r * r;
    for (const o of S.heroes) {
      if (o === h || !healerUsable(h, o, r)) continue;
      if (!(o.ai.hd >= h.ai.hd - 2)) continue;
      const dx = o.x - h.x, dy = o.y - h.y, d2 = dx * dx + dy * dy;
      if (d2 <= bd) { bd = d2; best = o; }
    }
    return best;
  }

  /** A Cleric that can tend to us: alive, not fleeing/leaving itself, within r. */
  function healerUsable(h, o, r) {
    if (!o || o.type !== 'cleric' || !alive(o) || !o.ai) return false;
    if (o.ai.retreating || o.ai.escaping || o.ai.gaveUp || o.st.fearT > 0) return false;
    const dx = o.x - h.x, dy = o.y - h.y;
    return dx * dx + dy * dy <= r * r;
  }

  function kitTick(h, c, dt) {
    const ai = h.ai;
    switch (h.type) {
      case 'rogue':
        if ((ai.detectT -= dt) <= 0) { ai.detectT = K.detectEvery; rogueDetect(h, c); }
        break;
      case 'ranger':
        if ((ai.revealT -= dt) <= 0) { ai.revealT = K.revealEvery; rangerReveal(h, c); }
        break;
      case 'cleric':
        if ((ai.healT -= dt) <= 0) ai.healT = clericHeal(h, c) ? c.healCd : 0.25;
        break;
      case 'mage':
        if (ai.blastT > 0) ai.blastT -= dt;
        break;
    }
    if (h.boss) bossTick(h, dt);
  }

  /* ---------------------------------------------------------------------------
   * 13. HERO-BOSS ABILITIES — fire only when they will actually do something.
   * ------------------------------------------------------------------------ */
  function shieldBash(h) {
    const list = scratch; list.length = 0;
    const r2 = K.bashR * K.bashR;
    for (const m of S.monsters) {
      if (!monsterOk(m)) continue;
      const dx = m.x - h.x, dy = m.y - h.y;
      if (dx * dx + dy * dy <= r2) list.push(m);
    }
    if (!list.length) return false;
    const dmg = K.bashMul * h.dmg * Status.dmgMul(h);
    for (const m of list) {
      Combat.damage(m, dmg, h.ai.src);
      if (!m.dead) Status.apply(m, 'stun', { dur: K.bashStun });
      FX.burst(m.x, m.y - 0.2, { n: 6, colors: ['#ffe28a', '#ffffff'], speed: 2, life: 0.4, size: 2 });
    }
    list.length = 0;
    FX.ring(h.x, h.y, { color: '#ffd27a', r0: 0.3, r1: K.bashR + 0.2, life: 0.45, width: 4 });
    FX.ring(h.x, h.y, { color: '#ffffff', r0: 0.2, r1: K.bashR - 0.3, life: 0.3, width: 2 });
    FX.burst(h.x, h.y + 0.2, { n: 18, colors: ['#8a8296', '#c9b99a', '#6b6378'], speed: 2.6, life: 0.6, size: 2.5, grav: 6 });
    FX.text(h.x, h.y - 1.2, 'Shield Bash!', '#ffd27a', { size: 12 });
    FX.shake(6);
    SFX.play('collapse');
    h.animT = 0.4;
    return true;
  }

  function blink(h) {
    const ai = h.ai;
    if (ai.atHeart || !(ai.hd > 1)) return false;
    const cx = Math.floor(h.x), cy = Math.floor(h.y), R = K.blinkR, cur = ai.hd;
    let bx = -1, by = -1, bs = Infinity, bd = Infinity;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 === 0 || d2 > R * R) continue;
      const x = cx + dx, y = cy + dy;
      if (Grid.isSolid(x, y) || Grid.barricadeAt(x, y)) continue;
      const tt = Grid.tile(x, y).type;
      if (tt === T.HEART || tt === T.ENTRANCE) continue;
      const hd = Path.heartDist(x, y);
      if (!(hd <= cur - K.blinkMinGain)) continue;          // must be ≥ 3 steps closer (∞ = cut off)
      const score = hd + (field[y * S.cols + x] > 0 ? 2 : 0); // prefer not to land on known traps
      if (score < bs || (score === bs && d2 < bd)) { bs = score; bd = d2; bx = x; by = y; }
    }
    if (bx < 0) return false;
    const ox = h.x, oy = h.y;
    ai.blinkT = S.time;
    FX.burst(ox, oy, { n: 22, colors: ['#b86bff', '#e0c0ff', '#6a3cc0'], speed: 2.8, life: 0.6, size: 2.5, glow: true });
    h.x = bx + 0.5; h.y = by + 0.5;
    FX.beam(ox, oy - 0.3, h.x, h.y - 0.3, { color: '#c89bff', width: 2, life: 0.3 });
    FX.burst(h.x, h.y, { n: 26, colors: ['#b86bff', '#e0c0ff', '#ffffff'], speed: 3, life: 0.7, size: 2.5, glow: true });
    FX.ring(h.x, h.y, { color: '#c89bff', r0: 0.2, r1: 1.3, life: 0.4, width: 3 });
    FX.text(h.x, h.y - 1.2, 'Blink!', '#e0c0ff', { size: 12 });
    SFX.play('teleport');
    faceToward(h, h.x + (h.x - ox));
    cancelChannel(h);
    clearEngage(h);
    h.path = null; ai.repathT = 0;
    ai.hd = Path.heartDist(h.x, h.y);
    return true;
  }

  function sanctuary(h) {
    const r2 = K.sanctuaryR * K.sanctuaryR;
    let need = false;
    for (const o of S.heroes) {
      if (!alive(o)) continue;
      const dx = o.x - h.x, dy = o.y - h.y;
      if (dx * dx + dy * dy <= r2 && (o.hp < o.maxHp * 0.9 || ailing(o))) { need = true; break; }
    }
    if (!need) return false;
    for (const o of S.heroes) {
      if (!alive(o)) continue;
      const dx = o.x - h.x, dy = o.y - h.y;
      if (dx * dx + dy * dy > r2) continue;
      Combat.heal(o, K.sanctuaryHeal);
      Status.cleanse(o);
      if (o !== h) FX.beam(h.x, h.y - 0.4, o.x, o.y - 0.2, { color: '#fff3a0', width: 2.5, life: 0.4 });
      FX.burst(o.x, o.y - 0.1, { n: 10, colors: ['#fff3a0', '#ffffff', '#7dff8a'], speed: 1.4, life: 0.7, size: 2, grav: -3, glow: true });
    }
    FX.ring(h.x, h.y, { color: '#fff3a0', r0: 0.4, r1: K.sanctuaryR, life: 0.8, width: 4 });
    FX.text(h.x, h.y - 1.2, 'Sanctuary!', '#fff3a0', { size: 12 });
    SFX.play('heal');
    h.animT = 0.4;
    return true;
  }

  function shadowstep(h) {
    const r2 = K.shadowR * K.shadowR, list = scratch;
    list.length = 0;
    for (const s of S.structs) {
      if (s.cat !== 'trap' || s.broken || s.disarmed) continue;
      const dx = s.x + 0.5 - h.x, dy = s.y + 0.5 - h.y;
      if (dx * dx + dy * dy <= r2) list.push(s);
    }
    let threatened = false;
    if (!list.length) {
      for (const m of S.monsters) {
        if (!monsterOk(m) || !targetsHero(m, h)) continue;
        const dx = m.x - h.x, dy = m.y - h.y;
        if (dx * dx + dy * dy <= r2) { threatened = true; break; }
      }
    }
    if (!list.length && !threatened) { list.length = 0; return false; }
    for (const s of list) Traps.disarm(s, h);
    list.length = 0;
    Status.apply(h, 'invis', { dur: K.shadowInvis });
    FX.burst(h.x, h.y, { n: 30, colors: ['#2a1f3d', '#5b3d8a', '#9a7fd0'], speed: 2.2, life: 0.8, size: 3, grav: -1 });
    FX.ring(h.x, h.y, { color: '#9a7fd0', r0: 0.3, r1: K.shadowR, life: 0.5, width: 3 });
    FX.text(h.x, h.y - 1.2, 'Shadowstep!', '#c8b0ff', { size: 12 });
    SFX.play('magic');
    if (h.ai.engageKind === 'block') clearEngage(h);
    return true;
  }

  function bossTick(h, dt) {
    const ai = h.ai;
    if (h.abilityT > 0) return;
    if ((ai.abilityRetry -= dt) > 0) return;
    ai.abilityRetry = 0.25;
    if (!Status.canAct(h)) return;
    let fired = false;
    switch (h.boss) {
      case 'champion': fired = shieldBash(h); break;
      case 'archmage': fired = blink(h); break;
      case 'saint': fired = sanctuary(h); break;
      case 'shadow': fired = shadowstep(h); break;
    }
    if (fired) h.abilityT = h.abilityCd;
  }

  /* ---------------------------------------------------------------------------
   * 14. THE PER-HERO BRAIN
   * ------------------------------------------------------------------------ */
  function initAI(h) {
    const c = clsOf(h);
    const ai = {
      hd: S ? Path.heartDist(h.x, h.y) : Infinity,
      // pathing (goal + cost parameters)
      gx: -1, gy: -1, gk: '', pathVer: -1, dangerVer: -1, trapVer: -1, lastRepath: -99,
      repathT: 0, noPath: false,
      cost: null, cCareful: true, cDw: 0, cTw: 0, cDig: 0, cDigCost: 0, cFear: false, cFx: 0, cFy: 0,
      // strategic flags
      rushing: false, retreating: false, escaping: false, atHeart: false, heartR: K.heartReach, fleeing: false,
      healer: null, healerT: 0, healerLost: false,
      // per-tick flags (read by separation/queueing/labels). anchored = physically busy in
      // place (fighting, channeling, smashing, striking the Heart, stunned): heavy in
      // separation and others queue behind; idle waiting is deliberately NOT anchored.
      anchored: false, wantMove: false, waiting: false, charging: false, smash: null,
      // combat
      engage: null, engageKind: '', anchorX: h.x, anchorY: h.y, lostT: 0, losT: 0, los: true,
      ignore: new Map(), thinkT: Math.random() * K.thinkEvery, scanT: 0, chkTarget: null, chkT: 0, chkHp: 0,
      slip: false, slipT: 0,
      src: { team: 'hero', kind: 'hero', id: h.type, ent: h, elem: c.holy ? 'holy' : h.type === 'mage' ? 'magic' : 'phys' },
      // greed
      rolled: new Set(), lureT: Math.random() * K.lureEvery, lureTime: 0,
      // kits
      detectT: Math.random() * K.detectEvery, revealT: Math.random() * K.revealEvery,
      healT: Math.random() * (c.healCd || 2), blastT: randRange(2, 5), lohUsed: false,
      disarmOk: new Set(), disarmFail: new Set(), abilityRetry: 0,
      // cohesion (and clerics tending the wounded)
      waitT: 0, waitCd: 0, tendT: 0, tending: false,
      // movement bookkeeping
      sx: 0, sy: 0, queueT: 0, pushT: 0, crowdT: 0, slot: null, tickX: h.x, tickY: h.y, netMove: 0,
      stuckWin: 0, stuckAcc: 0, stuckN: 0, lastPX: h.x, lastPY: h.y,
      // anti-stall / route commitment / teleport loops
      switchT: -99, plainT: 0, stallWin: 0, stallT: 0, stallX: h.x, stallY: h.y, stalls: 0,
      intentState: '', intentGk: '', intentT: 0,
      teleports: 0, gaveUp: false, blinkT: -99,
      wdT: 0, wdX: h.x, wdY: h.y, wdStrikes: 0, noHealer: false,
    };
    h.ai = ai;
    ai.cost = makeCost(h);
    return ai;
  }

  function updateRush(h) {
    const ai = h.ai;
    if (ai.escaping || ai.retreating || ai.gaveUp) { ai.rushing = false; return; }
    if (!ai.rushing && ai.hd <= K.rushDist) {
      ai.rushing = true;
      if (h.lure && !h.channel) releaseLure(h);
      if (ai.engage && ai.engageKind !== 'taunt') clearEngage(h);
      h.path = null; ai.repathT = 0;               // replan ignoring danger & traps
    } else if (ai.rushing && ai.hd > K.rushExit) {
      ai.rushing = false; ai.atHeart = false; ai.slot = null;
      h.path = null; ai.repathT = 0;
    }
  }

  function updateRetreat(h) {
    const ai = h.ai;
    if (h.boss || ai.escaping || ai.gaveUp) { ai.retreating = false; return; }
    if (!ai.retreating) {
      if (!ai.rushing && !ai.atHeart && h.hp < K.retreatPct * h.maxHp && ai.hd > K.retreatMinDist) {
        ai.retreating = true;
        releaseLure(h);
        cancelChannel(h);
        if (ai.engage && ai.engageKind !== 'block' && ai.engageKind !== 'taunt') clearEngage(h);
        ai.healerT = 0; ai.healer = null; ai.healerLost = false;
        h.path = null; ai.repathT = 0;
        FX.text(h.x, h.y - 1, 'Fall back!', '#ffd0a0', { size: 10 });
      }
    } else if (h.hp > K.recoverPct * h.maxHp) {
      ai.retreating = false; ai.healer = null;
      h.path = null; ai.repathT = 0;
      FX.text(h.x, h.y - 1, 'Onward!', '#c8ffc8', { size: 10 });
    }
  }

  /**
   * Cleric: hold position while a wounded ally falls back to us to be healed
   * (capped, so a cleric never waits forever).
   */
  function tendWounded(h, dt) {
    const ai = h.ai;
    let need = false;
    for (const o of S.heroes) {
      if (o === h || !alive(o) || !o.ai || !o.ai.retreating || o.ai.healer !== h) continue;
      const dx = o.x - h.x, dy = o.y - h.y;
      if (dx * dx + dy * dy <= K.tendR * K.tendR) { need = true; break; }
    }
    if (!need) { ai.tendT = 0; return false; }
    ai.tendT += dt;
    return ai.tendT < K.tendMax;
  }

  /** A party member that is marching with the group (not fleeing, retreating, escaping or rushing). */
  function followable(o) {
    return !!o.ai && !o.ai.retreating && !o.ai.escaping && !o.ai.gaveUp && !o.ai.rushing && o.st.fearT <= 0 && isFinite(o.ai.hd);
  }

  /** Should this party member stop and wait for the others? */
  function cohesionWait(h, dt) {
    const ai = h.ai, p = h.party;
    if (!p || ai.waitCd > 0) return false;
    const L = p.leader;
    let wait = false, max = 0;
    if (L && L !== h) {
      if (alive(L) && followable(L) && isFinite(ai.hd) && ai.hd < L.ai.hd - K.memberAhead) { wait = true; max = K.memberWaitMax; }
    } else if (L === h && isFinite(ai.hd)) {
      for (const o of p.members) {
        if (o !== h && alive(o) && followable(o) && o.ai.hd > ai.hd + K.leaderBehind) { wait = true; break; }
      }
      max = K.leaderWaitMax;
    }
    if (!wait) { ai.waitT = 0; return false; }
    ai.waitT += dt;
    if (ai.waitT > max) { ai.waitT = 0; ai.waitCd = L === h ? K.leaderWaitCd : K.memberWaitCd; return false; }
    return true;
  }

  function fleeTick(h, dt) {
    const ai = h.ai;
    if (!ai.fleeing) {
      ai.fleeing = true;
      cancelChannel(h); releaseLure(h); clearEngage(h);
      ai.atHeart = false;
      h.path = null; ai.repathT = 0;
    }
    if (onEntrance(h)) { Game.heroEscaped(h); return; }
    setGoal(h, S.entrance.x, S.entrance.y, 'flee');
    follow(h, speedOf(h, K.fleeSpeed), dt, 'flee');
  }

  function moveTick(h, c, dt) {
    const ai = h.ai;
    // Retreating (to a healer or out) / escaping with treasure / giving up.
    if (ai.escaping || ai.retreating || ai.gaveUp) {
      if (ai.retreating && !ai.escaping && !ai.gaveUp) {
        if ((ai.healerT -= dt) <= 0) {
          ai.healerT = 0.5;
          // Sticky choice: keep a healer while it stays usable; re-acquire only well inside range.
          if (!healerUsable(h, ai.healer, K.healerSeekR + 3)) {
            const had = !!ai.healer;
            ai.healer = ai.noHealer ? null : findHealer(h, had || ai.healerLost ? K.healerSeekR - 2 : K.healerSeekR);
            if (had && !ai.healer) ai.healerLost = true;
          }
        }
        const hl = ai.healer;
        if (hl && alive(hl)) {
          // Standing by the healer (not "anchored": allies can jostle past a field hospital).
          if (dist(h.x, h.y, hl.x, hl.y) <= 1.3) { faceToward(h, hl.x); opportunistic(h, c); return; }
          setGoal(h, Math.floor(hl.x), Math.floor(hl.y), 'healer', true);
          follow(h, speedOf(h, 1), dt, 'exit');
          opportunistic(h, c);
          return;
        }
      }
      if (onEntrance(h)) { Game.heroEscaped(h); return; }
      setGoal(h, S.entrance.x, S.entrance.y, 'exit');
      follow(h, speedOf(h, 1), dt, 'exit');
      opportunistic(h, c);
      return;
    }
    // Greedy detour.
    if (h.lure) { lureTick(h, c, dt); return; }
    // Advance / rush on the party goal (the Heart).
    const hx = Heart.cx(), hy = Heart.cy(), dh = dist(h.x, h.y, hx, hy);
    if (dh <= K.heartReachRanged) {
      const reach = heartReachOf(h, c, dh);
      if (dh <= reach) { ai.atHeart = true; ai.heartR = reach; ai.slot = null; heartTick(h, c); return; }
    }
    if (!ai.rushing) {
      if (greedTick(h, c)) return;
      if (h.type === 'mage' && ai.blastT <= 0 && blastEvalFree && tryBlast(h, c)) return;
      // Idle waits are soft (not "anchored"): whoever comes through can nudge us aside.
      if (h.type === 'cleric' && tendWounded(h, dt)) { ai.waiting = true; ai.tending = true; opportunistic(h, c); return; }
      if (cohesionWait(h, dt)) { ai.waiting = true; opportunistic(h, c); return; }
    }
    const g = (h.party && h.party.goal) || S.heart;
    const spd = speedOf(h, 1);
    if (ai.slot) setGoal(h, ai.slot.x, ai.slot.y, 'slot');
    else setGoal(h, g.x, g.y, 'heart');
    follow(h, spd, dt, 'walk');
    if (ai.rushing && dh <= K.slotSeekR) heartCrowd(h, dt, spd, dh);
    else { ai.crowdT = 0; ai.slot = null; }
    opportunistic(h, c);
  }

  /**
   * The Heart is mobbed: a rushing hero making no net progress first walks round
   * to a free tile beside the Heart; failing that it strikes over its allies'
   * shoulders from where it stands (never shoves forever).
   */
  function heartCrowd(h, dt, spd, dh) {
    const ai = h.ai;
    const stalled = (ai.wantMove && ai.netMove < spd * dt * 0.35) || ai.queueT > 0;
    ai.crowdT = stalled ? ai.crowdT + dt : 0;
    if (ai.slot) {
      const arrived = h.path && h.pathIdx >= h.path.length && ai.gk === 'slot' && !ai.noPath;
      if (arrived || (ai.crowdT > 0.8 && dh <= K.heartCrowdReach)) {
        ai.atHeart = true; ai.heartR = Math.max(K.heartReach, dh); ai.slot = null; ai.crowdT = 0;
      } else if (ai.noPath || ai.crowdT > 0.8) { ai.slot = null; ai.crowdT = 0; }
      return;
    }
    if (ai.crowdT < 0.3) return;
    const s = pickHeartSlot(h);
    if (s) { ai.slot = s; ai.crowdT = 0; }
    else if (dh <= K.heartCrowdReach) { ai.atHeart = true; ai.heartR = Math.max(K.heartReach, dh); ai.crowdT = 0; }
  }

  /** A free, reachable tile around the Heart (orthogonal ones preferred), or null. */
  function pickHeartSlot(h) {
    let bx = -1, by = -1, bs = Infinity;
    for (let d = 0; d < 8; d++) {
      const x = S.heart.x + DIRS8[d][0], y = S.heart.y + DIRS8[d][1];
      if (Grid.isSolid(x, y) || Grid.barricadeAt(x, y) || !isFinite(Path.heartDist(x, y))) continue;
      let taken = false;
      for (const o of S.heroes) {
        if (o !== h && alive(o) && Math.abs(o.x - x - 0.5) < 0.6 && Math.abs(o.y - y - 0.5) < 0.6) { taken = true; break; }
      }
      if (taken) continue;
      const s = Math.abs(x + 0.5 - h.x) + Math.abs(y + 0.5 - h.y) + (d >= 4 ? 0.5 : 0);
      if (s < bs) { bs = s; bx = x; by = y; }
    }
    return bx < 0 ? null : { x: bx, y: by };
  }

  function deriveState(h) {
    const ai = h.ai;
    if (h.st.stunT > 0) return 'stunned';
    if (h.st.fearT > 0) return 'fear';
    if (h.channel) return h.channel.kind;   // 'loot' | 'disarm' | 'blast' | 'dig'
    if (ai.engage) return 'fight';
    if (ai.atHeart) return 'heart';
    if (ai.escaping) return 'escape';
    if (ai.retreating || ai.gaveUp) return 'retreat';
    if (h.lure) return 'loot';
    if (ai.rushing) return 'rush';
    return 'advance';
  }

  /** One simulation step of one living hero. */
  function tickHero(h, dt) {
    const ai = h.ai || initAI(h);
    const c = clsOf(h), st = h.st;
    // ---- timers
    if (h.atkT > 0) h.atkT -= dt;
    ai.thinkT -= dt; ai.repathT -= dt; ai.lureT -= dt; ai.scanT -= dt;
    if (ai.waitCd > 0) ai.waitCd -= dt;
    if (ai.pushT > 0) ai.pushT -= dt;
    if ((ai.slipT -= dt) <= 0) { ai.slipT = K.slipEvery; ai.slip = chance(K.slipChance); }
    if (ai.plainT > 0) ai.plainT -= dt;
    if (h.boss && h.abilityT > 0) h.abilityT = Math.max(0, h.abilityT - dt);
    ai.anchored = false; ai.wantMove = false; ai.waiting = false; ai.tending = false; ai.charging = false; ai.smash = null;
    h.moving = false;
    ai.netMove = Math.hypot(h.x - ai.tickX, h.y - ai.tickY);   // last step's net motion (incl. shoves)
    ai.tickX = h.x; ai.tickY = h.y;
    if (ai.netMove > 2 && onEntrance(h) && S.time - ai.blinkT > 0.1) onTeleported(h);
    ensureOpen(h);
    ai.hd = Path.heartDist(h.x, h.y);

    // ---- incapacitated / terrified
    if (st.stunT > 0) { cancelChannel(h); ai.anchored = true; h.state = 'stunned'; return; }
    if (st.fearT > 0) { fleeTick(h, dt); h.state = 'fear'; if (alive(h)) { stuckCheck(h, dt); stallCheck(h, dt); watchdog(h, dt); } return; }
    if (ai.fleeing) { ai.fleeing = false; h.path = null; ai.repathT = 0; }

    // ---- strategy, passive kits, engagement
    updateRush(h);
    updateRetreat(h);
    kitTick(h, c, dt);
    engageTick(h, c);

    // ---- act
    if (h.channel) channelTick(h, c, dt);
    else if (ai.engage) fightTick(h, c, dt);
    else if (ai.atHeart) heartTick(h, c);
    else moveTick(h, c, dt);

    if (alive(h)) { h.state = deriveState(h); stuckCheck(h, dt); stallCheck(h, dt); watchdog(h, dt); }
  }

  function promote(p) {
    let best = null, bs = -Infinity;
    for (const m of p.members) {
      m.leader = false;
      if (!alive(m) || (m.ai && (m.ai.escaping || m.ai.gaveUp))) continue;
      const s = (m.boss ? 1000 : 0) + (LEADER_RANK[m.type] || 0) * 10 + (m.elite ? 5 : 0) + Math.min(4, m.maxHp / 1000);
      if (s > bs) { bs = s; best = m; }
    }
    p.leader = best;
    if (best) best.leader = true;
    return best;
  }

  /* ---------------------------------------------------------------------------
   * 15. PUBLIC API
   * ------------------------------------------------------------------------ */
  /**
   * Create (but don't place/push) a hero. opts: { elite, boss }.
   * Hero bosses use their HERO_BOSSES[boss].base class.
   */
  function create(cls, opts = {}) {
    const bossId = opts.boss && HERO_BOSSES[opts.boss] ? opts.boss : null;
    if (bossId) cls = HERO_BOSSES[bossId].base;
    if (!HERO_CLASSES[cls]) cls = 'warrior';
    const c = HERO_CLASSES[cls];
    const w = Math.max(1, S.wave || 1);
    // Wave scaling: core's heroWaveScale (linear + gentle compounding, shared with the UI preview).
    const sc = typeof heroWaveScale === 'function' ? heroWaveScale(w)
      : { hp: 1 + CFG.heroHpPerWave * (w - 1), dmg: 1 + CFG.heroDmgPerWave * (w - 1) };
    let hpM = sc.hp, dmgM = sc.dmg, spdM = 1;
    const elite = !!opts.elite;
    if (elite) { hpM *= CFG.eliteHpMul; dmgM *= CFG.eliteDmgMul; spdM *= CFG.eliteSpeedMul; }
    if (bossId) { const b = HERO_BOSSES[bossId]; hpM *= b.hpMul; dmgM *= b.dmgMul; spdM *= b.speedMul; }
    if (hasPerk('midas')) hpM *= 1.2;
    const h = makeEntity('hero', cls, S.entrance.x + 0.5, S.entrance.y + 0.5);
    h.maxHp = h.hp = Math.max(1, Math.round(c.hp * hpM));
    h.dmg = c.dmg * dmgM;
    h.heartDmg = Math.max(1, Math.round(c.heartDmg * dmgM));
    h.healAmt = c.healAmt ? c.healAmt * dmgM : 0;
    h.speed = c.speed * spdM;
    h.atkCd = c.atkCd;
    h.atkT = Math.random() * c.atkCd * 0.5;
    h.range = c.range;
    h.name = bossId ? HERO_BOSSES[bossId].name : pickName(cls);
    h.elite = elite;
    h.boss = bossId;
    h.party = null;
    h.leader = false;
    h.state = 'advance';
    h.loot = 0;
    h.lure = null;
    h.channel = null;
    h.abilityCd = bossId ? HERO_BOSSES[bossId].abilityCd : 0;
    h.abilityT = bossId ? h.abilityCd * 0.5 : 0;
    h.abilityName = bossId ? HERO_BOSSES[bossId].ability : null;
    h.escaped = false;
    h.moving = false;
    h.smart = heroSmartness(h.elite);
    initAI(h);
    return h;
  }

  /** Spawn a party at the entrance. specs: [{cls, elite, boss}] (or class-id strings). */
  function spawnParty(specs) {
    if (!S || !Array.isArray(specs) || !specs.length) return null;
    const party = { id: ++partySeq, members: [], leader: null, goal: { x: S.heart.x, y: S.heart.y } };
    const ex = S.entrance.x + 0.5, ey = S.entrance.y + 0.5;
    for (const sp of specs) {
      const spec = typeof sp === 'string' ? { cls: sp } : (sp || {});
      const h = create(spec.cls, spec);
      h.x = ex + randRange(-0.12, 0.12);
      h.y = ey + randRange(-0.12, 0.12);
      h.ai.lastPX = h.x; h.ai.lastPY = h.y; h.ai.anchorX = h.x; h.ai.anchorY = h.y;
      h.party = party;
      party.members.push(h);
      S.heroes.push(h);
    }
    promote(party);
    S.parties.push(party);
    if (S.ws) S.ws.spawned += party.members.length;
    FX.burst(ex + 0.3, ey, { n: 14, colors: ['#9fe8ff', '#ffffff', '#6fb0ff'], speed: 2, life: 0.6, size: 2, dir: [1, 0], spread: 1.6 });
    return party;
  }

  /** Advance every living hero by one simulation step. */
  function update(dt) {
    if (!S || !S.heroes || !S.heroes.length) return;
    budget = K.astarBudget;
    blastEvalFree = true;
    refreshField();
    for (const p of S.parties) {
      const L = p && p.leader;
      if (p && p.members && (!L || !alive(L) || (L.ai && (L.ai.escaping || L.ai.gaveUp)))) promote(p);
    }
    const hs = S.heroes;
    for (let i = 0; i < hs.length; i++) { const h = hs[i]; if (alive(h)) tickHero(h, dt); }
    separate();
    for (let i = 0; i < hs.length; i++) { const h = hs[i]; if (alive(h)) ensureOpen(h); }
  }

  function onWaveStart() {
    partySeq = 0;
    usedNames.clear();
    field = null; fieldSig = NaN; fieldPathVer = -1;
    lureCache = null; lureCacheT = -1;
  }

  function onWaveEnd() {
    for (const s of S.structs) if (s.cat === 'object' && s.id === 'chest' && s.data) s.data.claimedBy = null;
    for (const h of S.heroes) { h.channel = null; h.lure = null; }
    S.parties = [];
    usedNames.clear();
    lureCache = null;
  }

  /** Core calls this after a hero died: free its claims and pass on the leadership. */
  function onDeath(h) {
    if (!h) return;
    if (h.ai) { releaseLure(h); clearEngage(h); }
    h.channel = null;
    const p = h.party;
    if (p && p.leader === h) promote(p);
  }

  /**
   * Paladin's Lay on Hands: a living Paladin within 4 tiles that hasn't used it
   * this wave saves the dying hero (itself included) at lohPct × maxHp.
   * @returns true if the death was prevented.
   */
  function preventDeath(h) {
    if (!S || !h || h.team !== 'hero' || h.dead) return false;
    let best = null, bd = K.lohRange * K.lohRange;
    for (const p of S.heroes) {
      if (p.type !== 'paladin' || !alive(p) || !p.ai || p.ai.lohUsed) continue;
      const dx = p.x - h.x, dy = p.y - h.y, d2 = dx * dx + dy * dy;
      if (d2 <= bd) { bd = d2; best = p; }
    }
    if (!best) return false;
    best.ai.lohUsed = true;
    h.hp = Math.max(1, Math.round(h.maxHp * (HERO_CLASSES.paladin.lohPct || 0.5)));
    h.st.burnT = 0; h.st.bleedT = 0;   // the saved hero is also purged of lingering wounds
    if (best !== h) FX.beam(best.x, best.y - 0.4, h.x, h.y - 0.2, { color: '#ffe680', width: 4, life: 0.5 });
    FX.ring(h.x, h.y, { color: '#ffe680', r0: 0.2, r1: 1.4, life: 0.6, width: 4 });
    FX.burst(h.x, h.y - 0.2, { n: 24, colors: ['#ffe680', '#ffffff', '#fff3a0'], speed: 2.4, life: 0.8, size: 2.5, grav: -3, glow: true });
    FX.text(h.x, h.y - 1.2, 'Lay on Hands!', '#ffe680', { size: 12 });
    SFX.play('heal');
    best.animT = 0.4;
    return true;
  }

  /** Friendly description of what the hero is doing (tooltips / inspector). */
  function stateLabel(h) {
    if (!h) return '';
    if (h.escaped) return h.loot > 0 ? 'Escaped with treasure' : 'Escaped';
    if (h.dead) return 'Slain';
    const ai = h.ai || {};
    switch (h.state) {
      case 'advance':
        if (ai.smash) return 'Smashing a barricade';
        if (ai.tending) return 'Tending the wounded';
        if (ai.waiting) return h.leader ? 'Waiting for the party' : 'Waiting for the leader';
        if (h.loot > 0) return 'Hauling treasure to the Heart';
        return h.leader ? 'Leading the party' : 'Advancing';
      case 'loot': return h.channel ? 'Looting a chest' : 'Heading for treasure';
      case 'fight': {
        const m = ai.engage || h.target;
        const who = m ? monsterName(m) : '';
        if (ai.engageKind === 'taunt') return `Taunted by ${who}`;
        if (ai.charging) return `Charging ${who}`;
        return who ? `Fighting ${who}` : 'Fighting';
      }
      case 'retreat':
        if (ai.gaveUp) return 'Giving up on this cursed maze';
        return ai.healer && alive(ai.healer) ? 'Falling back to the healer' : 'Retreating to the exit';
      case 'dig': return h.channel && h.channel.rubble ? 'Clawing through rubble' : 'Digging through a wall';
      case 'disarm': return h.channel && h.channel.jam ? 'Jamming the teleporter' : LABELS.disarm;
      case 'rush': return ai.smash ? 'Smashing a barricade' : LABELS.rush;
      default:
        return LABELS[h.state] || (h.state ? h.state.charAt(0).toUpperCase() + h.state.slice(1) : 'Advancing');
    }
  }

  /** The weighted A* cost function this hero uses right now ((x,y,idx) → cost). */
  function costFn(h) {
    if (!h || !S) return Path.baseCost;
    const ai = h.ai || initAI(h);
    refreshField();
    prepCost(h, ai.gk || 'heart');
    return ai.cost;
  }

  return { create, spawnParty, update, onWaveStart, onWaveEnd, onDeath, preventDeath, stateLabel, costFn };
})();
