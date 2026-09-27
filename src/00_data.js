'use strict';
/* =============================================================================
 *  DUNGEON HEART — a roguelike reverse dungeon crawler
 *  -----------------------------------------------------------------------------
 *  You are the Dungeon Master. Build a deadly maze, fill it with traps and
 *  monsters, and keep invading adventurers away from your Dungeon Heart.
 *
 *  This file is assembled from ordered sections (see build.mjs):
 *    00 data      — utilities, tuning constants and ALL content definitions
 *    05 engine    — grid, pathfinding, danger memory, light, spatial queries,
 *                   status effects, combat, projectiles, heart, economy, building
 *    08 fx        — particles / floating text / screen shake + synthesized audio
 *    20 heroes    — adventurer AI (parties, greed, adaptive pathing, classes)
 *    30 traps     — trap & dungeon-object behaviour
 *    31 monsters  — monster & dungeon-boss AI
 *    40 director  — wave generation, perks, Dungeon Master powers
 *    50 render    — procedural pixel-art sprites & canvas drawing
 *    60 ui        — DOM interface, tooltips, input
 *    90 game      — phase state machine (build → wave → reward), saving
 *    99 main      — boot + fixed-timestep main loop
 *
 *  Conventions
 *    • World coordinates are in TILE units (floats). Tile (tx,ty) spans
 *      [tx,tx+1)×[ty,ty+1); its centre is (tx+0.5, ty+0.5).
 *    • All durations are seconds of SIMULATION time (speed controls scale it).
 *    • `S` is the single mutable run-state object (recreated each run).
 * ========================================================================== */

/* -----------------------------------------------------------------------------
 * 1. UTILITIES
 * -------------------------------------------------------------------------- */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const randRange = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const chance = p => Math.random() < p;
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
function shuffle(arr, r = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}
/** Small, fast seeded PRNG (used where results must be reproducible, e.g. wave previews). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Weighted random pick: items = [{w, ...}] or with weightFn. */
function weightedPick(items, weightFn = it => it.w, r = Math.random) {
  let total = 0;
  for (const it of items) total += Math.max(0, weightFn(it));
  if (total <= 0) return items[Math.floor(r() * items.length)];
  let x = r() * total;
  for (const it of items) { x -= Math.max(0, weightFn(it)); if (x <= 0) return it; }
  return items[items.length - 1];
}
let _uid = 1;
const nextUid = () => _uid++;
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = n => Math.round(n).toLocaleString('en-US');

/* -----------------------------------------------------------------------------
 * 2. TUNING CONSTANTS
 * -------------------------------------------------------------------------- */
const TS = 32;             // pixels per tile on the (unscaled) canvas
const SIM_DT = 1 / 60;     // fixed simulation step

const CFG = {
  startGold: 320,
  heartHp: 100,
  heartPulseDmg: 12,       // flat damage per pulse to heroes adjacent to the Heart…
  heartPulsePct: 0.12,     // …plus this fraction of each hero's max HP, so leaks are short and sharp
  heartPulseCd: 1.0,
  heartPulseRange: 1.6,    // from Heart tile centre
  heartRegenPerWave: 8,    // Heart HP restored after each survived wave
  sellRate: 0.6,           // fraction refunded when selling
  repairRate: 0.3,         // repair cost as fraction of base cost
  upgradeRate: [0, 0.6, 0.9], // upgrade cost to reach level 2 / 3 (index = current level) × base cost
  levelStatMul: [1, 1, 1.35, 1.75], // monster/boss stat multiplier by level (index = level)
  manaMax: 100,
  manaStart: 40,           // mana at the start of each wave
  manaRegen: 1.25,         // per second during waves
  torchRadius: 3.2,
  torchExposed: 0.25,      // heroes in torchlight take +25% damage
  dangerDecay: 0.55,       // danger memory multiplier applied between waves
  dangerDecayMastermind: 0.3,
  dangerCap: 30,
  // Grid size by "tier". Tier = floor((wave-1)/10): the dungeon expands after waves 10, 20, 30.
  gridSizes: [[20, 14], [24, 16], [28, 18], [32, 20]],
  baseIncome: 55,
  incomePerWave: 8,
  chestBaseValue: 25,
  chestValuePerWave: 5,
  corpseLife: 25,
  lureRadius: 5,
  // Hero scaling per wave (applied to class base stats)
  heroHpPerWave: 0.085,
  heroDmgPerWave: 0.05,
  bountyPerWave: 0.07,
  eliteHpMul: 1.8, eliteDmgMul: 1.3, eliteSpeedMul: 1.08, eliteBountyMul: 2.5, eliteTrapResist: 0.85,
  heroBossBountyMul: 10,
};

