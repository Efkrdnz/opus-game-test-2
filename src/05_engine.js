/* =============================================================================
 *  05 ENGINE — run state, grid, pathfinding, danger memory, light, spatial
 *  queries, status effects, combat, projectiles, the Heart, economy, building.
 * ========================================================================== */

/* -----------------------------------------------------------------------------
 * 1. RUN STATE
 * -------------------------------------------------------------------------- */
/** The live run. Recreated by Game.newRun(). Modules must always read `S` at call time. */
let S = null;

function makeState() {
  return {
    seed: (Math.random() * 1e9) | 0,
    phase: 'title',          // 'title' | 'build' | 'wave' | 'reward' | 'gameover'
    wave: 1,                 // the wave being built for / fought
    gold: CFG.startGold,
    mana: CFG.manaStart,
    manaMax: CFG.manaMax,
    heartHp: CFG.heartHp,
    heartMax: CFG.heartHp,
    cols: 0, rows: 0,
    tiles: [],               // flat array (index = y*cols + x) of Tile objects
    danger: null,            // Float32Array — hero danger memory per tile
    lit: null,               // Uint8Array — 1 where a torch lights the tile
    entrance: { x: 0, y: 0 },
    heart: { x: 0, y: 0 },
    structs: [],             // every placed Structure (traps, objects, monster/boss posts)
    heroes: [],              // hero entities (dead ones linger briefly for the death animation)
    monsters: [],            // monster entities (placed + summoned)
    projectiles: [],
    corpses: [],             // {x,y,type,t,uid} — fallen heroes (Lich raises these)
    parties: [],             // managed by Heroes
    perks: {},               // id -> stack count
    perkOrder: [],           // ids in the order taken
    unlocked: new Set(),     // 'cat:id' keys
    pathVersion: 1,          // bumps whenever walkability / structures change
    dangerVersion: 1,        // bumps whenever danger memory changes
    time: 0,                 // sim seconds since the current wave started
    speed: 1,
    paused: false,
    nextWave: null,          // preview object from Waves.generate()
    powerCd: {},             // power id -> remaining cooldown
    undyingUsed: false,
    heartPulseT: 0,
    heartHitT: 0,            // >0 briefly after the Heart is hit (render flash)
    waveEndT: -1,            // countdown once all heroes are gone
    endingT: -1,             // countdown after the Heart is destroyed
    ws: null,                // stats for the wave in progress (see Game.startWave)
    lastSummary: null,
    stats: {
      kills: 0, goldEarned: 0, heartDamage: 0, escaped: 0, stolen: 0, bossKills: 0,
      wavesSurvived: 0, trapKills: {}, trapDamage: {}, killsBy: {}, elitesKilled: 0,
    },
    ui: {
      tool: null,            // {cat,id} build tool, or null
      selected: null,        // {x,y} inspected tile, or null
      hover: null,           // {wx,wy,tx,ty} mouse position over the board, or null
      power: null,           // power id awaiting a target click, or null
      showDanger: false,     // overlay hero danger memory
      showPath: true,        // overlay predicted hero route during build
    },
  };
}

/* -----------------------------------------------------------------------------
 * 2. GRID
 *    Tile = { x, y, type:T.*, s:Structure|null, paid:number (gold paid for a
 *             player wall), rubble:bool, deco:int (visual variation) }
 * -------------------------------------------------------------------------- */
