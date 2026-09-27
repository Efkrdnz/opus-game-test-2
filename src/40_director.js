/* =============================================================================
 *  40 DIRECTOR — the wave director (deterministic previews shaped by the
 *  Adaptive Adventurers' Guild), perk offers & effects, and the Dungeon
 *  Master's powers.
 *
 *    Waves  — generate(n) → preview · begin(preview) · update(dt) · done() · remaining()
 *    Perks  — roll(n) · take(id) · available() · rarityWeight(r)
 *    Powers — onWaveStart() · update(dt) · cost(id) · canCast(id, wx, wy) · ready(id)
 *             · cast(id, wx, wy) · cooldown(id)
 * ========================================================================== */

/* -----------------------------------------------------------------------------
 * 1. WAVES — the wave director
 *
 *    generate(n) is a pure function of (S.seed, n) and a snapshot of the dungeon
 *    taken the first time wave n is previewed during the current build phase
 *    ("what the Guild has heard"), so regenerating the preview always yields
 *    exactly the wave that will spawn.
 *
 *    Threat budget = target head-count curve × the unbiased average threat of a
 *    hero at that wave (incl. the elite surcharge). The Guild's class bias then
 *    decides how the budget is spent: cheap Rogues mean more heroes, Paladins
 *    mean fewer but tougher ones. On boss waves the boss takes one average
 *    hero's share, so the escort budget is slightly smaller. Past MAX_HEROES
 *    the surplus buys elites.
 * -------------------------------------------------------------------------- */