/* -----------------------------------------------------------------------------
 * 3. CONTENT DEFINITIONS
 *    Every entry here is fully implemented by the gameplay modules.
 *    `unlock` = the wave whose BUILD phase first offers the item (1 = start).
 *    Perks may unlock items earlier.
 * -------------------------------------------------------------------------- */

/** Tile terrain types. */
const T = { FLOOR: 0, WALL: 1, ROCK: 2, ENTRANCE: 3, HEART: 4 };

/** Player-built wall. */
const WALL_DEF = {
  name: 'Wall', cost: 6, unlock: 1,
  desc: 'Solid stone. Shape a maze to lengthen the heroes’ path. You must always leave a route to the Heart.',
};

/* ---- Adventurer classes -------------------------------------------------- */
// hp/dmg are wave-1 values (scaled per wave). speed in tiles/sec. range in tiles.
// threat  = wave-budget cost.            gold    = base kill bounty.
// dangerW = weight of danger memory in pathing.  trapW = weight of KNOWN traps in pathing.
// greed   = chance to go for a chest that comes within lure radius.
const HERO_CLASSES = {
  warrior: {
    name: 'Warrior', role: 'Vanguard', color: '#d0873a',
    hp: 120, speed: 1.5, dmg: 10, atkCd: 1.0, range: 1.2, heartDmg: 3,
    gold: 12, threat: 3, dangerW: 0.3, trapW: 0.15, greed: 0.35, minWave: 1,
    engageR: 2.5, // actively charges monsters this close
    desc: 'High HP. Charges monsters in melee and walks straight through traps.',
  },
  rogue: {
    name: 'Rogue', role: 'Thief', color: '#5fae5a',
    hp: 60, speed: 2.4, dmg: 8, atkCd: 0.7, range: 1.2, heartDmg: 2,
    gold: 10, threat: 2, dangerW: 0.8, trapW: 1.0, greed: 1.0, minWave: 1,
    detect: 0.35,   // chance per second to spot each hidden trap within detectR
    detectR: 2.2,
    disarm: 0.5,    // chance to successfully disarm a known trap on the path
    disarmTime: 1.6,
    desc: 'Fast. Spots and disarms hidden traps, and always goes for treasure — then runs for the exit with it.',
  },
  ranger: {
    name: 'Ranger', role: 'Scout', color: '#3f9c8f',
    hp: 65, speed: 1.8, dmg: 10, atkCd: 1.1, range: 5, ranged: true, proj: 'arrow', heartDmg: 2,
    gold: 11, threat: 2, dangerW: 0.9, trapW: 1.0, greed: 0.5, minWave: 2,
    revealR: 3,     // automatically reveals hidden traps within this radius
    desc: 'Shoots monsters from range and reveals hidden traps around them.',
  },
  mage: {
    name: 'Mage', role: 'Arcanist', color: '#6a6cf0',
    hp: 50, speed: 1.4, dmg: 15, atkCd: 1.4, range: 4.5, ranged: true, proj: 'bolt', heartDmg: 3,
    gold: 13, threat: 3, dangerW: 1.0, trapW: 1.0, greed: 0.45, minWave: 3,
    blastCd: 12,       // seconds between wall-blast attempts
    blastTime: 1.2,    // channel time
    blastMinGain: 6,   // only blasts a wall if it shortens the route by ≥ this many tiles
    desc: 'Ranged magic. Every so often blasts through a wall to shortcut your maze.',
  },
  cleric: {
    name: 'Cleric', role: 'Healer', color: '#e8e0b0',
    hp: 75, speed: 1.4, dmg: 5, atkCd: 1.2, range: 1.2, holy: true, heartDmg: 2,
    gold: 12, threat: 3, dangerW: 1.15, trapW: 1.1, greed: 0.3, minWave: 4,
    healAmt: 12, healCd: 2.0, healR: 3.5,
    desc: 'Heals the most wounded nearby ally. Weak attacks, but holy damage hurts undead double.',
  },
  paladin: {
    name: 'Paladin', role: 'Holy Knight', color: '#f0d060',
    hp: 180, speed: 1.3, dmg: 14, atkCd: 1.1, range: 1.2, holy: true, heartDmg: 4,
    gold: 20, threat: 5, dangerW: 0.5, trapW: 0.4, greed: 0.25, minWave: 8,
    engageR: 2.5, fearImmune: true, fireResist: 0.5,
    lohPct: 0.5, // Lay on Hands: once per wave, saves an ally within 4 tiles from death, healing to 50%
    desc: 'Immune to Fear, resists fire, and once per wave saves a dying ally with Lay on Hands.',
  },
  miner: {
    name: 'Dwarf Miner', role: 'Sapper', color: '#b07048',
    hp: 105, speed: 1.25, dmg: 9, atkCd: 1.0, range: 1.2, heartDmg: 3,
    gold: 16, threat: 4, dangerW: 0.7, trapW: 0.8, greed: 0.7, minWave: 12,
    digTime: 2.0, pitImmune: true,
    desc: 'Tunnels straight through your walls and never falls into pits.',
  },
};