const Grid = {
  idx(x, y) { return y * S.cols + x; },
  inb(x, y) { return x >= 0 && y >= 0 && x < S.cols && y < S.rows; },
  tile(x, y) { return this.inb(x, y) ? S.tiles[y * S.cols + x] : null; },
  /** Walls, rock and out-of-bounds block movement and line of sight. */
  isSolid(x, y) {
    if (!this.inb(x, y)) return true;
    const t = S.tiles[y * S.cols + x].type;
    return t === T.WALL || t === T.ROCK;
  },
  /** Unbroken barricade on this tile? */
  barricadeAt(x, y) {
    const t = this.tile(x, y);
    return t && t.s && t.s.cat === 'object' && t.s.id === 'barricade' && !t.s.broken ? t.s : null;
  },
  makeTile(x, y, type) { return { x, y, type, s: null, paid: 0, rubble: false, deco: (Math.random() * 1000) | 0 }; },

  /** Build a fresh dungeon of the given size with a few natural rock outcrops. */
  init(cols, rows) {
    S.cols = cols; S.rows = rows;
    S.tiles = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const border = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
      S.tiles.push(this.makeTile(x, y, border ? T.ROCK : T.FLOOR));
    }
    const my = Math.floor(rows / 2);
    S.entrance = { x: 0, y: my };
    S.heart = { x: cols - 3, y: my };
    this.tile(0, my).type = T.ENTRANCE;
    this.tile(cols - 3, my).type = T.HEART;
    S.danger = new Float32Array(cols * rows);
    S.lit = new Uint8Array(cols * rows);
    this.scatterRocks(4 + ((Math.random() * 3) | 0));
    Path.bump();
  },

  /** Scatter small natural rock outcrops in the interior while keeping the Heart reachable. */
  scatterRocks(count) {
    let placed = 0, tries = 0;
    while (placed < count && tries++ < 200) {
      const cx = randInt(4, S.cols - 7);
      const cy = randInt(2, S.rows - 3);
      const shape = pick([[[0, 0]], [[0, 0], [1, 0]], [[0, 0], [0, 1]], [[0, 0], [1, 0], [0, 1]], [[0, 0], [1, 1]]]);
      const cells = shape.map(([dx, dy]) => [cx + dx, cy + dy]).filter(([x, y]) => {
        const t = this.tile(x, y);
        return t && t.type === T.FLOOR && !t.s && y > 0 && y < S.rows - 1 &&
          dist(x, y, S.heart.x, S.heart.y) > 3 && dist(x, y, S.entrance.x, S.entrance.y) > 3;
      });
      if (!cells.length) continue;
      for (const [x, y] of cells) this.tile(x, y).type = T.ROCK;
      if (!Path.reachable()) { for (const [x, y] of cells) this.tile(x, y).type = T.FLOOR; continue; }
      placed++;
    }
  },

  /**
   * Expand the dungeon to a larger size (called between waves). New space is
   * added on the entrance (left) side and split top/bottom; everything shifts.
   */
  expand(cols, rows) {
    if (cols <= S.cols && rows <= S.rows) return false;
    const oc = S.cols, or = S.rows, oldTiles = S.tiles, oldDanger = S.danger;
    const dx = cols - oc, dy = Math.floor((rows - or) / 2);
    S.cols = cols; S.rows = rows;
    S.tiles = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const border = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
      S.tiles.push(this.makeTile(x, y, border ? T.ROCK : T.FLOOR));
    }
    S.danger = new Float32Array(cols * rows);
    S.lit = new Uint8Array(cols * rows);
    for (let y = 0; y < or; y++) for (let x = 0; x < oc; x++) {
      const ot = oldTiles[y * oc + x];
      const nx = x + dx, ny = y + dy;
      const oldBorder = x === 0 || y === 0 || y === or - 1; // old right border stays the right border
      const nt = this.tile(nx, ny);
      if (!nt) continue;
      if (x === oc - 1) { nt.type = T.ROCK; nt.s = ot.s; continue; } // right border stays; keeps mounted Arrow Walls
      if (oldBorder) {
        // The old left/top/bottom edge opens up (incl. the old entrance) — except rock carrying an
        // Arrow Wall, which stays as a pillar (it was solid already, so no route is lost).
        if (ot.s) { nt.type = T.ROCK; nt.s = ot.s; continue; }
        nt.type = T.FLOOR; continue;
      }
      nt.type = ot.type; nt.s = ot.s; nt.paid = ot.paid; nt.rubble = ot.rubble; nt.deco = ot.deco;
      S.danger[ny * cols + nx] = oldDanger[y * oc + x];
    }
    // Shift everything that stores coordinates.
    for (const s of S.structs) {
      s.x += dx; s.y += dy;
      if (s.ent) { s.ent.x += dx; s.ent.y += dy; s.ent.homeX += dx; s.ent.homeY += dy; }
    }
    for (const m of S.monsters) if (!m.post) { m.x += dx; m.y += dy; m.homeX += dx; m.homeY += dy; }
    const my = S.heart.y + dy;
    S.heart = { x: S.heart.x + dx, y: my };
    S.entrance = { x: 0, y: Math.floor(rows / 2) };
    this.tile(S.entrance.x, S.entrance.y).type = T.ENTRANCE;
    this.tile(S.heart.x, S.heart.y).type = T.HEART;
    // Effects already in flight (e.g. a perk's heal ring) move with the world.
    for (const a of [FX.parts, FX.texts, FX.rings, FX.tileFlashes]) for (const o of a) { o.x += dx; o.y += dy; }
    for (const b of FX.beams) { b.x0 += dx; b.x1 += dx; b.y0 += dy; b.y1 += dy; }
    // A few new outcrops in the freshly dug area.
    this.scatterRocksIn(1, dx + 1, 1, rows - 1, 2 + ((Math.random() * 2) | 0));
    Path.bump();
    Light.recompute();
    return true;
  },

  scatterRocksIn(x0, x1, y0, y1, count) {
    let placed = 0, tries = 0;
    while (placed < count && tries++ < 120) {
      const x = randInt(x0 + 1, Math.max(x0 + 1, x1 - 1)), y = randInt(y0 + 1, y1 - 2);
      const t = this.tile(x, y);
      if (!t || t.type !== T.FLOOR || t.s || dist(x, y, S.entrance.x, S.entrance.y) < 3) continue;
      t.type = T.ROCK;
      if (!Path.reachable()) { t.type = T.FLOOR; continue; }
      placed++;
    }
  },

  /**
   * Exact grid traversal (Amanatides & Woo) of the segment A→B. Returns false as soon as the
   * segment enters a solid tile. The start tile is never tested; the end tile only if
   * `includeEnd`. A segment passing exactly through a tile corner must have both side tiles clear.
   * Line of sight and projectile wall checks share this so they can never disagree.
   */
  traceClear(ax, ay, bx, by, includeEnd) {
    let x = Math.floor(ax), y = Math.floor(ay);
    const ex = Math.floor(bx), ey = Math.floor(by);
    const dx = bx - ax, dy = by - ay;
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity, tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tmx = dx !== 0 ? (dx > 0 ? x + 1 - ax : ax - x) * tdx : Infinity;
    let tmy = dy !== 0 ? (dy > 0 ? y + 1 - ay : ay - y) * tdy : Infinity;
    let n = Math.abs(ex - x) + Math.abs(ey - y);
    while (n > 0) {
      if (tmx < tmy - 1e-9) { x += stepX; tmx += tdx; n--; }
      else if (tmy < tmx - 1e-9) { y += stepY; tmy += tdy; n--; }
      else { // exactly through a corner
        if (this.isSolid(x + stepX, y) || this.isSolid(x, y + stepY)) return false;
        x += stepX; y += stepY; tmx += tdx; tmy += tdy; n -= 2;
      }
      if ((includeEnd || x !== ex || y !== ey) && this.isSolid(x, y)) return false;
    }
    return true;
  },
  /** Line of sight between two world points: false if any wall/rock lies strictly between (barricades don't block). */
  los(ax, ay, bx, by) { return this.traceClear(ax, ay, bx, by, false); },

  /** Turn a WALL tile back into floor (mage blast / miner dig). Destroys any mounted trap. */
  destroyWall(x, y, cause) {
    const t = this.tile(x, y);
    if (!t || t.type !== T.WALL) return false;
    if (t.s) {
      const s = t.s;
      Build.removeStruct(s);
      if (typeof UI !== 'undefined') UI.toast(`${contentDef(s.cat, s.id).name} destroyed by ${cause || 'a hero'}!`, 'bad');
    }
    t.type = T.FLOOR; t.paid = 0; t.rubble = false;
    FX.burst(x + 0.5, y + 0.5, { n: 26, colors: ['#6b6378', '#4a4453', '#8a8296', '#2f2a36'], speed: 3.2, life: 0.8, size: 3, grav: 6 });
    FX.shake(4);
    SFX.play('collapse');
    Path.bump();
    return true;
  },

  /** Can the DM "Collapse" this tile right now? */
  canCollapse(x, y) {
    const t = this.tile(x, y);
    if (!t) return { ok: false, reason: 'Out of bounds.' };
    if (t.type !== T.FLOOR) return { ok: false, reason: 'Only open floor can collapse.' };
    if (t.s) return { ok: false, reason: 'Something is built there.' };
    if (dist(x, y, S.entrance.x, S.entrance.y) < 1.5) return { ok: false, reason: 'Too close to the entrance.' };
    if (!Path.reachable(this.idx(x, y))) return { ok: false, reason: 'That would seal off the Heart!' };
    return { ok: true };
  },

  /** Collapse a floor tile into a rubble wall, damaging and shoving entities on it. */
  collapse(x, y, dmg) {
    const chk = this.canCollapse(x, y);
    if (!chk.ok) return false;
    const t = this.tile(x, y);
    t.type = T.WALL; t.rubble = true; t.paid = 0;
    // Shove to the nearest neighbour a unit may stand on: never the Heart, the Entrance, a standing
    // barricade, or diagonally through a wall corner (falls back to any open tile if boxed in).
    const shove = e => {
      let best = null, bd = 1e9, loose = null, ld = 1e9;
      for (const [ddx, ddy] of DIRS8) {
        const nx = x + ddx, ny = y + ddy;
        if (this.isSolid(nx, ny)) continue;
        const d = dist(e.x, e.y, nx + 0.5, ny + 0.5);
        if (d < ld) { ld = d; loose = [nx, ny]; }
        const tt = this.tile(nx, ny).type;
        if (tt === T.HEART || tt === T.ENTRANCE || this.barricadeAt(nx, ny)) continue;
        if (ddx && ddy && (this.isSolid(x + ddx, y) || this.isSolid(x, y + ddy))) continue;
        if (d < bd) { bd = d; best = [nx, ny]; }
      }
      best = best || loose;
      if (best) { e.x = best[0] + 0.5; e.y = best[1] + 0.5; }
      e.path = null;
    };
    for (const h of S.heroes) if (!h.dead && Math.floor(h.x) === x && Math.floor(h.y) === y) {
      shove(h);
      Combat.damage(h, dmg, { team: 'dm', kind: 'power', id: 'collapse', elem: 'phys' });
      Status.apply(h, 'stun', { dur: 0.8 });
    }
    for (const m of S.monsters) if (!m.dead && Math.floor(m.x) === x && Math.floor(m.y) === y) shove(m);
    FX.burst(x + 0.5, y + 0.5, { n: 40, colors: ['#6b6378', '#4a4453', '#8a8296', '#c9b99a'], speed: 4, life: 1, size: 3.5, grav: 7 });
    FX.shake(7);
    SFX.play('collapse');
    Path.bump();
    return true;
  },
};

