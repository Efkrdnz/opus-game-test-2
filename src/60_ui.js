/* =============================================================================
 *  60 UI — the DOM interface: top-bar HUD, build panel & inspector, incoming
 *  wave preview, live wave status, Dungeon Master powers, perks, toasts, the
 *  single mouse-following tooltip, modals (title, reward, game over, help) and
 *  all board / keyboard input.
 *
 *  Design notes
 *    • The run is always read through the global `S` at call time.
 *    • update() runs every frame but only touches the DOM for the power
 *      cooldown sweeps (CSS variables); everything else refreshes at ~10 Hz
 *      through diffed writes (a node is rewritten only when its text/HTML
 *      actually changed).
 *    • Panels whose content is expensive (build cards, wave preview, perks)
 *      are rebuilt only when their signature changes.
 * ========================================================================== */
const UI = (() => {
  /* ---------------------------------------------------------------------------
   * 1. CONSTANTS & UI-ONLY TABLES
   * ------------------------------------------------------------------------ */
  const HUD_INTERVAL = 0.1;       // seconds between HUD refreshes (~10 Hz)
  const TOAST_MAX = 4;            // visible toasts at once
  const REWARD_GUARD_MS = 320;    // ignore perk picks right after the modal opens (no click-through)
  const FAIL_TOAST_GAP = 1400;    // ms before the same placement-failure reason may toast again
  const LOW_HEART = 0.3;          // Heart bar turns red & pulses at/below this fraction
  const SPEEDS = [1, 2, 4];
  const POWER_IDS = Object.keys(POWERS);

  /** Emoji used when Sprites.iconURL() returns nothing for an item. */
  const GLYPH = {
    'wall:wall': '🧱',
    'trap:spike': '🔺', 'trap:arrow': '🏹', 'trap:pit': '🕳️', 'trap:slime': '🟢', 'trap:fire': '🔥',
    'trap:alarm': '🔔', 'trap:boulder': '🪨', 'trap:teleport': '🌀',
    'monster:skeleton': '💀', 'monster:goblin': '👺', 'monster:orc': '👹', 'monster:spider': '🕷️',
    'monster:imp': '😈', 'monster:wraith': '👻', 'monster:mimic': '🎁',
    'boss:minotaur': '🐂', 'boss:lich': '☠️', 'boss:dragon': '🐉',
    'object:chest': '💰', 'object:torch': '🕯️', 'object:barricade': '🚧', 'object:well': '⛲', 'object:lair': '🦴',
    'hero:warrior': '⚔️', 'hero:rogue': '🗡️', 'hero:ranger': '🏹', 'hero:mage': '🧙', 'hero:cleric': '✨',
    'hero:paladin': '🛡️', 'hero:miner': '⛏️',
    'heroBoss:champion': '👑', 'heroBoss:archmage': '🔮', 'heroBoss:saint': '😇', 'heroBoss:shadow': '🥷',
    'tile:rock': '🪨', 'tile:entrance': '🚪', 'tile:heart': '❤️', 'tile:floor': '⬛',
  };

  /** Stats shown as chips on each build card (in order; missing keys are skipped). */
  const CARD_KEYS = {
    spike: ['dmg', 'cd'], arrow: ['dmg', 'cd', 'range'], pit: ['killHp', 'dmg'], slime: ['slow', 'linger'],
    fire: ['burn', 'cd'], alarm: ['radius', 'buffDur'], boulder: ['dmg', 'cd'], teleport: ['cd'],
    skeleton: ['hp', 'dmg'], goblin: ['hp', 'dmg'], orc: ['hp', 'dmg'], spider: ['hp', 'dmg'],
    imp: ['hp', 'dmg'], wraith: ['hp', 'dmg'], mimic: ['hp', 'ambushDmg'],
    minotaur: ['hp', 'dmg'], lich: ['hp', 'dmg'], dragon: ['hp', 'dmg'],
  };
  /** One descriptive tag per item (shown after the stat chips). */
  const CARD_TAG = {
    arrow: 'On walls', pit: 'One use', slime: 'Always on', boulder: 'Re-forms', teleport: 'Sends back',
    skeleton: 'Respawns', goblin: 'Fast', orc: 'Knockback', spider: 'Webs', imp: 'Ranged', wraith: 'Phasing',
    mimic: 'Lure', minotaur: 'Charge', lich: 'Raise Dead', dragon: 'Fire Breath',
  };
  const STAT_SKIP = new Set(['cost', 'unlock', 'name', 'desc', 'place', 'hidden', 'oneUse', 'lure', 'undead', 'phasing', 'ranged', 'ability', 'abilityName', 'level', 'lvl', 'id', 'type']);
  /** describe() lines that merely repeat an HP bar we already draw. */
  const HP_LINE = /^\s*(hp|health)\s*[:\s]\s*\d/i;
  const MON_SCALED = new Set(['hp', 'dmg', 'ambushDmg', 'chargeDmg', 'breathDmg']);

  /* ---------------------------------------------------------------------------
   * 2. SMALL HELPERS
   * ------------------------------------------------------------------------ */
  const esc = s => escapeHtml(s == null ? '' : s);
  /** Number → short string (integers stay integers, others get ≤ 2 decimals). */
  const num = (v, dp = 2) => {
    if (typeof v !== 'number' || !isFinite(v)) return String(v);
    if (Number.isInteger(v)) return fmtInt(v);
    const f = Math.pow(10, dp);
    return String(Math.round(v * f) / f);
  };
  const secs = v => num(v, 2) + 's';
  const tiles = v => num(v, 1) + (v === 1 ? ' tile' : ' tiles');
  const pct = v => Math.round(v * 100) + '%';
  const humanize = k => String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()).replace(/ ([A-Z])/g, (m, c) => ' ' + c.toLowerCase());
  const rarColor = r => (RARITY[r] ? RARITY[r].color : '#b9b9b9');
  const has = (obj, fn) => typeof obj !== 'undefined' && obj && typeof obj[fn] === 'function';

  /** Stat key → [label, long formatter, short chip formatter]. */
  const STAT = {
    dmg: ['Damage', v => num(Math.round(v)), v => num(Math.round(v)) + ' dmg'],
    damage: ['Damage', v => num(Math.round(v)), v => num(Math.round(v)) + ' dmg'],
    cd: ['Cooldown', secs, v => secs(v) + ' cd'],
    range: ['Range', tiles, v => num(v) + ' rng'],
    killHp: ['Swallows heroes at', v => '≤ ' + num(Math.round(v)) + ' HP', v => 'kills ≤' + num(Math.round(v))],
    slow: ['Slow', pct, v => '−' + pct(v) + ' spd'],
    linger: ['Slow lingers', secs, v => secs(v) + ' linger'],
    burn: ['Burn', v => num(v) + ' dmg/s', v => num(v) + '/s burn'],
    burnDur: ['Burn duration', secs, v => secs(v) + ' burn'],
    radius: ['Radius', tiles, v => 'r ' + num(v)],
    buffDur: ['Enrage duration', secs, v => secs(v) + ' rage'],
    hp: ['Health', v => num(Math.round(v)), v => num(Math.round(v)) + ' HP'],
    maxHp: ['Health', v => num(Math.round(v)), v => num(Math.round(v)) + ' HP'],
    atkCd: ['Attacks every', secs, v => secs(v) + ' atk'],
    speed: ['Speed', v => num(v) + ' tiles/s', v => num(v) + ' spd'],
    guard: ['Guard radius', tiles, v => 'guard ' + num(v)],
    leash: ['Leash', tiles, v => 'leash ' + num(v)],
    respawn: ['Reassembles after', secs, v => secs(v) + ' respawn'],
    webCd: ['Web cooldown', secs], webRange: ['Web range', tiles], webSlow: ['Web slow', pct], webDur: ['Web duration', secs],
    drain: ['Life drain', pct], ambushDmg: ['Ambush bite', v => num(Math.round(v)), v => num(Math.round(v)) + ' bite'],
    chargeDmg: ['Charge damage', v => num(Math.round(v))], chargeRange: ['Charge range', tiles],
    abilityCd: ['Ability cooldown', secs], raiseCount: ['Raises', v => num(v) + ' corpses'], raiseRange: ['Raise range', tiles],
    breathDmg: ['Breath damage', v => num(Math.round(v))], breathLen: ['Breath length', tiles],
    bleed: ['Bleed', v => num(v) + ' dmg/s'], bleedDur: ['Bleed duration', secs], stun: ['Stun', secs], dur: ['Duration', secs],
    volleys: ['Volleys', num], dps: ['Damage/s', num], heal: ['Heal', num], regen: ['Regen', v => num(v) + '/s'],
    spawnCd: ['Spawns every', secs], maxAlive: ['Max alive', num], value: ['Treasure', v => num(v) + 'g'],
  };
  /** Label/format info for any stat key (unknown keys get a humanized label). */
  function statInfo(k) {
    const d = STAT[k];
    const label = d ? d[0] : humanize(k);
    const fmt = d ? d[1] : (v => num(v));
    const short = d && d[2] ? d[2] : (v => fmt(v) + ' ' + label.toLowerCase());
    return { label, fmt, short };
  }

  /** Run fn, returning `fallback` on error (other modules may be mid-development). Warns once per site. */
  const warned = new Set();
  function safe(fn, fallback, site) {
    try { return fn(); } catch (e) {
      const key = site || String(e && e.message);
      if (!warned.has(key)) { warned.add(key); console.warn('[UI] ' + key + ':', e); }
      return fallback;
    }
  }

  /** Diffed DOM writes — only touch a node when the value changed. */
  function setText(node, v) { v = String(v); if (node && node._t !== v) { node._t = v; node.textContent = v; } }
  function setHTML(node, v) { if (node && node._h !== v) { node._h = v; node.innerHTML = v; return true; } return false; }
  function setWidth(node, frac) {
    const w = (clamp(frac, 0, 1) * 100).toFixed(1) + '%';
    if (node && node._w !== w) { node._w = w; node.style.width = w; }
  }
  function setClass(node, cls, on) { if (node && node.classList.contains(cls) !== !!on) node.classList.toggle(cls, !!on); }
  function setShown(node, on) { if (node && node.hidden === !!on) node.hidden = !on; }
  function setAttr(node, a, v) { v = String(v); if (node && node.getAttribute(a) !== v) node.setAttribute(a, v); }

  /* ---------------------------------------------------------------------------
   * 3. PIXEL ICONS — tiny pixel-art glyphs rendered as crisp inline SVG
   *    (one <path> per colour; '.' = transparent).
   * ------------------------------------------------------------------------ */
  const PIX = {
    heart: { c: { r: '#ff4560', w: '#ffc2cc', d: '#a3122e' }, g: ['.rr.rr.', 'rwrrrrr', 'rrrrrrd', '.rrrrd.', '..rrd..', '...d...'] },
    gem: { c: { r: '#ff3a5c', w: '#ffd0d8', p: '#ff8aa0', d: '#9a0f2c', k: '#5a0418' }, g: [
      '.kkk.kkk.', 'krrrkrrrk', 'kwwrrrrpk', 'kwrrrrrdk', 'krrrrrrdk', '.krrrrdk.', '..krrdk..', '...kdk...', '....k....'] },
    coin: { c: { o: '#8a5a10', y: '#ffcf40', w: '#fff4b8', d: '#d99a1c' }, g: ['..ooo..', '.oyyyo.', 'oywyyyo', 'oyyyydo', 'oyyyddo', '.oyddo.', '..ooo..'] },
    mana: { c: { o: '#12306e', b: '#4a9bff', w: '#d0e8ff', d: '#2a64d0' }, g: ['...o...', '..obo..', '..obo..', '.obbbo.', 'obwbbbo', 'obwbbbo', 'obbbbdo', '.obddo.', '..ooo..'] },
    flag: { c: { p: '#c9b99a', r: '#e0324e', d: '#9a1030' }, g: ['prr....', 'prrrrr.', 'prrrrd.', 'prrd...', 'p......', 'p......', 'p......', 'p......'] },
    trophy: { c: { y: '#ffcf40', w: '#fff4b8', d: '#b8801c' }, g: ['yyyyyyy', 'y.ywyd.', 'yyywydy', '.yyyyd.', '..yyd..', '...y...', '..yyy..', '.ddddd.'] },
    crown: { c: { y: '#ffcf40', r: '#ff3a5c', b: '#6ab0ff', d: '#b8801c' }, g: ['y..y..y', 'yy.y.yy', 'yyyyyyy', 'yrybyry', 'ddddddd'] },
    star: { c: { y: '#ffd24a', w: '#fff4b8' }, g: ['...y...', '...w...', 'yyywyyy', '.yyyyy.', '..yyy..', '.yy.yy.', '.y...y.'] },
    skull: { c: { w: '#ece6d4', k: '#2a2230', s: '#b8b09c' }, g: ['.wwwww.', 'wwwwwww', 'wkkwkkw', 'wkkwkkw', 'swwkwws', '.wwwww.', '.w.s.w.'] },
    sword: { c: { w: '#e8eef8', s: '#9aa6ba', h: '#c08a28', g: '#ffcf40' }, g: ['......ww', '.....wws', '....wws.', '...wws..', 'g.wws...', '.gws....', '.hg.....', 'h..g....'] },
    pause: { c: { w: '#ede6f3' }, g: ['ww.ww', 'ww.ww', 'ww.ww', 'ww.ww', 'ww.ww', 'ww.ww', 'ww.ww'] },
    play: { c: { w: '#ede6f3' }, g: ['w....', 'ww...', 'www..', 'wwww.', 'www..', 'ww...', 'w....'] },
    sound: { c: { w: '#ede6f3', b: '#8cc0ff' }, g: ['...w..b.', '..ww...b', 'wwww.b.b', 'wwww.b.b', 'wwww.b.b', '..ww...b', '...w..b.'] },
    mute: { c: { w: '#ede6f3', r: '#ff5364' }, g: ['...w....', '..ww....', 'wwww.r.r', 'wwww..r.', 'wwww.r.r', '..ww....', '...w....'] },
    help: { c: { w: '#ede6f3' }, g: ['.wwww.', 'ww..ww', '....ww', '...ww.', '..ww..', '..ww..', '......', '..ww..'] },
    route: { c: { g: '#62d27f', y: '#ffd76a', r: '#ff4560' }, g: ['gg......', 'gg.y.y..', '......y.', '.....y..', '..y.y...', '.y......', '..y.y.rr', '......rr'] },
    eye: { c: { w: '#e8d8ff', r: '#ff5a5a', k: '#2a0a0a' }, g: ['..wwww..', '.w.rr.w.', 'w.rkkr.w', 'w.rkkr.w', '.w.rr.w.', '..wwww..'] },
    lock: { c: { g: '#b8b0c4', y: '#d9a84a', k: '#3a2410', d: '#9a7020' }, g: ['..ggg..', '.g...g.', '.g...g.', 'yyyyyyy', 'yyykyyy', 'yyykyyy', 'ddddddd'] },
    clock: { c: { w: '#d8d0e4', k: '#ffd76a' }, g: ['..www..', '.w.k.w.', 'w..k..w', 'w..kk.w', 'w.....w', '.w...w.', '..www..'] },
    door: { c: { o: '#4a2c14', b: '#8a5a2a', y: '#ffcf40' }, g: ['.oooo.', 'obbbbo', 'obbbbo', 'obbbbo', 'obbbyo', 'obbbbo', 'obbbbo', 'oooooo'] },
    sack: { c: { b: '#a87848', d: '#6a4a28', y: '#ffcf40' }, g: ['..d.d..', '...d...', '..bbb..', '.bbbbb.', 'bbbybbb', 'bbbbbbd', '.bddbd.'] },
    wrench: { c: { g: '#c0c8d6', d: '#7a8296' }, g: ['....g.g', '....ggg', '...ggd.', '..ggd..', '.ggd...', 'ggd....', 'gd.....'] },
    up: { c: { g: '#62d27f', d: '#2c8a48' }, g: ['...g...', '..ggg..', '.ggggg.', 'ggggggd', '..ggd..', '..ggd..', '..ggd..'] },
    scroll: { c: { p: '#e8d8b0', k: '#8a7050', d: '#a08050' }, g: ['ddddddd', '.ppppp.', '.pkkkp.', '.ppppp.', '.pkkpp.', '.ppppp.', 'ddddddd'] },
    tower: { c: { g: '#a89cc0', d: '#6a5e84', k: '#2a2238' }, g: ['g.g.g.g', 'ggggggg', '.ggggd.', '.gkggd.', '.ggggd.', '.ggkgd.', 'ddddddd'] },
    expand: { c: { g: '#62d27f' }, g: ['ggg.ggg', 'gg...gg', 'g.....g', '.......', 'g.....g', 'gg...gg', 'ggg.ggg'] },
    person: { c: { w: '#d8d0e4' }, g: ['.www.', '.www.', '..w..', 'wwwww', '.www.', '.w.w.', '.w.w.'] },
    info: { c: { b: '#8fb8ff', w: '#10182a' }, g: ['..bbb..', '.bbwbb.', 'bbbbbbb', 'bbbwbbb', 'bbbwbbb', '.bbwbb.', '..bbb..'] },
    good: { c: { g: '#62d27f' }, g: ['......g', '.....gg', 'g...gg.', 'gg.gg..', '.ggg...', '..g....'] },
    warn: { c: { y: '#f2b640', k: '#2a1a05' }, g: ['...y...', '..yyy..', '..yky..', '.yykyy.', '.yyyyy.', 'yyykyyy', 'yyyyyyy'] },
    bad: { c: { r: '#ff5364' }, g: ['r.....r', 'rr...rr', '.rr.rr.', '..rrr..', '.rr.rr.', 'rr...rr', 'r.....r'] },
    hammer: { c: { s: '#b8c0cc', d: '#6a7282', h: '#a0703a' }, g: ['.sssss.', 'sssssd.', '.dsh...', '...h...', '...h...', '...h...', '...h...'] },
  };
  const pxCache = new Map();
  /** Inline SVG markup for a pixel icon. */
  function px(name, cls = '') {
    const key = name + '|' + cls;
    if (pxCache.has(key)) return pxCache.get(key);
    const def = PIX[name];
    if (!def) return '';
    const h = def.g.length, w = def.g.reduce((m, r) => Math.max(m, r.length), 0);
    const paths = {};
    def.g.forEach((row, y) => {
      for (let x = 0; x < row.length;) {
        const ch = row[x];
        if (ch === '.' || !def.c[ch]) { x++; continue; }
        let n = 1;
        while (row[x + n] === ch) n++;
        paths[ch] = (paths[ch] || '') + `M${x} ${y}h${n}v1h-${n}z`;
        x += n;
      }
    });
    const body = Object.keys(paths).map(ch => `<path fill="${def.c[ch]}" d="${paths[ch]}"/>`).join('');
    const svg = `<svg class="px px-${name}${cls ? ' ' + cls : ''}" viewBox="0 0 ${w} ${h}" width="${w * 2}" height="${h * 2}" shape-rendering="crispEdges" aria-hidden="true">${body}</svg>`;
    pxCache.set(key, svg);
    return svg;
  }
  /** Replace every <i data-px="name"> placeholder inside root with its SVG. */
  function hydratePixels(root) {
    for (const n of root.querySelectorAll('[data-px]')) {
      const tpl = document.createElement('template');
      tpl.innerHTML = px(n.getAttribute('data-px'));
      const svg = tpl.content.firstChild;
      if (svg) { if (n.id) svg.id = n.id; n.replaceWith(svg); }
    }
  }

  /* ---------------------------------------------------------------------------
   * 4. SPRITE ICONS (from Render's Sprites, with emoji fallback)
   * ------------------------------------------------------------------------ */
  const iconCache = new Map();
  /** Cached Sprites.iconURL(kind, id); '' when unavailable. Empty results are not cached. */
  function iconURL(kind, id) {
    const key = kind + ':' + id;
    const hit = iconCache.get(key);
    if (hit) return hit;
    let url = '';
    if (typeof Sprites !== 'undefined' && Sprites && typeof Sprites.iconURL === 'function') {
      url = safe(() => Sprites.iconURL(kind, id), '', 'Sprites.iconURL') || '';
    }
    if (typeof url !== 'string') url = '';
    if (url) iconCache.set(key, url);
    return url;
  }
  /** <img> for a sprite icon, or a glyph span when there is no image. */
  function iconHTML(kind, id, cls = '') {
    const url = iconURL(kind, id);
    if (url) return `<img class="ico${cls ? ' ' + cls : ''}" src="${url}" alt="" draggable="false">`;
    return `<span class="ico glyph${cls ? ' ' + cls : ''}">${GLYPH[kind + ':' + id] || '❔'}</span>`;
  }
  const structIcon = (cat, id, cls) => iconHTML(cat === 'wall' ? 'wall' : cat, id, cls);

  /* ---------------------------------------------------------------------------
   * 5. UI STATE & DOM REFERENCES
   * ------------------------------------------------------------------------ */
  const U = {
    ready: false,
    run: null,              // the S object the panels were built for (new run → full rebuild)
    hudT: 0,
    tab: BUILD_TABS[0].id,
    seen: new Set(),        // unlocked item keys the player has seen (for "NEW" markers)
    cardSig: '', previewSig: '', perkSig: '', gridKey: '',
    lastGold: null, lastHeart: null,
    drag: null,             // active left-drag placement {visited:Set, tx, ty, noGold}
    failMsg: '', failT: 0,  // throttling for placement-failure toasts
    toasts: [],
    reward: { ids: [], t: 0 },
    helpPaused: false,      // help overlay paused the wave (resume on close)
    bossKillsAtStart: 0,
    cdMax: {},              // observed full cooldown per power (handles perk-scaled cooldowns)
    powerRefs: {},
    resizeQueued: false,
    previewFor: undefined,  // the S.nextWave object the preview was built from
    mouseX: -1, mouseY: -1,
  };
  const el = {};
  const $ = id => document.getElementById(id);

  /** Perk names that unlock a given 'cat:id' early. */
  const UNLOCK_PERKS = {};
  for (const p of PERKS) if (p.unlocks) for (const [c, i] of p.unlocks) (UNLOCK_PERKS[c + ':' + i] = UNLOCK_PERKS[c + ':' + i] || []).push(p.name);

  /* ---------------------------------------------------------------------------
   * 6. TOASTS — top-centre of the board, max 4, auto-fading, de-duplicated.
   * ------------------------------------------------------------------------ */
  const TOAST_ICON = { info: 'info', good: 'good', warn: 'warn', bad: 'bad' };
  /** Show a toast. kind: 'info' | 'good' | 'warn' | 'bad'. Repeats bump a ×N counter instead of stacking. */
  function toast(msg, kind = 'info') {
    msg = String(msg == null ? '' : msg);
    if (!msg) return;
    if (!TOAST_ICON[kind]) kind = 'info';
    if (!U.ready) { console.log('[toast] ' + msg); return; }
    const dup = U.toasts.find(t => !t.leaving && t.msg === msg && t.kind === kind);
    if (dup) {
      dup.count++;
      dup.countEl.textContent = '×' + dup.count;
      dup.node.classList.remove('bump'); void dup.node.offsetWidth; dup.node.classList.add('bump');
      armToast(dup);
      return;
    }
    const node = document.createElement('div');
    node.className = 'toast t-' + kind;
    node.innerHTML = `<span class="t-ico">${px(TOAST_ICON[kind])}</span><span class="t-msg">${esc(msg)}</span><b class="t-count"></b>`;
    el.toasts.appendChild(node);
    const t = { msg, kind, node, count: 1, countEl: node.querySelector('.t-count'), timer: 0, leaving: false };
    U.toasts.push(t);
    const live = U.toasts.filter(x => !x.leaving);
    for (let i = 0; i < live.length - TOAST_MAX; i++) dismissToast(live[i]);
    armToast(t);
  }
  function armToast(t) {
    clearTimeout(t.timer);
    const base = t.kind === 'bad' ? 4200 : t.kind === 'good' ? 3400 : 2900;
    t.timer = setTimeout(() => dismissToast(t), Math.min(6500, base + t.msg.length * 25));
  }
  function dismissToast(t) {
    if (t.leaving) return;
    t.leaving = true;
    clearTimeout(t.timer);
    t.node.classList.add('out');
    setTimeout(() => {
      t.node.remove();
      const i = U.toasts.indexOf(t);
      if (i >= 0) U.toasts.splice(i, 1);
    }, 300);
  }
  /** Remove every toast immediately (new run / back to title). */
  function clearToasts() {
    for (const t of U.toasts) { clearTimeout(t.timer); t.node.remove(); }
    U.toasts.length = 0;
  }
  /** Throttled toast for repeated failures (placement, casting). */
  function failToast(reason, kind = 'warn') {
    if (!reason) return;
    const now = performance.now();
    if (reason === U.failMsg && now - U.failT < FAIL_TOAST_GAP) return;
    U.failMsg = reason; U.failT = now;
    toast(reason, kind);
  }

  /* ---------------------------------------------------------------------------
   * 7. TOOLTIP — one DOM element that follows the mouse and never leaves the
   *    viewport. Sources: elements with data-tip="kind|args…" or the board.
   * ------------------------------------------------------------------------ */
  const Tip = {
    src: null,       // Element with data-tip, 'board', or null
    html: '',
    w: 0, h: 0,
    /** Start showing the tooltip for an element. */
    forEl(node) {
      if (this.src === node) return;
      this.src = node;
      this.render();
    },
    /** Show/refresh the board tooltip (hover target changed). */
    forBoard() { this.src = 'board'; this.render(); },
    hide() {
      this.src = null;
      if (!el.tip.hidden) el.tip.hidden = true;
    },
    /** Rebuild content (if changed) and position it. */
    render() {
      if (!this.src) return;
      const html = this.src === 'board' ? boardTip() : tipFor(this.src.getAttribute('data-tip') || '');
      if (!html) { if (!el.tip.hidden) el.tip.hidden = true; this.html = ''; return; }
      if (html !== this.html || el.tip.hidden) {
        this.html = html;
        el.tip.innerHTML = html;
        el.tip.hidden = false;
        this.w = el.tip.offsetWidth; this.h = el.tip.offsetHeight;
      }
      this.place();
    },
    place() {
      if (el.tip.hidden) return;
      const mx = U.mouseX, my = U.mouseY, vw = window.innerWidth, vh = window.innerHeight, m = 6;
      let x = mx + 16, y = my + 18;
      if (x + this.w > vw - m) x = mx - this.w - 14;
      if (y + this.h > vh - m) y = my - this.h - 14;
      x = Math.max(m, Math.min(x, vw - this.w - m));
      y = Math.max(m, Math.min(y, vh - this.h - m));
      el.tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    },
    /** ~10 Hz: refresh dynamic content; follow panels that were rebuilt under the mouse. */
    tick() {
      if (!this.src) return;
      if (this.src !== 'board' && !this.src.isConnected) {
        const under = document.elementFromPoint(U.mouseX, U.mouseY);
        const t = under && under.closest ? under.closest('[data-tip]') : null;
        if (t) { this.src = t; } else { this.hide(); return; }
      }
      this.render();
    },
  };

  /** Tooltip HTML for a data-tip spec. */
  function tipFor(spec) {
    if (!S) return '';
    const p = spec.split('|');
    switch (p[0]) {
      case 'card': return cardTip(p[1], p[2]);
      case 'perk': return perkTip(p[1]);
      case 'power': return powerTip(p[1]);
      case 'hero': return heroClassTip(p[1], p[2] === '1', p[3] || null, Number(p[4]) || S.wave);
      case 'heroBoss': return heroClassTip(HERO_BOSSES[p[1]] ? HERO_BOSSES[p[1]].base : 'warrior', false, p[1], Number(p[2]) || S.wave);
      case 'hud': return hudTip(p[1]);
      case 'trap': return p[1] && TRAPS[p[1]] ? simpleTip(structIcon('trap', p[1]), TRAPS[p[1]].name, 'Trap', TRAPS[p[1]].desc) : '';
      case 'text': return `<div class="tt-desc">${esc(spec.slice(5))}</div>`;
      default: return '';
    }
  }
  function tipHead(iconHtml, title, sub, right = '') {
    return `<div class="tt-head">${iconHtml || ''}<div style="min-width:0;flex:1"><div class="tt-title">${title}</div>${sub ? `<div class="tt-sub">${sub}</div>` : ''}</div>${right}</div>`;
  }
  function simpleTip(iconHtml, title, sub, desc) {
    return tipHead(iconHtml, esc(title), esc(sub)) + (desc ? `<div class="tt-desc">${esc(desc)}</div>` : '');
  }
  function rows(pairs) {
    const r = pairs.filter(Boolean);
    return r.length ? `<dl class="tt-rows">${r.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : '';
  }
  function hpBar(cur, max, cls = 'fill-hp', label = true) {
    const f = max > 0 ? clamp(cur / max, 0, 1) : 0;
    const tone = cls === 'fill-hp' ? (f < 0.3 ? ' low' : f < 0.6 ? ' mid' : '') : '';
    return `<div class="tt-bar"><div class="bar"><i class="fill ${cls}${tone}" style="width:${(f * 100).toFixed(1)}%"></i></div>${label ? `<span>${fmtInt(Math.max(0, Math.ceil(cur)))}/${fmtInt(max)}</span>` : ''}</div>`;
  }
  const chip = (text, cls = '') => `<span class="chip${cls ? ' ' + cls : ''}">${text}</span>`;
  function pipsHTML(level, max = 3) {
    let s = '<span class="pips">';
    for (let i = 1; i <= max; i++) s += `<i class="pip${i <= level ? ' on' : ''}"></i>`;
    return s + '</span>';
  }

  /** Status-effect chips for a hero or monster. */
  function statusChips(e) {
    const s = e.st;
    if (!s) return '';
    const out = [];
    if (s.stunT > 0) out.push(chip('Stunned ' + secs(Math.max(0.1, s.stunT)), 'warnc'));
    if (s.rootT > 0) out.push(chip('Rooted', 'warnc'));
    if (s.fearT > 0) out.push(chip('Terrified', 'tag'));
    if (s.slowT > 0) out.push(chip('Slowed ' + pct(s.slow), 'warnc'));
    if (s.burnT > 0) out.push(chip('Burning ' + num(s.burn) + '/s', 'badc'));
    if (s.bleedT > 0) out.push(chip('Bleeding ' + num(s.bleed) + '/s', 'badc'));
    if (s.buffT > 0) out.push(chip(e.team === 'dm' ? 'Enraged' : 'Empowered', 'goodc'));
    if (e.team === 'hero' && s.exposed) out.push(chip('Exposed +25%', 'warnc'));
    if (s.invisT > 0) out.push(chip('Invisible', 'tag'));
    return out.length ? `<div class="tt-chips">${out.join('')}</div>` : '';
  }

  /* ---- Board tooltips ---------------------------------------------------- */
  function boardTip() {
    if (!S) return '';
    const hv = S.ui.hover;
    if (!hv) return '';
    // While placing, only surface non-obvious rejection reasons.
    if (S.phase === 'build' && S.ui.tool) {
      const t = S.ui.tool;
      const c = safe(() => Build.canPlace(t.cat, t.id, hv.tx, hv.ty), { ok: true }, 'Build.canPlace');
      if (c && !c.ok && c.reason && !/occupied|open floor/i.test(c.reason)) {
        return `<div class="${c.blocks ? 'tt-bad' : 'tt-warn'}">${px(c.blocks ? 'bad' : 'warn')} ${esc(c.reason)}</div>`;
      }
      return '';
    }
    if (S.phase === 'wave' && S.ui.power) return powerTargetTip(S.ui.power, hv);
    const e = Spatial.entityAt(hv.wx, hv.wy, 0.5);
    if (e) return e.team === 'hero' ? heroTip(e) : monsterTip(e);
    const t = Grid.tile(hv.tx, hv.ty);
    if (!t) return '';
    if (t.s) return structTip(t.s, t);
    return terrainTip(t);
  }

  function powerTargetTip(id, hv) {
    const p = POWERS[id];
    if (!p) return '';
    const chk = powerCan(id, hv.wx, hv.wy);
    if (!chk.ok && chk.reason) return `<div class="tt-warn">${px('warn')} ${esc(chk.reason)}</div>`;
    if (id === 'collapse') {
      const c = Grid.canCollapse(hv.tx, hv.ty);
      return c.ok ? `<div class="tt-good">${p.icon} Collapse this tile</div>` : `<div class="tt-warn">${px('warn')} ${esc(c.reason)}</div>`;
    }
    if (p.target === 'hero') {
      const h = Spatial.nearestHero(hv.wx, hv.wy, 0.9);
      if (!h) return `<div class="tt-desc">${p.icon} Click a hero to terrify them.</div>`;
      const immune = HERO_CLASSES[h.type].fearImmune || h.boss;
      return immune ? `<div class="tt-warn">${px('warn')} ${esc(heroName(h))} is immune to fear.</div>` : `<div class="tt-good">${p.icon} Terrify ${esc(heroName(h))}</div>`;
    }
    if (id === 'lightning') {
      const n = Spatial.heroesInRadius(hv.wx, hv.wy, p.radius).length;
      return `<div class="${n ? 'tt-good' : 'tt-desc'}">${p.icon} ${n ? `Strike ${n} hero${n > 1 ? 'es' : ''}` : 'No heroes in the blast'}</div>`;
    }
    return '';
  }

  const heroName = h => (h.boss && HERO_BOSSES[h.boss] ? HERO_BOSSES[h.boss].name : h.name || HERO_CLASSES[h.type].name);

  /** Tooltip for a live hero entity. */
  function heroTip(h) {
    const c = HERO_CLASSES[h.type] || { name: h.type, role: '' };
    const b = h.boss ? HERO_BOSSES[h.boss] : null;
    const icon = b ? iconHTML('heroBoss', h.boss) : iconHTML('hero', h.type);
    const tags = [];
    if (b) tags.push(`<span class="badge badge-boss">${px('crown')}Boss</span>`);
    if (h.elite) tags.push(`<span class="badge badge-rep">${px('star')}Elite</span>`);
    const sub = b ? esc(b.title) + ' · ' + esc(c.name) : esc(c.name) + ' · ' + esc(c.role);
    const state = has(typeof Heroes !== 'undefined' ? Heroes : null, 'stateLabel') ? safe(() => Heroes.stateLabel(h), h.state, 'Heroes.stateLabel') : h.state;
    const r = [['State', esc(state || '—')]];
    if (h.loot > 0) r.push(['Carrying', `<span class="goldc">${px('sack')} ${fmtInt(h.loot)} gold</span>`]);
    if (h.channel && h.channel.max > 0) r.push(['Channeling', `${esc(humanize(h.channel.kind))} ${pct(clamp(h.channel.t / h.channel.max, 0, 1))}`]);
    if (b) r.push([esc(b.ability), h.abilityT > 0 ? 'in ' + secs(Math.max(0.1, h.abilityT)) : '<span class="bad">ready</span>']);
    if (h.leader) r.push(['Role', 'Party leader']);
    return tipHead(icon, esc(heroName(h)), sub, tags.join(' ')) + hpBar(h.hp, h.maxHp) + rows(r) + statusChips(h);
  }

  /** Tooltip for a live monster entity. */
  function monsterTip(m) {
    const d = MONSTERS[m.type] || BOSSES[m.type] || { name: m.type };
    const cat = BOSSES[m.type] ? 'boss' : 'monster';
    const lvl = m.level || (m.post && m.post.level) || 1;
    const tags = [];
    if (m.isBoss || cat === 'boss') tags.push('Dungeon boss');
    if (m.temp) tags.push(m.risen ? 'Risen for this wave' : m.lair ? 'Lair spawn' : 'Summoned');
    else if (m.risen) tags.push('Risen');
    const state = has(typeof Monsters !== 'undefined' ? Monsters : null, 'stateLabel') ? safe(() => Monsters.stateLabel(m), m.state, 'Monsters.stateLabel') : m.state;
    const r = [['State', esc(state || '—')]];
    if (m.disguised) r.push(['Disguise', 'Looks like a treasure chest']);
    if (m.abilityName) r.push([esc(m.abilityName), m.abilityT > 0 ? 'in ' + secs(Math.max(0.1, m.abilityT)) : '<span class="good">ready</span>']);
    if (m.respawnT > 0) r.push(['Reassembles', 'in ' + secs(m.respawnT)]);
    const lines = has(typeof Monsters !== 'undefined' ? Monsters : null, 'describe') ? safe(() => Monsters.describe(m), [], 'Monsters.describe') : [];
    const extra = Array.isArray(lines) ? lines.map(String).filter(l => !HP_LINE.test(l)) : [];
    const lineHTML = extra.length ? `<ul class="tt-lines">${extra.slice(0, 6).map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : '';
    const sub = `${pipsHTML(lvl)} Level ${lvl}${tags.length ? ' · ' + tags.join(' · ') : ''}`;
    return tipHead(structIcon(cat, m.type), esc(d.name), sub) + hpBar(m.hp, m.maxHp, 'fill-mon') + rows(r) + statusChips(m) + lineHTML;
  }

  /** Tooltip for a placed structure (trap/object/monster post). */
  function structTip(s, t) {
    if ((s.cat === 'monster' || s.cat === 'boss') && s.ent && !s.ent.dead && !s.ent.removed) return monsterTip(s.ent);
    const d = contentDef(s.cat, s.id) || { name: s.id };
    const lines = describeStruct(s);
    const levelled = s.cat === 'trap' || s.cat === 'monster' || s.cat === 'boss';
    const sub = (levelled ? `${pipsHTML(s.level)} Level ${s.level}` : catLabel(s.cat)) + (t.type === T.WALL || t.type === T.ROCK ? ' · wall-mounted' : '');
    let body = tipHead(structIcon(s.cat, s.id), esc(d.name), sub);
    body += flagChips(s, lines);
    if (s.maxHp) body += hpBar(s.hp, s.maxHp, 'fill-prog');
    if ((s.cat === 'monster' || s.cat === 'boss') && s.ent && s.ent.dead) body += `<div class="tt-warn">${s.ent.respawnT > 0 ? 'Reassembling in ' + secs(s.ent.respawnT) : 'Slain — returns next wave'}</div>`;
    const shown = s.maxHp ? lines.filter(l => !HP_LINE.test(l)) : lines;
    if (shown.length) body += `<ul class="tt-lines">${shown.slice(0, 8).map(l => `<li>${esc(l)}</li>`).join('')}</ul>`;
    if (S.phase === 'build') body += `<div class="tt-foot">Sell for <b class="goldc">${fmtInt(Build.sellValue(s.x, s.y))}g</b> · right-click to sell · click to inspect</div>`;
    return body;
  }
  const catLabel = c => ({ trap: 'Trap', object: 'Dungeon object', monster: 'Monster', boss: 'Dungeon boss', wall: 'Wall' }[c] || c);

  /** Status flag chips for a structure; skips flags the describe() lines already mention. */
  function flagChips(s, lines) {
    const c = flagChipList(s, lines);
    return c ? `<div class="tt-chips" style="margin:.1rem 0 .2rem">${c}</div>` : '';
  }
  function flagChipList(s, lines) {
    const text = lines.join(' ').toLowerCase();
    const out = [];
    const add = (word, label, cls) => { if (!text.includes(word)) out.push(chip(label, cls)); };
    if (s.broken) add('broken', 'Broken', 'badc');
    if (s.cat === 'trap') {
      if (s.disarmed) add('disarm', 'Disarmed', 'badc');
      else if (s.hidden && !s.revealed) add('hidden', Light.isLit(s.x, s.y) ? 'Hidden · lit by torch' : 'Hidden', 'tag');
      else if (s.revealed) add('reveal', 'Revealed', 'warnc');
      if (!s.broken && !s.disarmed && trapKnown(s) && S.phase === 'wave') out.push(chip('Heroes avoid it', 'warnc'));
    }
    if (s.cat === 'object' && s.id === 'chest' && s.data) {
      if (s.data.empty) add('empty', 'Looted', 'badc');
      else if (s.data.claimedBy) add('claim', 'A hero is coming for it', 'warnc');
    }
    return out.join('');
  }

  /** Tooltip for bare terrain (walls, rock, entrance, Heart, remembered danger). */
  function terrainTip(t) {
    switch (t.type) {
      case T.WALL:
        if (t.rubble) return simpleTip(iconHTML('wall', 'wall'), 'Rubble', 'Collapsed tunnel', 'Blocks the way like a wall. Right-click during the build phase to clear it (no refund).');
        return tipHead(iconHTML('wall', 'wall'), 'Stone Wall', 'Player-built') +
          `<div class="tt-desc">Blocks heroes and their line of sight. Arrow Walls can be mounted on it.</div>` +
          (S.phase === 'build' ? `<div class="tt-foot">Sell for <b class="goldc">${fmtInt(Build.sellValue(t.x, t.y))}g</b> · right-click to sell</div>` : '');
      case T.ROCK:
        return simpleTip(iconHTML('tile', 'rock'), 'Bedrock', 'Natural stone', 'Indestructible. Nothing can be built on it, but Arrow Walls can be mounted on its face.');
      case T.ENTRANCE:
        return simpleTip(iconHTML('tile', 'entrance'), 'Entrance', 'Where heroes arrive', 'Adventurers enter here. Fleeing heroes — and thieves carrying your treasure — escape through it.');
      case T.HEART: return heartTip();
      default: {
        const dng = Danger.get(t.x, t.y);
        if (dng >= 1 || (S.ui.showDanger && dng > 0.05)) {
          return tipHead(px('eye'), 'Danger memory', 'Heroes remember this spot') + hpBar(dng, CFG.dangerCap, 'fill-mon', false) +
            `<div class="tt-desc">Heroes died or found traps near here (${num(dng, 1)}). Smarter heroes route around remembered danger; it fades between waves.</div>`;
        }
        return '';
      }
    }
  }
  /** Human text for the Heart's retaliation pulse (flat + % of the victim's max HP, ×3 with Heart of Thorns). */
  function heartPulseText() {
    const mul = hasPerk('thorns') ? 3 : 1;
    const flat = CFG.heartPulseDmg * mul, frac = (CFG.heartPulsePct || 0) * mul;
    return `${flat}${frac ? ' + ' + pct(frac) + ' of max HP' : ''} damage every ${secs(CFG.heartPulseCd)} to heroes beside or attacking it`;
  }
  function heartTip() {
    const r = [['Pulse', heartPulseText()], ['Regenerates', `+${CFG.heartRegenPerWave} HP after each wave`]];
    if (hasPerk('undying_heart')) r.push(['Undying', S.undyingUsed ? '<span class="bad">spent this wave</span>' : '<span class="good">ready</span>']);
    return tipHead(px('gem'), 'The Dungeon Heart', 'Protect it at all costs') + hpBar(S.heartHp, S.heartMax, 'fill-heart') + rows(r) +
      '<div class="tt-foot">If it shatters, the run is over.</div>';
  }

  /* ---- Build-card / perk / power / hero-class / HUD tooltips -------------- */
  function cardTip(cat, id) {
    const d = contentDef(cat, id);
    if (!d) return '';
    const unlocked = Build.isUnlocked(cat, id);
    const cost = Build.cost(cat, id);
    const right = unlocked ? `<b class="${S.gold < cost ? 'bad' : 'goldc'}">${px('coin')} ${cost}</b>` : px('lock');
    let html = tipHead(structIcon(cat, id), esc(d.name), esc(catLabel(cat)) + (cat === 'trap' && (d.hidden || hasPerk('hidden_depths')) ? ' · hidden' : ''), right);
    html += `<div class="tt-desc">${esc(d.desc)}</div>`;
    const st = itemStats(cat, id, 1);
    const keys = Object.keys(st).filter(k => typeof st[k] === 'number' && !STAT_SKIP.has(k));
    if (keys.length) html += rows(keys.slice(0, 8).map(k => { const i = statInfo(k); return [esc(i.label), esc(i.fmt(st[k]))]; }));
    html += objectRows(cat, id);
    const place = cat === 'wall' ? 'Open floor. Must leave heroes a path to the Heart.'
      : cat === 'trap' && d.place === 'wall' ? 'Mounted on a wall or rock that faces a corridor.'
        : cat === 'boss' ? 'Open floor. Only one boss may guard the dungeon.' : 'Open floor.';
    html += `<div class="tt-foot">${px('hammer')} ${place}`;
    if (!unlocked) {
      const perks = UNLOCK_PERKS[cat + ':' + id];
      html += `<br>${px('lock')} <span class="warn">Unlocks at wave ${d.unlock}</span>${perks ? ` — or sooner with the perk <b>${esc(perks.join(' / '))}</b>` : ''}`;
    } else if (S.gold < cost) html += `<br><span class="bad">Need ${cost - S.gold} more gold.</span>`;
    return html + '</div>';
  }
  /** Extra tooltip rows for dungeon objects (their numbers live outside TRAPS/MONSTERS). */
  function objectRows(cat, id) {
    if (cat !== 'object') return '';
    const d = OBJECTS[id];
    switch (id) {
      case 'chest': return rows([['Treasure', Lures.chestValue() + 'g'], ['Lure radius', tiles(Lures.radius())]]);
      case 'torch': return rows([['Light radius', tiles(CFG.torchRadius)], ['Exposed heroes', '+' + pct(CFG.torchExposed) + ' damage taken']]);
      case 'barricade': return rows([['Health', fmtInt(d.hp * (hasPerk('reinforced') ? 2 : 1))]]);
      case 'well': return rows([['Mana regen', '+' + num(d.regen) + '/s']]);
      case 'lair': return rows([['Spawns', 'Goblin or Skeleton every ' + secs(d.spawnCd)], ['Max alive', d.maxAlive]]);
      default: return '';
    }
  }
  function perkTip(id) {
    const p = PERK_BY_ID[id];
    if (!p) return '';
    const n = S.perks[id] || 0;
    const col = rarColor(p.rarity);
    const badges = [];
    if (p.tradeoff) badges.push('<span class="badge badge-trade">Tradeoff</span>');
    if (p.repeatable) badges.push('<span class="badge badge-rep">Repeatable</span>');
    if (n > 1) badges.push(`<span class="badge badge-rep">×${n}</span>`);
    const unl = p.unlocks ? `<div class="tt-foot">${px('lock')} Unlocks: <b>${p.unlocks.map(([c, i]) => esc((contentDef(c, i) || { name: i }).name)).join(', ')}</b></div>` : '';
    return tipHead(`<span class="ico glyph">${p.icon}</span>`, esc(p.name), `<span class="rar" style="color:${col}">${esc(RARITY[p.rarity] ? RARITY[p.rarity].name : p.rarity)}</span>`, badges.join(' ')) +
      `<div class="tt-desc">${esc(p.desc)}</div>` + unl;
  }
  function powerTip(id) {
    const p = POWERS[id];
    if (!p) return '';
    const cost = powerCost(id);
    const target = p.target === 'tile' ? (id === 'collapse' ? 'An empty floor tile' : 'Any tile') : p.target === 'hero' ? 'A hero' : 'Instant';
    let status;
    if (S.phase !== 'wave') status = '<span class="muted">Usable during waves.</span>';
    else {
      const c = powerCan(id);
      status = S.ui.power === id ? '<span class="good">Armed — click the board to cast. Right-click or Esc cancels.</span>'
        : c.ok ? '<span class="good">Ready.</span>' : `<span class="bad">${esc(c.reason || 'Unavailable.')}</span>`;
    }
    return tipHead(`<span class="ico glyph">${p.icon}</span>`, esc(p.name), 'Dungeon Master power', `<kbd>${p.key}</kbd>`) +
      `<div class="tt-desc">${esc(p.desc)}</div>` +
      rows([['Mana', `<span class="manac">${cost}</span>`], ['Cooldown', secs(p.cd)], ['Target', target]]) +
      `<div class="tt-foot">${status}</div>`;
  }
  /** Tooltip for a hero class (wave preview / help), with numbers estimated for `wave`. */
  function heroClassTip(cls, elite, boss, wave) {
    const c = HERO_CLASSES[cls];
    if (!c) return '';
    const b = boss ? HERO_BOSSES[boss] : null;
    const sc = typeof heroWaveScale === 'function' ? heroWaveScale(wave)
      : { hp: 1 + CFG.heroHpPerWave * (wave - 1), dmg: 1 + CFG.heroDmgPerWave * (wave - 1) };
    let hp = c.hp * sc.hp, dmg = c.dmg * sc.dmg, spd = c.speed;
    let bounty = c.gold * (1 + CFG.bountyPerWave * (wave - 1));
    if (elite) { hp *= CFG.eliteHpMul; dmg *= CFG.eliteDmgMul; spd *= CFG.eliteSpeedMul; bounty *= CFG.eliteBountyMul; }
    if (b) { hp *= b.hpMul; dmg *= b.dmgMul; spd *= b.speedMul; bounty *= CFG.heroBossBountyMul; }
    if (hasPerk('midas')) hp *= 1.2;
    if (hasPerk('blood_money')) bounty *= 2;
    const icon = b ? iconHTML('heroBoss', boss) : iconHTML('hero', cls);
    const tags = [];
    if (b) tags.push(`<span class="badge badge-boss">${px('crown')}Boss</span>`);
    if (elite) tags.push(`<span class="badge badge-rep">${px('star')}Elite</span>`);
    let html = tipHead(icon, esc(b ? b.name : c.name), esc(b ? b.title + ' · ' + c.name : c.role), tags.join(' '));
    html += `<div class="tt-desc">${esc(c.desc)}</div>`;
    if (b) html += `<div class="tt-desc"><b class="goldc">${esc(b.ability)}:</b> ${esc(b.desc)}</div>`;
    const traits = [];
    if (c.ranged) traits.push('Ranged');
    if (c.detect) traits.push('Detects traps');
    if (c.disarm) traits.push('Disarms ' + pct(c.disarm));
    if (c.revealR) traits.push('Reveals traps');
    if (c.blastCd) traits.push('Blasts walls');
    if (c.healAmt) traits.push('Heals allies');
    if (c.fearImmune) traits.push('Fear-immune');
    if (c.fireResist) traits.push('Resists fire');
    if (c.digTime) traits.push('Digs walls');
    if (c.pitImmune) traits.push('Pit-immune');
    if (c.holy) traits.push('Holy');
    html += rows([
      ['Health', '≈ ' + fmtInt(Math.round(hp))], ['Damage', '≈ ' + fmtInt(Math.round(dmg))],
      ['Speed', num(spd, 2) + ' tiles/s'], ['Greed', pct(c.greed)], ['Bounty', '≈ ' + fmtInt(Math.round(bounty)) + 'g'],
    ]);
    if (traits.length) html += `<div class="tt-chips">${traits.map(t => chip(t, 'tag')).join('')}</div>`;
    return html;
  }
  function hudTip(k) {
    switch (k) {
      case 'logo': return simpleTip(px('gem'), 'Dungeon Heart', 'You are the Dungeon Master', 'Build a deadly maze and keep the adventurers away from your Heart.');
      case 'wave': {
        const nw = S.nextWave;
        let t = `Wave ${S.wave}. Every 5th wave a Hero Boss leads the charge; every 10 waves the dungeon expands.`;
        if (nw && nw.boss && HERO_BOSSES[nw.boss]) t += ` This wave: ${HERO_BOSSES[nw.boss].name}!`;
        return simpleTip(px('flag'), 'Wave ' + S.wave, S.phase === 'wave' ? 'In progress' : 'Next wave', t);
      }
      case 'gold': return simpleTip(px('coin'), fmtInt(S.gold) + ' gold', 'Your treasury',
        `Spend it on walls, traps, monsters and objects. Earned from slain heroes, recovered loot and wave income (+${Econ.waveIncome()} after this wave). Thieves who escape steal from it.`);
      case 'mana': {
        const wells = S.structs.filter(s => s.cat === 'object' && s.id === 'well' && !s.broken).length;
        const regen = CFG.manaRegen * (hasPerk('mana_spring') ? 1.4 : 1) + wells * OBJECTS.well.regen;
        return tipHead(px('mana'), `Mana ${Math.floor(S.mana)} / ${S.manaMax}`, 'Fuels Dungeon Master powers') +
          `<div class="tt-desc">Regenerates during waves and resets to ${CFG.manaStart} when a wave begins.</div>` +
          rows([['Regeneration', `+${num(regen, 2)}/s`], ['Mana Wells', String(wells)]]);
      }
      case 'heart': return heartTip();
      case 'best': {
        const d = Save.data;
        return simpleTip(px('trophy'), 'Best run', d.runs ? `${d.runs} run${d.runs === 1 ? '' : 's'} played` : 'No runs yet',
          d.bestWave ? `Survived ${d.bestWave} wave${d.bestWave === 1 ? '' : 's'} with ${fmtInt(d.bestKills || 0)} heroes slain.` : 'Survive a wave to set a record.');
      }
      case 'speed1': case 'speed2': case 'speed4':
        return simpleTip('', 'Game speed ' + k.slice(5) + '×', 'Keys 1 · 2 · 3 during waves', 'Simulation speed for waves. Building is never timed.');
      case 'pause': return simpleTip(px(S.paused ? 'play' : 'pause'), S.paused ? 'Resume' : 'Pause', 'Space', S.phase === 'wave' ? 'Freeze the wave. You can still inspect everything while paused.' : 'Only needed during waves — building is never timed.');
      case 'route': return simpleTip(px('route'), 'Predicted route ' + (S.ui.showPath ? 'on' : 'off'), 'Build-phase overlay', 'Shows the path a typical hero will take, avoiding visible traps and remembered danger.');
      case 'memory': return simpleTip(px('eye'), 'Danger memory ' + (S.ui.showDanger ? 'on' : 'off'), 'Overlay', 'Red tiles are where heroes died or discovered traps. They remember across waves (fading slowly) and path around it.');
      case 'mute': return simpleTip(px(SFX.muted ? 'mute' : 'sound'), SFX.muted ? 'Sound off' : 'Sound on', 'M', 'Toggle all sound effects.');
      case 'help': return simpleTip(px('help'), 'How to play', 'H or ?', 'Controls and the rules of the dungeon.');
      case 'start': {
        if (S.phase !== 'build') return simpleTip('', 'Start Wave', 'Enter', 'Available during the build phase.');
        const nw = S.nextWave;
        return simpleTip(px('sword'), 'Start Wave ' + S.wave, 'Enter', nw ? `Release ${waveTotal(nw)} heroes in ${nw.parties.length} part${nw.parties.length === 1 ? 'y' : 'ies'}. You cannot build again until the wave ends.` : 'Begin the wave.');
      }
      case 'alive': return simpleTip(px('person'), 'Heroes in the dungeon', '', 'Living adventurers currently inside your halls.');
      case 'incoming': return simpleTip(px('clock'), 'Incoming', '', 'Heroes of this wave who have not entered yet.');
      case 'slain': return simpleTip(px('skull'), 'Slain this wave', '', 'Each kill pays a bounty plus loot.');
      case 'escaped': return simpleTip(px('door'), 'Escaped', '', 'Heroes who fled out of the entrance. Thieves carrying treasure steal your gold.');
      case 'heartdmg': return simpleTip(px('heart'), 'Heart damage', '', 'Damage the Heart took this wave.');
      case 'wavegold': return simpleTip(px('coin'), 'Gold this wave', '', 'Bounties, loot and other income earned this wave.');
      default: return '';
    }
  }

  /* ---------------------------------------------------------------------------
   * 8. STATS — module-provided numbers with a data-table fallback
   * ------------------------------------------------------------------------ */
  /** Raw per-level numbers straight from the content tables (no perks). */
  function tableStats(cat, id, level) {
    const d = contentDef(cat, id);
    const out = {};
    if (!d) return out;
    const L = clamp(level | 0, 1, 3);
    if (cat === 'trap') {
      for (const k of Object.keys(d)) {
        if (STAT_SKIP.has(k)) continue;
        const v = d[k];
        if (Array.isArray(v) && typeof v[0] === 'number') out[k] = v[Math.min(v.length, L) - 1];
        else if (typeof v === 'number') out[k] = v;
      }
    } else if (cat === 'monster' || cat === 'boss') {
      const mul = CFG.levelStatMul[L] || 1;
      for (const k of Object.keys(d)) {
        if (STAT_SKIP.has(k) || typeof d[k] !== 'number') continue;
        out[k] = MON_SCALED.has(k) ? Math.round(d[k] * mul) : d[k];
      }
    }
    return out;
  }
  /** Effective stats (with perks) from Traps.stats / Monsters.stats; table fallback when unavailable. */
  function itemStats(cat, id, level) {
    let r = null;
    if (cat === 'trap' && has(typeof Traps !== 'undefined' ? Traps : null, 'stats')) r = safe(() => Traps.stats(id, level), null, 'Traps.stats');
    else if ((cat === 'monster' || cat === 'boss') && has(typeof Monsters !== 'undefined' ? Monsters : null, 'stats')) r = safe(() => Monsters.stats(id, level), null, 'Monsters.stats');
    if (r && typeof r === 'object' && Object.keys(r).some(k => typeof r[k] === 'number')) return r;
    return tableStats(cat, id, level);
  }
  /** Human-readable lines for a structure: the owning module's describe(), else stats. */
  function describeStruct(s) {
    let lines = null;
    if (s.cat === 'trap' && has(typeof Traps !== 'undefined' ? Traps : null, 'describe')) lines = safe(() => Traps.describe(s), null, 'Traps.describe');
    else if (s.cat === 'object' && has(typeof Objects !== 'undefined' ? Objects : null, 'describe')) lines = safe(() => Objects.describe(s), null, 'Objects.describe');
    else if ((s.cat === 'monster' || s.cat === 'boss') && s.ent && has(typeof Monsters !== 'undefined' ? Monsters : null, 'describe')) lines = safe(() => Monsters.describe(s.ent), null, 'Monsters.describe');
    if (Array.isArray(lines) && lines.length) return lines.map(String);
    // Fallback: plain stat lines.
    const st = itemStats(s.cat, s.id, s.level);
    const out = Object.keys(st).filter(k => typeof st[k] === 'number' && !STAT_SKIP.has(k)).slice(0, 6).map(k => { const i = statInfo(k); return i.label + ': ' + i.fmt(st[k]); });
    if (s.cat === 'object') {
      const d = OBJECTS[s.id];
      if (s.id === 'chest') out.push(s.data && s.data.empty ? 'Looted this wave' : `Holds ${Lures.chestValue()} gold`);
      else if (s.id === 'torch') out.push(`Lights ${num(CFG.torchRadius)} tiles: heroes take +${pct(CFG.torchExposed)} damage`);
      else if (s.id === 'barricade') out.push(`Health: ${fmtInt(Math.max(0, s.hp || 0))}/${fmtInt(s.maxHp || d.hp)}`);
      else if (s.id === 'well') out.push(`+${num(d.regen)} mana per second during waves`);
      else if (s.id === 'lair') out.push(`Spawns every ${secs(d.spawnCd)} (max ${d.maxAlive})`);
    }
    return out;
  }

  /* ---------------------------------------------------------------------------
   * 9. TOP BAR (HUD)
   * ------------------------------------------------------------------------ */
  function updateHud() {
    setText(el.hudWave, S.wave);
    setShown(el.hudBoss, !!(S.nextWave && S.nextWave.boss) && (S.phase === 'build' || S.phase === 'wave'));
    // Gold with an up/down bump.
    const g = Math.floor(S.gold);
    if (U.lastGold !== null && g !== U.lastGold) {
      el.hudGoldBox.classList.remove('up', 'down'); void el.hudGoldBox.offsetWidth;
      el.hudGoldBox.classList.add(g > U.lastGold ? 'up' : 'down');
    }
    U.lastGold = g;
    setText(el.hudGold, fmtInt(g));
    // Mana
    setWidth(el.hudManaFill, S.mana / Math.max(1, S.manaMax));
    setText(el.hudManaTxt, `${Math.floor(S.mana)} / ${S.manaMax}`);
    // Heart
    const hp = Math.max(0, S.heartHp);
    setWidth(el.hudHeartFill, hp / Math.max(1, S.heartMax));
    setText(el.hudHeartTxt, `${fmtInt(Math.ceil(hp))} / ${fmtInt(S.heartMax)}`);
    setClass(el.hudHeart, 'low', S.phase !== 'title' && hp / Math.max(1, S.heartMax) <= LOW_HEART);
    if (U.lastHeart !== null && hp < U.lastHeart) { el.hudHeart.classList.remove('hit'); void el.hudHeart.offsetWidth; el.hudHeart.classList.add('hit'); }
    U.lastHeart = hp;
    setText(el.hudBest, Math.max(Save.data.bestWave || 0, S.phase === 'title' ? 0 : S.stats.wavesSurvived || 0));
    // Controls
    for (const b of el.speedBtns) setClass(b, 'on', Number(b.getAttribute('data-speed')) === S.speed);
    const pauseName = S.paused ? 'play' : 'pause';
    if (el.btnPause._px !== pauseName) { el.btnPause._px = pauseName; el.btnPause.innerHTML = px(pauseName); }
    setClass(el.btnPause, 'on', !!S.paused);
    setClass(el.btnPause, 'is-off', S.phase !== 'wave');
    setClass(el.btnRoute, 'on', !!S.ui.showPath);
    setClass(el.btnMemory, 'on', !!S.ui.showDanger);
    const muteName = SFX.muted ? 'mute' : 'sound';
    if (el.btnMute._px !== muteName) { el.btnMute._px = muteName; el.btnMute.innerHTML = px(muteName); }
    setClass(el.btnMute, 'on', !!SFX.muted);
  }

  /* ---------------------------------------------------------------------------
   * 10. BUILD PANEL — tabs + item cards
   * ------------------------------------------------------------------------ */
  const tabById = id => BUILD_TABS.find(t => t.id === id) || BUILD_TABS[0];
  const toolIs = (cat, id) => !!(S.ui.tool && S.ui.tool.cat === cat && S.ui.tool.id === id);

  function renderTabs() {
    el.tabs.innerHTML = BUILD_TABS.map(t => `<button class="tab" data-tab="${t.id}">${esc(t.name)}</button>`).join('');
    el.tabBtns = [...el.tabs.querySelectorAll('.tab')];
  }
  /** Mark every unlocked item of a tab as seen (clears its NEW markers). */
  function markSeen(tabId) {
    for (const [c, i] of tabById(tabId).items) if (Build.isUnlocked(c, i)) U.seen.add(c + ':' + i);
  }
  function updateTabs() {
    for (const b of el.tabBtns) {
      const id = b.getAttribute('data-tab');
      setClass(b, 'on', id === U.tab);
      const fresh = id !== U.tab && tabById(id).items.some(([c, i]) => Build.isUnlocked(c, i) && !U.seen.has(c + ':' + i));
      setClass(b, 'fresh', fresh);
      setAttr(b, 'data-tip', fresh ? 'text|New items unlocked in this tab!' : 'text|' + tabById(id).name);
    }
  }

  /** Signature of everything the cards display; the list is rebuilt only when it changes. */
  function cardSignature() {
    const tab = tabById(U.tab);
    let sig = S.phase + '|' + U.tab + '|' + S.unlocked.size + '|' + S.perkOrder.length + '|' + (S.ui.tool ? S.ui.tool.cat + ':' + S.ui.tool.id : '') + '|' + (Build.bossPlaced() ? 1 : 0) + '|';
    for (const [c, i] of tab.items) {
      const k = c + ':' + i;
      sig += (Build.isUnlocked(c, i) ? (S.gold >= Build.cost(c, i) ? 'A' : 'P') : 'L') + (U.seen.has(k) ? '' : 'n');
    }
    return sig;
  }
  function renderCards() {
    const tab = tabById(U.tab);
    const bossTaken = Build.bossPlaced();
    el.cards.innerHTML = tab.items.map(([cat, id], idx) => {
      const d = contentDef(cat, id);
      if (!d) return '';
      const unlocked = Build.isUnlocked(cat, id);
      const cost = Build.cost(cat, id);
      const blocked = unlocked && cat === 'boss' && !!bossTaken;
      const cls = ['card'];
      if (!unlocked) cls.push('locked');
      else if (S.gold < cost) cls.push('poor');
      if (blocked) cls.push('blocked');
      if (toolIs(cat, id)) cls.push('sel');
      const isNew = unlocked && !U.seen.has(cat + ':' + id) && S.phase !== 'title';
      let bottom;
      if (!unlocked) {
        const perks = UNLOCK_PERKS[cat + ':' + id];
        bottom = `<span class="lockline">${px('lock')} Unlocks at wave ${d.unlock}${perks ? ` <span class="perkhint">· or perk</span>` : ''}</span>`;
      } else if (blocked) {
        bottom = bossTaken.id === id ? `<span class="lockline goodline">${px('crown')} Guarding your dungeon</span>`
          : `<span class="lockline">${px('crown')} Boss slot taken (${esc(BOSSES[bossTaken.id].name)})</span>`;
      } else bottom = cardChips(cat, id);
      return `<div class="${cls.join(' ')}" data-cat="${cat}" data-id="${id}" data-tip="card|${cat}|${id}">` +
        `<div class="card-ico">${structIcon(cat, id)}${idx < 9 && S.phase === 'build' && unlocked ? `<kbd class="card-key">${idx + 1}</kbd>` : ''}</div>` +
        `<div class="card-main"><div class="card-top"><span class="card-name">${esc(d.name)}</span>` +
        (unlocked ? `<span class="card-cost">${px('coin')}${cost}</span>` : '') + `</div>` +
        `<div class="card-desc">${esc(d.desc)}</div><div class="card-stats">${bottom}</div></div>` +
        (isNew ? '<span class="newtag">NEW</span>' : '') + `</div>`;
    }).join('');
  }
  /** Key-stat chips for a card. */
  function cardChips(cat, id) {
    const out = [];
    if (cat === 'wall') {
      out.push(chip('Blocks path'));
      if (hasPerk('architect')) out.push(chip('Architect −50%', 'goodc'));
      return out.join('');
    }
    if (cat === 'object') {
      const d = OBJECTS[id];
      switch (id) {
        case 'chest': out.push(chip(Lures.chestValue() + 'g treasure'), chip('Lure ' + num(Lures.radius(), 1), 'tag')); break;
        case 'torch': out.push(chip('r ' + num(CFG.torchRadius)), chip('+' + pct(CFG.torchExposed) + ' dmg'), chip('Reveals traps', 'warnc')); break;
        case 'barricade': out.push(chip(fmtInt(d.hp * (hasPerk('reinforced') ? 2 : 1)) + ' HP'), chip('Breakable', 'tag')); break;
        case 'well': out.push(chip('+' + num(d.regen) + ' mana/s', 'tag')); break;
        case 'lair': out.push(chip('every ' + secs(d.spawnCd)), chip('max ' + d.maxAlive), chip('Spawns', 'tag')); break;
      }
      return out.join('');
    }
    const st = itemStats(cat, id, 1);
    for (const k of CARD_KEYS[id] || (cat === 'trap' ? ['dmg', 'cd'] : ['hp', 'dmg'])) {
      if (typeof st[k] === 'number') out.push(chip(esc(statInfo(k).short(st[k]))));
    }
    const d = contentDef(cat, id);
    if (cat === 'trap' && (d.hidden || hasPerk('hidden_depths'))) out.push(chip('Hidden', 'tag'));
    else if (CARD_TAG[id]) out.push(chip(CARD_TAG[id], 'tag'));
    return out.join('');
  }
  function updateBuildPanel() {
    // Newly unlocked items stay "NEW" until the player views another tab or starts a wave.
    updateTabs();
    const sig = cardSignature();
    if (sig !== U.cardSig) { U.cardSig = sig; renderCards(); }
    setShown(el.buildLock, S.phase === 'wave');
    setText(el.buildNote, S.ui.tool ? 'Placing: ' + ((contentDef(S.ui.tool.cat, S.ui.tool.id) || {}).name || '') : S.phase === 'build' ? S.structs.length + ' built' : '');
  }

  /** Click on a build card: select / deselect that tool. */
  function clickCard(cat, id) {
    const d = contentDef(cat, id);
    if (!d || !S) return;
    if (S.phase !== 'build') { SFX.play('error'); failToast('You can only build between waves.', 'info'); return; }
    if (!Build.isUnlocked(cat, id)) {
      SFX.play('error');
      const perks = UNLOCK_PERKS[cat + ':' + id];
      failToast(`${d.name} unlocks at wave ${d.unlock}${perks ? ' (or with ' + perks.join(' / ') + ')' : ''}.`, 'warn');
      return;
    }
    if (cat === 'boss' && Build.bossPlaced()) { SFX.play('error'); failToast('Only one boss may guard the dungeon — sell yours to swap.', 'warn'); return; }
    U.seen.add(cat + ':' + id);
    if (toolIs(cat, id)) S.ui.tool = null;
    else { S.ui.tool = { cat, id }; S.ui.selected = null; }
    SFX.play('click');
    refreshNow();
  }
  function selectTab(id) {
    if (id === U.tab) return;
    markSeen(U.tab);
    U.tab = id;
    SFX.play('click');
    el.cards.scrollTop = 0;
    refreshNow();
  }

  /* ---------------------------------------------------------------------------
   * 11. INSPECTOR — the selected tile (or the active tool) with actions
   * ------------------------------------------------------------------------ */
  function updateInspector() {
    const sel = S.ui.selected;
    let head = '', flags = '', lines = '', preview = '', actions = '', note = '';
    if (sel) {
      const t = Grid.tile(sel.x, sel.y);
      if (!t || (!t.s && t.type === T.FLOOR)) { S.ui.selected = null; return updateInspector(); }
      const m = inspectModel(t);
      head = m.head; flags = m.flags; lines = m.lines; preview = m.preview; actions = m.actions; note = m.note;
    } else if (S.ui.tool && S.phase === 'build') {
      const { cat, id } = S.ui.tool;
      const d = contentDef(cat, id) || { name: id, desc: '' };
      const cost = Build.cost(cat, id);
      head = inspHead(structIcon(cat, id), esc(d.name), `Placing · <b class="${S.gold < cost ? 'bad' : 'goldc'}">${cost}g</b> each`, false);
      lines = `<div class="insp-empty">${esc(d.desc)}</div>`;
      const st = itemStats(cat, id, 1);
      const ks = Object.keys(st).filter(k => typeof st[k] === 'number' && !STAT_SKIP.has(k)).slice(0, 6);
      if (ks.length) lines += `<ul class="insp-lines">${ks.map(k => { const i = statInfo(k); return `<li>${esc(i.label)}: ${esc(i.fmt(st[k]))}</li>`; }).join('')}</ul>`;
      preview = `<div class="insp-empty"><b>Click</b> or <b>drag</b> on the board to place. <b>Right-click</b> empty ground or press <kbd>Esc</kbd> to put it away.</div>`;
      note = 'Tool';
    } else if (S.phase === 'wave') {
      lines = `<div class="insp-empty"><b>Click</b> anything on the board to inspect it. Use <b>DM Powers</b> <span class="nowrap">(<kbd>Q</kbd> <kbd>W</kbd> <kbd>E</kbd> <kbd>R</kbd>)</span> to intervene. <kbd>Space</kbd> pauses.</div>`;
    } else {
      lines = `<div class="insp-empty"><b>Pick a card</b> above, then click or drag on the board to build.<br>With no card selected, <b>click</b> anything you built to upgrade, repair or sell it. <b>Right-click</b> sells instantly.</div>`;
    }
    ensureInspectorNodes();
    setHTML(el.inspHead, head);
    setShown(el.inspHead, !!head);
    setHTML(el.inspFlags, flags);
    setShown(el.inspFlags, !!flags);
    setHTML(el.inspLines, lines);
    setShown(el.inspLines, !!lines);
    setHTML(el.inspPreview, preview);
    setShown(el.inspPreview, !!preview);
    setHTML(el.inspActions, actions);
    setShown(el.inspActions, !!actions);
    setText(el.inspNote, note);
    // Repair all
    const broken = S.structs.filter(s => s.broken);
    if (broken.length && S.phase !== 'title') {
      const total = Build.totalRepairCost();
      const minCost = Math.min(...broken.map(s => Build.repairCost(s)));
      const can = S.phase === 'build' && S.gold >= minCost;
      setHTML(el.btnRepairAll, `${px('wrench')} Repair all <span class="price ${can ? '' : 'bad'}">(${total ? total + 'g' : 'free'})</span> <span class="muted">· ${broken.length} broken</span>`);
      setClass(el.btnRepairAll, 'is-off', !can);
      setShown(el.btnRepairAll, true);
    } else setShown(el.btnRepairAll, false);
  }
  function ensureInspectorNodes() {
    if (el.inspHead) return;
    el.inspBody.innerHTML = '<div id="inspHead"></div><div id="inspFlags" class="insp-flags"></div><div id="inspLines"></div><div id="inspPreview"></div>';
    el.inspHead = $('inspHead'); el.inspFlags = $('inspFlags'); el.inspLines = $('inspLines');
    el.inspPreview = $('inspPreview'); el.inspActions = $('inspActions'); // actions stay pinned below the scrolling body
  }
  function inspHead(icon, title, sub, closable = true) {
    return `<div class="insp-head"><div class="card-ico">${icon}</div><div style="min-width:0"><div class="insp-title">${title}</div><div class="insp-sub">${sub}</div></div>` +
      (closable ? `<button class="btn insp-close" data-act="deselect" data-tip="text|Close (Esc)">✕</button>` : '<span></span>') + '</div>';
  }
  const actBtn = (act, icon, label, price, off, tip, extra = '') =>
    `<button class="btn ${extra}${off ? ' is-off' : ''}" data-act="${act}" aria-disabled="${off ? 'true' : 'false'}" data-tip="text|${esc(tip)}">${icon}${label}${price !== '' ? ` <span class="price">${price}</span>` : ''}</button>`;

  /** Build the inspector sections for a tile. */
  function inspectModel(t) {
    const building = S.phase === 'build';
    const m = { head: '', flags: '', lines: '', preview: '', actions: '', note: '' };
    const s = t.s;
    if (s) {
      const d = contentDef(s.cat, s.id) || { name: s.id };
      const levelled = s.cat === 'trap' || s.cat === 'monster' || s.cat === 'boss';
      const sub = (levelled ? `${pipsHTML(s.level)} Level ${s.level}${s.level >= 3 ? ' (max)' : ''}` : esc(catLabel(s.cat))) +
        ` · <span class="muted">spent ${fmtInt(s.spent)}g</span>`;
      m.head = inspHead(structIcon(s.cat, s.id), esc(d.name), sub);
      const lines = describeStruct(s);
      m.flags = flagChipList(s, lines);
      let hpHTML = '';
      if (s.maxHp) hpHTML = `<div class="insp-hp">HP ${hpBar(s.hp, s.maxHp, 'fill-prog')}</div>`;
      if (s.ent && (s.cat === 'monster' || s.cat === 'boss')) {
        const e = s.ent;
        hpHTML = e.dead ? `<div class="insp-hp warn">${e.respawnT > 0 ? 'Reassembling in ' + secs(e.respawnT) : 'Fallen — returns at the next wave'}</div>`
          : `<div class="insp-hp">HP ${hpBar(e.hp, e.maxHp, 'fill-mon')}</div>`;
      }
      const shown = hpHTML ? lines.filter(l => !HP_LINE.test(l)) : lines;
      m.lines = hpHTML + (shown.length ? `<ul class="insp-lines">${shown.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : '');
      // Upgrade preview
      if (Build.upgradable(s)) {
        const a = itemStats(s.cat, s.id, s.level), b = itemStats(s.cat, s.id, s.level + 1);
        const diffs = [];
        for (const k of Object.keys(b)) {
          if (STAT_SKIP.has(k) || typeof a[k] !== 'number' || typeof b[k] !== 'number' || Math.abs(a[k] - b[k]) < 1e-9) continue;
          const i = statInfo(k);
          diffs.push(`<span class="diff">${esc(i.label)} ${esc(i.fmt(a[k]))}<i>→</i><b>${esc(i.fmt(b[k]))}</b></span>`);
        }
        if (diffs.length) m.preview = `<div class="insp-preview"><span class="ttl">${px('up')} Level ${s.level + 1}</span>${diffs.join('')}</div>`;
      }
      // Actions
      const acts = [];
      if (levelled) {
        if (Build.upgradable(s)) {
          const c = Build.upgradeCost(s);
          const off = !building || S.gold < c;
          acts.push(actBtn('upgrade', px('up'), 'Upgrade', c + 'g', off, !building ? 'Upgrades are made between waves.' : S.gold < c ? `Need ${c - S.gold} more gold.` : `Upgrade to level ${s.level + 1} (U).`));
        } else acts.push(actBtn('upgrade', px('star'), 'Max level', '', true, 'Already at the maximum level.'));
      }
      if (s.broken) {
        const c = Build.repairCost(s);
        const off = !building || S.gold < c;
        acts.push(actBtn('repair', px('wrench'), 'Repair', c ? c + 'g' : 'free', off, !building ? 'Repairs are made between waves.' : S.gold < c ? `Need ${c - S.gold} more gold.` : 'Restore it to working order.'));
      }
      const sv = Build.sellValue(s.x, s.y);
      acts.push(actBtn('sell', px('coin'), 'Sell', '+' + sv + 'g', !building, building ? `Refund ${sv}g (${hasPerk('salvager') ? '100' : Math.round(CFG.sellRate * 100)}% of the gold spent). Del or right-click.` : 'Selling is only possible between waves.', 'btn-red'));
      m.actions = acts.join('');
      m.note = catLabel(s.cat);
      return m;
    }
    switch (t.type) {
      case T.WALL: {
        const sv = Build.sellValue(t.x, t.y);
        m.head = inspHead(iconHTML('wall', 'wall'), t.rubble ? 'Rubble' : 'Stone Wall', t.rubble ? 'Collapsed by your power' : `Player-built · <span class="muted">paid ${fmtInt(t.paid)}g</span>`);
        m.lines = `<ul class="insp-lines"><li>Blocks movement and line of sight.</li>${t.rubble ? '<li>Clearing it gives no refund.</li>' : '<li>Arrow Walls can be mounted on it.</li>'}<li>Mages and Dwarf Miners can break through walls.</li></ul>`;
        m.actions = actBtn('sell', px(t.rubble ? 'hammer' : 'coin'), t.rubble ? 'Clear' : 'Sell', t.rubble ? '' : '+' + sv + 'g', !building,
          building ? (t.rubble ? 'Clear the rubble (no refund).' : `Refund ${sv}g.`) : 'Only possible between waves.', t.rubble ? '' : 'btn-red');
        m.note = 'Wall';
        return m;
      }
      case T.ROCK:
        m.head = inspHead(iconHTML('tile', 'rock'), 'Bedrock', 'Natural stone');
        m.lines = '<ul class="insp-lines"><li>Indestructible — nothing can dig or blast through it.</li><li>Arrow Walls can be mounted on its face.</li></ul>';
        m.note = 'Terrain';
        return m;
      case T.ENTRANCE:
        m.head = inspHead(iconHTML('tile', 'entrance'), 'Entrance', 'Where heroes arrive');
        m.lines = '<ul class="insp-lines"><li>Every party enters here.</li><li>Fleeing heroes and thieves escape through it — with your gold.</li><li>Keep the tiles next to it clear of walls.</li></ul>';
        m.note = 'Terrain';
        return m;
      case T.HEART: {
        m.head = inspHead(px('gem'), 'The Dungeon Heart', 'Protect it at all costs');
        m.lines = `<div class="insp-hp">HP ${hpBar(S.heartHp, S.heartMax, 'fill-heart')}</div><ul class="insp-lines"><li>Pulses for ${heartPulseText()}.</li><li>Regenerates ${CFG.heartRegenPerWave} HP after each wave.</li><li>If it shatters, the run ends.</li></ul>`;
        m.note = 'Heart';
        return m;
      }
      default: return m;
    }
  }

  /** Inspector / keyboard action on the selected tile. */
  function inspectAction(act) {
    if (!S) return;
    if (act === 'deselect') { S.ui.selected = null; refreshNow(); return; }
    const sel = S.ui.selected;
    if (!sel) return;
    if (S.phase !== 'build') { SFX.play('error'); failToast('That can only be done between waves.', 'info'); return; }
    const s = Build.structAt(sel.x, sel.y);
    switch (act) {
      case 'upgrade': {
        if (!Build.upgradable(s)) { SFX.play('error'); return; }
        const c = Build.upgradeCost(s);
        if (S.gold < c) { SFX.play('error'); failToast(`Not enough gold to upgrade (need ${c}g).`, 'warn'); return; }
        if (Build.upgrade(sel.x, sel.y)) toast(`${contentDef(s.cat, s.id).name} upgraded to level ${s.level}.`, 'good');
        break;
      }
      case 'repair': {
        if (!s || !s.broken) return;
        const c = Build.repairCost(s);
        if (S.gold < c) { SFX.play('error'); failToast(`Not enough gold to repair (need ${c}g).`, 'warn'); return; }
        Build.repair(sel.x, sel.y);
        break;
      }
      case 'sell':
        if (Build.sell(sel.x, sel.y)) S.ui.selected = null;
        break;
    }
    refreshNow();
  }
  function repairAll() {
    if (!S || S.phase !== 'build') { SFX.play('error'); return; }
    const n = Build.repairAll();
    if (n) toast(`Repaired ${n} structure${n === 1 ? '' : 's'}.`, 'good');
    else failToast('Not enough gold to repair anything.', 'warn');
    refreshNow();
  }

  /* ---------------------------------------------------------------------------
   * 12. CENTRE — Start Wave bar, wave progress and board overlays
   * ------------------------------------------------------------------------ */
  function aliveHeroes() { let n = 0; for (const h of S.heroes) if (Spatial.heroAlive(h)) n++; return n; }
  function wavesRemaining() { return has(typeof Waves !== 'undefined' ? Waves : null, 'remaining') ? safe(() => Waves.remaining(), 0, 'Waves.remaining') || 0 : 0; }

  function updateCentre() {
    const ph = S.phase;
    const building = ph === 'build';
    setShown(el.btnStart, ph !== 'wave');
    setClass(el.btnStart, 'is-off', !building);
    setAttr(el.btnStart, 'aria-disabled', building ? 'false' : 'true');
    setShown(el.waveProg, ph === 'wave');
    const nw = S.nextWave;
    if (building) {
      const route = safe(() => Path.preview(), [], 'Path.preview') || [];
      const sealed = !route.length && !Path.reachable();
      const straight = Math.abs(S.heart.x - S.entrance.x) + Math.abs(S.heart.y - S.entrance.y);
      const parties = nw ? nw.parties.length : 0;
      let main = `Wave ${S.wave}`;
      const total = waveTotal(nw);
      if (nw) main += ` · ${total} hero${total === 1 ? '' : 'es'} in ${parties} part${parties === 1 ? 'y' : 'ies'}` + (nw.elites ? ` · ${nw.elites} elite` : '');
      if (nw && nw.boss && HERO_BOSSES[nw.boss]) main += ` · <span class="badge badge-boss">${px('crown')}${esc(HERO_BOSSES[nw.boss].name)}</span>`;
      setHTML(el.wiMain, main);
      const sub = [];
      if (sealed) sub.push(`<span class="item bad">${px('bad')} The Heart is sealed off — open a path!</span>`);
      else sub.push(`<span class="item">${px('route')} Route <b>${route.length}</b> tiles${route.length > straight ? ` <span class="good">(+${route.length - straight} from your maze)</span>` : ''}</span>`);
      const broken = S.structs.reduce((n, s) => n + (s.broken ? 1 : 0), 0);
      if (broken) sub.push(`<span class="item warn">${px('wrench')} ${broken} broken — repair ${Build.totalRepairCost()}g</span>`);
      sub.push(`<span class="item">${px('coin')} +${Econ.waveIncome()}g after the wave</span>`);
      setHTML(el.wiSub, sub.join(''));
    } else if (ph === 'wave') {
      const alive = aliveHeroes(), rem = wavesRemaining(), ws = S.ws || { kills: 0, escaped: 0 };
      const total = Math.max(waveTotal(nw), (ws.spawned || 0) + rem, 1);
      const done = ws.kills + ws.escaped;
      setWidth(el.wpFill, done / total);
      setText(el.wpTxt, `${done} / ${total} dealt with`);
      setText(el.wpTag, S.paused ? 'Paused' : `Wave ${S.wave}` + (S.speed > 1 ? ` · ${S.speed}×` : ''));
      setHTML(el.wiMain, '');
      setShown(el.wiMain, false);
      setHTML(el.wiSub, `<span class="item">${px('person')} <b>${alive}</b> inside</span><span class="item">${px('clock')} <b>${rem}</b> yet to enter</span>` +
        `<span class="item">${px('skull')} <b>${ws.kills}</b> slain</span><span class="item">${px('door')} <b>${ws.escaped}</b> escaped</span>`);
    } else {
      setHTML(el.wiMain, ph === 'reward' ? `Wave ${S.wave} survived` : ph === 'gameover' ? 'The Heart has fallen' : 'Dungeon Heart');
      setHTML(el.wiSub, ph === 'reward' ? '<span class="item">Choose a perk to continue.</span>' : ph === 'gameover' ? '<span class="item">Start a new run to try again.</span>' : '');
    }
    if (ph !== 'wave') setShown(el.wiMain, true);
  }

  function updateBoardOverlays() {
    const ph = S.phase;
    // Pause banner
    const paused = ph === 'wave' && S.paused;
    setShown(el.boardBanner, paused);
    if (paused) setHTML(el.boardBanner, `<div class="big">Paused</div><div class="small">Press <kbd>Space</kbd> to resume</div>`);
    // Contextual hint
    let hint = '', power = false;
    if (ph === 'wave' && S.ui.power && POWERS[S.ui.power]) {
      const p = POWERS[S.ui.power];
      const what = p.target === 'hero' ? 'click a hero' : S.ui.power === 'collapse' ? 'click an empty floor tile' : 'click where to strike';
      hint = `<span class="hint-ico">${p.icon}</span><b>${esc(p.name)}</b> — ${what} · <kbd>Esc</kbd> / right-click to cancel`;
      power = true;
    } else if (ph === 'build' && S.ui.tool) {
      const { cat, id } = S.ui.tool;
      const d = contentDef(cat, id);
      if (d) hint = `${structIcon(cat, id, 'mini')}<b>${esc(d.name)}</b> · ${Build.cost(cat, id)}g — click or drag to place · <kbd>Esc</kbd> to cancel`;
    }
    setShown(el.boardHint, !!hint);
    setHTML(el.boardHint, hint);
    setClass(el.boardHint, 'is-power', power);
    setClass(document.body, 'has-tool', ph === 'build' && !!S.ui.tool);
    setClass(document.body, 'has-power', ph === 'wave' && !!S.ui.power);
  }

  /* ---------------------------------------------------------------------------
   * 13. RIGHT COLUMN — incoming wave preview, live status, powers, perks
   * ------------------------------------------------------------------------ */
  /** Hero count of a wave preview (falls back to counting party members). */
  function waveTotal(nw) {
    if (!nw) return 0;
    if (typeof nw.total === 'number') return nw.total;
    let n = 0;
    for (const p of nw.parties || []) n += (p.members || []).length;
    return n;
  }
  function updatePreview() {
    const nw = S.nextWave;
    const sig = (nw ? nw.wave + ':' + waveTotal(nw) + ':' + (nw.boss || '') + ':' + nw.parties.length + ':' + (nw.guildNotes || []).length : 'none') + '|' + S.perkOrder.length + '|' + S.phase;
    if (sig === U.previewSig && U.previewFor === nw) return;
    U.previewSig = sig; U.previewFor = nw;
    setText(el.pvTitle, nw ? `Incoming · Wave ${nw.wave || S.wave}` : 'Incoming Wave');
    setHTML(el.pvNote, nw && nw.boss ? `<span class="badge badge-boss">${px('crown')}Boss</span>` : nw ? `${waveTotal(nw)} heroes` : '');
    setHTML(el.previewBody, previewHTML(nw));
  }
  function previewHTML(nw) {
    if (!nw || !Array.isArray(nw.parties)) return '<div class="placeholder">The Guild has not yet chosen its champions…</div>';
    const wave = nw.wave || S.wave;
    let html = '';
    let counts = nw.counts;
    if (!counts) { counts = {}; for (const p of nw.parties) for (const m of p.members || []) counts[m.cls] = (counts[m.cls] || 0) + 1; }
    const chips = Object.keys(counts).filter(k => counts[k] > 0 && HERO_CLASSES[k])
      .map(k => `<span class="chip" data-tip="hero|${k}|0||${wave}">${iconHTML('hero', k, 'mini')} ${esc(HERO_CLASSES[k].name)} ×${counts[k]}</span>`);
    if (chips.length) html += `<div class="pv-summary">${chips.join('')}</div>`;
    if (nw.boss && HERO_BOSSES[nw.boss]) {
      const b = HERO_BOSSES[nw.boss];
      html += `<div class="boss-card" data-tip="heroBoss|${nw.boss}|${wave}"><div class="bc-ico">${iconHTML('heroBoss', nw.boss)}</div><div style="min-width:0">` +
        `<div class="bc-title">${esc(b.title)} · Hero Boss</div><div class="bc-name">${esc(b.name)}</div>` +
        `<div class="bc-ability"><b>${esc(b.ability)}</b> (every ${b.abilityCd}s): ${esc(b.desc)}</div></div></div>`;
    }
    let t = 0;
    nw.parties.forEach((p, i) => {
      t += p.delay || 0;
      const when = i === 0 ? 'enters at once' : `+${num(p.delay || 0, 1)}s · at ${num(t, 1)}s`;
      html += `<div class="party"><div class="party-head">${px('person')} Party ${i + 1} <span class="muted">(${(p.members || []).length})</span><span class="when">${px('clock')} ${when}</span></div>` +
        `<div class="party-icons">${(p.members || []).map(m => heroIconHTML(m, wave)).join('')}</div></div>`;
    });
    if (nw.guildNotes && nw.guildNotes.length) html += `<div class="notes">${nw.guildNotes.map(n => `<div class="note">${px('scroll')}<span>${esc(n)}</span></div>`).join('')}</div>`;
    const total = waveTotal(nw);
    html += `<div class="pv-total"><b>${total}</b> hero${total === 1 ? '' : 'es'} · <b>${nw.elites || 0}</b> elite` + (nw.threat != null ? ` · threat <b>${fmtInt(nw.threat)}</b>` : '') + '</div>';
    return html;
  }
  function heroIconHTML(m, wave) {
    const c = HERO_CLASSES[m.cls];
    if (!c) return '';
    const boss = m.boss && HERO_BOSSES[m.boss] ? m.boss : null;
    const mark = boss ? `<span class="mark">${px('crown')}</span>` : m.elite ? `<span class="mark">${px('star')}</span>` : '';
    return `<div class="hero-ico${m.elite ? ' elite' : ''}${boss ? ' boss' : ''}" style="--cc:${c.color}" data-tip="hero|${m.cls}|${m.elite ? 1 : 0}|${boss || ''}|${wave}">` +
      `${boss ? iconHTML('heroBoss', boss) : iconHTML('hero', m.cls)}${mark}</div>`;
  }

  function updateLive() {
    const ws = S.ws;
    const ph = S.phase;
    setText(el.liveTitle, ph === 'wave' ? `Wave ${S.wave}` : ph === 'reward' ? `Wave ${S.wave} · cleared` : ph === 'gameover' ? 'Final wave' : 'Wave');
    setText(el.liveNote, ph === 'wave' ? (S.paused ? 'Paused' : Math.floor(S.time) + 's') : '');
    if (!ws) return;
    const alive = ph === 'wave' ? aliveHeroes() : 0;
    setText(el.lvAlive, alive);
    setText(el.lvIncoming, ph === 'wave' ? wavesRemaining() : 0);
    setText(el.lvSlain, ws.kills);
    setText(el.lvEscaped, ws.escaped);
    setClass(el.lvEscaped, 'bad', ws.escaped > 0);
    setText(el.lvHeartDmg, ws.heartDmg);
    setClass(el.lvHeartDmg, 'bad', ws.heartDmg > 0);
    setText(el.lvGold, '+' + fmtInt(ws.gold));
    // Closest threat
    let best = null, bd = Infinity;
    if (ph === 'wave') for (const h of S.heroes) {
      if (!Spatial.heroAlive(h)) continue;
      const d = Path.heartDist(h.x, h.y);
      if (!best || d < bd) { bd = d; best = h; }
    }
    let line;
    if (best) {
      const c = HERO_CLASSES[best.type];
      const nm = heroName(best), cn = c ? c.name : best.type;
      line = `${px('warn')} Closest: <b>${esc(nm)}</b>${nm !== cn ? ` <span class="muted">(${esc(cn)})</span>` : ''} · ${isFinite(bd) ? `<b class="${bd <= 6 ? 'bad' : ''}">${bd}</b> tiles to the Heart` : 'tunnelling'}`;
    } else if (ph === 'wave') line = wavesRemaining() ? `${px('clock')} The next party is on its way…` : `${px('good')} The halls fall silent…`;
    else line = ph === 'reward' ? `${px('good')} Every hero is dead or gone.` : '';
    setHTML(el.lvThreat, line);
    // Boss HP
    const boss = ph === 'wave' ? S.heroes.find(h => h.boss && Spatial.heroAlive(h)) : null;
    setShown(el.lvBoss, !!boss);
    if (boss) {
      const b = HERO_BOSSES[boss.boss];
      setHTML(el.lvBoss, `<div class="bl-top">${iconHTML('heroBoss', boss.boss)}<span>${esc(b ? b.name : 'Hero boss')}</span>` +
        `<span class="bl-ab">${esc(b ? b.ability : '')} ${boss.abilityT > 0 ? secs(Math.max(0.1, Math.round(boss.abilityT * 10) / 10)) : '<span class="bad">ready</span>'}</span></div>` +
        `<div class="bar"><i class="fill fill-boss" style="width:${(clamp(boss.hp / boss.maxHp, 0, 1) * 100).toFixed(1)}%"></i><span>${fmtInt(Math.ceil(boss.hp))} / ${fmtInt(boss.maxHp)}</span></div>`);
    }
  }

  /* ---- DM powers ------------------------------------------------------------ */
  const powerCost = id => (has(typeof Powers !== 'undefined' ? Powers : null, 'cost') ? safe(() => Powers.cost(id), POWERS[id].mana, 'Powers.cost') : POWERS[id].mana);
  /** Powers.canCast(id[, wx, wy]) normalised to {ok, reason}; the point (optional) also validates the target. */
  function powerCan(id, wx, wy) {
    if (S.phase !== 'wave') return { ok: false, reason: 'Only during waves.' };
    if (!has(typeof Powers !== 'undefined' ? Powers : null, 'canCast')) return { ok: false, reason: 'Unavailable.' };
    const r = safe(() => (wx === undefined ? Powers.canCast(id) : Powers.canCast(id, wx, wy)), { ok: false, reason: 'Unavailable.' }, 'Powers.canCast');
    return r && typeof r === 'object' ? r : { ok: !!r, reason: '' };
  }
  /** Why the last Powers.cast() failed, if the module reports it. */
  const powerLastReason = () => (typeof Powers !== 'undefined' && Powers && typeof Powers.lastReason === 'string' ? Powers.lastReason : '');
  function powerCd(id) {
    if (has(typeof Powers !== 'undefined' ? Powers : null, 'cooldown')) {
      const v = safe(() => Powers.cooldown(id), null, 'Powers.cooldown');
      if (typeof v === 'number') return Math.max(0, v);
    }
    return Math.max(0, (S.powerCd && S.powerCd[id]) || 0);
  }
  function buildPowers() {
    el.powers.innerHTML = POWER_IDS.map(id => {
      const p = POWERS[id];
      return `<button class="power" data-power="${id}" data-tip="power|${id}">` +
        `<span class="pw-ico">${p.icon}<span class="pw-sweep"></span><span class="pw-cdtxt"></span></span>` +
        `<span class="pw-text"><span class="pw-name">${esc(p.name)}</span><span class="pw-status"></span></span>` +
        `<span class="pw-cost">${px('mana')}<span class="pw-costn">${p.mana}</span></span><kbd>${p.key}</kbd></button>`;
    }).join('');
    U.powerRefs = {};
    for (const b of el.powers.querySelectorAll('.power')) {
      const id = b.getAttribute('data-power');
      U.powerRefs[id] = { btn: b, cost: b.querySelector('.pw-costn'), status: b.querySelector('.pw-status'), cdtxt: b.querySelector('.pw-cdtxt'), cd: -1, prev: 0 };
    }
  }
  /** ~10 Hz: costs, enabled/armed state, mana bar. */
  function updatePowers() {
    const manaF = S.mana / Math.max(1, S.manaMax);
    setWidth(el.pwManaFill, manaF);
    setText(el.pwManaTxt, `${Math.floor(S.mana)}/${S.manaMax}`);
    setText(el.pwNote, S.ui.power && POWERS[S.ui.power] ? 'Targeting…' : '');
    for (const id of POWER_IDS) {
      const r = U.powerRefs[id];
      if (!r) continue;
      const cost = powerCost(id);
      setText(r.cost, cost);
      const can = powerCan(id);
      const armed = S.ui.power === id;
      setClass(r.btn, 'off', !can.ok && !armed);
      setClass(r.btn, 'nomana', S.mana < cost);
      setClass(r.btn, 'armed', armed);
      setAttr(r.btn, 'aria-disabled', can.ok ? 'false' : 'true');
      const cd = powerCd(id);
      setText(r.status, armed ? 'Armed — pick a target' : can.ok ? 'Ready' : cd > 0 ? 'Recharging' : S.mana < cost ? `Needs ${Math.ceil(cost - S.mana)} more mana` : (can.reason || 'Unavailable'));
      setClass(r.status, 'ok', can.ok || armed);
    }
  }
  /** Every frame (cheap): cooldown sweeps through a CSS variable. */
  function updatePowerSweeps() {
    for (const id of POWER_IDS) {
      const r = U.powerRefs[id];
      if (!r) continue;
      const cd = S.phase === 'wave' ? powerCd(id) : 0;
      let max = U.cdMax[id] || POWERS[id].cd;
      if (cd > (r.prev || 0) + 0.05) { max = Math.max(cd, 0.01); U.cdMax[id] = max; } // a new cooldown started
      r.prev = cd;
      const f = cd > 0 ? clamp(cd / max, 0, 1) : 0;
      const q = Math.round(f * 200) / 200;
      if (q !== r.cd) { r.cd = q; r.btn.style.setProperty('--cd', q); }
      setText(r.cdtxt, cd > 0 ? (cd >= 1 ? Math.ceil(cd) + 's' : cd.toFixed(1)) : '');
    }
  }

  /* ---- Perks sidebar --------------------------------------------------------- */
  function updatePerks() {
    const sig = S.perkOrder.join(',');
    if (sig === U.perkSig && el.perkGrid._h !== undefined) return;
    U.perkSig = sig;
    setText(el.perkNote, S.perkOrder.length ? `${S.perkOrder.length} taken` : '');
    setHTML(el.perkGrid, perkIconsHTML(S.perkOrder, S.perks) || '<div class="placeholder">No perks yet — survive a wave to choose your first boon.</div>');
  }
  /** Rarity-framed perk icons (unique, in the order taken, with stack counts). */
  function perkIconsHTML(order, stacks) {
    const seen = new Set();
    let html = '';
    for (const id of order) {
      if (seen.has(id)) continue;
      seen.add(id);
      const p = PERK_BY_ID[id];
      if (!p) continue;
      const n = stacks ? stacks[id] || 1 : 1;
      html += `<div class="perk-ico${p.tradeoff ? ' trade' : ''}" style="--rc:${rarColor(p.rarity)}" data-tip="perk|${id}">${p.icon}${n > 1 ? `<span class="stack">×${n}</span>` : ''}</div>`;
    }
    return html;
  }

  /* ---------------------------------------------------------------------------
   * 14. MODALS — title, reward, game over, help
   * ------------------------------------------------------------------------ */
  const MODALS = { title: 'mTitle', reward: 'mReward', over: 'mOver', help: 'mHelp' };
  const modalOpen = name => el.modal[name].classList.contains('open');
  function openModal(name) { el.modal[name].classList.add('open'); Tip.hide(); }
  function closeModal(name) {
    const m = el.modal[name];
    if (!m.classList.contains('open')) return;
    m.classList.remove('open');
    if (name === 'reward') { el.rewardCard.innerHTML = ''; U.reward.ids = []; } // no stale data-perk cards
  }
  const corners = '<i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>';

  /** Title screen. Also the phase hook for Game.toTitle() (which does not call onPhase). */
  function showTitle() {
    if (!U.ready) return;
    setPhaseClass('title');
    closeModal('reward'); closeModal('over'); closeHelp();
    endDrag();
    clearToasts();
    const d = Save.data;
    el.titleCard.innerHTML = corners +
      `<div class="title-gem">${px('gem')}</div>` +
      `<div class="logo-big"><span class="l1">Dungeon</span><span class="l2">Heart</span></div>` +
      `<p class="tagline">You are the <em>Dungeon Master</em>. Carve a maze, arm it with traps and monsters, bait the greedy with treasure — and keep the adventurers away from your beating Heart.</p>` +
      `<button class="btn btn-gold btn-big" data-act="newrun">${px('sword')} New Run <kbd>Enter</kbd></button>` +
      bestBoxHTML(d) +
      `<div class="howto">` +
      `<div class="step"><h4><span class="n">1</span>Build</h4><p>Spend gold on walls, traps, monsters and treasure. Heroes must always have a path — make it long and deadly.</p></div>` +
      `<div class="step"><h4><span class="n">2</span>Defend</h4><p>Parties storm in from the left. Cast Dungeon Master powers <span class="nowrap">(<kbd>Q</kbd><kbd>W</kbd><kbd>E</kbd><kbd>R</kbd>)</span> to collapse tunnels, terrify and smite.</p></div>` +
      `<div class="step"><h4><span class="n">3</span>Evolve</h4><p>Survive to pick 1 of 3 perks. Heroes remember where they died — keep your killing grounds moving.</p></div>` +
      `</div>` +
      `<div class="title-foot"><button class="btn" data-act="help">${px('help')} How to play <kbd>H</kbd></button>` +
      `<button class="btn" data-act="mute">${px(SFX.muted ? 'mute' : 'sound')} Sound ${SFX.muted ? 'off' : 'on'} <kbd>M</kbd></button></div>`;
    openModal('title');
    refresh();
  }
  function bestBoxHTML(d) {
    if (!d || (!d.bestWave && !d.runs)) {
      return `<div class="best-box"><div class="bb-head">${px('trophy')} Best run</div><div class="best-stats"><span class="muted">No legend yet — the Adventurers' Guild has never heard of you.</span></div></div>`;
    }
    const br = d.bestRun || {};
    const perkIds = (br.perks || []).map(name => { const p = PERKS.find(q => q.name === name); return p ? p.id : null; }).filter(Boolean);
    return `<div class="best-box"><div class="bb-head">${px('trophy')} Best run${br.date ? `<span class="date">${esc(br.date)}</span>` : ''}</div>` +
      `<div class="best-stats"><span>${px('flag')} <b>${fmtInt(d.bestWave || 0)}</b> waves survived</span><span>${px('skull')} <b>${fmtInt(d.bestKills || 0)}</b> heroes slain</span>` +
      (br.goldEarned != null ? `<span>${px('coin')} <b>${fmtInt(br.goldEarned)}</b> gold earned</span>` : '') +
      (br.favoriteTrap ? `<span>${px('star')} Favourite: <b>${esc(br.favoriteTrap)}</b></span>` : '') +
      `<span class="muted">${fmtInt(d.runs || 0)} run${d.runs === 1 ? '' : 's'} played</span></div>` +
      (perkIds.length ? `<div class="best-perks">${perkIconsHTML(perkIds, null)}</div>` : '') + `</div>`;
  }

  /** End-of-wave summary + 3 perk choices. */
  function showReward(summary, choices) {
    if (!U.ready || !S) return;
    const sm = summary || S.lastSummary || {};
    const ids = (Array.isArray(choices) ? choices : []).map(c => (typeof c === 'string' ? c : c && c.id)).filter(id => PERK_BY_ID[id]);
    U.reward = { ids, t: performance.now() };
    closeModal('help');
    const bossName = sm.boss && HERO_BOSSES[sm.boss] ? HERO_BOSSES[sm.boss].name : null;
    const bossKilled = !!sm.bossKilled || (sm.boss && S.stats.bossKills > U.bossKillsAtStart);
    const sum = (icon, big, label, small, hl = '') => `<div class="sum${hl ? ' hl-' + hl : ''}">${px(icon)}<b>${big}</b><span>${label}</span>${small ? `<small>${small}</small>` : ''}</div>`;
    const tiles = [
      sum('skull', fmtInt(sm.kills || 0), 'Heroes slain', `of ${fmtInt(sm.spawned || 0)} who entered`, 'good'),
      sum('coin', '+' + fmtInt(Math.max(0, sm.goldFromKills || 0)), 'Bounty & loot', 'from kills this wave', 'gold'),
      sum('tower', '+' + fmtInt(sm.income || 0), 'Wave income', hasPerk('midas') ? 'doubled by Midas Curse' : 'paid by your dark patrons', 'gold'),
      hasPerk('interest') || sm.interest ? sum('up', '+' + fmtInt(sm.interest || 0), 'Interest', '10% of unspent gold', 'gold')
        : sum('coin', fmtInt(S.gold), 'Treasury', 'gold to spend now', 'gold'),
      sum('heart', (sm.heartDmg ? '−' : '') + fmtInt(sm.heartDmg || 0), 'Heart damage', sm.heartHealed ? `+${sm.heartHealed} regenerated` : `${fmtInt(S.heartHp)}/${fmtInt(S.heartMax)} HP`, sm.heartDmg ? 'bad' : 'good'),
      sum('door', fmtInt(sm.escaped || 0), 'Escaped', sm.stolen ? `${fmtInt(sm.stolen)}g stolen!` : 'nothing stolen', sm.escaped ? 'bad' : ''),
      bossName ? sum('crown', bossKilled ? 'Slain!' : 'Escaped', 'Hero boss', esc(bossName), bossKilled ? 'good' : 'bad')
        : sum('flag', 'Wave ' + fmtInt((sm.wave || S.wave) + 1), 'Next up', (sm.wave || S.wave) % 5 === 4 ? 'a Hero Boss approaches!' : 'the Guild regroups'),
      sum('wrench', fmtInt(sm.broken || 0), 'Broken', sm.broken ? `repair for ${fmtInt(sm.repairCost || 0)}g` : 'everything intact', sm.broken ? 'bad' : ''),
    ];
    // Top trap of the wave
    let topTrap = '';
    const tk = sm.trapKills || {};
    const topId = Object.keys(tk).filter(k => TRAPS[k]).sort((a, b) => tk[b] - tk[a])[0];
    if (topId && tk[topId] > 0) topTrap = `<div class="reward-extra"><span class="chip" style="font-size:.76rem;padding:.15rem .5rem" data-tip="trap|${topId}">${structIcon('trap', topId, 'mini')} Deadliest trap: <b>&nbsp;${esc(TRAPS[topId].name)}</b>&nbsp;— ${tk[topId]} kill${tk[topId] === 1 ? '' : 's'}</span></div>`;
    const expand = sm.expandsNext ? `<div class="expand-note">${px('expand')} The dungeon will expand! New ground will be dug out near the entrance.</div>` : '';
    let picks;
    if (ids.length) {
      picks = `<div class="m-section">Choose a boon</div><div class="perk-row">${ids.map((id, i) => perkCardHTML(id, i)).join('')}</div>` +
        `<div class="pick-hint">Click a card or press ${ids.map((_, i) => `<kbd>${i + 1}</kbd>`).join(' ')}</div>`;
    } else {
      picks = `<div class="m-section">No boons remain</div><p class="m-sub">The dark powers have nothing more to offer — for now.</p>` +
        `<div class="m-actions"><button class="btn btn-gold btn-big" data-act="continue">Continue <kbd>Enter</kbd></button></div>`;
    }
    const flavor = sm.heartDmg ? 'The Heart is bruised, but it still beats.' : sm.kills && sm.kills === sm.spawned ? 'Not a single adventurer made it out alive.' : 'The adventurers retreat to lick their wounds.';
    el.rewardCard.innerHTML = corners + `<h2 class="m-title">Wave ${fmtInt(sm.wave || S.wave)} survived</h2><p class="m-sub">${flavor}</p>` +
      `<div class="sum-grid">${tiles.join('')}</div>` + topTrap + expand + picks;
    openModal('reward');
    refresh();
  }
  function perkCardHTML(id, i) {
    const p = PERK_BY_ID[id];
    const col = rarColor(p.rarity);
    const owned = S.perks[id] || 0;
    const badges = [];
    if (p.tradeoff) badges.push('<span class="badge badge-trade">Tradeoff</span>');
    if (p.unlocks) badges.push(`<span class="badge badge-unlock">${px('lock')}Unlocks ${esc(p.unlocks.map(([c, x]) => (contentDef(c, x) || { name: x }).name).join(', '))}</span>`);
    if (p.repeatable) badges.push(`<span class="badge badge-rep">${owned ? 'Owned ×' + owned : 'Repeatable'}</span>`);
    return `<div class="perk-card r-${esc(p.rarity)}" style="--rc:${col}" data-perk="${esc(id)}" role="button" tabindex="-1">` +
      `<kbd>${i + 1}</kbd><span class="rar pc-rar">${esc(RARITY[p.rarity] ? RARITY[p.rarity].name : p.rarity)}</span>` +
      `<div class="pc-ico">${p.icon}</div><div class="pc-name">${esc(p.name)}</div><div class="pc-desc">${esc(p.desc)}</div>` +
      `<div class="pc-badges">${badges.join('')}</div></div>`;
  }
  /** Pick a perk (or null to continue) from the reward modal. */
  function pickPerk(id) {
    if (!S || S.phase !== 'reward') return;
    if (performance.now() - U.reward.t < REWARD_GUARD_MS) return;
    const card = id && el.rewardCard.querySelector(`[data-perk="${id}"]`);
    if (card) card.classList.add('kb');
    closeModal('reward');
    Game.pickPerk(id || null);
  }

  /** Run summary after the Heart shatters. */
  function showGameOver(r) {
    if (!U.ready) return;
    r = r || {};
    closeModal('reward'); closeModal('help');
    const best = r.best || Save.data;
    const sum = (icon, big, label, hl = '') => `<div class="sum${hl ? ' hl-' + hl : ''}">${px(icon)}<b>${big}</b><span>${label}</span></div>`;
    const fav = r.favoriteTrap && TRAPS[r.favoriteTrap.id]
      ? `<div class="fav"><div class="ico-box">${structIcon('trap', r.favoriteTrap.id)}</div><div><div class="f-lbl">Favourite trap</div><div class="f-name">${esc(r.favoriteTrap.name)}</div></div>` +
        `<div class="f-stats"><b>${fmtInt(r.favoriteTrap.kills || 0)}</b> kill${r.favoriteTrap.kills === 1 ? '' : 's'}<br><b>${fmtInt(r.favoriteTrap.damage || 0)}</b> damage dealt</div></div>`
      : `<div class="fav"><div class="ico-box">${px('skull')}</div><div><div class="f-lbl">Favourite trap</div><div class="f-name muted">No trap drew blood this run</div></div></div>`;
    const perks = r.perks && r.perks.length ? `<div class="over-perks">${perkIconsHTML(r.perks.map(p => p.id), S ? S.perks : null)}</div>` : '<p class="m-sub">No perks were collected.</p>';
    const ws = r.wavesSurvived || 0;
    el.overCard.innerHTML = corners + `<h2 class="m-title">The Heart has shattered</h2>` +
      `<p class="m-sub">The adventurers plunder your halls. Your legend ends here… for now.</p>` +
      `<div class="over-hero"><div class="big">${fmtInt(ws)}</div><div class="lbl">wave${ws === 1 ? '' : 's'} survived</div>${r.newBest ? '<div class="newbest">New best!</div>' : ''}</div>` +
      `<div class="sum-grid">` +
      sum('skull', fmtInt(r.kills || 0), 'Heroes slain', 'good') + sum('star', fmtInt(r.elitesKilled || 0), 'Elites slain') +
      sum('crown', fmtInt(r.bossKills || 0), 'Bosses slain') + sum('coin', fmtInt(r.goldEarned || 0), 'Gold earned', 'gold') +
      sum('sack', fmtInt(r.stolen || 0), 'Gold stolen', r.stolen ? 'bad' : '') + sum('door', fmtInt(r.escaped || 0), 'Escaped', r.escaped ? 'bad' : '') +
      sum('heart', fmtInt(r.heartDamage || 0), 'Heart damage', 'bad') + sum('tower', fmtInt(r.structures || 0), 'Structures') +
      `</div>` + fav +
      `<div class="m-section">Perks collected</div>` + perks +
      `<div class="over-best">${px('trophy')} Best run: <b>${fmtInt(best.bestWave || 0)}</b> waves · <b>${fmtInt(best.bestKills || 0)}</b> slain` +
      (best.bestRun && best.bestRun.date ? ` <span class="muted">(${esc(best.bestRun.date)})</span>` : '') + ` · ${fmtInt(best.runs || 0)} runs</div>` +
      `<div class="m-actions"><button class="btn btn-gold btn-big" data-act="restart">${px('sword')} Restart <kbd>Enter</kbd></button>` +
      `<button class="btn btn-big" data-act="totitle">Title</button></div>`;
    openModal('over');
    refresh();
  }

  /** Help overlay (auto-pauses a running wave). */
  function openHelp() {
    if (!U.ready || modalOpen('help')) return;
    if (S && S.phase === 'wave' && !S.paused) { S.paused = true; U.helpPaused = true; }
    el.helpCard.innerHTML = helpHTML();
    openModal('help');
    SFX.play('click');
  }
  function closeHelp() {
    if (!modalOpen('help')) return;
    closeModal('help');
    if (U.helpPaused && S && S.phase === 'wave') S.paused = false;
    U.helpPaused = false;
  }
  function helpHTML() {
    const cls = Object.keys(HERO_CLASSES).map(k => {
      const c = HERO_CLASSES[k];
      return `<div class="cls-row" data-tip="hero|${k}|0||${S ? S.wave : 1}">${iconHTML('hero', k)}<span><b>${esc(c.name)}</b> <span class="muted">(${esc(c.role)}, from wave ${c.minWave})</span> — ${esc(c.desc)}</span></div>`;
    }).join('');
    const pw = POWER_IDS.map(id => { const p = POWERS[id]; return `<div class="pw-row"><kbd>${p.key}</kbd><span class="e">${p.icon}</span><span><b>${esc(p.name)}</b> <span class="manac">(${p.mana} mana)</span> — ${esc(p.desc)}</span></div>`; }).join('');
    const rar = Object.keys(RARITY).map(r => `<span><i style="border-color:${RARITY[r].color}"></i>${esc(RARITY[r].name)}</span>`).join('');
    return corners + `<button class="btn m-x" data-act="closehelp" data-tip="text|Close (Esc)">✕</button>` +
      `<h2 class="m-title">Dungeon Master's Handbook</h2><p class="m-sub">Keep the adventurers from destroying your Heart. Survive as many waves as you can.</p>` +
      `<div class="help-grid">` +
      `<div class="help-sec"><h3>${px('hammer')} Building</h3><p>Pick a card on the left, then <b>click or drag</b> on the board. <b>Walls</b> shape a maze — heroes must always have a path to the Heart (placements that seal it are refused). With no card selected, <b>click</b> a structure to upgrade, repair or sell it; <b>right-click</b> sells instantly (${Math.round(CFG.sellRate * 100)}% refund).</p>` +
      `<p>Traps and monsters have 3 levels. Broken traps stay broken until repaired. Only one boss may guard the dungeon.</p></div>` +
      `<div class="help-sec"><h3>${px('eye')} How heroes think</h3><ul>` +
      `<li><b>Danger memory</b> — heroes remember where companions died and traps were found, and route around it next time. It fades between waves. Toggle <b>Memory</b> to see it.</li>` +
      `<li><b>Hidden traps</b> — most traps are invisible until triggered. Rogues detect and disarm, Rangers reveal, and <b>torchlight</b> exposes them (but heroes in light take +25% damage).</li>` +
      `<li><b>Greed</b> — chests lure heroes off their route. A hero who escapes with treasure steals your gold.</li>` +
      `<li><b>The Guild adapts</b> — it counters your build: traps draw Rogues and Rangers, mazes draw Mages and Miners, monsters draw Warriors, Clerics and Paladins.</li></ul></div>` +
      `<div class="help-sec"><h3>${px('mana')} Dungeon Master powers</h3><div class="pw-list">${pw}</div><p style="margin-top:.4rem">Mana regenerates during waves (Mana Wells add more) and resets to ${CFG.manaStart} at the start of each wave.</p></div>` +
      `<div class="help-sec"><h3>${px('star')} Waves & perks</h3><p>Every 5th wave a <b>Hero Boss</b> leads the charge. Every 10 waves the dungeon <b>expands</b>. After each wave you earn income and choose <b>1 of 3 perks</b>.</p>` +
      `<div class="rar-row">${rar}</div><p style="margin-top:.35rem"><span class="badge badge-trade">Tradeoff</span> perks are double-edged; <span class="badge badge-unlock">Unlocks</span> perks grant content early.</p></div>` +
      `<div class="help-sec"><h3>${px('person')} Adventurers</h3><div class="cls-list">${cls}</div></div>` +
      `<div class="help-sec"><h3>${px('help')} Controls</h3><div class="keys">` +
      `<kbd>Click / drag</kbd><span>Place the selected item · select a structure</span>` +
      `<kbd>Right-click</kbd><span>Sell what's under the cursor · cancel tool / power</span>` +
      `<kbd>1 – 9</kbd><span>Build: pick a card of the current tab</span>` +
      `<kbd>U</kbd><span>Upgrade the selected structure</span><kbd>Del</kbd><span>Sell the selected structure</span>` +
      `<kbd>Esc</kbd><span>Cancel tool, power or selection</span>` +
      `<kbd>Enter</kbd><span>Start wave</span>` +
      `<kbd>Q W E R</kbd><span>Arm a Dungeon Master power (wave)</span>` +
      `<kbd>Space</kbd><span>Pause / resume (wave)</span>` +
      `<kbd>1 2 3</kbd><span>Speed 1× 2× 4× (wave) · pick a perk (reward)</span>` +
      `<kbd>H  ?</kbd><span>This handbook</span><kbd>M</kbd><span>Mute</span>` +
      `</div></div></div>`;
  }

  /* ---------------------------------------------------------------------------
   * 15. INPUT — board pointer (hover, place, drag-paint, select, sell, cast)
   * ------------------------------------------------------------------------ */
  /** Screen → world through Render; null when outside the board. */
  function worldAt(cx, cy) {
    if (typeof Render === 'undefined' || !Render || typeof Render.screenToWorld !== 'function') return null;
    const p = safe(() => Render.screenToWorld(cx, cy), null, 'Render.screenToWorld');
    return p && p.inside ? p : null;
  }
  function setHover(p) {
    if (!S) return;
    S.ui.hover = p ? { wx: p.wx, wy: p.wy, tx: p.tx, ty: p.ty } : null;
  }
  /** Tile a click refers to: a monster standing near its post selects/sells the post. */
  function targetTile(p) {
    const e = Spatial.entityAt(p.wx, p.wy, 0.5);
    if (e && e.team === 'dm' && e.post) {
      const t = Grid.tile(e.post.x, e.post.y);
      if (t && t.s === e.post) return { x: e.post.x, y: e.post.y };
    }
    return { x: p.tx, y: p.ty };
  }

  function onBoardDown(e) {
    if (!S || !U.ready) return;
    if (e.button !== 0 && e.button !== 2) return;
    const p = worldAt(e.clientX, e.clientY);
    setHover(p);
    if (e.button === 2) { e.preventDefault(); rightClick(p); return; }
    if (!p) return;
    if (S.phase === 'build') {
      if (S.ui.tool) {
        U.drag = { visited: new Set(), tx: p.tx, ty: p.ty, noGold: false, id: e.pointerId };
        try { el.boardWrap.setPointerCapture(e.pointerId); } catch { /* capture is optional */ }
        attemptPlace(p.tx, p.ty, true);
      } else selectAt(p);
    } else if (S.phase === 'wave') {
      if (S.ui.power) castAt(p);
      else selectAt(p);
    }
  }
  function onBoardMove(e) {
    U.mouseX = e.clientX; U.mouseY = e.clientY;
    if (!S || !U.ready) return;
    const p = worldAt(e.clientX, e.clientY);
    const prev = S.ui.hover;
    setHover(p);
    if (U.drag && p && S.phase === 'build' && S.ui.tool && (p.tx !== U.drag.tx || p.ty !== U.drag.ty)) {
      // Walk every tile between the last and current one (4-connected) so fast drags leave no gaps.
      line4(U.drag.tx, U.drag.ty, p.tx, p.ty, (x, y) => attemptPlace(x, y, false));
      U.drag.tx = p.tx; U.drag.ty = p.ty;
    }
    if (!p) { if (Tip.src === 'board') Tip.hide(); return; }
    if (!prev || prev.tx !== p.tx || prev.ty !== p.ty || Tip.src !== 'board' || Spatial.entityAt(p.wx, p.wy, 0.5)) Tip.forBoard();
    else Tip.place();
  }
  function onBoardUp(e) {
    if (U.drag && U.drag.id === e.pointerId) endDrag();
  }
  function onBoardLeave() {
    if (S) S.ui.hover = null;
    if (Tip.src === 'board') Tip.hide();
  }
  function endDrag() {
    if (!U.drag) return;
    try { if (el.boardWrap.hasPointerCapture && el.boardWrap.hasPointerCapture(U.drag.id)) el.boardWrap.releasePointerCapture(U.drag.id); } catch { /* ignore */ }
    U.drag = null;
  }
  /** 4-connected line walk from (x0,y0) exclusive to (x1,y1) inclusive. */
  function line4(x0, y0, x1, y1, fn) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = Math.sign(x1 - x0), sy = Math.sign(y1 - y0);
    let x = x0, y = y0, ix = 0, iy = 0;
    while (ix < dx || iy < dy) {
      if ((0.5 + ix) / dx < (0.5 + iy) / dy) { x += sx; ix++; } else { y += sy; iy++; }
      fn(x, y);
    }
  }
  /** One placement attempt per tile per drag. The first click gives feedback on any failure;
   *  drag continuations stay quiet over occupied/unsuitable tiles. */
  function attemptPlace(tx, ty, first) {
    const d = U.drag, tool = S.ui.tool;
    if (!d || !tool || !Grid.inb(tx, ty)) return;
    const key = ty * S.cols + tx;
    if (d.visited.has(key)) return;
    d.visited.add(key);
    const chk = Build.canPlace(tool.cat, tool.id, tx, ty);
    if (chk.ok) {
      const r = Build.place(tool.cat, tool.id, tx, ty);
      if (r && r.ok) {
        U.seen.add(tool.cat + ':' + tool.id);
        if (tool.cat === 'boss') { S.ui.tool = null; endDrag(); toast(`${contentDef(tool.cat, tool.id).name} now guards your dungeon.`, 'good'); }
        refreshSoon();
      }
      return;
    }
    if (!first && !chk.blocks && !chk.gold) return;
    if (chk.gold) { if (d.noGold) return; d.noGold = true; }
    Build.place(tool.cat, tool.id, tx, ty); // re-validates: error sound + red ring / blocked-tile flash
    failToast(chk.reason, chk.blocks ? 'bad' : 'warn');
  }
  function selectAt(p) {
    const { x, y } = targetTile(p);
    const t = Grid.tile(x, y);
    if (t && (t.s || t.type !== T.FLOOR)) {
      const same = S.ui.selected && S.ui.selected.x === x && S.ui.selected.y === y;
      S.ui.selected = same ? null : { x, y };
      SFX.play('click');
    } else S.ui.selected = null;
    refreshNow();
  }
  function rightClick(p) {
    if (S.phase === 'build') {
      if (p) {
        const { x, y } = targetTile(p);
        const t = Grid.tile(x, y);
        if (t && (t.s || t.type === T.WALL)) {
          if (Build.sell(x, y)) {
            if (S.ui.selected && S.ui.selected.x === x && S.ui.selected.y === y) S.ui.selected = null;
            refreshSoon();
          }
          return;
        }
      }
      if (S.ui.tool) S.ui.tool = null; else S.ui.selected = null;
      endDrag();
      refreshNow();
    } else if (S.phase === 'wave') {
      if (S.ui.power) S.ui.power = null; else S.ui.selected = null;
      refreshNow();
    }
  }

  /* ---- Powers --------------------------------------------------------------- */
  /** Arm a power (Q/W/E/R or button). Instant powers cast immediately. */
  function armPower(id) {
    if (!S || !POWERS[id]) return;
    if (S.phase !== 'wave') { failToast('Dungeon Master powers can only be used during a wave.', 'info'); return; }
    if (S.ui.power === id) { S.ui.power = null; refreshNow(); return; }
    const c = powerCan(id);
    if (!c.ok) { SFX.play('error'); failToast(c.reason || `${POWERS[id].name} is not ready.`, 'warn'); return; }
    if (POWERS[id].target === 'none') {
      const hv = S.ui.hover;
      const ok = safe(() => Powers.cast(id, hv ? hv.wx : Heart.cx(), hv ? hv.wy : Heart.cy()), false, 'Powers.cast');
      if (!ok) { SFX.play('error'); failToast(powerLastReason() || powerCan(id).reason || `${POWERS[id].name} failed.`, 'warn'); }
      S.ui.power = null;
    } else {
      S.ui.power = id;
      SFX.play('click');
    }
    refreshNow();
  }
  /** Cast the armed power at a board point. */
  function castAt(p) {
    const id = S.ui.power;
    if (!id) return;
    const before = powerCan(id);
    if (!before.ok) { SFX.play('error'); failToast(before.reason, 'warn'); S.ui.power = null; refreshNow(); return; }
    const ok = safe(() => Powers.cast(id, p.wx, p.wy), false, 'Powers.cast');
    if (ok) S.ui.power = null; // stays armed after a bad target so the player can simply click again
    else {
      SFX.play('error');
      failToast(powerLastReason() || castFailReason(id, p), 'warn');
    }
    refreshNow();
  }
  /** Best-effort explanation of a failed cast when the Powers module gives none. */
  function castFailReason(id, p) {
    if (id === 'collapse') { const c = Grid.canCollapse(p.tx, p.ty); if (!c.ok) return c.reason; }
    if (POWERS[id].target === 'hero') {
      const h = Spatial.nearestHero(p.wx, p.wy, 0.9);
      if (!h) return 'Click directly on a hero.';
      if (HERO_CLASSES[h.type].fearImmune || h.boss) return 'Immune to fear.';
    }
    const c = powerCan(id, p.wx, p.wy);
    return (!c.ok && c.reason) || 'Cannot cast there.';
  }

  /* ---- Keyboard ------------------------------------------------------------- */
  function onKeyDown(e) {
    if (!U.ready || !S) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    // Buttons never keep focus, but guard anyway so Enter/Space can't double-fire one.
    if ((k === 'Enter' || k === ' ') && e.target && e.target.closest && e.target.closest('button, [role="button"]')) e.preventDefault();
    if (modalOpen('help')) {
      if (k === 'Escape' || lower === 'h' || k === '?') { e.preventDefault(); closeHelp(); }
      return;
    }
    if (!e.repeat && (lower === 'h' || k === '?')) { e.preventDefault(); openHelp(); return; }
    if (!e.repeat && lower === 'm') { toggleMute(); return; }
    if (k === ' ') e.preventDefault();
    switch (S.phase) {
      case 'title':
        if (k === 'Enter' && !e.repeat) { e.preventDefault(); newRun(); }
        return;
      case 'reward': {
        const n = Number(k);
        if (n >= 1 && n <= 3 && !e.repeat) { const id = U.reward.ids[n - 1]; if (id) { e.preventDefault(); pickPerk(id); } }
        else if (k === 'Enter' && !U.reward.ids.length && !e.repeat) { e.preventDefault(); pickPerk(null); }
        return;
      }
      case 'gameover':
        if (k === 'Enter' && !e.repeat) { e.preventDefault(); newRun(); }
        return;
      case 'build': {
        if (k === 'Enter' && !e.repeat) { e.preventDefault(); startWave(); return; }
        if (k === 'Escape') { if (S.ui.tool) S.ui.tool = null; else S.ui.selected = null; endDrag(); refreshNow(); return; }
        if (/^[1-9]$/.test(k) && !e.repeat) {
          const it = tabById(U.tab).items[Number(k) - 1];
          if (it) clickCard(it[0], it[1]);
          return;
        }
        if (lower === 'u' && S.ui.selected) { inspectAction('upgrade'); return; }
        if ((k === 'Delete' || k === 'Backspace') && S.ui.selected) { e.preventDefault(); inspectAction('sell'); return; }
        if (POWER_IDS.some(id => POWERS[id].key.toLowerCase() === lower)) failToast('Dungeon Master powers can only be used during a wave.', 'info');
        return;
      }
      case 'wave': {
        if (k === ' ' && !e.repeat) { togglePause(); return; }
        if (k === 'Escape') { if (S.ui.power) S.ui.power = null; else S.ui.selected = null; refreshNow(); return; }
        if (/^[1-3]$/.test(k) && !e.repeat) { setSpeed(SPEEDS[Number(k) - 1]); return; }
        const pid = POWER_IDS.find(id => POWERS[id].key.toLowerCase() === lower);
        if (pid && !e.repeat) { armPower(pid); return; }
        return;
      }
    }
  }

  /* ---- Commands shared by buttons and keys ----------------------------------- */
  function newRun() { SFX.play('click'); Game.newRun(); }
  function startWave() {
    if (!S || S.phase !== 'build') return;
    endDrag();
    Game.startWave(); // refuses (with a toast) if the Heart is sealed off; tools are cleared by the phase change
    refreshNow();
  }
  function togglePause() {
    if (!S || S.phase !== 'wave') return;
    S.paused = !S.paused;
    U.helpPaused = false;
    SFX.play('click');
    refreshNow();
  }
  function setSpeed(v) {
    if (!S || SPEEDS.indexOf(v) < 0) return;
    S.speed = v;
    refreshNow();
  }
  function toggleMute() {
    const m = !SFX.muted;
    SFX.setMuted(m);
    Save.data.muted = m;
    Save.write();
    if (!m) SFX.play('click');
    toast(m ? 'Sound muted' : 'Sound on', 'info');
    if (S && S.phase === 'title' && modalOpen('title')) {
      const b = el.titleCard.querySelector('[data-act="mute"]');
      if (b) b.innerHTML = `${px(m ? 'mute' : 'sound')} Sound ${m ? 'off' : 'on'} <kbd>M</kbd>`;
    }
    refreshNow();
  }

  /** Delegated clicks for all buttons / cards / perks / powers. */
  function onClick(e) {
    if (!U.ready || !S) return;
    const t = e.target;
    if (!t || !t.closest) return;
    const perk = t.closest('[data-perk]');
    if (perk && el.modal.reward.contains(perk)) { pickPerk(perk.getAttribute('data-perk')); return; }
    const card = t.closest('.card');
    if (card && el.cards.contains(card)) { clickCard(card.getAttribute('data-cat'), card.getAttribute('data-id')); return; }
    const tab = t.closest('.tab');
    if (tab && el.tabs.contains(tab)) { selectTab(tab.getAttribute('data-tab')); return; }
    const pw = t.closest('.power');
    if (pw) { armPower(pw.getAttribute('data-power')); return; }
    const sp = t.closest('[data-speed]');
    if (sp) { SFX.play('click'); setSpeed(Number(sp.getAttribute('data-speed'))); return; }
    const btn = t.closest('button');
    if (!btn) {
      if (t === el.modal.help) closeHelp(); // click on the backdrop
      return;
    }
    const off = btn.classList.contains('is-off') || btn.getAttribute('aria-disabled') === 'true';
    const act = btn.getAttribute('data-act');
    switch (btn.id || act) {
      case 'btnStart':
        if (off) { SFX.play('error'); return; }
        SFX.play('click'); startWave(); return;
      case 'btnPause': if (off) { SFX.play('error'); return; } togglePause(); return;
      case 'btnRoute': SFX.play('click'); S.ui.showPath = !S.ui.showPath; refreshNow(); return;
      case 'btnMemory': SFX.play('click'); S.ui.showDanger = !S.ui.showDanger; refreshNow(); return;
      case 'btnMute': toggleMute(); return;
      case 'btnHelp': openHelp(); return;
      case 'btnRepairAll': if (off) { SFX.play('error'); failToast(S.phase === 'build' ? 'Not enough gold to repair anything.' : 'Repairs are made between waves.', 'warn'); return; } repairAll(); return;
      case 'newrun': case 'restart': newRun(); return;
      case 'totitle': SFX.play('click'); Game.toTitle(); return;
      case 'continue': pickPerk(null); return;
      case 'help': openHelp(); return;
      case 'closehelp': SFX.play('click'); closeHelp(); return;
      case 'mute': toggleMute(); return;
      case 'deselect': SFX.play('click'); inspectAction('deselect'); return;
      case 'upgrade': case 'repair': case 'sell':
        if (off) {
          SFX.play('error');
          const tip = btn.getAttribute('data-tip');
          failToast(tip ? tip.slice(5) : 'Not available right now.', 'warn');
          return;
        }
        inspectAction(act);
        return;
    }
  }

  /* ---------------------------------------------------------------------------
   * 16. REFRESH, PHASES & FRAME UPDATE
   * ------------------------------------------------------------------------ */
  function setPhaseClass(phase) {
    const b = document.body;
    for (const c of [...b.classList]) if (c.startsWith('phase-')) b.classList.remove(c);
    b.classList.add('phase-' + phase);
  }
  /** Detect a new run (fresh S) and reset per-run UI state. */
  function syncRun() {
    if (U.run === S) return;
    U.run = S;
    U.seen = new Set(S.unlocked);
    for (const t of BUILD_TABS) for (const [c, i] of t.items) if (Build.isUnlocked(c, i)) U.seen.add(c + ':' + i);
    clearToasts();
    U.cardSig = ''; U.previewSig = ''; U.previewFor = undefined; U.perkSig = null;
    U.lastGold = null; U.lastHeart = null; U.cdMax = {};
    U.tab = BUILD_TABS[0].id;
    if (el.cards) el.cards.scrollTop = 0;
    endDrag();
  }
  /** Keep the board container's aspect vars in sync with the grid; resize the canvas on change. */
  function syncGrid() {
    const key = S.cols + 'x' + S.rows;
    if (key === U.gridKey) return;
    U.gridKey = key;
    el.boardWrap.style.setProperty('--cols', S.cols || 20); // aspect-ratio of the board in the stacked layout
    el.boardWrap.style.setProperty('--rows', S.rows || 14);
    scheduleResize();
  }
  function scheduleResize() {
    if (U.resizeQueued) return;
    U.resizeQueued = true;
    requestAnimationFrame(() => {
      U.resizeQueued = false;
      if (S && typeof Render !== 'undefined' && Render && typeof Render.resize === 'function') safe(() => Render.resize(), null, 'Render.resize');
    });
  }
  /** Everything that refreshes at ~10 Hz. */
  function slowRefresh() {
    if (!S) return;
    syncRun();
    syncGrid();
    updateHud();
    updateBuildPanel();
    updateInspector();
    updateCentre();
    updateBoardOverlays();
    if (S.phase === 'build') updatePreview();
    if (S.phase === 'wave' || S.phase === 'reward' || S.phase === 'gameover') updateLive();
    if (S.phase === 'wave') updatePowers();
    updatePerks();
    Tip.tick();
  }
  function refreshNow() { if (U.ready) { U.hudT = 0; slowRefresh(); } }
  let soonQueued = false;
  /** Coalesce many refresh requests (e.g. a drag placing 10 walls) into one on the next frame. */
  function refreshSoon() {
    if (soonQueued) return;
    soonQueued = true;
    requestAnimationFrame(() => { soonQueued = false; refreshNow(); });
  }

  /** Rebuild all panels from scratch. */
  function refresh() {
    if (!U.ready || !S) return;
    U.cardSig = ''; U.previewSig = ''; U.previewFor = undefined; U.perkSig = null;
    for (const n of [el.inspHead, el.inspFlags, el.inspLines, el.inspPreview, el.inspActions, el.previewBody, el.perkGrid]) if (n) n._h = undefined;
    refreshNow();
  }

  /** Phase hook from Game.setPhase: show/hide panels, close stale modals. */
  function onPhase(phase) {
    if (!U.ready || !S) return;
    setPhaseClass(phase);
    endDrag();
    if (phase !== 'title') closeModal('title');
    if (phase !== 'reward') closeModal('reward');
    if (phase !== 'gameover') closeModal('over');
    S.paused = false; // every phase starts running (the help overlay re-pauses a wave if it is open)
    U.helpPaused = false;
    if (phase === 'wave') {
      U.bossKillsAtStart = S.stats.bossKills;
      U.cdMax = {};
      for (const t of BUILD_TABS) markSeen(t.id); // NEW markers last until the first wave after the unlock
    }
    if (phase === 'build') S.ui.selected = null; // the grid may have expanded (coordinates shift)
    if (Tip.src === 'board') Tip.hide();
    refresh();
    scheduleResize();
  }

  /** Per-frame update from the main loop. */
  function update(dtReal) {
    if (!U.ready || !S) return;
    if (S.phase === 'wave') updatePowerSweeps();
    U.hudT += dtReal;
    if (U.hudT >= HUD_INTERVAL) { U.hudT = 0; slowRefresh(); }
  }

  /* ---------------------------------------------------------------------------
   * 17. INIT
   * ------------------------------------------------------------------------ */
  function init() {
    const need = ['app', 'boardWrap', 'tabs', 'cards', 'inspBody', 'toasts', 'tip', 'btnStart', 'previewBody', 'powers', 'perkGrid', 'mTitle', 'mReward', 'mOver', 'mHelp'];
    if (need.some(id => !$(id))) { console.warn('[UI] shell markup missing — UI disabled.'); return; }
    hydratePixels(document);
    const ids = ['boardWrap', 'toasts', 'boardBanner', 'boardHint', 'tip', 'hudWave', 'hudBoss', 'hudGold', 'hudGoldBox', 'hudManaFill', 'hudManaTxt',
      'hudHeart', 'hudHeartFill', 'hudHeartTxt', 'hudBest', 'btnPause', 'btnRoute', 'btnMemory', 'btnMute', 'btnHelp', 'tabs', 'cards', 'buildLock',
      'buildNote', 'inspBody', 'inspNote', 'btnRepairAll', 'btnStart', 'wiMain', 'wiSub', 'waveProg', 'wpTag', 'wpFill', 'wpTxt', 'pvTitle', 'pvNote',
      'previewBody', 'liveTitle', 'liveNote', 'lvAlive', 'lvIncoming', 'lvSlain', 'lvEscaped', 'lvHeartDmg', 'lvGold', 'lvThreat', 'lvBoss',
      'pwNote', 'pwManaFill', 'pwManaTxt', 'powers', 'perkNote', 'perkGrid', 'titleCard', 'rewardCard', 'overCard', 'helpCard'];
    for (const id of ids) el[id] = $(id);
    el.modal = {};
    for (const k of Object.keys(MODALS)) el.modal[k] = $(MODALS[k]);
    el.speedBtns = [...document.querySelectorAll('#speedSeg [data-speed]')];
    for (const r of Object.keys(RARITY)) document.documentElement.style.setProperty('--rar-' + r, RARITY[r].color);
    renderTabs();
    buildPowers();
    ensureInspectorNodes();

    // Board input
    const bw = el.boardWrap;
    bw.addEventListener('pointerdown', onBoardDown);
    bw.addEventListener('pointermove', onBoardMove);
    bw.addEventListener('pointerup', onBoardUp);
    bw.addEventListener('pointercancel', onBoardUp);
    bw.addEventListener('pointerleave', onBoardLeave);
    bw.addEventListener('lostpointercapture', () => { U.drag = null; });
    bw.addEventListener('contextmenu', e => e.preventDefault());
    // Global input
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', e => { if (e.target && e.target.closest && e.target.closest('button, .card, .tab, .perk-card, .power')) e.preventDefault(); });
    document.addEventListener('pointerover', e => {
      U.mouseX = e.clientX; U.mouseY = e.clientY;
      const t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      if (t) Tip.forEl(t);
      else if (Tip.src && Tip.src !== 'board') Tip.hide();
    });
    document.addEventListener('pointermove', e => { U.mouseX = e.clientX; U.mouseY = e.clientY; if (Tip.src && Tip.src !== 'board') Tip.place(); });
    document.addEventListener('mouseout', e => { if (!e.relatedTarget) Tip.hide(); });
    window.addEventListener('blur', () => { endDrag(); Tip.hide(); });
    window.addEventListener('resize', () => { scheduleResize(); Tip.hide(); });
    if (window.ResizeObserver) new ResizeObserver(scheduleResize).observe(bw);
    U.ready = true;
  }

  return { init, update, onPhase, showTitle, showReward, showGameOver, toast, refresh };
})();