/* ---- Hero bosses (every 5th wave, in rotation) --------------------------- */
const HERO_BOSSES = {
  champion: {
    name: 'Sir Aldric the Unbroken', title: 'The Champion', base: 'warrior',
    hpMul: 8, dmgMul: 2.0, speedMul: 0.95, ability: 'Shield Bash', abilityCd: 6,
    desc: 'Every 6s slams the ground, stunning monsters within 1.8 tiles for 2s and dealing heavy damage.',
  },
  archmage: {
    name: 'Archmage Velyra', title: 'The Archmage', base: 'mage',
    hpMul: 6.5, dmgMul: 1.8, speedMul: 1.0, ability: 'Blink', abilityCd: 7,
    desc: 'Every 7s teleports up to 4 tiles closer to the Heart — straight through walls.',
  },
  saint: {
    name: 'High Priestess Seraphine', title: 'The Saint', base: 'cleric',
    hpMul: 7, dmgMul: 1.6, speedMul: 1.0, ability: 'Sanctuary', abilityCd: 9,
    desc: 'Every 9s heals all allies within 5 tiles for 40 HP and cleanses their ailments.',
  },
  shadow: {
    name: 'Vex, the Shadow', title: 'The Shadow', base: 'rogue',
    hpMul: 5.5, dmgMul: 1.8, speedMul: 1.05, ability: 'Shadowstep', abilityCd: 8,
    desc: 'Every 8s disarms every trap within 3 tiles and turns invisible to monsters for 3s.',
  },
};
const HERO_BOSS_ORDER = ['champion', 'archmage', 'saint', 'shadow'];

/* ---- Traps ----------------------------------------------------------------
 * place: 'floor' (on an empty floor tile) or 'wall' (mounted on a wall/rock tile that touches floor)
 * hidden: heroes do not know about it until it triggers or is detected.
 * Array stats are per level [L1, L2, L3].                                     */