/* -----------------------------------------------------------------------------
 * 3. PATHFINDING
 *    • reachable()  — BFS validity check used by every wall placement.
 *    • astar()      — weighted A* with a caller-supplied cost function.
 *    • a distance field from the Heart (cached per pathVersion).
 * -------------------------------------------------------------------------- */
class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  clear() { this.k.length = 0; this.v.length = 0; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

const Path = {
  _n: 0, _g: null, _came: null, _stamp: null, _closed: null, _gen: 0, _heap: new MinHeap(),
  _heartField: null, _heartVer: -1,
  _preview: null, _previewKey: '',

  /** Call whenever walkability, structures or traps change. */
  bump() { if (S) S.pathVersion++; },
  /** Forget every cache (a new run restarts the version counters, so stale keys could collide). */
  reset() { this._heartField = this._preview = null; this._heartVer = -1; this._previewKey = ''; },

  _ensure() {
    const n = S.cols * S.rows;
    if (this._n !== n) {
      this._n = n;
      this._g = new Float64Array(n);
      this._came = new Int32Array(n);
      this._stamp = new Uint32Array(n);
      this._closed = new Uint32Array(n);
      this._gen = 0;
    }
  },

  /**
   * Is the Heart reachable from the Entrance? Walls & rock block; barricades
   * count as passable (heroes can smash them). `blockIdx` is an extra tile
   * index to treat as solid (used to test a placement before committing it).
   */
  reachable(blockIdx = -1) {
    const cols = S.cols, rows = S.rows, n = cols * rows;
    const seen = new Uint8Array(n);
    const start = Grid.idx(S.entrance.x, S.entrance.y), goal = Grid.idx(S.heart.x, S.heart.y);
    const q = [start]; seen[start] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi];
      if (i === goal) return true;
      const x = i % cols, y = (i / cols) | 0;
      for (const [dx, dy] of DIRS4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const ni = ny * cols + nx;
        if (seen[ni] || ni === blockIdx) continue;
        const tt = S.tiles[ni].type;
        if (tt === T.WALL || tt === T.ROCK) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    return false;
  },

  /** BFS step-distance field from a tile over open tiles (barricades passable). */
  _field(sx, sy) {
    const cols = S.cols, rows = S.rows, n = cols * rows;
    const f = new Float32Array(n).fill(Infinity);
    const s = sy * cols + sx;
    f[s] = 0;
    const q = [s];
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi];
      const x = i % cols, y = (i / cols) | 0;
      for (const [dx, dy] of DIRS4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const ni = ny * cols + nx;
        if (f[ni] !== Infinity) continue;
        const tt = S.tiles[ni].type;
        if (tt === T.WALL || tt === T.ROCK) continue;
        f[ni] = f[i] + 1; q.push(ni);
      }
    }
    return f;
  },
  /** Walking distance (tiles) from (x,y) to the Heart ignoring danger; Infinity if cut off. */
  heartDist(x, y) {
    if (this._heartVer !== S.pathVersion || !this._heartField || this._heartField.length !== S.cols * S.rows) {
      this._heartField = this._field(S.heart.x, S.heart.y); this._heartVer = S.pathVersion;
    }
    x = Math.floor(x); y = Math.floor(y);
    return Grid.inb(x, y) ? this._heartField[y * S.cols + x] : Infinity;
  },

  /**
   * Weighted A* over the 4-connected grid.
   * @param cost (x, y, idx) => number|Infinity — cost to ENTER tile (≥ 1 when passable).
   * @returns array of {x,y} steps from the first tile after start up to and including
   *          the goal; [] if start === goal; null if unreachable.
   */
  astar(sx, sy, gx, gy, cost) {
    this._ensure();
    sx = Math.floor(sx); sy = Math.floor(sy); gx = Math.floor(gx); gy = Math.floor(gy);
    if (!Grid.inb(sx, sy) || !Grid.inb(gx, gy)) return null;
    if (sx === gx && sy === gy) return [];
    const cols = S.cols, rows = S.rows;
    const gen = ++this._gen;
    const g = this._g, came = this._came, stamp = this._stamp, closed = this._closed;
    const heap = this._heap; heap.clear();
    const s = sy * cols + sx, goal = gy * cols + gx;
    g[s] = 0; stamp[s] = gen; came[s] = -1;
    heap.push(Math.abs(gx - sx) + Math.abs(gy - sy), s);
    let iter = 0;
    const maxIter = cols * rows * 6;
    while (heap.size && iter++ < maxIter) {
      const i = heap.pop();
      if (closed[i] === gen) continue;
      closed[i] = gen;
      if (i === goal) break;
      const x = i % cols, y = (i / cols) | 0;
      const gi = g[i];
      for (let d = 0; d < 4; d++) {
        const nx = x + DIRS4[d][0], ny = y + DIRS4[d][1];
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const ni = ny * cols + nx;
        if (closed[ni] === gen) continue;
        const c = cost(nx, ny, ni);
        if (!(c < Infinity)) continue;
        const ng = gi + c;
        if (stamp[ni] !== gen || ng < g[ni]) {
          stamp[ni] = gen; g[ni] = ng; came[ni] = i;
          heap.push(ng + Math.abs(gx - nx) + Math.abs(gy - ny), ni);
        }
      }
    }
    if (closed[goal] !== gen) return null;
    const out = [];
    for (let i = goal; i !== s; i = came[i]) out.push({ x: i % cols, y: (i / cols) | 0 });
    out.reverse();
    return out;
  },

  /** Default walkability for heroes: walls/rock blocked; everything else passable. */
  baseCost(x, y, i) {
    const t = S.tiles[i];
    if (t.type === T.WALL || t.type === T.ROCK) return Infinity;
    // The Heart is a valid goal but nobody should walk *through* it; every route to it pays this equally.
    if (t.type === T.HEART) return 50;
    let c = 1;
    const s = t.s;
    if (s) {
      if (s.cat === 'object' && s.id === 'barricade' && !s.broken) c += 6 * (s.hp / Math.max(1, s.maxHp)) + 2;
    }
    return c;
  },

  /**
   * Predicted route of a "typical" hero for the build-phase overlay: avoids
   * visible traps and remembered danger at the current wave's smartness.
   */
  preview() {
    const key = S.pathVersion + ':' + S.dangerVersion + ':' + S.wave;
    if (this._previewKey === key && this._preview) return this._preview;
    const smart = heroSmartness(false);
    const p = this.astar(S.entrance.x, S.entrance.y, S.heart.x, S.heart.y, (x, y, i) => {
      let c = Path.baseCost(x, y, i);
      if (c === Infinity) return c;
      const s = S.tiles[i].s;
      if (s && s.cat === 'trap' && !s.broken && s.id !== 'arrow' && (!(TRAPS[s.id].hidden || hasPerk('hidden_depths')) || S.lit[i])) c += 4 * smart;
      c += S.danger[i] * 0.9 * smart;
      return c;
    });
    this._preview = p || [];
    this._previewKey = key;
    return this._preview;
  },
};

/** How strongly heroes heed danger this wave (low early so new players learn; high later). */
function heroSmartness(elite) {
  const w = S ? S.wave : 1;
  return Math.min(1.3, 0.35 + w * 0.07) + (elite ? 0.25 : 0);
}

/* -----------------------------------------------------------------------------
 * 4. DANGER MEMORY — where heroes have died or discovered traps. Persists
 *    across waves (decaying), so reused kill-zones lose effectiveness.
 * -------------------------------------------------------------------------- */