const Waves = (() => {
  /* ---- 1.1 Tuning ---------------------------------------------------------- */
  const MAX_HEROES = 40;      // per-wave head-count cap; surplus budget is spent on elites
  const ELITE_THREAT = 1.8;   // an elite costs this × its class threat (≈ CFG.eliteHpMul)
  const BOSS_THREAT = 0.6;    // reported boss threat = base class threat × hpMul × this
  const CALL_AHEAD = 2;       // with no hero left alive, the next party arrives within this many s
  const NOTE_MIN = 0.45;      // Guild axis score needed before the Guild reacts to it in a note

  /** Recruitment weight per class before the Guild's bias. */
  const BASE_WEIGHT = { warrior: 10, rogue: 8, ranger: 7, mage: 6, cleric: 5, paladin: 4, miner: 3.5 };
  /** Leader-slot preference — parties are led by sturdy heroes. */
  const STURDY = { paladin: 3, warrior: 2.6, miner: 2, cleric: 0.9, ranger: 0.55, mage: 0.45, rogue: 0.4 };
  /** Front-liners a Cleric likes to accompany. */
  const FIGHTER = { warrior: true, paladin: true, miner: true };
  /** Who each hero boss likes to bring along (escort weight multipliers). */
  const BOSS_ESCORTS = {
    champion: { warrior: 1.4, cleric: 1.3 },
    archmage: { mage: 1.6, ranger: 1.2 },
    saint: { paladin: 1.5, warrior: 1.3, cleric: 0.5 },
    shadow: { rogue: 1.9, ranger: 1.1 },
  };
  const CLASS_IDS = Object.keys(HERO_CLASSES);

  /* ---- 1.2 The Adaptive Guild ------------------------------------------------
   * Each axis scores one aspect of the player's dungeon (0 … ~1.5) and lists the
   * classes the Guild recruits to counter it (weight bonus per score point).
   * Axes in the same `group` share at most one guild note per wave.
   * Note templates: {C} = counter classes available this wave, {B} = boss name. */
  const AXES = [
    {
      id: 'traps', group: 'traps', cls: { rogue: 1.1, ranger: 0.9, warrior: 0.15 },
      strong: ['The Adventurers Guild has heard of your traps: {C} volunteer.',
        'Tales of trap-riddled halls reach the Guild. {C} answer the call.'],
      weak: ['Rumours of your traps reach the Guild — a few {C} volunteer.'],
    },
    {
      id: 'hidden', group: 'traps', cls: { ranger: 1.1, rogue: 0.45 },
      strong: ['Survivors whisper of traps no one saw coming. {C} sharpen their eyes.'],
      weak: ['Whispers of hidden traps spread. A few {C} take an interest.'],
    },
    {
      id: 'pits', group: 'traptype', cls: { miner: 2.5 },
      strong: ['Word of your pits spreads. Sure-footed {C}, who never fall in, sign up.'],
      weak: ['Talk of your pits reaches a few sure-footed {C}.'],
    },
    {
      id: 'fire', group: 'traptype', cls: { paladin: 2.2 },
      strong: ['Your fire vents are infamous. Fire-resistant {C} take up the challenge.'],
      weak: ['Tales of scorched adventurers draw a few fire-resistant {C}.'],
    },
    {
      id: 'maze', group: 'maze', cls: { miner: 1.7, mage: 1.3 },
      strong: ['Survivors curse your winding maze. {C} sign up to cut straight through it.',
        'The Guild has mapped your labyrinth — {C} are coming to shorten it.'],
      weak: ['Grumbles about a twisting maze reach the Guild. A few {C} sign up.'],
    },
    {
      id: 'monsters', group: 'monsters', cls: { paladin: 1.2, warrior: 0.9, cleric: 0.7, mage: 0.5 },
      strong: ['Your monsters are the talk of the taverns. {C} take up arms.',
        'The Guild posts a bounty on your monsters: {C} answer.'],
      weak: ['Tales of your monsters reach the Guild. Some {C} take up arms.'],
    },
    {
      id: 'undead', group: 'monsters', cls: { cleric: 1.3, paladin: 1.1 },
      strong: ['The temples are outraged by your undead: {C} march to purge them.'],
      weak: ['Priests mutter about your undead. A few {C} take up the cause.'],
    },
    {
      id: 'boss', group: 'boss', cls: { paladin: 1.0, cleric: 0.8, warrior: 0.3 },
      strong: ['The Guild fears your {B}: {C} lead the way.', 'A {B} guards your Heart? The Guild sends {C}.'],
      weak: ['Rumours of a {B} reach the Guild. A few {C} volunteer.'],
    },
    {
      id: 'treasure', group: 'treasure', cls: { rogue: 1.1 },
      strong: ['Word of your treasure spreads. {C} smell gold.',
        'Every cutpurse in the realm has heard of your chests — {C} flock in.'],
      weak: ['Rumours of treasure draw a few more {C}.'],
    },
    {
      id: 'torches', group: 'torches', cls: { cleric: 0.7, paladin: 0.3 },
      strong: ['Your torchlit killing grounds are no secret — {C} come to tend the wounded.'],
      weak: ['Stories of torchlit killing grounds bring a few {C} along.'],
    },
  ];

  /* ---- 1.3 Helpers ----------------------------------------------------------- */
  /** Class weight at wave n: joins at 35% on its first wave, full weight two waves later. */
  function classWeight(c, n) {
    const mw = HERO_CLASSES[c].minWave;
    if (n < mw) return 0;
    return (BASE_WEIGHT[c] || 5) * Math.min(1, 0.35 + 0.325 * (n - mw));
  }
  /** Weighted average class threat for a weight table. */
  function avgThreat(w) {
    let sw = 0, st = 0;
    for (const c of CLASS_IDS) { const k = w[c] || 0; sw += k; st += k * HERO_CLASSES[c].threat; }
    return sw > 0 ? st / sw : 2.5;
  }
  /** Target head-count (uncapped): 3, 4, 5, 6, 8 … 14 @10 … 26 @20 … 36 @30. */
  function headcount(n) { return Math.floor((20 + 12 * n - 2 * Math.max(0, n - 20)) / 10); }
  function eliteChance(n) { return n < 6 ? 0 : Math.min(0.4, 0.04 + 0.025 * (n - 6)); }
  function bossThreat(id) {
    const b = HERO_BOSSES[id];
    return b ? HERO_CLASSES[b.base].threat * b.hpMul * BOSS_THREAT : 0;
  }
  const plural = c => HERO_CLASSES[c].name + 's';
  const joinNames = a => (a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a[0] || '');
  const r2 = v => Math.round(v * 100) / 100;

  /** Split `total` heroes into party sizes (2–5; never a party of one). */
  function partySizes(total, n, boss, rng) {
    const lo = n >= 20 ? 4 : n >= 10 ? 3 : 2;
    const hi = n <= 3 ? 3 : n <= 9 ? 4 : 5;
    const out = [];
    let left = total;
    while (left > 0) {
      const min = boss && !out.length ? Math.max(3, lo) : lo; // a hero boss brings ≥ 2 escorts
      let s = min + Math.floor(rng() * (hi - min + 1));
      if (s >= left) s = left;
      else if (left - s === 1) s = s + 1 <= hi ? s + 1 : s - 1;
      out.push(s);
      left -= s;
    }
    return out;
  }

  /** How well class `c` fits into a party that already holds `members`. */
  function affinity(c, members) {
    let fighters = 0, clerics = 0, rogues = 0, ranged = 0, paladins = 0, miners = 0;
    for (const m of members) {
      if (FIGHTER[m.cls]) fighters++;
      if (m.cls === 'cleric') clerics++;
      else if (m.cls === 'rogue') rogues++;
      else if (m.cls === 'ranger' || m.cls === 'mage') ranged++;
      if (m.cls === 'paladin') paladins++;
      else if (m.cls === 'miner') miners++;
    }
    let a = 1;
    switch (c) {
      case 'cleric': a = clerics ? 0.25 : fighters ? 1.8 : 0.6; break;     // clerics follow the front line
      case 'rogue': a = rogues === 1 ? 1.7 : rogues >= 2 ? 0.3 : 1; break;  // rogues like to work in pairs
      case 'ranger': case 'mage': a = ranged === 0 ? 1.25 : ranged >= 2 ? 0.6 : 1; break;
      case 'paladin': a = paladins ? 0.5 : 1; break;
      case 'miner': a = miners ? 0.6 : 1; break;
    }
    const lead = members[0];
    if (lead && lead.boss && BOSS_ESCORTS[lead.boss]) a *= BOSS_ESCORTS[lead.boss][c] || 1;
    return a;
  }

  /** Fill a party up to `size`: a sturdy leader first, then members that suit the group. */
  function fillParty(members, size, weights, rng) {
    while (members.length < size) {
      const leaderSlot = members.length === 0;
      const cls = weightedPick(CLASS_IDS, c => (weights[c] > 0
        ? weights[c] * (leaderSlot ? (STURDY[c] || 1) : affinity(c, members)) : 0), rng);
      members.push({ cls, elite: false, boss: null });
    }
  }
  const leadRank = m => (m.boss ? 100 : (STURDY[m.cls] || 1) + (m.elite ? 0.01 : 0));

  /** Is any hero currently alive in the dungeon? (no allocation — called every tick) */
  function anyHeroAlive() {
    for (const h of S.heroes) if (!h.dead && !h.removed && !h.escaped) return true;
    return false;
  }

  /* ---- 1.4 Module ------------------------------------------------------------ */
  const api = {
    /** The preview currently being played (set by begin). */
    current: null,
    _queue: null, _left: 0, _timer: 0, _s: null, _partyNo: 0, _partyCount: 0,
    _memo: null,

    MAX_HEROES,
    headcount,
    eliteChance,

    /** Threat-point budget of wave n (before the boss-wave escort reduction). */
    budget(n) {
      const w = {};
      for (const c of CLASS_IDS) w[c] = classWeight(c, n);
      return headcount(n) * avgThreat(w) * (1 + (ELITE_THREAT - 1) * eliteChance(n));
    },

    /**
     * Scout the player's dungeon for the Guild: traps (count/value/types/hidden),
     * monsters (count/value/types/undead), boss, walls & maze length, lures, torches…
     */
    analyze() {
      const I = {
        traps: 0, trapValue: 0, trapTypes: {}, hidden: 0,
        monsters: 0, monsterValue: 0, monsterTypes: {}, undeadValue: 0,
        boss: null, bossLevel: 0, bossValue: 0,
        walls: 0, route: 0, straight: 1, ratio: 1,
        chests: 0, mimics: 0, torches: 0, barricades: 0, wells: 0, lairs: 0,
      };
      const deep = hasPerk('hidden_depths');
      for (const s of S.structs) {
        const v = s.spent || 0;
        if (s.cat === 'trap') {
          I.traps++; I.trapValue += v;
          I.trapTypes[s.id] = (I.trapTypes[s.id] || 0) + 1;
          if (s.hidden || deep || (TRAPS[s.id] && TRAPS[s.id].hidden)) I.hidden++;
        } else if (s.cat === 'monster') {
          I.monsters++; I.monsterValue += v;
          I.monsterTypes[s.id] = (I.monsterTypes[s.id] || 0) + 1;
          if (MONSTERS[s.id] && MONSTERS[s.id].undead) I.undeadValue += v;
          if (s.id === 'mimic') I.mimics++;
        } else if (s.cat === 'boss') {
          I.boss = s.id; I.bossLevel = s.level || 1; I.bossValue = v;
          if (BOSSES[s.id] && BOSSES[s.id].undead) I.undeadValue += v;
        } else if (s.cat === 'object') {
          if (s.id === 'chest') I.chests++;
          else if (s.id === 'torch') I.torches++;
          else if (s.id === 'barricade') I.barricades++;
          else if (s.id === 'well') I.wells++;
          else if (s.id === 'lair') { I.lairs++; I.monsterValue += v * 0.6; I.undeadValue += v * 0.3; } // goblins & skeletons
        }
      }
      for (const t of S.tiles) if (t.type === T.WALL) I.walls++;
      I.straight = Math.max(1, Math.abs(S.heart.x - S.entrance.x) + Math.abs(S.heart.y - S.entrance.y));
      const route = Path.preview();
      I.route = route && route.length ? route.length : I.straight;
      I.ratio = I.route / I.straight;
      return I;
    },

    /** Guild axis scores (0 … ~1.5) for an analysis. */
    scores(I) {
      const defence = I.trapValue + I.monsterValue + I.bossValue + I.walls * WALL_DEF.cost + 1;
      const monVal = I.monsterValue + I.bossValue;
      const traps = clamp(1.7 * I.trapValue / defence, 0, 1.2) * Math.min(1, I.traps / 4);
      const monsters = clamp(1.7 * monVal / defence, 0, 1.2) * Math.min(1, (I.monsters + I.lairs + (I.boss ? 2 : 0)) / 4);
      // A trap type the dungeon leans on (≥ 3 of them and a big share of the traps).
      const typeScore = id => {
        const k = I.trapTypes[id] || 0;
        return I.traps ? Math.min(1.2, traps * 1.4 * (k / I.traps) * Math.min(1, k / 3)) : 0;
      };
      return {
        traps,
        hidden: I.traps ? traps * 1.1 * (I.hidden / I.traps) * Math.min(1, I.hidden / 3) : 0,
        pits: typeScore('pit'),
        fire: typeScore('fire'),
        maze: clamp((I.ratio - 1.2) / 1.6, 0, 1.5) * (0.4 + 0.6 * Math.min(1, I.walls / 14)),
        monsters,
        undead: monVal > 0 ? Math.min(1.2, monsters * 1.3 * I.undeadValue / monVal) : 0,
        boss: I.boss ? 0.6 + 0.2 * (I.bossLevel - 1) : 0,
        treasure: Math.min(1.2, (I.chests + 0.6 * I.mimics) / 3),
        torches: 0.8 * Math.min(1, I.torches / 4),
      };
    },

    /** Dungeon snapshot for wave n — taken once per build phase, then reused. */
    _intelFor(n) {
      let m = api._memo;
      if (!m || m.s !== S || m.seed !== S.seed || m.atWave !== S.wave) {
        m = api._memo = { s: S, seed: S.seed, atWave: S.wave, byWave: new Map() };
      }
      if (!m.byWave.has(n)) m.byWave.set(n, api.analyze());
      return m.byWave.get(n);
    },

    /**
     * The Guild's reaction: class weight multipliers + 1–2 notes naming the counter.
     * Weak from wave 4, full strength from wave 8. Per-axis jitter keeps runs varied.
     */
    _guild(n, I, rng) {
      const g = n >= 8 ? 1 : n >= 4 ? 0.5 : 0;
      const mul = {};
      for (const c of CLASS_IDS) mul[c] = 1;
      const raw = api.scores(I);
      const sc = {};
      for (const ax of AXES) {
        const v = raw[ax.id] * (0.75 + 0.5 * rng()); // always drawn: fixed rng consumption
        sc[ax.id] = v;
        if (!g || v <= 0) continue;
        for (const c in ax.cls) mul[c] += g * ax.cls[c] * v;
      }
      // Miners also answer trap-heavy dungeons when the walls run long.
      if (g) mul.miner += g * 0.6 * sc.traps * Math.min(1, sc.maze);
      const notes = [], focus = [];
      if (g) {
        const ranked = AXES.filter(ax => sc[ax.id] >= NOTE_MIN).sort((a, b) => sc[b.id] - sc[a.id]);
        const used = {};
        for (const ax of ranked) {
          if (notes.length >= (g >= 1 ? 2 : 1)) break;
          if (used[ax.group]) continue;
          const names = Object.keys(ax.cls)
            .filter(c => HERO_CLASSES[c].minWave <= n && ax.cls[c] >= 0.3)
            .sort((a, b) => ax.cls[b] - ax.cls[a]).slice(0, 2).map(plural);
          if (!names.length) continue;
          const lines = g >= 1 ? ax.strong : ax.weak;
          const line = lines[Math.floor(rng() * lines.length)];
          notes.push(line.replace('{C}', joinNames(names)).replace('{B}', I.boss && BOSSES[I.boss] ? BOSSES[I.boss].name : 'guardian'));
          used[ax.group] = true;
          focus.push(ax.id);
        }
        if (!notes.length) notes.push(g >= 1 ? 'The Adventurers Guild is studying your dungeon. Nothing about it stands out — yet.'
          : 'The Adventurers Guild has begun asking survivors about your dungeon.');
      }
      return { strength: g, mul, scores: sc, notes, focus };
    },

    /**
     * Build the preview of wave n (deterministic for (S.seed, n) within a build phase).
     * `intel` optionally overrides the dungeon snapshot (see analyze()).
     */
    generate(n, intel) {
      n = Math.max(1, Math.floor(n) || 1);
      const rng = mulberry32(S.seed * 31 + n * 977);
      const I = intel || api._intelFor(n);
      const guild = api._guild(n, I, rng);

      // Class weights this wave: availability ramp × Guild bias.
      const weights = {};
      for (const c of CLASS_IDS) weights[c] = classWeight(c, n) * guild.mul[c];

      // Head-count: what the (boss-reduced) budget buys at this class mix.
      const bossId = n % 5 === 0 ? HERO_BOSS_ORDER[(n / 5 - 1) % HERO_BOSS_ORDER.length] : null;
      const p = eliteChance(n);
      const budget = api.budget(n);
      const eff = avgThreat(weights) * (1 + (ELITE_THREAT - 1) * p);
      let x = budget * (bossId ? 1 - 1 / headcount(n) : 1) / eff; // the boss takes one hero's share
      if (n >= 6) x *= 0.95 + 0.1 * rng();
      x = Math.round(x * 1000) / 1000;
      const cap = MAX_HEROES - (bossId ? 1 : 0);
      const count = clamp(Math.floor(x + rng()), 2, cap); // stochastic rounding
      let spare = x > cap ? (x - cap) * eff : 0;        // budget beyond the cap → elite promotions

      // Parties: the boss (if any) leads the first one.
      const sizes = partySizes(count + (bossId ? 1 : 0), n, !!bossId, rng);
      const parties = [];
      for (let i = 0; i < sizes.length; i++) {
        const members = [];
        if (i === 0 && bossId) members.push({ cls: HERO_BOSSES[bossId].base, elite: false, boss: bossId });
        fillParty(members, sizes[i], weights, rng);
        parties.push({ members, delay: 0 });
      }

      // Elites: rolled per hero, then any surplus budget promotes more.
      for (const pt of parties) for (const m of pt.members) if (!m.boss && rng() < p) m.elite = true;
      if (spare > 0) {
        const pool = [];
        for (const pt of parties) for (const m of pt.members) if (!m.boss && !m.elite) pool.push(m);
        shuffle(pool, rng);
        for (const m of pool) {
          const c = (ELITE_THREAT - 1) * HERO_CLASSES[m.cls].threat;
          if (c <= spare) { m.elite = true; spare -= c; }
        }
      }
      for (const pt of parties) pt.members.sort((a, b) => leadRank(b) - leadRank(a)); // leader first

      // Departure gaps: 5–9 s, tightening in later waves; the boss gets a moment of fame.
      const tempo = Math.max(0.6, 1 - 0.012 * (n - 1));
      for (let i = 1; i < parties.length; i++) {
        const d = (5 + 4 * rng()) * tempo + (i === 1 && bossId ? 1.5 : 0);
        parties[i].delay = Math.round(d * 10) / 10;
      }

      // Summary. `counts`/`elites` cover regular heroes (the boss has its own card);
      // `total` is every hero that will spawn, boss included.
      const tally = {};
      let elites = 0, total = 0, threat = 0;
      for (const pt of parties) for (const m of pt.members) {
        total++;
        if (m.boss) { threat += bossThreat(m.boss); continue; }
        tally[m.cls] = (tally[m.cls] || 0) + 1;
        if (m.elite) elites++;
        threat += HERO_CLASSES[m.cls].threat * (m.elite ? ELITE_THREAT : 1);
      }
      const counts = {};
      for (const c of CLASS_IDS) if (tally[c]) counts[c] = tally[c];
      const scores = {};
      for (const k in guild.scores) scores[k] = r2(guild.scores[k]);
      return {
        wave: n, boss: bossId, parties, counts, elites, total,
        threat: Math.round(threat), budget: Math.round(budget), eliteChance: r2(p),
        guildNotes: guild.notes,
        guild: { strength: guild.strength, focus: guild.focus, scores },
      };
    },

    /** Schedule a wave's parties (called by Game.startWave with S.nextWave). */
    begin(preview) {
      if (!preview || !Array.isArray(preview.parties) || preview.wave !== S.wave) preview = api.generate(S.wave);
      api.current = preview;
      api._s = S;
      api._queue = [];
      api._left = 0;
      for (const p of preview.parties) {
        const members = (p.members || []).filter(m => m && HERO_CLASSES[m.cls])
          .map(m => ({ cls: m.cls, elite: !!m.elite, boss: m.boss && HERO_BOSSES[m.boss] ? m.boss : null }));
        if (!members.length) continue;
        api._queue.push({ delay: Math.max(0, Number(p.delay) || 0), members });
        api._left += members.length;
      }
      api._timer = api._queue.length ? api._queue[0].delay : 0;
      api._partyNo = 0;
      api._partyCount = api._queue.length;
    },

    /** Release parties on schedule via Heroes.spawnParty. */
    update(dt) {
      const q = api._queue;
      if (!q || !q.length || api._s !== S || S.endingT >= 0) return;
      api._timer -= dt;
      // Keep the pace: if the dungeon is empty, hurry the next party along.
      if (api._timer > CALL_AHEAD && !anyHeroAlive()) api._timer = CALL_AHEAD;
      while (q.length && api._timer <= 0) {
        const p = q.shift();
        api._left -= p.members.length;
        Heroes.spawnParty(p.members);
        api._spawnFX(p);
        api._partyNo++;
        if (q.length) api._timer += q[0].delay;
      }
    },

    /** Dust, a ring and a callout at the entrance as a party marches in. */
    _spawnFX(p) {
      const ex = S.entrance.x + 0.5, ey = S.entrance.y + 0.5;
      let boss = null;
      for (const m of p.members) if (m.boss) boss = m.boss;
      FX.burst(ex, ey, { n: 10 + p.members.length * 3, colors: ['#c9b99a', '#8a8296', '#6b6378'], speed: 2.2, life: 0.6, size: 2.2, grav: 3, dir: [1, 0], spread: 1.8 });
      FX.ring(ex, ey, { color: boss ? '#ffd84a' : '#d8c8a8', r0: 0.2, r1: boss ? 2.6 : 1.3, life: boss ? 0.9 : 0.5, width: boss ? 4 : 2 });
      if (boss) {
        FX.text(ex + 1.8, ey - 1.1, HERO_BOSSES[boss].name, '#ffd84a', { size: 13, life: 2.4, vy: -0.35 });
        FX.shake(6);
      } else if (api._partyNo > 0) {
        FX.text(ex + 1.3, ey - 0.9, `Party ${api._partyNo + 1}/${api._partyCount}`, '#e8dcc0', { size: 10, life: 1.4, vy: -0.5 });
      }
    },

    /** True once every party of the current wave has entered. */
    done() { return !api._queue || api._s !== S || api._queue.length === 0; },
    /** Heroes that have not spawned yet this wave. */
    remaining() { return api._queue && api._s === S ? api._left : 0; },
  };
  return api;
})();