const TRAPS = {
  spike: {
    name: 'Spike Trap', cost: 30, place: 'floor', hidden: true, unlock: 1,
    dmg: [24, 36, 52], cd: [1.8, 1.5, 1.2],
    desc: 'Hidden. Impales heroes that step on it.',
  },
  arrow: {
    name: 'Arrow Wall', cost: 45, place: 'wall', hidden: false, unlock: 1,
    dmg: [14, 20, 28], cd: [1.6, 1.35, 1.1], range: [6, 7, 8],
    desc: 'Mounted on a wall. Shoots the nearest hero in a straight line (any direction) within range.',
  },
  pit: {
    name: 'Pit Trap', cost: 40, place: 'floor', hidden: true, unlock: 1, oneUse: true,
    killHp: [70, 110, 160], dmg: [35, 50, 70],
    desc: 'Hidden, one use. Swallows a weakened hero whole (HP ≤ threshold); stronger heroes take heavy damage and are stunned.',
  },
  slime: {
    name: 'Slime Floor', cost: 20, place: 'floor', hidden: false, unlock: 1,
    slow: [0.4, 0.52, 0.64], linger: 1.5,
    desc: 'Heroes crossing it are slowed, and stay slowed briefly after leaving.',
  },
  fire: {
    name: 'Fire Vent', cost: 50, place: 'floor', hidden: true, unlock: 2,
    burn: [6, 9, 13], burnDur: 4, cd: [4, 3.4, 2.8],
    desc: 'Hidden. Erupts when stepped on, setting heroes on and beside it ablaze.',
  },
  alarm: {
    name: 'Alarm Rune', cost: 35, place: 'floor', hidden: true, unlock: 3,
    radius: [6, 7, 8], buffDur: [8, 10, 12], cd: 10,
    desc: 'Hidden. When triggered, monsters nearby are enraged (+50% damage, +30% speed) and rush to the rune.',
  },
  boulder: {
    name: 'Boulder', cost: 70, place: 'floor', hidden: false, unlock: 4,
    dmg: [45, 65, 90], cd: [14, 11, 8], range: 8,
    desc: 'Rolls down a straight corridor at the first hero in line, crushing everyone in its path. Re-forms after a cooldown.',
  },
  teleport: {
    name: 'Teleporter Pad', cost: 60, place: 'floor', hidden: true, unlock: 6,
    cd: [8, 6.5, 5],
    desc: 'Hidden. Sends an advancing hero all the way back to the entrance.',
  },
};

/* ---- Monsters ------------------------------------------------------------- */
// guard = sight/aggro radius around their post. leash = max distance from post before giving up.
const MONSTERS = {
  skeleton: {
    name: 'Skeleton', cost: 25, unlock: 1, undead: true,
    hp: 55, dmg: 8, atkCd: 1.0, range: 1.1, speed: 1.8, guard: 3.5, leash: 6,
    respawn: 10,
    desc: 'Cheap undead guard. Reassembles itself 10s after being destroyed.',
  },
  goblin: {
    name: 'Goblin', cost: 20, unlock: 1,
    hp: 38, dmg: 6, atkCd: 0.6, range: 1.1, speed: 3.0, guard: 4.5, leash: 7,
    desc: 'Fast and frail. Quick to chase down stragglers.',
  },
  orc: {
    name: 'Orc Brute', cost: 60, unlock: 2,
    hp: 220, dmg: 18, atkCd: 1.4, range: 1.2, speed: 1.3, guard: 2.5, leash: 5,
    desc: 'Tank. Heavy blows knock heroes back.',
  },
  spider: {
    name: 'Spider', cost: 45, unlock: 3,
    hp: 60, dmg: 7, atkCd: 1.0, range: 1.1, speed: 2.3, guard: 4, leash: 6,
    webCd: 3.5, webRange: 3.5, webSlow: 0.5, webDur: 2.5,
    desc: 'Spits webs that slow heroes from range, then closes in.',
  },
  imp: {
    name: 'Imp', cost: 50, unlock: 4,
    hp: 42, dmg: 11, atkCd: 1.3, range: 4, ranged: true, speed: 2.2, guard: 4.5, leash: 6,
    desc: 'Hurls fire bolts from range and keeps its distance.',
  },
  wraith: {
    name: 'Wraith', cost: 70, unlock: 7, undead: true, phasing: true,
    hp: 75, dmg: 12, atkCd: 1.1, range: 1.1, speed: 2.0, guard: 5.5, leash: 8,
    drain: 0.5, // heals for this fraction of damage dealt
    desc: 'Drifts straight through walls and drains life from its victims.',
  },
  mimic: {
    name: 'Mimic', cost: 55, unlock: 9, lure: true,
    hp: 160, dmg: 15, atkCd: 1.2, range: 1.1, speed: 1.1, guard: 2, leash: 3,
    ambushDmg: 60,
    desc: 'Looks exactly like a treasure chest and lures greedy heroes. Ambushes with a devastating bite.',
  },
};