const Danger = {
  /** Add danger at a tile, spreading with falloff to `radius` tiles. */
  add(x, y, amt, radius = 1) {
    x = Math.floor(x); y = Math.floor(y);
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const nx = x + dx, ny = y + dy;
      if (!Grid.inb(nx, ny)) continue;
      const d = Math.abs(dx) + Math.abs(dy);
      if (d > radius) continue;
      const i = ny * S.cols + nx;
      S.danger[i] = Math.min(CFG.dangerCap, S.danger[i] + amt / (1 + d));
    }
    S.dangerVersion++;
  },
  get(x, y) { return Grid.inb(x, y) ? S.danger[y * S.cols + x] : 0; },
  /** Between waves: heroes' memories fade. */
  decay() {
    const f = hasPerk('mastermind') ? CFG.dangerDecayMastermind : CFG.dangerDecay;
    for (let i = 0; i < S.danger.length; i++) { S.danger[i] *= f; if (S.danger[i] < 0.05) S.danger[i] = 0; }
    S.dangerVersion++;
  },
};

/* -----------------------------------------------------------------------------
 * 5. LIGHT — torch-lit tiles (heroes there are Exposed; hidden traps there are
 *    visible to heroes).
 * -------------------------------------------------------------------------- */
const Light = {
  recompute() {
    S.lit = new Uint8Array(S.cols * S.rows);
    const r = CFG.torchRadius;
    for (const s of S.structs) {
      if (s.cat !== 'object' || s.id !== 'torch') continue;
      for (let y = Math.floor(s.y - r); y <= Math.ceil(s.y + r); y++)
        for (let x = Math.floor(s.x - r); x <= Math.ceil(s.x + r); x++)
          if (Grid.inb(x, y) && dist(x, y, s.x, s.y) <= r) S.lit[y * S.cols + x] = 1;
    }
  },
  isLit(x, y) { x = Math.floor(x); y = Math.floor(y); return Grid.inb(x, y) && S.lit[y * S.cols + x] === 1; },
};

/** Do heroes currently know about this trap (for pathing)? */
function trapKnown(s) {
  if (!s || s.cat !== 'trap' || s.broken || s.disarmed) return false;
  return !s.hidden || s.revealed || Light.isLit(s.x, s.y);
}

/* -----------------------------------------------------------------------------
 * 6. LURES — things greedy heroes want: filled chests and disguised mimics.
 * -------------------------------------------------------------------------- */
const Lures = {
  /** @returns [{x,y (tile), kind:'chest'|'mimic', struct?, ent?}] */
  list() {
    const out = [];
    for (const s of S.structs) {
      if (s.cat !== 'object' || s.id !== 'chest' || s.broken || s.data.empty) continue;
      if (s.data.claimedBy && !this.claimantAlive(s.data.claimedBy)) s.data.claimedBy = null; // claimant died/fled
      if (!s.data.claimedBy) out.push({ x: s.x, y: s.y, kind: 'chest', struct: s });
    }
    for (const m of S.monsters) {
      if (!m.dead && m.disguised) out.push({ x: Math.floor(m.x), y: Math.floor(m.y), kind: 'mimic', ent: m });
    }
    return out;
  },
  /** Is the hero with this uid still alive in the dungeon? */
  claimantAlive(uid) {
    for (const h of S.heroes) if (h.uid === uid) return !h.dead && !h.escaped && !h.removed;
    return false;
  },
  radius() {
    let r = CFG.lureRadius;
    if (hasPerk('greedy_gods')) r *= 2;
    if (hasPerk('cursed_gold')) r *= 1.5;
    return r;
  },
  chestValue() { return CFG.chestBaseValue + CFG.chestValuePerWave * S.wave; },
};

/* -----------------------------------------------------------------------------
 * 7. ENTITIES & SPATIAL QUERIES
 *    Common entity fields (heroes AND monsters):
 *      uid, team:'hero'|'dm', type, x, y, hp, maxHp, dmg, atkCd, atkT, range,
 *      speed, dead, deadT, flashT, animT, face (±1), st (status block), path, pathIdx
 * -------------------------------------------------------------------------- */
function makeStatus() {
  return {
    slow: 0, slowT: 0, burn: 0, burnT: 0, burnSrc: null, bleed: 0, bleedT: 0, bleedSrc: null,
    stunT: 0, rootT: 0, fearT: 0, fearX: 0, fearY: 0, buffT: 0, buffDmg: 1, buffSpd: 1,
    dotT: 0, burnAcc: 0, bleedAcc: 0, exposed: false, invisT: 0,
  };
}

function makeEntity(team, type, x, y) {
  return {
    uid: nextUid(), team, type, x, y, hp: 1, maxHp: 1, dmg: 0, atkCd: 1, atkT: 0, range: 1.1, speed: 1,
    dead: false, deadT: 0, removed: false, flashT: 0, animT: 0, face: 1, st: makeStatus(),
    path: null, pathIdx: 0, state: 'idle', target: null, bob: Math.random() * 10,
  };
}

const Spatial = {
  heroAlive(h) { return h && !h.dead && !h.removed && !h.escaped; },
  heroesInRadius(x, y, r, includeInvisible = true) {
    const out = [], r2 = r * r;
    for (const h of S.heroes) {
      if (!this.heroAlive(h)) continue;
      if (!includeInvisible && h.st.invisT > 0) continue;
      const dx = h.x - x, dy = h.y - y;
      if (dx * dx + dy * dy <= r2) out.push(h);
    }
    return out;
  },
  nearestHero(x, y, r, filter) {
    let best = null, bd = r * r;
    for (const h of S.heroes) {
      if (!this.heroAlive(h) || (filter && !filter(h))) continue;
      const dx = h.x - x, dy = h.y - y, d = dx * dx + dy * dy;
      if (d <= bd) { bd = d; best = h; }
    }
    return best;
  },
  nearestMonster(x, y, r, filter) {
    let best = null, bd = r * r;
    for (const m of S.monsters) {
      if (m.dead || m.removed || m.disguised || (filter && !filter(m))) continue;
      const dx = m.x - x, dy = m.y - y, d = dx * dx + dy * dy;
      if (d <= bd) { bd = d; best = m; }
    }
    return best;
  },
  heroesOnTile(tx, ty) {
    const out = [];
    for (const h of S.heroes) if (this.heroAlive(h) && Math.floor(h.x) === tx && Math.floor(h.y) === ty) out.push(h);
    return out;
  },
  /** Any entity under a world point (for tooltips / targeting). */
  entityAt(wx, wy, r = 0.5) {
    let best = null, bd = r * r;
    for (const arr of [S.heroes, S.monsters]) for (const e of arr) {
      if (e.dead || e.removed || e.escaped) continue;
      const dx = e.x - wx, dy = (e.y - 0.1) - wy, d = dx * dx + dy * dy;
      if (d <= bd) { bd = d; best = e; }
    }
    return best;
  },
};

/* -----------------------------------------------------------------------------
 * 8. STATUS EFFECTS
 * -------------------------------------------------------------------------- */