/* -----------------------------------------------------------------------------
 * 2. PERKS — offers after each wave and their immediate effects.
 *    Offers pick a rarity tier by weight (RARITY, tuned by wave / boss rewards),
 *    then a perk uniformly inside that tier.
 * -------------------------------------------------------------------------- */
const Perks = (() => {
  const TIERS = ['common', 'rare', 'epic', 'legendary'];
  const rarePlus = p => p.rarity !== 'common';

  const api = {
    /** Can this perk be offered right now? */
    offerable(p) {
      if (!p || !S) return false;
      if (S.perks[p.id] && !p.repeatable) return false;
      if (p.req && !Build.isUnlocked(p.req[0], p.req[1])) return false;
      if (p.unlocks && !p.unlocks.some(([cat, id]) => !Build.isUnlocked(cat, id))) return false;
      return true;
    },
    /** Every perk definition that could be offered right now. */
    available() { return PERKS.filter(p => api.offerable(p)); },

    /** Is the current reward phase the reward for a hero-boss wave? */
    bossReward() { return !!(S && S.ws && S.ws.boss && S.ws.wave === S.wave); },

    /** Weight of a rarity tier: RARITY weight, legendary/epic creep up in later waves, ×2 after boss waves. */
    rarityWeight(r, boss = api.bossReward()) {
      const def = RARITY[r];
      if (!def) return 0;
      const w = S ? S.wave : 1;
      let m = 1;
      if (r === 'common') m = Math.max(0.7, 1 - 0.01 * (w - 1));
      else if (r === 'epic') m = 1 + Math.min(0.6, 0.02 * (w - 1));
      else if (r === 'legendary') m = 1 + Math.min(1.5, 0.05 * (w - 1));
      if (boss && (r === 'epic' || r === 'legendary')) m *= 2;
      return def.weight * m;
    },

    /** Pick one perk from `cands`: rarity tier by weight, then uniformly within it. */
    _pick(cands, boss) {
      let total = 0;
      const tw = [0, 0, 0, 0];
      for (let t = 0; t < TIERS.length; t++) {
        if (cands.some(p => p.rarity === TIERS[t])) tw[t] = api.rarityWeight(TIERS[t], boss);
        total += tw[t];
      }
      if (total <= 0) return cands[Math.floor(Math.random() * cands.length)];
      let x = Math.random() * total, tier = TIERS[TIERS.length - 1];
      for (let t = 0; t < TIERS.length; t++) { x -= tw[t]; if (tw[t] > 0 && x <= 0) { tier = TIERS[t]; break; } }
      const inTier = cands.filter(p => p.rarity === tier);
      return inTier.length ? inTier[Math.floor(Math.random() * inTier.length)] : cands[0];
    },

    /**
     * Offer up to n distinct perk ids. Avoids two repeatables in one offer unless the
     * pool runs dry; after a boss wave at least one offer is rare or better.
     */
    roll(n = 3) {
      const pool = api.available();
      const boss = api.bossReward();
      const out = [];
      let repeatables = 0;
      while (out.length < n) {
        const left = pool.filter(p => !out.includes(p));
        if (!left.length) break;
        let cands = left;
        if (repeatables) { const fresh = left.filter(p => !p.repeatable); if (fresh.length) cands = fresh; }
        if (boss && out.length === n - 1 && !out.some(rarePlus)) {
          const good = cands.filter(rarePlus);
          const any = good.length ? good : left.filter(rarePlus);
          if (any.length) cands = any;
        }
        const p = api._pick(cands, boss);
        out.push(p);
        if (p.repeatable) repeatables++;
      }
      return shuffle(out).map(p => p.id);
    },

    /** Take a perk: record it and apply its immediate effects. @returns true if applied */
    take(id) {
      const p = PERK_BY_ID[id];
      if (!p || !S) return false;
      S.perks[id] = (S.perks[id] || 0) + 1;
      S.perkOrder.push(id);
      const hx = Heart.cx(), hy = Heart.cy();
      let msg = `${p.name} acquired!`;
      switch (id) {
        case 'treasury':
          Econ.gain(150, hx, hy - 1.2);
          msg = `${p.name}: +150 gold!`;
          break;
        case 'mend': {
          S.heartMax += 10;
          const before = S.heartHp;
          S.heartHp = Math.min(S.heartMax, S.heartHp + 35);
          FX.text(hx, hy - 1, `+${Math.round(S.heartHp - before)} HP`, '#ff7a9a', { size: 12 });
          FX.ring(hx, hy, { color: '#ff7a9a', r0: 0.3, r1: 1.6, life: 0.6, width: 3 });
          msg = `${p.name}: the Heart mends (${Math.round(S.heartHp)}/${S.heartMax} HP).`;
          break;
        }
        case 'glass_cannon':
          S.heartMax = Math.max(1, Math.round(S.heartMax * 0.7));
          S.heartHp = clamp(S.heartHp, 1, S.heartMax);
          FX.burst(hx, hy, { n: 24, colors: ['#b86bff', '#e0c0ff', '#ff4d6d'], speed: 3, life: 0.8, size: 2.5 });
          msg = `${p.name}: traps hit harder — the Heart shrinks to ${S.heartMax} max HP.`;
          break;
        case 'reinforced': {
          let n = 0;
          for (const s of S.structs) {
            if (s.cat !== 'object' || s.id !== 'barricade' || !s.maxHp) continue;
            s.maxHp *= 2; s.hp *= 2; n++;
            FX.burst(s.x + 0.5, s.y + 0.5, { n: 8, colors: ['#c9b99a', '#8a8296'], speed: 1.5, life: 0.5, size: 2 });
          }
          if (n) Path.bump();
          msg = `${p.name}: walls resist heroes${n ? ` and ${n} barricade${n > 1 ? 's are' : ' is'} reinforced` : ''}.`;
          break;
        }
      }
      if (p.unlocks) {
        const names = [];
        for (const [cat, uid] of p.unlocks) {
          if (Game.unlock(cat, uid)) { const d = contentDef(cat, uid); names.push(d ? d.name : uid); }
        }
        if (names.length) {
          msg = `${p.name}: ${joinList(names)} unlocked!`;
          SFX.play('unlock');
        }
      }
      UI.toast(`${p.icon} ${msg}`, 'good');
      return true;
    },
  };
  /** 'A', 'A and B', 'A, B and C'. */
  function joinList(a) { return a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a[0] || ''; }
  return api;
})();