/* ---- Dungeon bosses (only one may be placed) ------------------------------ */
const BOSSES = {
  minotaur: {
    name: 'Minotaur', cost: 250, unlock: 6,
    hp: 650, dmg: 30, atkCd: 1.3, range: 1.25, speed: 1.6, guard: 5, leash: 8,
    ability: 'Charge', abilityCd: 8, chargeDmg: 50, chargeRange: 6,
    desc: 'Charges in a straight line at heroes up to 6 tiles away, trampling and stunning everyone in the way.',
  },
  lich: {
    name: 'Lich', cost: 300, unlock: 11, undead: true,
    hp: 420, dmg: 18, atkCd: 1.5, range: 5, ranged: true, speed: 1.4, guard: 5.5, leash: 8,
    ability: 'Raise Dead', abilityCd: 12, raiseCount: 2, raiseRange: 6,
    desc: 'Casts shadow bolts and raises fallen heroes nearby as Skeletons that fight for you.',
  },
  dragon: {
    name: 'Dragon', cost: 400, unlock: 16,
    hp: 900, dmg: 28, atkCd: 1.6, range: 1.35, speed: 1.2, guard: 5, leash: 7,
    ability: 'Fire Breath', abilityCd: 10, breathDmg: 45, breathLen: 5,
    desc: 'Breathes a wide cone of fire 5 tiles long, torching whole parties.',
  },
};

/* ---- Objects / room tiles ------------------------------------------------- */
const OBJECTS = {
  chest: {
    name: 'Treasure Chest', cost: 25, unlock: 1, lure: true,
    desc: 'Lures greedy heroes within 5 tiles. If a hero escapes carrying its treasure, you lose that gold.',
  },
  torch: {
    name: 'Torch', cost: 15, unlock: 1,
    desc: 'Heroes in its light are Exposed (+25% damage taken) — but hidden traps in the light are visible to them.',
  },
  barricade: {
    name: 'Barricade', cost: 30, unlock: 1, hp: 160,
    desc: 'A breakable wall. Heroes must smash through it (160 HP). Does not count as blocking the path.',
  },
  well: {
    name: 'Mana Well', cost: 60, unlock: 6, regen: 0.5,
    desc: '+0.5 mana per second during waves.',
  },
  lair: {
    name: 'Monster Lair', cost: 80, unlock: 7, spawnCd: 12, maxAlive: 3,
    desc: 'During waves, spawns a Goblin or Skeleton every 12s (max 3 alive).',
  },
};

/** Build-panel tabs → list of [category, id]. */
const BUILD_TABS = [
  { id: 'walls', name: 'Walls', items: [['wall', 'wall'], ['object', 'barricade']] },
  { id: 'traps', name: 'Traps', items: Object.keys(TRAPS).map(k => ['trap', k]) },
  { id: 'monsters', name: 'Monsters', items: Object.keys(MONSTERS).map(k => ['monster', k]) },
  { id: 'bosses', name: 'Bosses', items: Object.keys(BOSSES).map(k => ['boss', k]) },
  { id: 'objects', name: 'Objects', items: [['object', 'chest'], ['object', 'torch'], ['object', 'well'], ['object', 'lair']] },
];