const Status = {
  /**
   * Apply a status effect.
   *   slow  {amt, dur}   burn {dps, dur, src}   bleed {dps, dur, src}
   *   stun  {dur}        root {dur}             fear  {dur, x, y}   (x,y = what they flee from)
   *   buff  {dmg, spd, dur}  (multipliers, e.g. 1.5)     invis {dur}
   */
  apply(e, type, o = {}) {
    if (!e || e.dead) return false;
    const st = e.st;
    const bossResist = e.team === 'hero' && e.boss ? 0.5 : 1;
    switch (type) {
      case 'slow':
        if (st.slowT <= 0 || o.amt >= st.slow) st.slow = o.amt;
        st.slowT = Math.max(st.slowT, o.dur * bossResist);
        break;
      case 'burn':
        st.burn = st.burnT > 0 ? Math.max(st.burn, o.dps) : o.dps;
        st.burnT = Math.max(st.burnT, o.dur); st.burnSrc = o.src || st.burnSrc;
        break;
      case 'bleed':
        st.bleed = st.bleedT > 0 ? Math.max(st.bleed, o.dps) : o.dps;
        st.bleedT = Math.max(st.bleedT, o.dur); st.bleedSrc = o.src || st.bleedSrc;
        break;
      case 'stun': st.stunT = Math.max(st.stunT, o.dur * bossResist); break;
      case 'root': st.rootT = Math.max(st.rootT, o.dur * bossResist); break;
      case 'fear': {
        if (this.fearImmune(e)) {
          FX.text(e.x, e.y - 0.6, 'Immune', '#ffe28a', { size: 10 });
          return false;
        }
        st.fearT = Math.max(st.fearT, o.dur); st.fearX = o.x ?? e.x; st.fearY = o.y ?? e.y;
        e.path = null;
        break;
      }
      case 'buff':
        st.buffDmg = o.dmg ?? 1; st.buffSpd = o.spd ?? 1; st.buffT = Math.max(st.buffT, o.dur);
        break;
      case 'invis': st.invisT = Math.max(st.invisT, o.dur); break;
    }
    return true;
  },
  /** Paladins and hero bosses shrug off Fear (single source of truth for powers, UI and render). */
  fearImmune(e) { return !!e && e.team === 'hero' && (!!(HERO_CLASSES[e.type] && HERO_CLASSES[e.type].fearImmune) || !!e.boss); },
  cleanse(e) {
    const st = e.st;
    st.slowT = st.burnT = st.bleedT = st.stunT = st.rootT = st.fearT = 0;
  },
  /** Advance timers and damage-over-time. Called by Game for every entity each tick. */
  tick(e, dt) {
    const st = e.st;
    if (st.slowT > 0) st.slowT -= dt;
    if (st.stunT > 0) st.stunT -= dt;
    if (st.rootT > 0) st.rootT -= dt;
    if (st.fearT > 0) st.fearT -= dt;
    if (st.buffT > 0) st.buffT -= dt;
    if (st.invisT > 0) st.invisT -= dt;
    if (e.flashT > 0) e.flashT -= dt;
    if (e.animT > 0) e.animT -= dt;
    if (e.team === 'hero') st.exposed = Light.isLit(e.x, e.y);
    const burning = st.burnT > 0, bleeding = st.bleedT > 0;
    if (burning) st.burnT -= dt;
    if (bleeding) st.bleedT -= dt;
    if (burning || bleeding) {
      st.dotT += dt;
      if (st.dotT >= 0.5) {
        st.dotT -= 0.5;
        // Fractional damage is carried between ticks so odd DPS values aren't rounded away (or up).
        if (burning) {
          st.burnAcc = (st.burnAcc || 0) + st.burn * 0.5;
          const w = Math.floor(st.burnAcc);
          if (w > 0) { st.burnAcc -= w; Combat.damage(e, w, Object.assign({ team: 'dm', kind: 'dot' }, st.burnSrc || {}, { elem: 'fire', dot: true })); }
          if (Math.random() < 0.7) FX.burst(e.x, e.y - 0.2, { n: 3, colors: ['#ffb347', '#ff6a1f', '#ffe066'], speed: 0.8, life: 0.5, size: 2, grav: -3 });
        }
        if (bleeding && !e.dead) {
          st.bleedAcc = (st.bleedAcc || 0) + st.bleed * 0.5;
          const w = Math.floor(st.bleedAcc);
          if (w > 0) { st.bleedAcc -= w; Combat.damage(e, w, Object.assign({ team: 'dm', kind: 'dot' }, st.bleedSrc || {}, { elem: 'phys', dot: true })); }
          FX.burst(e.x, e.y, { n: 2, colors: ['#a0101a', '#d02030'], speed: 0.6, life: 0.5, size: 2, grav: 4 });
        }
      }
    } else { st.dotT = 0; st.burnAcc = 0; st.bleedAcc = 0; }
  },
  /** Movement multiplier from slows / roots / stuns / buffs (0 = cannot move). */
  speedMul(e) {
    const st = e.st;
    if (st.stunT > 0 || st.rootT > 0) return 0;
    let m = 1;
    if (st.slowT > 0) m *= 1 - st.slow;
    if (st.buffT > 0) m *= st.buffSpd;
    return Math.max(0.1, m);
  },
  dmgMul(e) { return e.st.buffT > 0 ? e.st.buffDmg : 1; },
  canAct(e) { return !e.dead && e.st.stunT <= 0; },
};

/* -----------------------------------------------------------------------------
 * 9. COMBAT
 *    Damage source descriptor `src`:
 *      { team:'dm'|'hero', kind:'trap'|'monster'|'boss'|'power'|'heart'|'dot'|'hero'|'object',
 *        id:string (trap/monster/power id), ent?:entity, elem:'phys'|'fire'|'holy'|'magic',
 *        dot?:bool, noText?:bool }
 * -------------------------------------------------------------------------- */