/* -----------------------------------------------------------------------------
 * 3. POWERS — the Dungeon Master's mana-powered spells (Q W E R).
 *    Mana regenerates during waves (CFG.manaRegen, ×1.4 Mana Spring, +0.5/s
 *    per unbroken Mana Well). Mana and cooldown are only spent when a cast
 *    actually succeeds.
 * -------------------------------------------------------------------------- */
const Powers = (() => {
  const IDS = Object.keys(POWERS);
  const FEAR_PICK = 0.9;        // fear targets the nearest hero within this many tiles of the click
  const CHAIN = { jumps: 3, range: 3, mul: 0.5 }; // Chain Lightning: 3 arcs, 3 tiles, 50% damage
  const LIGHTNING_SRC = { team: 'dm', kind: 'power', id: 'lightning', elem: 'magic' };

  /** Frozen refusal results, shared so per-frame UI queries make no garbage. */
  const OK = Object.freeze({ ok: true, reason: '' });
  const refusals = {};
  const refuse = reason => refusals[reason] || (refusals[reason] = Object.freeze({ ok: false, reason }));

  const hasPoint = (x, y) => Number.isFinite(x) && Number.isFinite(y);
  /** Any living hero within r of (x, y)? (no allocation) */
  function heroNear(x, y, r) {
    const r2 = r * r;
    for (const h of S.heroes) {
      if (h.dead || h.removed || h.escaped) continue;
      const dx = h.x - x, dy = h.y - y;
      if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
  }
  /** Does the dungeon have any trap for Reset Traps to work on? */
  function hasTraps() {
    for (const s of S.structs) if (s.cat === 'trap') return true;
    return false;
  }
  /** Would Reset Traps change anything (a cooldown, a broken/disarmed/revealed trap, a spent boulder)? */
  function trapsNeedReset() {
    for (const s of S.structs) {
      if (s.cat !== 'trap') continue;
      const d = s.data || {};
      if (s.cd > 0 || s.broken || s.disarmed || (s.hidden && s.revealed) || d.rearmT > 0 || (s.id === 'boulder' && d.ready === false)) return true;
    }
    return false;
  }

  const api = {
    /** Why the last cast() failed ('' after a success). */
    lastReason: '',

    /** Wave start: all powers ready. (Game resets mana.) */
    onWaveStart() {
      S.powerCd = {};
      for (const id of IDS) S.powerCd[id] = 0;
      api.lastReason = '';
    },

    /** Current mana regeneration per second. */
    manaRegen() {
      let r = CFG.manaRegen * (hasPerk('mana_spring') ? 1.4 : 1);
      for (const s of S.structs) if (s.cat === 'object' && s.id === 'well' && !s.broken) r += OBJECTS.well.regen;
      return r;
    },

    /** Mana regeneration and cooldowns (wave phase only). */
    update(dt) {
      if (!S) return;
      if (S.endingT < 0) S.mana = Math.min(S.manaMax, S.mana + api.manaRegen() * dt);
      const cd = S.powerCd;
      for (let i = 0; i < IDS.length; i++) {
        const id = IDS[i];
        if (cd[id] > 0) cd[id] = Math.max(0, cd[id] - dt);
      }
    },

    /** Mana cost (×0.7 with Overcharge, rounded). */
    cost(id) {
      const d = POWERS[id];
      if (!d) return Infinity;
      return Math.round(d.mana * (hasPerk('overcharge') ? 0.7 : 1));
    },
    /** Remaining cooldown in seconds. */
    cooldown(id) { return S && S.powerCd ? Math.max(0, S.powerCd[id] || 0) : 0; },
    /** Remaining cooldown as a fraction of the full cooldown (for UI sweeps). */
    cooldownFrac(id) { const d = POWERS[id]; return d && d.cd ? clamp(api.cooldown(id) / d.cd, 0, 1) : 0; },
    /** Castable right now (ignoring the target)? */
    ready(id) { return api.canCast(id).ok; },

    /**
     * Can `id` be cast? Without a point it checks phase, cooldown, mana (and for
     * Reset Traps that something needs rearming); with a point it also validates
     * the target. @returns {ok, reason}
     */
    canCast(id, wx, wy) {
      const def = POWERS[id];
      if (!def) return refuse('Unknown power');
      if (!S || S.phase !== 'wave') return refuse('Only during waves');
      if (S.endingT >= 0) return refuse('The Heart has fallen');
      if (api.cooldown(id) > 0) return refuse('Recharging');
      if (S.mana < api.cost(id)) return refuse('Not enough mana');
      if (id === 'reset' && !hasTraps()) return refuse('You have no traps');
      if (id === 'reset' && !trapsNeedReset()) return refuse('All traps are already armed');
      if (!hasPoint(wx, wy)) return OK;
      switch (id) {
        case 'collapse': {
          const c = Grid.canCollapse(Math.floor(wx), Math.floor(wy));
          return c.ok ? OK : refuse(c.reason);
        }
        case 'fear': {
          const h = Spatial.nearestHero(wx, wy, FEAR_PICK);
          if (!h) return refuse('Pick a hero');
          if (Status.fearImmune(h)) return refuse('Immune to fear');
          if (h.st.fearT > 1) return refuse('Already terrified');
          return OK;
        }
        case 'lightning':
          return heroNear(wx, wy, def.radius) ? OK : refuse('No heroes there');
      }
      return OK;
    },

    /** Cast a power at world point (wx, wy). @returns true if it happened (mana & cooldown spent) */
    cast(id, wx, wy) {
      const def = POWERS[id];
      let chk = api.canCast(id, wx, wy);
      if (chk.ok && def.target !== 'none' && !hasPoint(wx, wy)) chk = refuse(def.target === 'hero' ? 'Pick a hero' : 'Pick a target');
      if (!chk.ok) return api._refused(chk.reason, wx, wy);
      api.lastReason = '';
      let done = false;
      switch (id) {
        case 'collapse': done = api._collapse(Math.floor(wx), Math.floor(wy)); break;
        case 'fear': done = api._fear(wx, wy); break;
        case 'lightning': done = api._lightning(wx, wy); break;
        case 'reset': done = api._reset(); break;
      }
      if (!done) return api._refused(api.lastReason || 'Nothing happened', wx, wy);
      S.mana = Math.max(0, S.mana - api.cost(id));
      S.powerCd[id] = def.cd;
      return true;
    },

    /** Failed cast feedback: remember the reason, float it at the click, buzz. */
    _refused(reason, wx, wy) {
      api.lastReason = reason;
      if (S && S.heart) {
        const x = hasPoint(wx, wy) ? wx : Heart.cx(), y = hasPoint(wx, wy) ? wy : Heart.cy() - 1;
        FX.text(x, y - 0.5, reason, '#ff9a9a', { size: 10, life: 1.1, vy: -0.6 });
      }
      SFX.play('error');
      return false;
    },

    /* ---- Collapse: a floor tile caves in (core handles damage, shove, path check) ---- */
    _collapse(tx, ty) {
      if (!Grid.collapse(tx, ty, POWERS.collapse.dmg)) {
        const c = Grid.canCollapse(tx, ty);
        api.lastReason = c.ok ? 'The ground holds firm' : c.reason;
        return false;
      }
      FX.ring(tx + 0.5, ty + 0.5, { color: '#c9b99a', r0: 0.3, r1: 1.6, life: 0.5, width: 3 });
      return true;
    },

    /* ---- Fear: the nearest hero flees toward the entrance ---- */
    _fear(wx, wy) {
      const h = Spatial.nearestHero(wx, wy, FEAR_PICK);
      if (!h) { api.lastReason = 'Pick a hero'; return false; }
      if (Status.fearImmune(h) || !Status.apply(h, 'fear', { dur: POWERS.fear.dur, x: h.x, y: h.y })) {
        api.lastReason = 'Immune to fear';
        return false;
      }
      FX.ring(h.x, h.y, { color: '#b36bff', r0: 0.2, r1: 1.7, life: 0.55, width: 3 });
      FX.ring(h.x, h.y, { color: '#e2c4ff', r0: 1.2, r1: 0.2, life: 0.35, width: 2 });
      FX.burst(h.x, h.y - 0.3, { n: 24, colors: ['#b36bff', '#7a3dcc', '#e2c4ff'], speed: 2.2, life: 0.9, size: 2.4, grav: -2.5, glow: true });
      FX.text(h.x, h.y - 0.95, 'Terrified!', '#d7a6ff', { size: 12 });
      SFX.play('fear');
      return true;
    },

    /* ---- Lightning: smite heroes around the point; Chain Lightning arcs onward ---- */
    _lightning(wx, wy) {
      const def = POWERS.lightning;
      const hits = Spatial.heroesInRadius(wx, wy, def.radius);
      if (!hits.length) { api.lastReason = 'No heroes there'; return false; }
      api._boltFX(wx, wy);
      for (const h of hits) {
        if (dist(wx, wy, h.x, h.y) > 0.35) FX.beam(wx, wy, h.x, h.y - 0.1, { color: '#bfe9ff', width: 2, life: 0.22, jag: true });
        FX.burst(h.x, h.y - 0.2, { n: 10, colors: ['#ffffff', '#9fe8ff'], speed: 3, life: 0.4, size: 2, glow: true });
        Combat.damage(h, def.dmg, LIGHTNING_SRC);
        if (!h.dead) Status.apply(h, 'stun', { dur: def.stun });
      }
      if (hasPerk('chain_lightning')) api._chain(wx, wy, hits);
      SFX.play('lightning');
      return true;
    },

    /** A bright jagged bolt from above with forks, flash, shake, sparks and scorch smoke. */
    _boltFX(wx, wy) {
      const top = Math.min(wy - 3.5, -0.6);
      const x0 = wx + randRange(-1.1, 1.1);
      FX.beam(x0, top, wx, wy, { color: '#6fc8ff', width: 10, life: 0.26, jag: true });
      FX.beam(x0, top, wx, wy, { color: '#e8f8ff', width: 4, life: 0.34, jag: true });
      FX.beam(x0, top, wx, wy, { color: '#ffffff', width: 1.5, life: 0.4, jag: true });
      for (let i = 0; i < 3; i++) {
        const t = 0.35 + Math.random() * 0.45;
        const fx = lerp(x0, wx, t), fy = lerp(top, wy, t);
        FX.beam(fx, fy, fx + randRange(-1.4, 1.4), fy + randRange(0.4, 1.4), { color: '#bfe9ff', width: 2, life: 0.22, jag: true });
      }
      const r = POWERS.lightning.radius;
      FX.ring(wx, wy, { color: '#bfe9ff', r0: 0.15, r1: r + 0.4, life: 0.45, width: 4 });
      FX.ring(wx, wy, { color: '#ffffff', r0: 0.1, r1: 0.9, life: 0.25, width: 3 });
      FX.burst(wx, wy, { n: 46, colors: ['#ffffff', '#dff6ff', '#8fd8ff', '#ffe98a'], speed: 5.5, life: 0.55, size: 2.4, glow: true, drag: 3 });
      FX.burst(wx, wy, { n: 14, colors: ['#3a3f4a', '#555c6a'], speed: 1.2, life: 1.1, size: 3, grav: -1.5 });
      const tx0 = Math.floor(wx - r), tx1 = Math.floor(wx + r), ty0 = Math.floor(wy - r), ty1 = Math.floor(wy + r);
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
        if (Grid.inb(tx, ty) && !Grid.isSolid(tx, ty) && dist(tx + 0.5, ty + 0.5, wx, wy) <= r + 0.35) FX.flashTile(tx, ty, '#bfe9ff', 0.35);
      }
      FX.flash('#d8f0ff', 0.18);
      FX.shake(10);
    },

    /**
     * Chain Lightning: up to 3 more heroes within range of the strike take 50% and a
     * short stun. Arcs jump nearest-neighbour style from the strike point; later
     * links linger a little longer so the discharge reads as travelling.
     */
    _chain(wx, wy, hits) {
      const def = POWERS.lightning;
      const cands = Spatial.heroesInRadius(wx, wy, CHAIN.range).filter(h => !hits.includes(h));
      let px = wx, py = wy;
      for (let k = 0; k < CHAIN.jumps && cands.length; k++) {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < cands.length; i++) {
          const d = (cands[i].x - px) ** 2 + (cands[i].y - py) ** 2;
          if (d < bd) { bd = d; bi = i; }
        }
        const h = cands.splice(bi, 1)[0];
        const life = 0.26 + 0.07 * k;
        FX.beam(px, py, h.x, h.y - 0.1, { color: '#8fd8ff', width: 5, life, jag: true });
        FX.beam(px, py, h.x, h.y - 0.1, { color: '#ffffff', width: 1.8, life: life + 0.04, jag: true });
        FX.burst(h.x, h.y - 0.2, { n: 12, colors: ['#ffffff', '#bfe9ff', '#6fc8ff'], speed: 3, life: 0.4, size: 2, glow: true });
        Combat.damage(h, def.dmg * CHAIN.mul, LIGHTNING_SRC);
        if (!h.dead) Status.apply(h, 'stun', { dur: def.stun * CHAIN.mul });
        px = h.x; py = h.y - 0.1;
        if (k === 0) SFX.play('magic');
      }
    },

    /* ---- Reset Traps: every trap rearmed, repaired and re-hidden ---- */
    _reset() {
      if (!hasTraps()) { api.lastReason = 'You have no traps'; return false; }
      if (!trapsNeedReset()) { api.lastReason = 'All traps are already armed'; return false; }
      Traps.resetAll();
      Path.bump(); // hidden/broken state changed → heroes' routes & the static layer refresh
      const hx = Heart.cx(), hy = Heart.cy();
      FX.ring(hx, hy, { color: '#9fe8ff', r0: 0.5, r1: Math.max(S.cols, S.rows) * 0.9, life: 0.8, width: 3 });
      FX.text(hx, hy - 1.3, 'Traps rearmed!', '#9fe8ff', { size: 12 });
      FX.flash('#9fe8ff', 0.1);
      SFX.play('reset');
      return true;
    },
  };
  return api;
})();