/** Look up a content definition by category and id. */
function contentDef(cat, id) {
  switch (cat) {
    case 'wall': return WALL_DEF;
    case 'trap': return TRAPS[id];
    case 'monster': return MONSTERS[id];
    case 'boss': return BOSSES[id];
    case 'object': return OBJECTS[id];
    case 'hero': return HERO_CLASSES[id];
    case 'heroBoss': return HERO_BOSSES[id];
    default: return null;
  }
}

/* ---- Dungeon Master powers ------------------------------------------------ */
// target: 'tile' (click a tile), 'hero' (click a hero), 'none' (instant)
const POWERS = {
  collapse: {
    name: 'Collapse', key: 'Q', icon: '⛰️', mana: 30, cd: 4, target: 'tile', dmg: 40,
    desc: 'Collapse an empty floor tile into a rubble wall. Heroes on it take 40 damage and are shoved aside. Cannot seal off the Heart.',
  },
  fear: {
    name: 'Fear', key: 'W', icon: '😱', mana: 25, cd: 2, target: 'hero', dur: 4,
    desc: 'Terrify one hero: they flee toward the entrance for 4s (and may leave the dungeon). Paladins and hero bosses are immune.',
  },
  lightning: {
    name: 'Lightning Strike', key: 'E', icon: '⚡', mana: 40, cd: 3, target: 'tile', dmg: 65, radius: 1.25, stun: 0.6,
    desc: 'Smite heroes within 1.25 tiles for 65 damage and stun them briefly.',
  },
  reset: {
    name: 'Reset Traps', key: 'R', icon: '🔄', mana: 50, cd: 12, target: 'none',
    desc: 'Instantly rearm every trap: clears cooldowns, repairs broken traps and re-hides revealed ones.',
  },
};

/* ---- Perks ------------------------------------------------------------------
 * rarity: common | rare | epic | legendary
 * req:       [cat,id] — only offered once that content is unlocked
 * unlocks:   [[cat,id],...] — unlocks content immediately; only offered while at least one is still locked
 * repeatable: may be offered/taken multiple times
 * tradeoff:  flagged in the UI as a double-edged perk                          */
const RARITY = {
  common: { name: 'Common', color: '#b9b9b9', weight: 58 },
  rare: { name: 'Rare', color: '#4aa3ff', weight: 28 },
  epic: { name: 'Epic', color: '#b86bff', weight: 11 },
  legendary: { name: 'Legendary', color: '#ffae33', weight: 3 },
};