const Combat = {
  /** Deal damage; returns the amount actually dealt. Handles death. */
  damage(t, amount, src = {}) {
    if (!t || t.dead || t.removed || amount <= 0) return 0;
    let a = amount;
    const trapish = src.kind === 'trap'; // DoTs keep their original source kind/id
    if (t.team === 'hero') {
      if (t.st.exposed) a *= 1 + CFG.torchExposed;
      if (trapish) {
        if (hasPerk('glass_cannon')) a *= 1.4;
        if (t.elite) a *= CFG.eliteTrapResist;
      }
      const fr = HERO_CLASSES[t.type].fireResist;
      if (fr && src.elem === 'fire') a *= 1 - fr;
    } else {
      if (src.elem === 'holy' && t.undead) a *= 2;
      if (t.type === 'orc' && hasPerk('warcry')) a *= 0.8;
      if (t.dmgTakenMul) a *= t.dmgTakenMul;
    }
    if (t.dmgTakenMulAll) a *= t.dmgTakenMulAll; // generic per-entity hook
    a = Math.max(1, Math.round(a));
    if (t.team === 'hero' && t.hp - a <= 0 && typeof Heroes !== 'undefined' && Heroes.preventDeath && Heroes.preventDeath(t, src)) {
      return 0; // saved (e.g. Paladin's Lay on Hands)
    }
    t.hp -= a;
    if (!src.dot) t.flashT = 0.12;
    // Stats: attribute trap damage (including trap-sourced DoTs).
    const trapId = src.kind === 'trap' ? src.id : null;
    if (t.team === 'hero' && trapId) S.stats.trapDamage[trapId] = (S.stats.trapDamage[trapId] || 0) + Math.min(a, a + t.hp);
    if (!src.noText) {
      const col = t.team === 'hero' ? (src.elem === 'fire' ? '#ffa040' : src.elem === 'holy' ? '#fff3a0' : '#ffffff') : '#ff6b6b';
      FX.text(t.x + randRange(-0.2, 0.2), t.y - 0.55, String(a), col, { size: src.dot ? 9 : (a >= 40 ? 14 : 11) });
    }
    if (t.hp <= 0) { t.hp = 0; this.kill(t, src); }
    return a;
  },

  heal(t, amount, showText = true) {
    if (!t || t.dead || amount <= 0) return 0;
    const before = t.hp;
    t.hp = Math.min(t.maxHp, t.hp + amount);
    const h = Math.round(t.hp - before);
    if (h > 0 && showText) FX.text(t.x, t.y - 0.6, '+' + h, '#7dff8a', { size: 10 });
    return h;
  },

  kill(t, src = {}) {
    if (t.dead) return;
    t.dead = true; t.deadT = 0; t.path = null;
    const tx = Math.floor(t.x), ty = Math.floor(t.y);
    if (t.team === 'hero') {
      const bounty = Econ.bounty(t);
      const loot = Math.round(bounty * randRange(0.25, 0.5) * (hasPerk('scavenger') ? 1.5 : 1));
      Econ.gain(bounty + loot, t.x, t.y - 0.8);
      FX.burst(t.x, t.y, { n: 8 + Math.min(20, (bounty + loot) >> 2), colors: ['#ffd84a', '#ffec8a', '#e0a800'], speed: 2.6, life: 0.9, size: 2.5, grav: 5 });
      if (t.loot) { FX.text(t.x, t.y - 1.2, 'Treasure recovered!', '#ffd84a', { size: 10 }); t.loot = 0; }
      S.stats.kills++; if (S.ws) S.ws.kills++;
      if (t.elite) S.stats.elitesKilled++;
      const by = src.kind || 'other';
      S.stats.killsBy[by] = (S.stats.killsBy[by] || 0) + 1;
      const trapId = src.kind === 'trap' ? src.id : null;
      if (trapId) {
        S.stats.trapKills[trapId] = (S.stats.trapKills[trapId] || 0) + 1;
        if (S.ws) S.ws.trapKills[trapId] = (S.ws.trapKills[trapId] || 0) + 1;
      }
      Danger.add(tx, ty, 6, 2);
      // Necromancy first: a hero that rises as a Skeleton leaves no corpse (so a Lich can't raise it twice).
      const risen = hasPerk('necromancy') && !t.boss && Math.random() < 0.25 ? Monsters.summon('skeleton', t.x, t.y, { temp: true, risen: true }) : null;
      if (risen) FX.text(t.x, t.y - 1, 'Risen!', '#bb88ff', { size: 11 });
      else S.corpses.push({ x: t.x, y: t.y, type: t.type, t: CFG.corpseLife, uid: t.uid, face: t.face || 1, boss: t.boss || null });
      if (hasPerk('soul_harvest')) S.mana = Math.min(S.manaMax, S.mana + 4);
      if (t.boss) {
        S.stats.bossKills++;
        if (S.ws) S.ws.bossKilled = true;
        FX.shake(12); FX.flash('#fff', 0.25);
        FX.burst(t.x, t.y, { n: 70, colors: ['#ffffff', '#ffd84a', '#ff9a3c'], speed: 5, life: 1.4, size: 3.5, grav: 2 });
        SFX.play('boss');
        UI.toast(`${HERO_BOSSES[t.boss].name} has fallen!`, 'good');
      } else {
        FX.burst(t.x, t.y, { n: 18, colors: ['#8a1020', '#c02030', '#5a0810'], speed: 2.4, life: 0.7, size: 2.5, grav: 6 });
        FX.shake(1.5);
      }
      SFX.play('heroDie');
      if (typeof Heroes !== 'undefined' && Heroes.onDeath) Heroes.onDeath(t, src);
    } else {
      FX.burst(t.x, t.y, { n: 16, colors: t.undead ? ['#d8d2c0', '#a8a290', '#fff'] : ['#5a1a2a', '#8a2a3a', '#3a0a14'], speed: 2.2, life: 0.7, size: 2.5, grav: 6 });
      SFX.play('monsterDie');
      if (typeof Monsters !== 'undefined' && Monsters.onDeath) Monsters.onDeath(t, src);
      if (hasPerk('legion') && !t.undead && !t.temp) {
        const m = Monsters.summon('skeleton', t.x, t.y, { temp: true, risen: true });
        if (m) FX.text(t.x, t.y - 1, 'Legion!', '#d8d2c0', { size: 10 });
      }
    }
  },

  /** Damage a structure with HP (barricades). */
  hitStruct(s, amount, src = {}) {
    if (!s || s.broken || !s.maxHp) return 0;
    const a = Math.max(1, Math.round(amount));
    s.hp -= a; s.animT = 0.15;
    FX.burst(s.x + 0.5, s.y + 0.5, { n: 4, colors: ['#8a5a2a', '#6a4020', '#b07a40'], speed: 1.8, life: 0.5, size: 2, grav: 6 });
    if (s.hp <= 0) {
      s.hp = 0; s.broken = true;
      FX.burst(s.x + 0.5, s.y + 0.5, { n: 26, colors: ['#8a5a2a', '#6a4020', '#b07a40', '#3a2410'], speed: 3.5, life: 0.9, size: 3, grav: 7 });
      FX.shake(3);
      SFX.play('collapse');
      Path.bump();
    }
    return a;
  },
};

/* -----------------------------------------------------------------------------
 * 10. PROJECTILES
 *    Projectile: { kind, x, y, team:'dm'|'hero', speed, dmg, src,
 *                  target?  (homing entity — only hits that target),
 *                  dx,dy    (unit direction for straight shots — hit first enemy),
 *                  range (max travel), pierce (hit many, once each), radius,
 *                  onHit?(ent, p) (custom effect instead of plain damage),
 *                  onEnd?(p)  (called when it expires / hits a wall), ghost (ignores walls) }
 *    kinds used: 'arrow','bolt','fire','web','shadow','boulder','magic'
 * -------------------------------------------------------------------------- */
const Proj = {
  spawn(p) {
    const q = Object.assign({ age: 0, travelled: 0, radius: 0.35, range: 12, speed: 8, dead: false, hit: null }, p);
    if (q.target) {
      const d = dist(q.x, q.y, q.target.x, q.target.y) || 1;
      q.dx = (q.target.x - q.x) / d; q.dy = (q.target.y - q.y) / d;
    }
    if (q.pierce) q.hit = new Set();
    S.projectiles.push(q);
    return q;
  },
  update(dt) {
    for (const p of S.projectiles) {
      if (p.dead) continue;
      p.age += dt;
      if (p.target) {
        const t = p.target;
        if (t.dead || t.removed || t.escaped) p.target = null;
        else {
          const d = dist(p.x, p.y, t.x, t.y);
          if (d <= Math.max(0.3, p.speed * dt)) { this._hit(p, t); continue; }
          p.dx = (t.x - p.x) / d; p.dy = (t.y - p.y) / d;
        }
      }
      const step = p.speed * dt;
      const ox = p.x, oy = p.y;
      p.x += p.dx * step; p.y += p.dy * step; p.travelled += step;
      if (!p.ghost && !Grid.traceClear(ox, oy, p.x, p.y, true)) { this._end(p); continue; }
      if (p.travelled >= p.range) { this._end(p); continue; }
      if (!p.target) {
        const foes = p.team === 'dm' ? S.heroes : S.monsters;
        for (const e of foes) {
          if (e.dead || e.removed || e.escaped || e.disguised) continue;
          if (p.hit && p.hit.has(e.uid)) continue;
          if (dist(p.x, p.y, e.x, e.y) <= p.radius) {
            this._hit(p, e);
            if (!p.pierce) break;
          }
        }
      }
    }
    S.projectiles = S.projectiles.filter(p => !p.dead);
  },
  _hit(p, e) {
    if (p.onHit) p.onHit(e, p); else Combat.damage(e, p.dmg, p.src || {});
    if (p.pierce) p.hit.add(e.uid); else { p.dead = true; if (p.onEnd) p.onEnd(p); }
  },
  _end(p) {
    p.dead = true;
    if (p.onEnd) p.onEnd(p);
    else FX.burst(p.x, p.y, { n: 4, colors: ['#bbb', '#888'], speed: 1.2, life: 0.3, size: 1.5 });
  },
};

