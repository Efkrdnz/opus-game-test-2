/* =============================================================================
 *  30 TRAPS & OBJECTS — everything the Dungeon Master bolts to the floor.
 *
 *    Traps    — the eight traps: triggering, cooldowns, upgrade levels, perks,
 *               hidden / revealed / disarmed / broken handling, and their juice
 *               (particles, rings, callouts, sounds, screen shake, s.animT).
 *    Objects  — treasure chests, torches, barricades, mana wells, monster lairs.
 *
 *  Both act only during waves (Game.update calls update(dt) in the wave phase)
 *  and only ever harm heroes. Per-structure runtime state lives in `s.data`;
 *  the fields documented in docs/SPEC.md §3.2 are read by Render and UI.
 * ========================================================================== */

/* -----------------------------------------------------------------------------
 * 1. TRAPS
 * -------------------------------------------------------------------------- */
const Traps = (() => {
  /* ---- 1.1 Tuning ---------------------------------------------------------- */
  const FLAME_TIME = 1.5;        // seconds a Fire Vent's flame column burns (data.flameT)
  const ALARM_RING = 1.6;        // seconds an Alarm Rune keeps ringing (data.ringT)
  const ALARM_BUFF_DMG = 1.5;    // what Monsters.alarm grants (shown in tooltips)
  const ALARM_BUFF_SPD = 1.3;
  const ARROW_SPEED = 12;        // tiles/s
  const ECHO_DELAY = 0.25;       // Echoing Halls: delay before the second volley
  const BOULDER_SPEED = 7;
  const BOULDER_RADIUS = 0.45;
  const BOULDER_STUN = 0.5;
  const BOULDER_KNOCK = 0.4;     // tiles a crushed hero is shoved along the roll
  const BOULDER_MAX_ROLL = 12;   // safety: a boulder can't be "rolling" longer than this
  const PIT_STUN = 1.5;
  const PIT_REARM = 8;           // Trapmaster
  const TELEPORT_STUN = 0.5;
  const BLEED_DPS = 4;           // Rusted Blades
  const BLEED_DUR = 4;
  const SLIME_TOUCH_CD = 3;      // slime counts as "triggered" (danger, sound) at most this often
  const TRIGGER_DANGER = 3;      // danger memory added at a trap each time it fires / is revealed
  const HIT_DANGER = 1;          // extra danger where an arrow or boulder strikes a hero
  /** Hero states a Teleporter Pad ignores (they are already heading out). */
  const NO_TELEPORT = { retreat: true, escape: true, fear: true };

  /** Damage sources, one per trap (shared; kind/id feed the kill & damage stats). */
  const SRC = {};
  for (const id of Object.keys(TRAPS)) SRC[id] = { team: 'dm', kind: 'trap', id, elem: id === 'fire' ? 'fire' : 'phys' };
  /** The pit's instant kill prints its own callout instead of a huge damage number. */
  const SRC_SWALLOW = { team: 'dm', kind: 'trap', id: 'pit', elem: 'phys', noText: true };

  /* ---- 1.2 FX palettes & reusable option objects ---------------------------
   * Emitters that run every tick reuse these objects, so the hot loop makes
   * no garbage beyond the particles themselves.                              */
  const C = {
    steel: ['#e4e8ef', '#a8b0bd', '#6b7380'],
    blood: ['#a0101a', '#d02030', '#6a0810'],
    dust: ['#8a7f70', '#6b6259', '#a89c8a'],
    rubble: ['#6b6378', '#4a4453', '#8a8296', '#c9b99a'],
    fire: ['#ffe066', '#ffb347', '#ff6a1f', '#e8401a'],
    slime: ['#7ddc4a', '#4fae2a', '#b6f07a'],
    pit: ['#1a1418', '#3a2e2a', '#5a4a40', '#2a2024'],
    tele: ['#b48cff', '#7fe8ff', '#ffffff', '#8a5cff'],
    reset: ['#9fe8ff', '#ffffff', '#6fc8ff'],
    disarm: ['#9fe8ff', '#d8dde6', '#6b7380'],
    crush: ['#a0101a', '#d02030', '#8a7f70', '#6b6259'],
  };
  const FX_FLAME_CORE = { n: 2, colors: C.fire, dir: [0, -1], spread: 0.9, speed: 2.8, life: 0.5, size: 2.8, grav: -6, drag: 1, glow: true, jitter: 0.5 };
  const FX_FLAME_SIDE = { n: 1, colors: C.fire, dir: [0, -1], spread: 1.2, speed: 1.8, life: 0.4, size: 2.2, grav: -5, drag: 1, glow: true, jitter: 0.7 };
  const FX_GOO = { n: 1, colors: C.slime, speed: 0.6, life: 0.5, size: 2, grav: 2, jitter: 0.4 };
  const FX_TRAIL = { n: 1, colors: C.dust, speed: 0.7, life: 0.55, size: 2.4, grav: -0.8, jitter: 0.35 };
  const SLOW_OPT = { amt: 0, dur: 0 };
  const BURN_OPT = { dps: 0, dur: 0, src: SRC.fire };
  const BLEED_OPT = { dps: BLEED_DPS, dur: BLEED_DUR, src: SRC.spike };

  /* ---- 1.3 Numbers (level + perks) -----------------------------------------
   * These are the values the simulation uses. Glass Cannon (+40% trap damage)
   * is applied by core Combat.damage, so it only shows up in stats().        */
  /** Per-level value: arrays are [L1, L2, L3]; scalars apply to every level. */
  const lv = (v, L) => (Array.isArray(v) ? v[L >= 3 ? 2 : L >= 2 ? 1 : 0] : v);
  function cooldown(id, L) {
    let c = lv(TRAPS[id].cd, L) || 0;
    if (id === 'arrow' && hasPerk('quick_reload')) c *= 0.7;
    if (id === 'boulder' && hasPerk('stonemason')) c *= 0.75;
    if (hasPerk('trapmaster')) c *= 0.8;
    return c;
  }
  function damage(id, L) {
    let v = lv(TRAPS[id].dmg, L) || 0;
    if ((id === 'spike' || id === 'pit') && hasPerk('whetstone')) v *= 1.4;
    return v;
  }
  const reach = (id, L) => lv(TRAPS[id].range, L) || 0;
  const killHp = L => lv(TRAPS.pit.killHp, L) * (hasPerk('whetstone') ? 1.4 : 1);
  const slowAmt = L => Math.min(0.9, lv(TRAPS.slime.slow, L) + (hasPerk('sticky') ? 0.15 : 0));
  const lingerDur = () => TRAPS.slime.linger + (hasPerk('sticky') ? 2 : 0);
  const burnDps = L => lv(TRAPS.fire.burn, L) + (hasPerk('kindling') ? 3 : 0);
  const burnDur = () => TRAPS.fire.burnDur + (hasPerk('kindling') ? 3 : 0);
  const isHiddenType = id => !!TRAPS[id].hidden || hasPerk('hidden_depths');

  /**
   * Effective numbers for a trap at a level, with every active perk applied
   * (including Glass Cannon on damage). Used by the build panel, the upgrade
   * preview and tooltips. Damage values are rounded like Combat rounds them.
   */
  function stats(id, level) {
    if (!TRAPS[id]) return {};
    const L = level || 1;
    const g = hasPerk('glass_cannon') ? 1.4 : 1;
    const r2 = v => Math.round(v * 100) / 100;
    const hidden = isHiddenType(id);
    switch (id) {
      case 'spike': {
        const bleed = hasPerk('rusted_blades');
        return { dmg: Math.round(damage(id, L) * g), cd: r2(cooldown(id, L)), bleed: bleed ? Math.round(BLEED_DPS * g) : 0, bleedDur: bleed ? BLEED_DUR : 0, hidden };
      }
      case 'arrow':
        return { dmg: Math.round(damage(id, L) * g), cd: r2(cooldown(id, L)), range: reach(id, L), volleys: hasPerk('echoing_halls') ? 2 : 1, hidden };
      case 'pit':
        return { killHp: Math.round(killHp(L)), dmg: Math.round(damage(id, L) * g), stun: PIT_STUN, rearm: hasPerk('trapmaster') ? PIT_REARM : 0, oneUse: true, hidden };
      case 'slime':
        return { slow: r2(slowAmt(L)), linger: lingerDur(), hidden };
      case 'fire':
        return { burn: Math.round(burnDps(L) * g), burnDur: burnDur(), cd: r2(cooldown(id, L)), flame: FLAME_TIME, radius: 1, hidden };
      case 'alarm':
        return { radius: lv(TRAPS.alarm.radius, L), buffDur: lv(TRAPS.alarm.buffDur, L), cd: r2(cooldown(id, L)), buffDmg: ALARM_BUFF_DMG, buffSpd: ALARM_BUFF_SPD, hidden };
      case 'boulder':
        return { dmg: Math.round(damage(id, L) * g), cd: r2(cooldown(id, L)), range: reach(id, L), stun: BOULDER_STUN, speed: BOULDER_SPEED, hidden };
      case 'teleport':
        return { cd: r2(cooldown(id, L)), stun: TELEPORT_STUN, hidden };
      default:
        return {};
    }
  }

  /* ---- 1.4 Hero occupancy ---------------------------------------------------
   * Rebuilt once per tick: a per-tile linked list of living heroes (head[] per
   * tile, next[] per hero). Every trap then asks "who is on tile (x,y)?" in
   * O(heroes on that tile) with no allocations — instead of each trap scanning
   * the whole hero list (Spatial.heroesOnTile) every tick.                   */
  const occ = { head: null, cols: 0, next: new Int32Array(128), list: [], touched: [] };

  function buildOcc() {
    const cols = S.cols, rows = S.rows, n = cols * rows;
    if (!occ.head || occ.head.length !== n || occ.cols !== cols) {
      occ.head = new Int32Array(n).fill(-1); // grid created or expanded
      occ.cols = cols;
      occ.touched.length = 0;
    } else {
      for (let i = 0; i < occ.touched.length; i++) occ.head[occ.touched[i]] = -1;
      occ.touched.length = 0;
    }
    const heroes = S.heroes;
    let k = 0;
    for (let i = 0; i < heroes.length; i++) {
      const h = heroes[i];
      if (h.dead || h.removed || h.escaped) continue;
      const tx = Math.floor(h.x), ty = Math.floor(h.y);
      if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) continue;
      if (k >= occ.next.length) { const grown = new Int32Array(occ.next.length * 2); grown.set(occ.next); occ.next = grown; }
      const ti = ty * cols + tx;
      if (occ.head[ti] < 0) occ.touched.push(ti);
      occ.next[k] = occ.head[ti];
      occ.head[ti] = k;
      occ.list[k] = h;
      k++;
    }
    for (let i = k; i < occ.list.length; i++) occ.list[i] = null; // don't retain departed heroes
  }
  /** Index of the first hero bucketed on tile (x,y), or -1. Walk on with occ.next[k]. */
  function firstOn(x, y) {
    if (x < 0 || y < 0 || x >= S.cols || y >= S.rows) return -1;
    return occ.head[y * S.cols + x];
  }
  /** Still alive and still on that tile? (A trap earlier this tick may have killed or moved it.) */
  function liveOn(h, x, y) {
    return !h.dead && !h.removed && !h.escaped && Math.floor(h.x) === x && Math.floor(h.y) === y;
  }
  function anyOn(x, y) {
    for (let k = firstOn(x, y); k >= 0; k = occ.next[k]) if (liveOn(occ.list[k], x, y)) return true;
    return false;
  }

  /* ---- 1.5 Shared trigger helpers ----------------------------------------- */
  /** Every trigger: animate, reveal the trap and teach the heroes to fear this tile. */
  function markTriggered(s, anim) {
    s.animT = Math.max(s.animT || 0, anim);
    if (s.hidden && !s.revealed) FX.text(s.x + 0.5, s.y + 0.05, '!', '#ffd84a', { size: 15, life: 0.8 });
    s.revealed = true;
    Danger.add(s.x, s.y, TRIGGER_DANGER, 0);
    s.data.hits = (s.data.hits || 0) + 1;
  }

  const scan = { dx: 0, dy: 0 }; // direction of the last scanLines() hit
  /**
   * Look down the 4 straight lines from a trap's tile, through open tiles only,
   * up to R tiles. Returns the nearest living, visible hero standing on one of
   * those lines (and sets scan.dx/dy), or null. Boulders are also stopped by
   * standing barricades.
   */
  function scanLines(s, R, stopAtBarricade) {
    const cx = s.x + 0.5, cy = s.y + 0.5;
    let best = null, bd = Infinity;
    for (let d = 0; d < 4; d++) {
      const dx = DIRS4[d][0], dy = DIRS4[d][1];
      for (let i = 1; i <= R; i++) {
        const x = s.x + dx * i, y = s.y + dy * i;
        if (Grid.isSolid(x, y)) break;
        if (stopAtBarricade && Grid.barricadeAt(x, y)) break;
        let found = false;
        for (let k = firstOn(x, y); k >= 0; k = occ.next[k]) {
          const h = occ.list[k];
          if (!liveOn(h, x, y) || h.st.invisT > 0) continue; // aimed traps can't see Shadowstep
          found = true;
          const ddx = h.x - cx, ddy = h.y - cy, dd = ddx * ddx + ddy * ddy;
          if (dd < bd) { bd = dd; best = h; scan.dx = dx; scan.dy = dy; }
        }
        if (found) break; // anything further down this line is farther away
      }
    }
    return best;
  }

  /** The direction an Arrow Wall initially faces: its first open neighbour. */
  function facing(s) {
    for (const [dx, dy] of DIRS4) if (!Grid.isSolid(s.x + dx, s.y + dy)) return [dx, dy];
    return [1, 0];
  }

  /* ---- 1.6 Trap behaviours --------------------------------------------------
   * tickX(s) runs only while the trap is armed (not broken, not disarmed).   */

  /** Spike: impale everyone on the tile; Rusted Blades adds a bleed. */
  function tickSpike(s) {
    if (s.cd > 0) return;
    const x = s.x, y = s.y, dmg = damage('spike', s.level), bleed = hasPerk('rusted_blades');
    let n = 0;
    for (let k = firstOn(x, y); k >= 0; k = occ.next[k]) {
      const h = occ.list[k];
      if (!liveOn(h, x, y)) continue;
      n++;
      Combat.damage(h, dmg, SRC.spike);
      if (bleed && !h.dead) Status.apply(h, 'bleed', BLEED_OPT);
      FX.burst(h.x, h.y - 0.1, { n: 6, colors: C.blood, dir: [0, -1], spread: 2.2, speed: 2.2, life: 0.45, size: 2, grav: 7 });
    }
    if (!n) return;
    s.cd = cooldown('spike', s.level);
    markTriggered(s, 0.45);
    FX.burst(x + 0.5, y + 0.7, { n: 12, colors: C.steel, dir: [0, -1], spread: 0.9, speed: 3.4, life: 0.35, size: 1.8, grav: 9, jitter: 0.6 });
    SFX.play('spike');
  }

  /** Arrow Wall: shoot the nearest hero on any of its 4 lines (plus an echo volley). */
  function tickArrow(s, dt) {
    const d = s.data;
    if (d.echoT > 0) {
      d.echoT -= dt;
      if (d.echoT <= 0) {
        d.echoT = 0;
        const h = scanLines(s, reach('arrow', s.level), false);
        if (h) fireArrow(s, h, scan.dx, scan.dy);
        else if (d.lastDir) fireArrow(s, null, d.lastDir[0], d.lastDir[1]); // the echo still flies
      }
    }
    if (s.cd > 0) return;
    const h = scanLines(s, reach('arrow', s.level), false);
    if (!h) return;
    fireArrow(s, h, scan.dx, scan.dy);
    s.cd = cooldown('arrow', s.level);
    if (hasPerk('echoing_halls')) d.echoT = ECHO_DELAY;
    markTriggered(s, 0.35);
  }

  /**
   * Loose one straight arrow from the wall face along (dx,dy). It flies at the
   * target's lateral offset (clamped inside the corridor) so it stays in its
   * row/column and hits the first hero in its way.
   */
  function fireArrow(s, h, dx, dy) {
    let x, y;
    if (dx !== 0) { x = s.x + 0.5 + dx * 0.55; y = h ? clamp(h.y, s.y + 0.2, s.y + 0.8) : s.y + 0.5; }
    else { x = h ? clamp(h.x, s.x + 0.2, s.x + 0.8) : s.x + 0.5; y = s.y + 0.5 + dy * 0.55; }
    Proj.spawn({
      kind: 'arrow', x, y, dx, dy, team: 'dm', speed: ARROW_SPEED, radius: 0.4,
      dmg: damage('arrow', s.level), range: reach('arrow', s.level) + 0.2, src: SRC.arrow, onHit: arrowHit,
    });
    const d = s.data;
    if (d.lastDir) { d.lastDir[0] = dx; d.lastDir[1] = dy; } else d.lastDir = [dx, dy];
    s.animT = Math.max(s.animT || 0, 0.3);
    FX.burst(x, y, { n: 4, colors: C.dust, dir: [dx, dy], spread: 0.8, speed: 1.6, life: 0.3, size: 1.6 });
    SFX.play('arrow');
  }
  /** Projectile callback (called by Proj with this === the projectile). */
  function arrowHit(e, p) {
    const dealt = Combat.damage(e, p.dmg, p.src);
    FX.burst(e.x, e.y - 0.15, { n: 5, colors: C.blood, dir: [p.dx, p.dy], spread: 0.9, speed: 2.2, life: 0.35, size: 1.8, grav: 4 });
    if (dealt > 0) SFX.play('heroHit');
    Danger.add(e.x, e.y, HIT_DANGER, 0);
  }

  /** Pit: one use. Swallows weakened heroes whole; others fall in, get hurt and stunned. */
  function tickPit(s) {
    const x = s.x, y = s.y, L = s.level;
    let fell = 0;
    for (let k = firstOn(x, y); k >= 0; k = occ.next[k]) {
      const h = occ.list[k];
      if (!liveOn(h, x, y)) continue;
      const cls = HERO_CLASSES[h.type];
      if (cls && cls.pitImmune) { // Dwarf Miners know solid ground: they only spot it
        if (reveal(s, h)) FX.text(h.x, h.y - 0.9, 'Pit spotted', '#e8c070', { size: 9 });
        continue;
      }
      fell++;
      FX.burst(h.x, h.y, { n: 10, colors: C.pit, speed: 1.6, life: 0.6, size: 2.4, grav: 3 });
      if (!h.boss && h.hp <= killHp(L)) {
        FX.text(h.x, h.y - 1.4, 'Swallowed!', '#ff9a5a', { size: 13, life: 1.1 });
        Combat.damage(h, h.hp + 999, SRC_SWALLOW);
      } else {
        Combat.damage(h, damage('pit', L), SRC.pit);
        if (!h.dead) FX.text(h.x, h.y - 1.3, 'Fell in!', '#e8c070', { size: 10 });
      }
      if (!h.dead) Status.apply(h, 'stun', { dur: PIT_STUN }); // incl. anyone saved by Lay on Hands
    }
    if (!fell) return;
    s.broken = true;
    s.cd = 0;
    if (hasPerk('trapmaster')) s.data.rearmT = PIT_REARM;
    markTriggered(s, 0.6);
    FX.burst(x + 0.5, y + 0.5, { n: 26, colors: C.pit, speed: 2.8, life: 0.75, size: 2.8, grav: 5, jitter: 0.5 });
    FX.ring(x + 0.5, y + 0.5, { color: '#3a2e2a', r0: 0.2, r1: 1.1, life: 0.45, width: 3 });
    FX.shake(3);
    SFX.play('pit');
    Path.bump(); // an open pit is a structural change (Render may cache it)
  }
  /** Trapmaster: a triggered pit closes up again after PIT_REARM seconds. */
  function tickRearm(s, dt) {
    const d = s.data;
    d.rearmT -= dt;
    if (d.rearmT > 0) return;
    d.rearmT = 0;
    s.broken = false;
    s.animT = 0.5;
    FX.burst(s.x + 0.5, s.y + 0.5, { n: 12, colors: C.reset, speed: 1.6, life: 0.6, size: 2, grav: -2, glow: true });
    FX.text(s.x + 0.5, s.y - 0.05, 'Rearmed', '#9fe8ff', { size: 9 });
    SFX.play('click');
    Path.bump();
  }

  /** Slime: always on — everyone on it is slowed, refreshed every tick. */
  function tickSlime(s) {
    const x = s.x, y = s.y, d = s.data;
    SLOW_OPT.amt = slowAmt(s.level);
    SLOW_OPT.dur = lingerDur();
    let any = false;
    for (let k = firstOn(x, y); k >= 0; k = occ.next[k]) {
      const h = occ.list[k];
      if (!liveOn(h, x, y)) continue;
      any = true;
      Status.apply(h, 'slow', SLOW_OPT);
      if (Math.random() < 0.12) FX.burst(h.x, h.y + 0.25, FX_GOO);
    }
    if (!any || d.touchT > 0) return;
    d.touchT = SLIME_TOUCH_CD;
    markTriggered(s, 0.35);
    FX.burst(x + 0.5, y + 0.6, { n: 8, colors: C.slime, speed: 1.6, life: 0.5, size: 2.2, grav: 4, jitter: 0.5 });
    SFX.play('slime');
  }

  /** Fire Vent: erupts when stepped on — a 1.5 s flame column over the tile and its 4 neighbours. */
  function tickFire(s) {
    if (s.cd > 0 || !anyOn(s.x, s.y)) return;
    const cx = s.x + 0.5, cy = s.y + 0.5;
    s.data.flameT = FLAME_TIME;
    s.cd = cooldown('fire', s.level);
    markTriggered(s, 0.6);
    burnCross(s);
    FX.burst(cx, cy + 0.2, { n: 30, colors: C.fire, dir: [0, -1], spread: 1.4, speed: 4.2, life: 0.7, size: 3, grav: -4, glow: true, jitter: 0.4 });
    FX.ring(cx, cy, { color: '#ff8a3a', r0: 0.3, r1: 1.7, life: 0.4, width: 3 });
    FX.shake(2);
    SFX.play('fire');
  }
  /** While the column burns: keep everyone in the cross ablaze and pour out flames. */
  function tickFlames(s, dt) {
    const d = s.data;
    d.flameT = Math.max(0, d.flameT - dt);
    burnCross(s);
    FX.burst(s.x + 0.5, s.y + 0.65, FX_FLAME_CORE);
    // One tongue of flame per tick on a random arm of the cross (walls stay clean).
    const dir = DIRS4[(Math.random() * 4) | 0];
    const nx = s.x + dir[0], ny = s.y + dir[1];
    if (!Grid.isSolid(nx, ny)) FX.burst(nx + 0.5, ny + 0.7, FX_FLAME_SIDE);
  }
  function burnCross(s) {
    BURN_OPT.dps = burnDps(s.level);
    BURN_OPT.dur = burnDur();
    burnTile(s.x, s.y);
    for (let i = 0; i < 4; i++) burnTile(s.x + DIRS4[i][0], s.y + DIRS4[i][1]);
  }
  function burnTile(x, y) {
    for (let k = firstOn(x, y); k >= 0; k = occ.next[k]) {
      const h = occ.list[k];
      if (liveOn(h, x, y)) Status.apply(h, 'burn', BURN_OPT);
    }
  }

  /** Alarm Rune: enrage and summon every monster in range to the rune. */
  function tickAlarm(s) {
    if (s.cd > 0 || !anyOn(s.x, s.y)) return;
    const L = s.level, cx = s.x + 0.5, cy = s.y + 0.5, r = lv(TRAPS.alarm.radius, L);
    if (typeof Monsters !== 'undefined' && Monsters.alarm) Monsters.alarm(cx, cy, r, lv(TRAPS.alarm.buffDur, L));
    s.cd = cooldown('alarm', L);
    s.data.ringT = ALARM_RING;
    s.data.pulseT = 0;
    markTriggered(s, 0.6);
    FX.ring(cx, cy, { color: '#ff4040', r0: 0.3, r1: r, life: 0.9, width: 3 });
    FX.flashTile(s.x, s.y, '#ff3030', 0.6);
    FX.text(cx, s.y - 0.1, 'ALARM!', '#ff5a4a', { size: 13 });
    FX.shake(1.5);
    SFX.play('alarm');
  }
  /** While ringing: small pulsing rings (Render also reads data.ringT). */
  function tickRing(s, dt) {
    const d = s.data;
    d.ringT = Math.max(0, d.ringT - dt);
    d.pulseT -= dt;
    if (d.pulseT <= 0) {
      d.pulseT = 0.4;
      FX.ring(s.x + 0.5, s.y + 0.5, { color: '#ff6a4a', r0: 0.2, r1: 1.4, life: 0.4, width: 2 });
    }
  }

  /** Boulder (armed): roll at the first hero seen down a straight open line. */
  function tickBoulder(s) {
    if (!s.data.ready) return;
    const h = scanLines(s, reach('boulder', s.level), true);
    if (h) rollBoulder(s, scan.dx, scan.dy);
  }
  /** Boulder bookkeeping (always): dust trail, barricade stop, re-forming. */
  function tickBoulderState(s, dt) {
    const d = s.data;
    if (d.rolling) {
      const p = d.proj;
      d.rollT = (d.rollT || 0) + dt;
      if (!p || p.dead || d.rollT > BOULDER_MAX_ROLL) { d.rolling = false; d.proj = null; }
      else {
        if (Math.random() < 0.5) FX.burst(p.x - p.dx * 0.3, p.y + 0.3, FX_TRAIL);
        if (Grid.barricadeAt(Math.floor(p.x), Math.floor(p.y))) { p.dead = true; boulderEnd(p); } // crashes into it
      }
    }
    if (!d.ready && !d.rolling && s.cd <= 0) {
      d.ready = true;
      s.animT = Math.max(s.animT || 0, 0.4);
      FX.burst(s.x + 0.5, s.y + 0.55, { n: 14, colors: C.dust, speed: 1.4, life: 0.7, size: 3, grav: -0.8, jitter: 0.5 });
      FX.ring(s.x + 0.5, s.y + 0.5, { color: '#a89c8a', r0: 0.2, r1: 0.8, life: 0.35, width: 2 });
    }
  }
  function rollBoulder(s, dx, dy) {
    const d = s.data, L = s.level;
    d.proj = Proj.spawn({
      kind: 'boulder', x: s.x + 0.5, y: s.y + 0.5, dx, dy, team: 'dm', speed: BOULDER_SPEED,
      dmg: damage('boulder', L), radius: BOULDER_RADIUS, pierce: true, range: S.cols + S.rows,
      src: SRC.boulder, onHit: boulderHit, onEnd: boulderEnd, trap: s,
    });
    d.ready = false;
    d.rolling = true;
    d.rollT = 0;
    s.cd = cooldown('boulder', L); // re-form timer starts at launch
    markTriggered(s, 0.5);
    FX.burst(s.x + 0.5, s.y + 0.7, { n: 14, colors: C.dust, dir: [-dx, -dy], spread: 1.6, speed: 2.2, life: 0.6, size: 2.4, grav: 2 });
    FX.shake(2);
    SFX.play('boulder');
  }
  /** Crush: damage + stun + shove the hero a little along the roll (never into walls/barricades). */
  function boulderHit(e, p) {
    Combat.damage(e, p.dmg, p.src);
    FX.burst(e.x, e.y, { n: 10, colors: C.crush, dir: [p.dx, p.dy], spread: 1.3, speed: 3, life: 0.5, size: 2.2, grav: 6 });
    FX.shake(3);
    SFX.play('hit');
    Danger.add(e.x, e.y, HIT_DANGER, 0);
    if (e.dead) return;
    Status.apply(e, 'stun', { dur: BOULDER_STUN });
    const nx = e.x + p.dx * BOULDER_KNOCK, ny = e.y + p.dy * BOULDER_KNOCK;
    const tx = Math.floor(nx), ty = Math.floor(ny), t = Grid.tile(tx, ty);
    if (t && !Grid.isSolid(tx, ty) && t.type !== T.HEART && !Grid.barricadeAt(tx, ty)) {
      const moved = tx !== Math.floor(e.x) || ty !== Math.floor(e.y);
      e.x = nx; e.y = ny;
      if (moved) e.path = null; // new tile: let the hero re-plan from here
    }
  }
  /** The boulder smashes into the first solid tile (or a barricade) and breaks apart. */
  function boulderEnd(p) {
    const s = p.trap;
    if (s && s.data && s.data.proj === p) { s.data.rolling = false; s.data.proj = null; }
    const ex = p.x - p.dx * 0.5, ey = p.y - p.dy * 0.5;
    FX.burst(ex, ey, { n: 28, colors: C.rubble, speed: 3.6, life: 0.9, size: 3, grav: 7 });
    FX.burst(ex, ey, { n: 10, colors: C.dust, speed: 1.2, life: 1.0, size: 3.5, grav: -0.6, jitter: 0.5 });
    FX.shake(4);
    SFX.play('collapse');
  }

  /** Teleporter Pad: sends advancing heroes (bosses too) all the way back to the entrance. */
  function tickTeleport(s) {
    if (s.cd > 0) return;
    const x = s.x, y = s.y;
    let n = 0;
    for (let k = firstOn(x, y); k >= 0; k = occ.next[k]) {
      const h = occ.list[k];
      if (!liveOn(h, x, y) || NO_TELEPORT[h.state] || h.st.fearT > 0) continue;
      sendToEntrance(h);
      n++;
    }
    if (!n) return;
    s.cd = cooldown('teleport', s.level);
    markTriggered(s, 0.5);
    FX.ring(x + 0.5, y + 0.5, { color: '#b48cff', r0: 0.1, r1: 1.2, life: 0.45, width: 3 });
    SFX.play('teleport');
  }
  function sendToEntrance(h) {
    const ox = h.x, oy = h.y;
    const ex = S.entrance.x + 0.5 + randRange(-0.12, 0.12), ey = S.entrance.y + 0.5 + randRange(-0.12, 0.12);
    FX.burst(ox, oy, { n: 18, colors: C.tele, speed: 2.4, life: 0.6, size: 2, grav: -2, glow: true });
    h.x = ex; h.y = ey;
    h.path = null; h.pathIdx = 0;
    Status.apply(h, 'stun', { dur: TELEPORT_STUN });
    FX.beam(ox, oy - 0.2, ex, ey - 0.2, { color: '#b48cff', width: 2, life: 0.3 });
    FX.burst(ex, ey, { n: 18, colors: C.tele, speed: 2.4, life: 0.6, size: 2, grav: -2, glow: true });
    FX.ring(ex, ey, { color: '#7fe8ff', r0: 0.1, r1: 1.0, life: 0.45, width: 2 });
    FX.text(ex + 0.4, ey - 0.8, 'Sent back!', '#c9a8ff', { size: 10 });
  }

  /* ---- 1.7 Lifecycle --------------------------------------------------------- */
  /** Make sure a trap's data has every runtime field (never overwrites). */
  function initData(s) {
    const d = s.data || (s.data = {});
    if (d.hits === undefined) d.hits = 0;
    switch (s.id) {
      case 'arrow': if (!d.lastDir) d.lastDir = facing(s); if (d.echoT === undefined) d.echoT = 0; break;
      case 'boulder':
        if (d.ready === undefined) d.ready = true;
        if (d.rolling === undefined) d.rolling = false;
        if (d.proj === undefined) d.proj = null;
        if (d.rollT === undefined) d.rollT = 0;
        break;
      case 'fire': if (d.flameT === undefined) d.flameT = 0; break;
      case 'alarm': if (d.ringT === undefined) d.ringT = 0; if (d.pulseT === undefined) d.pulseT = 0; break;
      case 'pit': if (d.rearmT === undefined) d.rearmT = 0; break;
      case 'slime': if (d.touchT === undefined) d.touchT = 0; break;
    }
    if (s.cd == null) s.cd = 0;
    if (s.animT == null) s.animT = 0;
    return d;
  }

  /** A trap was just built (Build.place). */
  function onPlace(s) {
    if (!s || s.cat !== 'trap' || !TRAPS[s.id]) return;
    initData(s);
    s.hidden = isHiddenType(s.id);
  }

  /** Wave start: everything armed, re-hidden, forgotten. Broken pits stay broken. */
  function onWaveStart() {
    for (const s of S.structs) {
      if (s.cat !== 'trap' || !TRAPS[s.id]) continue;
      const d = initData(s);
      s.cd = 0; s.animT = 0;
      s.revealed = false; s.disarmed = false;
      s.hidden = isHiddenType(s.id);
      d.hits = 0;
      switch (s.id) {
        case 'boulder': d.ready = true; d.rolling = false; d.proj = null; d.rollT = 0; break;
        case 'fire': d.flameT = 0; break;
        case 'alarm': d.ringT = 0; d.pulseT = 0; break;
        case 'arrow': d.echoT = 0; break;
        case 'slime': d.touchT = 0; break;
        case 'pit': d.rearmT = 0; break;
      }
    }
  }

  /** Wave end: clear transient state. Broken pits stay broken (a rearming one finishes). */
  function onWaveEnd() {
    let rearmed = false;
    for (const s of S.structs) {
      if (s.cat !== 'trap' || !TRAPS[s.id]) continue;
      const d = initData(s);
      s.cd = 0; s.animT = 0;
      switch (s.id) {
        case 'boulder': d.rolling = false; d.proj = null; d.ready = true; d.rollT = 0; break;
        case 'fire': d.flameT = 0; break;
        case 'alarm': d.ringT = 0; d.pulseT = 0; break;
        case 'arrow': d.echoT = 0; break;
        case 'slime': d.touchT = 0; break;
        case 'pit': if (s.broken && d.rearmT > 0) { s.broken = false; rearmed = true; } d.rearmT = 0; break;
      }
    }
    if (rearmed) Path.bump();
  }

  /** One simulation step (wave phase only): timers, visuals, then triggers. */
  function update(dt) {
    if (!S || S.phase !== 'wave') return;
    buildOcc();
    const list = S.structs;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.cat !== 'trap' || !TRAPS[s.id]) continue;
      const d = s.data || initData(s);
      if (s.animT > 0) s.animT = Math.max(0, s.animT - dt);
      if (s.cd > 0) s.cd = Math.max(0, s.cd - dt);
      // Timers and effects that run whatever the trap's state.
      switch (s.id) {
        case 'pit': if (s.broken && d.rearmT > 0) tickRearm(s, dt); break;
        case 'fire': if (d.flameT > 0) tickFlames(s, dt); break;
        case 'alarm': if (d.ringT > 0) tickRing(s, dt); break;
        case 'boulder': tickBoulderState(s, dt); break;
        case 'slime': if (d.touchT > 0) d.touchT -= dt; break;
      }
      if (s.broken || s.disarmed) continue;
      switch (s.id) {
        case 'spike': tickSpike(s); break;
        case 'arrow': tickArrow(s, dt); break;
        case 'pit': tickPit(s); break;
        case 'slime': tickSlime(s); break;
        case 'fire': tickFire(s); break;
        case 'alarm': tickAlarm(s); break;
        case 'boulder': tickBoulder(s); break;
        case 'teleport': tickTeleport(s); break;
      }
    }
  }

  /* ---- 1.8 Discovery & the Reset Traps power ------------------------------- */
  /**
   * A hero discovered a hidden trap (Rogue detection, Ranger, Miner at a pit).
   * @returns true if it was newly revealed.
   */
  function reveal(s, by) {
    if (!s || s.cat !== 'trap' || !s.hidden || s.revealed) return false;
    s.revealed = true;
    Danger.add(s.x, s.y, TRIGGER_DANGER, 0);
    const cx = s.x + 0.5, cy = s.y + 0.5;
    FX.text(cx, s.y + 0.05, '!', '#ffd84a', { size: 16, life: 0.9 });
    FX.ring(cx, cy, { color: '#ffd84a', r0: 0.15, r1: 0.8, life: 0.4, width: 2 });
    if (by && typeof by.x === 'number') FX.beam(by.x, by.y - 0.2, cx, cy, { color: '#ffd84a', width: 1, life: 0.25 });
    SFX.play('reveal');
    return true;
  }

  /** A Rogue (or the Shadow) disabled this trap for the rest of the wave. @returns true if it changed. */
  function disarm(s, by) {
    if (!s || s.cat !== 'trap' || s.disarmed) return false;
    const d = s.data || initData(s);
    s.disarmed = true;
    s.revealed = true;
    s.animT = Math.max(s.animT || 0, 0.4);
    d.flameT = 0; d.echoT = 0; d.ringT = 0;
    const cx = s.x + 0.5, cy = s.y + 0.5;
    FX.burst(cx, cy, { n: 12, colors: C.disarm, speed: 2, life: 0.45, size: 1.8, grav: 5 });
    FX.text(cx, s.y + 0.05, 'Disarmed', '#9fe8ff', { size: 10 });
    SFX.play('disarm');
    return true;
  }

  /**
   * Reset Traps power: every trap's cooldown cleared, broken ones repaired,
   * disarmed ones rearmed, revealed ones hidden again, boulders ready.
   * @returns number of traps reset.
   */
  function resetAll() {
    if (!S) return 0;
    let n = 0, repaired = false;
    for (const s of S.structs) {
      if (s.cat !== 'trap' || !TRAPS[s.id]) continue;
      const d = initData(s);
      if (s.broken) repaired = true;
      s.cd = 0; s.broken = false; s.revealed = false; s.disarmed = false;
      if (s.id === 'pit') d.rearmT = 0;
      if (s.id === 'boulder') d.ready = true;
      s.animT = 0.5;
      const cx = s.x + 0.5, cy = s.y + 0.5;
      FX.ring(cx, cy, { color: '#9fe8ff', r0: 0.1, r1: 0.9, life: 0.5, width: 2 });
      FX.burst(cx, cy, { n: 8, colors: C.reset, speed: 1.6, life: 0.6, size: 2, grav: -2, glow: true });
      n++;
    }
    if (repaired) Path.bump();
    return n;
  }

  /* ---- 1.9 Tooltip / inspector text ----------------------------------------- */
  const secs = v => `${Math.round(v * 100) / 100}s`;

  function statusLine(s) {
    const d = s.data || {};
    const wave = S.phase === 'wave';
    if (s.broken) {
      if (d.rearmT > 0) return `Status: Rearming (${d.rearmT.toFixed(1)}s)`;
      const c = Build.repairCost(s);
      return c > 0 ? `Status: Broken — repair for ${c}g` : 'Status: Broken — repair is free';
    }
    if (s.disarmed) return wave ? 'Status: Disarmed (inactive this wave)' : 'Status: Disarmed last wave — rearms at wave start';
    const hidden = wave ? s.hidden : isHiddenType(s.id);
    if (hidden) {
      if (wave && s.revealed) return 'Status: Revealed — heroes know it is here';
      if (Light.isLit(s.x, s.y)) return 'Status: Hidden, but torchlight exposes it';
      return 'Status: Hidden';
    }
    return 'Status: Visible to heroes';
  }

  /** Human-readable lines for the tooltip / inspector (stats, status, live state). */
  function describe(s) {
    if (!s || s.cat !== 'trap' || !TRAPS[s.id]) return [];
    const st = stats(s.id, s.level), d = s.data || {}, out = [];
    switch (s.id) {
      case 'spike':
        out.push(`Damage: ${st.dmg}`, `Cooldown: ${secs(st.cd)}`);
        if (st.bleed) out.push(`Bleed: ${st.bleed}/s for ${st.bleedDur}s`);
        break;
      case 'arrow':
        out.push(st.volleys > 1 ? `Damage: ${st.dmg} × ${st.volleys} volleys` : `Damage: ${st.dmg}`,
          `Cooldown: ${secs(st.cd)}`, `Range: ${st.range} tiles in 4 directions`);
        break;
      case 'pit':
        out.push(`Swallows heroes with ≤ ${st.killHp} HP`, `Others: ${st.dmg} damage + ${st.stun}s stun`,
          st.rearm ? `Rearms itself ${st.rearm}s after use` : 'One use — repair after it opens');
        break;
      case 'slime':
        out.push(`Slow: ${Math.round(st.slow * 100)}%`, `Lingers ${secs(st.linger)} after leaving`);
        break;
      case 'fire':
        out.push(`Burn: ${st.burn}/s for ${st.burnDur}s`, `Flames: ${st.flame}s on its tile + 4 beside it`, `Cooldown: ${secs(st.cd)}`);
        break;
      case 'alarm':
        out.push(`Radius: ${st.radius} tiles`, `Enrages monsters: +${Math.round((st.buffDmg - 1) * 100)}% dmg, +${Math.round((st.buffSpd - 1) * 100)}% speed for ${st.buffDur}s`,
          `Cooldown: ${secs(st.cd)}`);
        break;
      case 'boulder':
        out.push(`Damage: ${st.dmg} + ${st.stun}s stun`, `Range: ${st.range} tiles in straight lines`, `Re-forms after ${secs(st.cd)}`);
        break;
      case 'teleport':
        out.push('Sends advancing heroes back to the entrance', `Cooldown: ${secs(st.cd)}`);
        break;
    }
    out.push(statusLine(s));
    const wave = S.phase === 'wave';
    if (wave && !s.broken && !s.disarmed) {
      switch (s.id) {
        case 'boulder': out.push(d.ready ? 'Boulder: Ready to roll' : d.rolling ? 'Boulder: Rolling!' : `Boulder: Re-forming (${s.cd.toFixed(1)}s)`); break;
        case 'slime': out.push('Always active'); break;
        case 'pit': out.push('Armed'); break;
        default:
          if (s.id === 'fire' && d.flameT > 0) out.push('Erupting!');
          else if (s.id === 'alarm' && d.ringT > 0) out.push('Ringing!');
          else out.push(s.cd > 0 ? `Recharging: ${s.cd.toFixed(1)}s` : 'Ready');
      }
    }
    if (d.hits > 0) out.push(`Triggered ${d.hits}× ${wave ? 'this' : 'last'} wave`);
    return out;
  }

  return { onPlace, update, onWaveStart, onWaveEnd, reveal, disarm, resetAll, describe, stats };
})();

