// Minimal stand-ins used ONLY by `node build.mjs --dev` for modules that don't exist yet,
// so each module can be exercised in a browser before the others are finished.
// Each block starts with a "//@@ Name" marker; build.mjs includes a block only if no
// source file defines `const Name =` at the start of a line.

//@@ Heroes
const Heroes = {
  create(cls, o = {}) {
    const c = HERO_CLASSES[cls];
    const h = makeEntity('hero', cls, S.entrance.x + 0.5, S.entrance.y + 0.5);
    h.hp = h.maxHp = c.hp; h.dmg = c.dmg; h.speed = c.speed; h.elite = !!o.elite; h.boss = o.boss || null; h.loot = 0;
    h.name = c.name; h.state = 'advance'; return h;
  },
  spawnParty(members) {
    for (const m of members) { const h = this.create(m.cls, m); S.heroes.push(h); S.ws.spawned++; }
    return {};
  },
  update(dt) {
    for (const h of S.heroes) {
      if (h.dead) continue;
      if (!h.path) h.path = Path.astar(h.x, h.y, S.heart.x, S.heart.y, Path.baseCost) || [];
      const n = h.path[0];
      if (!n) { h.atkT -= dt; if (h.atkT <= 0) { h.atkT = 1; Heart.damage(3); } continue; }
      const tx = n.x + 0.5, ty = n.y + 0.5, d = dist(h.x, h.y, tx, ty), sp = h.speed * Status.speedMul(h) * dt;
      if (d <= sp) { h.x = tx; h.y = ty; h.path.shift(); if (h.path.length === 1 && h.path[0].x === S.heart.x && h.path[0].y === S.heart.y) h.path.shift(); }
      else { h.x += (tx - h.x) / d * sp; h.y += (ty - h.y) / d * sp; }
    }
  },
  onWaveStart() {}, onWaveEnd() {}, onDeath() {}, preventDeath() { return false; },
  stateLabel(h) { return h.state; },
};

//@@ Traps
const Traps = {
  onPlace() {}, update() {}, onWaveStart() {}, onWaveEnd() {}, reveal(s) { s.revealed = true; }, disarm(s) { s.disarmed = true; },
  resetAll() {}, describe() { return []; }, stats() { return {}; },
};

//@@ Objects
const Objects = {
  onPlace() {}, update() {}, onWaveStart() {}, onWaveEnd() {}, loot(s) { s.data.empty = true; return Lures.chestValue(); }, describe() { return []; },
};

//@@ Monsters
const Monsters = {
  create(s) {
    const d = contentDef(s.cat, s.id);
    const m = makeEntity('dm', s.id, s.x + 0.5, s.y + 0.5);
    m.post = s; m.homeX = m.x; m.homeY = m.y; m.hp = m.maxHp = d.hp; m.dmg = d.dmg; m.isBoss = s.cat === 'boss'; m.level = s.level;
    S.monsters.push(m); return m;
  },
  summon() { return null; }, refreshStats() {}, update() {}, idle() {}, onWaveStart() {}, onWaveEnd() {
    for (const m of S.monsters) { m.dead = false; m.hp = m.maxHp; }
  }, onDeath() {}, alarm() {}, stateLabel(m) { return m.state; }, describe() { return []; }, stats() { return {}; },
};

//@@ Waves
const Waves = {
  generate(n) { return { wave: n, parties: [{ members: [{ cls: 'warrior' }, { cls: 'rogue' }], delay: 0 }], boss: null, counts: { warrior: 1, rogue: 1 }, elites: 0, total: 2, threat: 5, guildNotes: [] }; },
  begin(p) { this._q = p.parties.slice(); this._t = 0; },
  update(dt) { this._t -= dt; if (this._q.length && this._t <= 0) { const p = this._q.shift(); Heroes.spawnParty(p.members); this._t = 5; } },
  done() { return !this._q || !this._q.length; },
  remaining() { return this._q ? this._q.reduce((a, p) => a + p.members.length, 0) : 0; },
  current: null,
};

//@@ Perks
const Perks = {
  roll() { return ['treasury', 'mend', 'architect']; },
  take(id) { S.perks[id] = (S.perks[id] || 0) + 1; S.perkOrder.push(id); },
  available() { return PERKS; },
};

//@@ Powers
const Powers = {
  lastReason: '',
  onWaveStart() {}, update(dt) { S.mana = Math.min(S.manaMax, S.mana + CFG.manaRegen * dt); },
  manaRegen() { return CFG.manaRegen; },
  cost(id) { return POWERS[id].mana; }, canCast() { return { ok: false, reason: 'stub' }; }, cast() { return false; }, ready() { return false; },
  cooldown() { return 0; }, cooldownFrac() { return 0; },
};

//@@ Render
const Render = {
  init(c) { this.c = c; }, resize() {}, draw() {},
  screenToWorld() { return { wx: 0, wy: 0, tx: 0, ty: 0, inside: false }; },
};

//@@ Sprites
const Sprites = { iconURL() { return ''; } };

//@@ UI
const UI = {
  init() {}, update() {}, onPhase() {}, showTitle() {}, showReward() {}, showGameOver() {}, refresh() {},
  toast(m) { console.log('[toast] ' + m); },
};