/* -----------------------------------------------------------------------------
 * 11. THE DUNGEON HEART
 * -------------------------------------------------------------------------- */
const Heart = {
  cx() { return S.heart.x + 0.5; },
  /** Multiplier on the retaliation pulse (Heart of Thorns doubles it). */
  pulseMul() { return hasPerk('thorns') ? 2 : 1; },
  cy() { return S.heart.y + 0.5; },
  damage(amt, src = {}) {
    if (S.phase !== 'wave' || S.heartHp <= 0 || S.endingT >= 0) return;
    amt = Math.max(1, Math.round(amt));
    S.heartHp -= amt;
    S.heartHitT = 0.25;
    if (S.ws) S.ws.heartDmg += amt;
    S.stats.heartDamage += amt;
    if (hasPerk('blood_tax')) Econ.gain(6, this.cx(), this.cy() - 1);
    FX.text(this.cx() + randRange(-0.3, 0.3), this.cy() - 0.8, '-' + amt, '#ff4d6d', { size: 13 });
    FX.burst(this.cx(), this.cy(), { n: 10, colors: ['#ff2d55', '#ff7a90', '#a0002a'], speed: 2.5, life: 0.6, size: 2.5 });
    FX.shake(Math.min(8, 2 + amt * 0.4));
    SFX.play('heart');
    if (S.heartHp <= 0) {
      if (hasPerk('undying_heart') && !S.undyingUsed) {
        S.undyingUsed = true; S.heartHp = Math.max(1, Math.round(S.heartMax * 0.25));
        for (const h of Spatial.heroesInRadius(this.cx(), this.cy(), 5)) Status.apply(h, 'fear', { dur: 6, x: this.cx(), y: this.cy() });
        FX.ring(this.cx(), this.cy(), { color: '#ff7ad9', r0: 0.5, r1: 5, life: 0.8, width: 4 });
        FX.flash('#ff7ad9', 0.3);
        SFX.play('fear');
        UI.toast('The Undying Heart refuses to break!', 'good');
      } else {
        S.heartHp = 0;
        Game.heartDestroyed();
      }
    }
  },
  /**
   * Pulse damages heroes crowding the Heart AND every hero currently attacking it
   * (ranged attackers included — the Heart lashes back at whoever strikes it).
   */
  update(dt) {
    if (S.heartHitT > 0) S.heartHitT -= dt;
    S.heartPulseT -= dt;
    if (S.heartPulseT <= 0) {
      S.heartPulseT = CFG.heartPulseCd;
      const near = Spatial.heroesInRadius(this.cx(), this.cy(), CFG.heartPulseRange);
      for (const h of S.heroes) {
        if (Spatial.heroAlive(h) && h.state === 'heart' && !near.includes(h)) {
          near.push(h);
          FX.beam(this.cx(), this.cy() - 0.2, h.x, h.y - 0.2, { color: '#ff4d7a', width: 3, life: 0.3, jag: true });
        }
      }
      if (near.length) {
        const mul = this.pulseMul();
        for (const h of near) Combat.damage(h, (CFG.heartPulseDmg + CFG.heartPulsePct * h.maxHp) * mul, { team: 'dm', kind: 'heart', id: 'heart', elem: 'magic' });
        FX.ring(this.cx(), this.cy(), { color: hasPerk('thorns') ? '#ff3b6b' : '#ff7a9a', r0: 0.4, r1: CFG.heartPulseRange + 0.3, life: 0.45, width: 3 });
      }
    }
  },
};

/* -----------------------------------------------------------------------------
 * 12. ECONOMY
 * -------------------------------------------------------------------------- */
const Econ = {
  gain(n, x, y) {
    n = Math.round(n);
    if (n <= 0) return;
    S.gold += n; S.stats.goldEarned += n;
    if (S.ws) S.ws.gold += n;
    if (x !== undefined) FX.text(x, y, '+' + n + 'g', '#ffd84a', { size: 11 });
    SFX.play('gold');
  },
  spend(n) {
    if (S.gold < n) return false;
    S.gold -= n; return true;
  },
  /** An escaping hero makes off with treasure. */
  steal(n, x, y) {
    let amt = n * (hasPerk('blood_money') ? 3 : 1) * (hasPerk('cursed_gold') ? 2 : 1);
    amt = Math.min(S.gold, Math.round(amt));
    S.gold -= amt;
    S.stats.stolen += amt;
    if (S.ws) S.ws.stolen += amt;
    if (x !== undefined) FX.text(x, y, '-' + amt + 'g stolen!', '#ff5a5a', { size: 12 });
    SFX.play('steal');
    if (amt > 0) UI.toast(`A thief escaped with ${amt} gold!`, 'bad');
    return amt;
  },
  bounty(h) { return Math.round(HERO_CLASSES[h.type].gold * heroStatMuls({ elite: h.elite, boss: h.boss }).bounty); },
  waveIncome() {
    let g = CFG.baseIncome + CFG.incomePerWave * S.wave;
    if (hasPerk('midas')) g *= 2;
    return Math.round(g);
  },
};

/* -----------------------------------------------------------------------------
 * 13. BUILDING — placement rules, costs, selling, upgrades, repairs.
 *    Structure = { uid, cat, id, x, y, level, spent, broken, hidden, revealed,
 *                  disarmed, cd, animT, hp?, maxHp?, ent?, data:{} }
 * -------------------------------------------------------------------------- */