/* -----------------------------------------------------------------------------
 * 2. OBJECTS — chests (loot & refill), torches (embers; light is core Light),
 *    barricades (HP & breaking are core Combat.hitStruct), mana wells
 *    (sparkles; Powers adds the regen), monster lairs (spawning).
 * -------------------------------------------------------------------------- */
const Objects = (() => {
  /* ---- 2.1 Tuning & FX presets --------------------------------------------- */
  const FIRST_SPAWN = 3;        // a lair's first summon arrives this long into the wave
  const SUMMON_RETRY = 2;       // retry delay when Monsters.summon refuses (global summon cap)
  const LAIR_TYPES = ['goblin', 'skeleton'];
  const EMBER_RATE = 0.07;      // chance per tick (≈4 embers/s per torch)
  const SPARKLE_RATE = 0.06;
  const GLINT_RATE = 0.012;
  const FX_EMBER = { n: 1, colors: ['#ffb347', '#ff7a1f', '#ffe08a'], dir: [0, -1], spread: 0.9, speed: 0.6, life: 0.9, size: 1.6, grav: -1.2, drag: 0.8, glow: true, jitter: 0.25 };
  const FX_SPARKLE = { n: 1, colors: ['#7fd4ff', '#bfefff', '#5aa8ff', '#ffffff'], dir: [0, -1], spread: 1.6, speed: 0.5, life: 0.9, size: 1.5, grav: -0.7, drag: 1, glow: true, jitter: 0.6 };
  const FX_GLINT = { n: 1, colors: ['#fff6c0', '#ffd84a'], speed: 0.3, life: 0.45, size: 1.8, grav: -0.5, glow: true, jitter: 0.5 };
  const FX_WISP = { n: 1, colors: ['#8a4ad0', '#3a1a5a', '#c080ff'], speed: 0.9, life: 0.6, size: 2, grav: -1.5, glow: true, jitter: 0.7 };
  const COINS = ['#ffd84a', '#ffec8a', '#e0a800'];

  /* ---- 2.2 Lifecycle --------------------------------------------------------- */
  function initData(s) {
    const d = s.data || (s.data = {});
    switch (s.id) {
      case 'chest':
        if (d.empty === undefined) d.empty = false;
        if (d.claimedBy === undefined) d.claimedBy = null;
        break;
      case 'lair':
        if (d.spawnT === undefined) d.spawnT = FIRST_SPAWN;
        if (d.alive === undefined) d.alive = 0;
        break;
    }
    if (s.animT == null) s.animT = 0;
    return d;
  }

  /** An object was just built (Build.place). Barricade HP is set by core. */
  function onPlace(s) {
    if (!s || s.cat !== 'object' || !OBJECTS[s.id]) return;
    initData(s);
  }

  /** Wave start: chests refill, lairs start their first countdown. Broken barricades stay broken. */
  function onWaveStart() {
    for (const s of S.structs) {
      if (s.cat !== 'object' || !OBJECTS[s.id]) continue;
      const d = initData(s);
      s.animT = 0;
      if (s.id === 'chest') { d.empty = false; d.claimedBy = null; }
      if (s.id === 'lair') { d.spawnT = FIRST_SPAWN; d.alive = 0; }
    }
  }

  /**
   * Wave end: drop claims (lair summons are removed by Monsters.onWaveEnd) and
   * mend standing barricades to full HP. Smashed ones still need a repair.
   */
  function onWaveEnd() {
    let mended = false;
    for (const s of S.structs) {
      if (s.cat !== 'object' || !OBJECTS[s.id]) continue;
      const d = initData(s);
      s.animT = 0;
      if (s.id === 'chest') d.claimedBy = null;
      if (s.id === 'lair') { d.alive = 0; d.spawnT = FIRST_SPAWN; }
      if (s.id === 'barricade' && !s.broken && s.maxHp && s.hp < s.maxHp) { s.hp = s.maxHp; mended = true; }
    }
    if (mended) Path.bump(); // Path.baseCost scales with barricade HP
  }

  /* ---- 2.3 Lairs --------------------------------------------------------------- */
  /** Living monsters this lair has spawned. */
  function countLair(s) {
    let n = 0;
    for (const m of S.monsters) if (m.lair === s && !m.dead && !m.removed) n++;
    return n;
  }
  /** Countdown runs while below maxAlive; each expiry summons a Goblin or Skeleton. */
  function tickLair(s, dt) {
    const d = s.data, def = OBJECTS.lair;
    d.alive = countLair(s);
    if (d.alive >= def.maxAlive) return; // full: the countdown waits for a free slot
    d.spawnT -= dt;
    const cx = s.x + 0.5, cy = s.y + 0.5;
    if (d.spawnT < 0.8 && Math.random() < 0.35) FX.burst(cx, cy + 0.2, FX_WISP); // it stirs...
    if (d.spawnT > 0) return;
    const m = typeof Monsters !== 'undefined' && Monsters.summon
      ? Monsters.summon(pick(LAIR_TYPES), cx, cy, { temp: true, lair: s }) : null;
    if (!m) { d.spawnT = SUMMON_RETRY; return; }
    if (m.lair !== s) m.lair = s; // keep the alive count honest even if summon ignored the option
    d.alive++;
    d.spawnT = def.spawnCd;
    s.animT = 0.6;
    FX.burst(cx, cy, { n: 20, colors: ['#8a4ad0', '#3a1a5a', '#c080ff', '#1a0a2a'], speed: 2.4, life: 0.7, size: 2.4, grav: -1, glow: true });
    FX.ring(cx, cy, { color: '#a060e0', r0: 0.2, r1: 1.1, life: 0.45, width: 2 });
    SFX.play('raise');
  }

  /* ---- 2.4 Update ------------------------------------------------------------ */
  /** One simulation step (wave phase only). */
  function update(dt) {
    if (!S || S.phase !== 'wave') return;
    const list = S.structs;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.cat !== 'object' || !OBJECTS[s.id]) continue;
      if (!s.data) initData(s);
      if (s.animT > 0) s.animT = Math.max(0, s.animT - dt); // incl. barricade hit shakes (core sets them)
      switch (s.id) {
        case 'torch': if (Math.random() < EMBER_RATE) FX.burst(s.x + 0.5, s.y + 0.2, FX_EMBER); break;
        case 'well': if (!s.broken && Math.random() < SPARKLE_RATE) FX.burst(s.x + 0.5, s.y + 0.45, FX_SPARKLE); break;
        case 'chest': if (!s.data.empty && Math.random() < GLINT_RATE) FX.burst(s.x + 0.5, s.y + 0.4, FX_GLINT); break;
        case 'lair': if (!s.broken) tickLair(s, dt); break;
        // barricade: HP and breaking are handled by core Combat.hitStruct.
      }
    }
  }

  /* ---- 2.5 Chests -------------------------------------------------------------- */
  /**
   * A hero finished looting a chest. Empties it for the rest of the wave.
   * @returns the gold value taken (0 if it was already empty).
   */
  function loot(s, hero) {
    if (!s || s.cat !== 'object' || s.id !== 'chest') return 0;
    const d = s.data || initData(s);
    if (d.empty) return 0;
    d.empty = true;
    d.claimedBy = null;
    s.animT = 0.6;
    const v = Lures.chestValue();
    const cx = s.x + 0.5, cy = s.y + 0.5;
    FX.burst(cx, cy - 0.1, { n: 18, colors: COINS, dir: [0, -1], spread: 1.8, speed: 3, life: 0.8, size: 2.2, grav: 7 });
    FX.text(cx, s.y - 0.1, `Looted! ${v}g`, '#ffd84a', { size: 11 });
    if (hero && typeof hero.x === 'number') FX.beam(cx, cy, hero.x, hero.y - 0.2, { color: '#ffd84a', width: 1, life: 0.2 });
    SFX.play('loot');
    return v;
  }

  /* ---- 2.6 Tooltip / inspector text -------------------------------------------- */
  function describe(s) {
    if (!s || s.cat !== 'object' || !OBJECTS[s.id]) return [];
    const d = s.data || {}, def = OBJECTS[s.id], wave = S.phase === 'wave', out = [];
    switch (s.id) {
      case 'chest': {
        out.push(`Treasure: ${Lures.chestValue()}g (stolen if a thief escapes with it)`,
          `Lures greedy heroes within ${Math.round(Lures.radius() * 10) / 10} tiles`);
        if (d.empty) out.push(wave ? 'Status: Looted — refills next wave' : 'Status: Refills at wave start');
        else if (d.claimedBy && wave) {
          const h = S.heroes.find(e => e.uid === d.claimedBy && !e.dead);
          out.push(h ? `Status: ${h.name || 'A hero'} is going for it!` : 'Status: Full');
        } else out.push('Status: Full');
        break;
      }
      case 'torch': {
        out.push(`Light radius: ${CFG.torchRadius} tiles`,
          `Heroes in the light take +${Math.round(CFG.torchExposed * 100)}% damage`,
          'Hidden traps in the light are visible to heroes');
        if (wave) out.push(`Exposing ${Spatial.heroesInRadius(s.x + 0.5, s.y + 0.5, CFG.torchRadius + 0.5).filter(h => h.st.exposed).length} hero(es)`);
        break;
      }
      case 'barricade':
        out.push(`HP: ${Math.ceil(s.hp || 0)}/${s.maxHp || def.hp}`, 'Heroes must smash through it', 'Mends between waves; repair if smashed');
        if (s.broken) {
          const c = Build.repairCost(s);
          out.push(c > 0 ? `Status: Smashed — repair for ${c}g` : 'Status: Smashed — repair is free');
        } else out.push('Status: Standing');
        break;
      case 'well':
        out.push(`+${def.regen} mana per second during waves`);
        break;
      case 'lair':
        out.push(`Spawns a Goblin or Skeleton every ${def.spawnCd}s`, `Max ${def.maxAlive} alive at once`);
        if (wave) {
          out.push(`Alive: ${d.alive || 0}/${def.maxAlive}`,
            (d.alive || 0) >= def.maxAlive ? 'Next spawn: when one falls' : `Next spawn: ${Math.max(0, d.spawnT || 0).toFixed(1)}s`);
        } else out.push(`First spawn ${FIRST_SPAWN}s into the wave`);
        break;
    }
    return out;
  }

  return { onPlace, update, onWaveStart, onWaveEnd, loot, describe };
})();