const PERKS = [
  // ---- Common ----
  { id: 'rusted_blades', name: 'Rusted Blades', rarity: 'common', icon: '🗡️', desc: 'Spike Traps inflict Bleed: 4 damage/sec for 4s.' },
  { id: 'architect', name: 'Architect', rarity: 'common', icon: '📐', desc: 'Walls cost 50% less.' },
  { id: 'whetstone', name: 'Whetstone', rarity: 'common', icon: '🔪', desc: 'Spike Traps and Pit Traps deal +40% damage.' },
  { id: 'sticky', name: 'Sticky Situation', rarity: 'common', icon: '🟢', desc: 'Slime slows 15% more and lingers 2s longer.', req: ['trap', 'slime'] },
  { id: 'bone_yard', name: 'Bone Yard', rarity: 'common', icon: '💀', desc: 'Skeletons reassemble after 4s instead of 10s.', req: ['monster', 'skeleton'] },
  { id: 'sticky_fingers', name: 'Sticky Fingers', rarity: 'common', icon: '🪙', desc: 'Each Goblin hit pilfers 2 gold for you.', req: ['monster', 'goblin'] },
  { id: 'tinkerer', name: 'Tinkerer', rarity: 'common', icon: '🔧', desc: 'Upgrades cost 35% less.' },
  { id: 'blood_tax', name: 'Blood Tax', rarity: 'common', icon: '🩸', desc: 'Gain 6 gold whenever the Heart takes damage.' },
  { id: 'mana_spring', name: 'Mana Spring', rarity: 'common', icon: '💧', desc: '+40% mana regeneration during waves.' },
  { id: 'salvager', name: 'Salvager', rarity: 'common', icon: '♻️', desc: 'Selling refunds 100% of what you spent.' },
  { id: 'quick_reload', name: 'Quick Reload', rarity: 'common', icon: '🏹', desc: 'Arrow Walls reload 30% faster.' },
  { id: 'kindling', name: 'Kindling', rarity: 'common', icon: '🔥', desc: 'Fire Vent burns last 3s longer and deal +3 damage/sec.', req: ['trap', 'fire'] },
  { id: 'reinforced', name: 'Reinforced Stone', rarity: 'common', icon: '🧱', desc: 'Mages and Miners take twice as long to break walls. Barricades have double HP.' },
  { id: 'scavenger', name: 'Scavenger', rarity: 'common', icon: '💰', desc: 'Slain heroes drop 50% more loot.' },
  { id: 'treasury', name: 'Royal Treasury', rarity: 'common', icon: '👑', desc: 'Gain 150 gold immediately.', repeatable: true },
  { id: 'mend', name: 'Mend the Heart', rarity: 'common', icon: '❤️', desc: 'Restore 35 Heart HP and gain +10 max Heart HP.', repeatable: true },
  // ---- Rare ----
  { id: 'echoing_halls', name: 'Echoing Halls', rarity: 'rare', icon: '📯', desc: 'Arrow Walls fire twice per volley.' },
  { id: 'necromancy', name: 'Necromancy', rarity: 'rare', icon: '⚰️', desc: '25% chance a slain hero rises as a Skeleton that fights for you for the rest of the wave.' },
  { id: 'greedy_gods', name: 'Greedy Gods', rarity: 'rare', icon: '💎', desc: 'Chests and Mimics lure heroes from twice the distance.' },
  { id: 'paranoia', name: 'Paranoia', rarity: 'rare', icon: '👁️', desc: 'For the first 10s of each wave, heroes ignore danger memory and known traps when pathing.' },
  { id: 'hidden_depths', name: 'Hidden Depths', rarity: 'rare', icon: '🌑', desc: 'All traps start hidden, and Rogues’ detection chance is halved.' },
  { id: 'web_weaver', name: 'Web Weaver', rarity: 'rare', icon: '🕸️', desc: 'Spider webs root for 1s and splash every hero within 1 tile.', req: ['monster', 'spider'] },
  { id: 'warcry', name: 'Orcish Warcry', rarity: 'rare', icon: '📢', desc: 'Orc Brutes taunt heroes within 2 tiles (they must fight the Orc) and take 20% less damage.', req: ['monster', 'orc'] },
  { id: 'thorns', name: 'Heart of Thorns', rarity: 'rare', icon: '🌹', desc: 'The Heart’s pulse deals triple damage to adjacent heroes.' },
  { id: 'interest', name: 'Compound Interest', rarity: 'rare', icon: '📈', desc: 'At the end of each wave, gain 10% of your unspent gold (max 75).' },
  { id: 'mastermind', name: 'Mastermind', rarity: 'rare', icon: '🧠', desc: 'Heroes forget danger much faster between waves.' },
  { id: 'infernal_pact', name: 'Infernal Pact', rarity: 'rare', icon: '😈', desc: 'Imp bolts ignite heroes (4 damage/sec for 3s) and Imps gain +1 range.', req: ['monster', 'imp'] },
  { id: 'stonemason', name: 'Stonemason’s Secret', rarity: 'rare', icon: '🪨', desc: 'Unlock the Boulder trap now. Boulders re-form 25% faster.', unlocks: [['trap', 'boulder']] },
  { id: 'arcane_circuitry', name: 'Arcane Circuitry', rarity: 'rare', icon: '🌀', desc: 'Unlock the Teleporter Pad and Alarm Rune now.', unlocks: [['trap', 'teleport'], ['trap', 'alarm']] },
  { id: 'mimicry', name: 'Mimicry', rarity: 'rare', icon: '🎁', desc: 'Unlock the Mimic now. Mimic ambushes deal +50% damage.', unlocks: [['monster', 'mimic']] },
  { id: 'summoning_circle', name: 'Summoning Circle', rarity: 'rare', icon: '🔯', desc: 'Unlock the Monster Lair and Mana Well now.', unlocks: [['object', 'lair'], ['object', 'well']] },
  // ---- Epic ----
  { id: 'soul_harvest', name: 'Soul Harvest', rarity: 'epic', icon: '👻', desc: 'Each hero kill restores 4 mana.' },
  { id: 'overcharge', name: 'Overcharge', rarity: 'epic', icon: '⚡', desc: 'Dungeon Master powers cost 30% less mana.' },
  { id: 'chain_lightning', name: 'Chain Lightning', rarity: 'epic', icon: '🌩️', desc: 'Lightning Strike arcs to up to 3 more heroes within 3 tiles for 50% damage.' },
  { id: 'pack_tactics', name: 'Pack Tactics', rarity: 'epic', icon: '🐺', desc: 'Monsters deal +12% damage for each other monster within 2 tiles (max +48%).' },
  { id: 'adrenaline', name: 'Adrenaline', rarity: 'epic', icon: '💢', desc: 'While the Heart is below 50% HP, monsters gain +35% damage and speed.' },
  { id: 'spectral_host', name: 'Spectral Host', rarity: 'epic', icon: '🌫️', desc: 'Wraiths cost 40% less and their hits have a 25% chance to Fear heroes for 1.5s.', req: ['monster', 'wraith'] },
  { id: 'labyrinth_lord', name: 'Labyrinth Lord', rarity: 'epic', icon: '🐂', desc: 'Unlock the Minotaur now. Its Charge recharges 35% faster.', unlocks: [['boss', 'minotaur']] },
  { id: 'dark_pact', name: 'Dark Pact', rarity: 'epic', icon: '☠️', desc: 'Unlock the Lich now. Raise Dead raises 1 extra corpse.', unlocks: [['boss', 'lich']] },
  { id: 'glass_cannon', name: 'Glass Cannon', rarity: 'epic', icon: '🔮', desc: 'Traps deal +60% damage, but the Heart permanently loses 30% of its max HP.', tradeoff: true },
  { id: 'blood_money', name: 'Blood Money', rarity: 'epic', icon: '💸', desc: 'Kills give double gold, but escaping heroes steal triple.', tradeoff: true },
  { id: 'cursed_gold', name: 'Cursed Gold', rarity: 'epic', icon: '🪬', desc: 'Chests lure from 1.5× distance and heroes carrying treasure move 40% slower — but treasure that escapes costs you double.', tradeoff: true },
  // ---- Legendary ----
  { id: 'dragons_hoard', name: 'Dragon’s Hoard', rarity: 'legendary', icon: '🐉', desc: 'Unlock the Dragon now. The Dragon deals +10% damage for each Treasure Chest you own.', unlocks: [['boss', 'dragon']] },
  { id: 'undying_heart', name: 'Undying Heart', rarity: 'legendary', icon: '💖', desc: 'Once per wave, the Heart survives a lethal blow at 1 HP and Fears every hero within 5 tiles.' },
  { id: 'time_warp', name: 'Time Warp', rarity: 'legendary', icon: '⏳', desc: 'All heroes move 15% slower.' },
  { id: 'legion', name: 'Legion of Bone', rarity: 'legendary', icon: '🦴', desc: 'Your non-undead monsters rise again as Skeletons when slain (for the rest of the wave).' },
  { id: 'trapmaster', name: 'Trapmaster', rarity: 'legendary', icon: '⚙️', desc: 'One-use traps rearm themselves 8s after triggering, and repairs are free.' },
  { id: 'midas', name: 'Midas Curse', rarity: 'legendary', icon: '🏆', desc: 'Wave income is doubled, but heroes have +20% HP.', tradeoff: true },
];
const PERK_BY_ID = Object.fromEntries(PERKS.map(p => [p.id, p]));

/** True if the current run owns the given perk. */
function hasPerk(id) { return !!(S && S.perks[id]); }