const Build = {
  key(cat, id) { return cat + ':' + id; },
  def(cat, id) { return contentDef(cat, id); },
  isUnlocked(cat, id) { return cat === 'wall' || S.unlocked.has(cat + ':' + id); },
  structAt(x, y) { const t = Grid.tile(x, y); return t ? t.s : null; },
  bossPlaced() { return S.structs.find(s => s.cat === 'boss') || null; },

  cost(cat, id) {
    const d = this.def(cat, id);
    let c = d.cost;
    if (cat === 'wall' && hasPerk('architect')) c = Math.ceil(c * 0.5);
    if (cat === 'monster' && id === 'wraith' && hasPerk('spectral_host')) c = Math.round(c * 0.6);
    return c;
  },
  upgradable(s) { return s && (s.cat === 'trap' || s.cat === 'monster' || s.cat === 'boss') && s.level < 3; },
  upgradeCost(s) {
    if (!this.upgradable(s)) return null;
    let c = this.def(s.cat, s.id).cost * CFG.upgradeRate[s.level];
    if (hasPerk('tinkerer')) c *= 0.65;
    return Math.max(1, Math.round(c));
  },
  repairCost(s) {
    if (!s || !s.broken) return 0;
    if (hasPerk('trapmaster')) return 0;
    return Math.max(1, Math.ceil(this.def(s.cat, s.id).cost * CFG.repairRate));
  },
  totalRepairCost() { return S.structs.filter(s => s.broken).reduce((a, s) => a + this.repairCost(s), 0); },
  sellValue(x, y) {
    const t = Grid.tile(x, y);
    if (!t) return 0;
    const rate = hasPerk('salvager') ? 1 : CFG.sellRate;
    if (t.s) return Math.floor(t.s.spent * rate);
    if (t.type === T.WALL) return t.rubble ? 0 : Math.floor(t.paid * rate);
    return 0;
  },

  /** Placement validation (also used for the hover ghost). @returns {ok, reason} */
  canPlace(cat, id, x, y) {
    if (S.phase !== 'build') return { ok: false, reason: 'You can only build between waves.' };
    const t = Grid.tile(x, y);
    if (!t) return { ok: false, reason: 'Out of bounds.' };
    const d = this.def(cat, id);
    if (!d) return { ok: false, reason: 'Unknown item.' };
    if (!this.isUnlocked(cat, id)) return { ok: false, reason: `${d.name} is still locked.` };
    if (t.type === T.ENTRANCE || t.type === T.HEART) return { ok: false, reason: 'Cannot build on the Entrance or the Heart.' };
    if (t.s) return { ok: false, reason: 'Tile already occupied.' };
    const floorOnly = () => t.type === T.FLOOR ? null : { ok: false, reason: 'Must be placed on open floor.' };
    let bad = null;
    if (cat === 'wall') {
      bad = floorOnly();
      if (!bad && dist(x, y, S.entrance.x, S.entrance.y) < 1.5) bad = { ok: false, reason: 'Keep the entrance clear.' };
      if (!bad && !Path.reachable(Grid.idx(x, y))) bad = { ok: false, reason: 'That would seal off the Heart! Heroes must always have a path.', blocks: true };
    } else if (cat === 'trap' && d.place === 'wall') {
      if (t.type !== T.WALL && t.type !== T.ROCK) bad = { ok: false, reason: 'Arrow Walls must be mounted on a wall.' };
      else if (!DIRS4.some(([dx, dy]) => { const n = Grid.tile(x + dx, y + dy); return n && n.type !== T.WALL && n.type !== T.ROCK; }))
        bad = { ok: false, reason: 'The wall must face an open corridor.' };
    } else {
      bad = floorOnly();
      if (!bad && cat === 'boss' && this.bossPlaced()) bad = { ok: false, reason: 'Only one boss may guard the dungeon.' };
    }
    if (bad) return bad;
    if (S.gold < this.cost(cat, id)) return { ok: false, reason: 'Not enough gold.', gold: true };
    return { ok: true };
  },

  makeStruct(cat, id, x, y, cost) {
    const d = this.def(cat, id);
    const s = {
      uid: nextUid(), cat, id, x, y, level: 1, spent: cost, broken: false,
      hidden: false, revealed: false, disarmed: false, cd: 0, animT: 0, ent: null, data: {},
    };
    if (cat === 'object' && id === 'barricade') { s.maxHp = d.hp * (hasPerk('reinforced') ? 2 : 1); s.hp = s.maxHp; }
    if (cat === 'trap') s.hidden = !!d.hidden || hasPerk('hidden_depths');
    return s;
  },

  place(cat, id, x, y) {
    const chk = this.canPlace(cat, id, x, y);
    if (!chk.ok) {
      SFX.play('error');
      FX.ring(x + 0.5, y + 0.5, { color: '#ff4040', r0: 0.2, r1: 0.8, life: 0.35, width: 3 });
      if (chk.blocks) { FX.flashTile(x, y, '#ff2020'); }
      return chk;
    }
    const cost = this.cost(cat, id);
    Econ.spend(cost);
    const t = Grid.tile(x, y);
    if (cat === 'wall') {
      t.type = T.WALL; t.paid = cost; t.rubble = false;
    } else {
      const s = this.makeStruct(cat, id, x, y, cost);
      t.s = s; S.structs.push(s);
      if (cat === 'monster' || cat === 'boss') s.ent = Monsters.create(s);
      if (cat === 'trap' && Traps.onPlace) Traps.onPlace(s);
      if (cat === 'object' && Objects.onPlace) Objects.onPlace(s);
    }
    Path.bump();
    Light.recompute();
    SFX.play('place');
    FX.burst(x + 0.5, y + 0.5, { n: 10, colors: ['#c9b99a', '#8a8296', '#fff2c0'], speed: 1.6, life: 0.4, size: 2 });
    return { ok: true };
  },

  /** Remove a structure from the world (no refund). */
  removeStruct(s) {
    const t = Grid.tile(s.x, s.y);
    if (t && t.s === s) t.s = null;
    S.structs = S.structs.filter(o => o !== s);
    if (s.ent) { s.ent.removed = true; S.monsters = S.monsters.filter(m => m !== s.ent); }
    if (s.cat === 'object' && s.id === 'lair') for (const m of S.monsters) if (m.lair === s) m.removed = true;
    S.monsters = S.monsters.filter(m => !m.removed);
    Path.bump();
    Light.recompute();
  },

  sell(x, y) {
    if (S.phase !== 'build') return false;
    const t = Grid.tile(x, y);
    if (!t) return false;
    const val = this.sellValue(x, y);
    if (t.s) {
      this.removeStruct(t.s);
    } else if (t.type === T.WALL) {
      t.type = T.FLOOR; t.paid = 0; t.rubble = false;
      Path.bump();
    } else return false;
    if (val > 0) { S.gold += val; FX.text(x + 0.5, y, '+' + val + 'g', '#ffd84a', { size: 11 }); }
    SFX.play('sell');
    FX.burst(x + 0.5, y + 0.5, { n: 8, colors: ['#ffd84a', '#c9b99a'], speed: 1.5, life: 0.4, size: 2 });
    return true;
  },

  upgrade(x, y) {
    const s = this.structAt(x, y);
    if (S.phase !== 'build' || !this.upgradable(s)) return false;
    const c = this.upgradeCost(s);
    if (!Econ.spend(c)) { SFX.play('error'); UI.toast('Not enough gold to upgrade.', 'warn'); return false; }
    s.level++; s.spent += c;
    if (s.ent && Monsters.refreshStats) Monsters.refreshStats(s.ent);
    SFX.play('upgrade');
    FX.ring(x + 0.5, y + 0.5, { color: '#ffd84a', r0: 0.2, r1: 1.0, life: 0.5, width: 3 });
    FX.burst(x + 0.5, y + 0.5, { n: 16, colors: ['#ffd84a', '#fff2a0'], speed: 2, life: 0.6, size: 2, grav: -2 });
    return true;
  },

  repair(x, y) {
    const s = this.structAt(x, y);
    if (S.phase !== 'build' || !s || !s.broken) return false;
    const c = this.repairCost(s);
    if (!Econ.spend(c)) { SFX.play('error'); UI.toast('Not enough gold to repair.', 'warn'); return false; }
    this._fix(s);
    SFX.play('upgrade');
    return true;
  },
  repairAll() {
    if (S.phase !== 'build') return 0;
    let n = 0;
    for (const s of S.structs) {
      if (!s.broken) continue;
      const c = this.repairCost(s);
      if (S.gold < c) continue;
      Econ.spend(c); this._fix(s); n++;
    }
    if (n) SFX.play('upgrade'); else SFX.play('error');
    return n;
  },
  _fix(s) {
    s.broken = false; s.cd = 0;
    if (s.maxHp) s.hp = s.maxHp;
    FX.burst(s.x + 0.5, s.y + 0.5, { n: 10, colors: ['#9fe8ff', '#ffffff'], speed: 1.5, life: 0.5, size: 2, grav: -2 });
    Path.bump();
  },
};
