/* =============================================================================
 *  50 RENDER — procedural pixel-art sprites and the canvas renderer.
 *
 *    Sprites  Every unit, trap, object, tile and icon is a small character
 *             grid + palette (or a tiny procedural painter) rasterized ONCE
 *             into offscreen canvases. The rasterizer adds a dark 1px outline,
 *             derives walk frames by lifting one leg, and lazily caches
 *             variants (hit-flash white, elite gold outline, risen tint, grey,
 *             corpse) and mirrored copies — nothing is re-rasterized per frame.
 *    Render   Draws the board every frame: a cached static tile layer, danger
 *             heat map, structures, route preview, corpses, y-sorted entities,
 *             projectiles, a darkness/light composite, HP bars & status icons,
 *             FX, build/power overlays and the screen flash.
 *
 *  Units: sprites are authored at 1 "art pixel" = 2 canvas px (TS = 32 px per
 *  tile = 16 art px). The backing store is RS = 2× the canvas size for crisp
 *  text, so one art pixel is 4 backing pixels.
 * ========================================================================== */

/* -----------------------------------------------------------------------------
 * 1. SPRITES
 * -------------------------------------------------------------------------- */
const Sprites = (() => {
  /* ---- 1.1 Colour helpers ------------------------------------------------ */
  const u32cache = {};
  /** '#rgb' | '#rrggbb' | '#rrggbbaa' → [r, g, b, a] */
  function rgbaOf(hex) {
    let h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }
  const pack = (r, g, b, a) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
  /** Hex colour → little-endian RGBA uint32 (ImageData layout). */
  function u32(hex) {
    let v = u32cache[hex];
    if (v === undefined) { const c = rgbaOf(hex); v = u32cache[hex] = pack(c[0], c[1], c[2], c[3]); }
    return v;
  }
  /** CSS rgba() string from a hex colour and an alpha. */
  function cssA(hex, a) { const c = rgbaOf(hex); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; }
  function mk(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0);
    return c;
  }

  /* ---- 1.2 Palettes -------------------------------------------------------- */
  const OUTLINE = '#120a16';
  const BASE = {
    k: '#150d1c', e: '#1a1024', s: '#f1c29c', S: '#c3886a',
    B: '#5e3c24', b: '#3b2616', W: '#eef1f6', M: '#a9afbd', m: '#696f80',
    G: '#f0c24a', g: '#a8801e', L: '#e9eef7', l: '#97a2b6', w: '#ffffff',
  };
  const pal = o => Object.assign({}, BASE, o);

  /* ---- 1.3 Pixel-map definitions ------------------------------------------
   * { rows[], pal, legs:[firstLegRow, splitCol] (auto walk frames),
   *   frames:[rows[],...] (explicit frames), outline:false (tiles/traps) }   */
  const DEFS = {};

  // ---------------- Heroes (18×16, facing right; flipped when face = -1)
  DEFS.h_warrior = {
    pal: pal({ H: '#efe4c8', h: '#a89876', O: '#d0873a', o: '#94541f', Q: '#f2b46a', R: '#c7cbd5', D: '#9a602e', d: '#653e1b' }),
    legs: [13, 9],
    rows: [
      '..................',
      '...H.........H....',
      '...Hh.WWMMMm.hH...',
      '....hWWMMMMMmh..L.',
      '.....MMMMMMMm...L.',
      '.....mmmmmmmm...L.',
      '.....ssessesS...L.',
      '.....mssssSSm...L.',
      '.RRR.oOQQOOOo...L.',
      'RDDDRoOQOOOOo..GGG',
      'RDGDRoOOOOOooOOsB.',
      'RDDDRBBBGBBBb.....',
      '.RRR.oOOOOOoo.....',
      '......BB..BB......',
      '......bb..bb......',
      '..................',
    ],
  };
  DEFS.h_rogue = {
    pal: pal({ N: '#5fae5a', n: '#3b7a3a', U: '#94d884', C: '#2f5634', c: '#1e3a22', K: '#241c2c' }),
    legs: [13, 9],
    rows: [
      '..................',
      '........nN........',
      '.......nNNU.......',
      '......nNNUNN......',
      '.....nNNNNNNN.....',
      '.....nKKKKKKN.....',
      '.....nsessesN.....',
      '.....nKsSSSKN.....',
      '....CnNNNNNNnC....',
      '..L.CBBnNNnBBC.L..',
      '..LsCBBBBGBBBCsL..',
      '..lcCnNNNNNNnCcl..',
      '...cCnNNNNNNnCc...',
      '....c.BB..BB.c....',
      '......bb..bb......',
      '..................',
    ],
  };
  DEFS.h_ranger = {
    pal: pal({ T: '#3f9c8f', t: '#276a60', V: '#78d2c4', F: '#e8543e', f: '#a8302a', P: '#9a6a36', p: '#634220', x: '#e8e2d0', h: '#7a4a2a', Q: '#6a4424', A: '#f4efe0' }),
    legs: [13, 9],
    rows: [
      '..................',
      '...F..............',
      '....Ff.TTTT.......',
      '.....FTVTTTT...P..',
      '.....tTTTTTTt.x.P.',
      '.....hsessesS.x.P.',
      '....AhssssSSS.x.P.',
      '....QTTTTTTTt.x.P.',
      '....QtTVTTTTtTTsP.',
      '....QtTTTTTTt.x.P.',
      '....BBBBGBBBB.x.P.',
      '.....TTTTTTTt.xP..',
      '.....tTTTTTTt.....',
      '......BB..BB......',
      '......bb..bb......',
      '..................',
    ],
  };
  DEFS.h_mage = {
    pal: pal({ A: '#6a6cf0', a: '#4446b0', Z: '#a4a6ff', X: '#dffcff', x: '#4cc4f0', P: '#8a5a2e', p: '#5a3a1a', w: '#c8ccd8', W: '#f4f6fb' }),
    legs: [13, 9],
    rows: [
      '......A...........',
      '......AA......xXx.',
      '......AZa.....XWX.',
      '.....AZAAa....xXx.',
      '.....AZAGAa....P..',
      '...aaAAAAAAAaa.P..',
      '......sesseS...P..',
      '......wWWWWw..sP..',
      '.....AwWWWWwAAsP..',
      '....AAAwWWwAAa.P..',
      '....AZAAwwAAAa.P..',
      '....AZAAGGAAaa.P..',
      '...AAZAAAAAAAa.P..',
      '...aAAAAAAAAaa.P..',
      '....aaaa.aaaa..p..',
      '..................',
    ],
  };
  DEFS.h_cleric = {
    pal: pal({ C: '#efe6c2', c: '#b9ad84', V: '#fffdf2', P: '#7a5230' }),
    legs: [13, 9],
    rows: [
      '..................',
      '.......cCCc.......',
      '......cCVVCCc.....',
      '.....cCVCCCCc.....',
      '.....CsessesC..M..',
      '.....CsssSSSC.MWM.',
      '.....cCCCCCCc.mMm.',
      '....cCCCGGCCCc.P..',
      '....CCCGVVGCCc.P..',
      '....CCCCGGCCCc.P..',
      '....cCCCCCCCCCsP..',
      '....cCgGgGgCCc....',
      '....cCCCCCCCCc....',
      '...cCCCCCCCCCCc...',
      '....cccc..cccc....',
      '..................',
    ],
  };
  DEFS.h_paladin = {
    pal: pal({ M: '#b4bac8', m: '#6a7082', W: '#f2f5fa', G: '#f0d060', g: '#b0902a', X: '#e8ecf6', Y: '#fff4a8b0' }),
    legs: [13, 8],
    rows: [
      '.....YYYYYY.......',
      '....Y.WMMm.Y......',
      '.....WMMMMm.......',
      '....WMMGMMMm......',
      '....MkkkkkkM......',
      '....MMmkkmMm......',
      '....gGGGGGGg......',
      '....MWMMMMMmGXGXG.',
      '...MMMGMMGMmGGGGG.',
      '...MWMMGGMMmGXGXG.',
      '...sMMMMMMMmGXGXG.',
      '....ggGGGGgg.GXG..',
      '....MMMMMMMm..G...',
      '.....MM..MM.......',
      '.....mm..mm.......',
      '..................',
    ],
  };
  DEFS.h_miner = {
    pal: pal({ B: '#b07048', b: '#7a4a2c', Q: '#d8946a', R: '#e0762e', r: '#a04a1a', H: '#8a8f9a', h: '#5a5f6a', Y: '#fff6b0', P: '#8a5a2e', p: '#5a3a1a', L: '#5b3a22', l: '#3a2414' }),
    legs: [13, 9],
    rows: [
      '..................',
      '..................',
      '..................',
      '......hHHHHh..mMMm',
      '.....hHHYYHHh..P..',
      '.....hhhhhhhh..P..',
      '.....SsessesS..P..',
      '....RRRsSSsRRR.P..',
      '...BRRRRRRRRRBsP..',
      '...BBRRRRRRRRBBP..',
      '...QBBrRRRRrBBbP..',
      '...LLLLrrrrLLLlP..',
      '...bBBBBBBBBBBbp..',
      '....LLL...LLL.....',
      '....lll...lll.....',
      '..................',
    ],
  };

  /** Hero bosses = base class art, a unique palette, a crown/halo patch; drawn 1.5× with an aura. */
  const HERO_BOSS_SKINS = {
    champion: {
      base: 'h_warrior', aura: '#ffcf4a',
      pal: { M: '#e8c050', m: '#9a7424', W: '#fff2b8', O: '#b81e2c', o: '#781018', Q: '#e8505a', R: '#f0d060', D: '#b81e2c', d: '#781018', H: '#ffffff', h: '#c8c0a8', r: '#ff3050', v: '#4ab0ff' },
      patch: [[6, 0, ['G.GG.G', 'GrGGvG']]],
    },
    archmage: {
      base: 'h_mage', aura: '#c060ff',
      pal: { A: '#5a1c8e', a: '#34105a', Z: '#a05ae0', x: '#ff4ad8', X: '#ffd6f6', w: '#e0e4f4', W: '#ffffff', r: '#ff4ad8' },
      patch: [[5, 4, ['GGrGGG']], [6, 0, ['G']]],
    },
    saint: {
      base: 'h_cleric', aura: '#fff1a0',
      pal: { C: '#ffffff', c: '#d8cc9e', V: '#fffbe0', M: '#ffd84a', m: '#b08a2a', W: '#fff8d0', Y: '#fff4a8d0', P: '#c89a3a' },
      patch: [[6, 0, ['YYYYYY']], [7, 1, ['GGGG']]],
    },
    shadow: {
      base: 'h_rogue', aura: '#8a3aff',
      pal: { N: '#3c2c5e', n: '#221838', U: '#6a5a9a', C: '#1c1428', c: '#100a18', K: '#0a0610', B: '#2c2440', b: '#1a1428', e: '#ff2a3a', s: '#b6a6cc', S: '#7a6a94', L: '#d6c8ff', l: '#8a7ab8', G: '#ff2a3a', r: '#ff2a3a' },
      patch: [[6, 5, ['MMrMMM']]],
    },
  };

  // ---------------- Monsters (18×16)
  DEFS.m_skeleton = {
    pal: pal({ W: '#e9e3cc', w: '#aaa184', k: '#1c1418', r: '#ff4a2a', L: '#a4acb8', O: '#8a5a34' }),
    legs: [13, 9],
    rows: [
      '..................',
      '..................',
      '......WWWWW.......',
      '.....WWWWWWw......',
      '.....WkkWkkw......',
      '.....WkrWrkw......',
      '......WWkWW.......',
      '......WkWkW.......',
      '.......wWw....L...',
      '....wWWWWWWw..L...',
      '....W.WWWWW.W.L...',
      '....W..WkW..W.L...',
      '....w.WWWWW.WOOO..',
      '.......W.W....O...',
      '......WW.WW.......',
      '..................',
    ],
  };
  DEFS.m_goblin = {
    pal: pal({ G: '#78b848', g: '#4a7e2c', Q: '#a8e070', E: '#ffe040', W: '#f4f0d8', B: '#7a5634', b: '#4e3620' }),
    legs: [13, 9],
    rows: [
      '..................',
      '..................',
      '..................',
      '..................',
      '......gGGGGg......',
      '.gG..GGQGGGGg.Gg..',
      '..gGGGEkGGEkGGg...',
      '....gGGGGGGGGg....',
      '.....gGWkWkGg...L.',
      '......gggggg...L..',
      '.....bBBBBBbGGG...',
      '....GbBBBBBBb.....',
      '....G.bBBBBb......',
      '......gg..gg......',
      '......gg..gg......',
      '..................',
    ],
  };
  DEFS.m_orc = {
    pal: pal({ O: '#557f3c', o: '#37562a', Q: '#7aa55a', T: '#f4eed4', E: '#ff5028', A: '#6a4a32', a: '#46301f', N: '#b0b4be', C: '#9a6a3a', c: '#63421f' }),
    legs: [13, 9],
    rows: [
      '..................',
      '...............CC.',
      '......kkkk.....CNC',
      '.....oOOOOOo...cCC',
      '....oOOQOOOOo..cC.',
      '....OEkOOEkOo..cC.',
      '....OOOOoOOOo.cC..',
      '....oTOOOOOTo.Cc..',
      '..oOOoOOOOOoOOOc..',
      '.oOOAAAAAAAAAOOO..',
      '.OOoAAANNAAAAoOO..',
      '.OO.aAAAAAAAa.OO..',
      '.oo.aAAAAAAAa.oo..',
      '.....OOO..OOO.....',
      '.....aaa..aaa.....',
      '..................',
    ],
  };
  DEFS.m_wraith = {
    pal: pal({ G: '#a8b8d0', g: '#6a7a98', V: '#e2eaf6', K: '#141a28', E: '#8ff8ff', w: '#c8d4e8' }),
    frames: [[
      '..................',
      '.......gGGg.......',
      '......gGVVGg......',
      '.....gGVGGGGg.....',
      '.....GKKKKKKG.....',
      '.....GKEKKEKG.....',
      '.....GKKKKKKg.....',
      '...wgGGKKKKGGgw...',
      '..w.gGGGGGGGGg.w..',
      '....gGGVGGGGGg....',
      '.....gGGGGGGg.....',
      '.....gGGGGGg......',
      '....gGGGGgg.......',
      '....gGg.gg........',
      '...gg.............',
      '..................',
    ], [
      '..................',
      '.......gGGg.......',
      '......gGVVGg......',
      '.....gGVGGGGg.....',
      '.....GKKKKKKG.....',
      '.....GKEKKEKG.....',
      '.....GKKKKKKg.....',
      '..wwgGGKKKKGGgww..',
      '....gGGGGGGGGg....',
      '....gGGVGGGGGg....',
      '.....gGGGGGGg.....',
      '......gGGGGGg.....',
      '.......ggGGGGg....',
      '........gg.gGg....',
      '.............gg...',
      '..................',
    ]],
  };
  DEFS.m_mimic = {
    pal: pal({ D: '#8a5a2c', d: '#5e3a1a', Q: '#b07a40', G: '#e8b84a', g: '#a07a22', M: '#5a0a18', T: '#ff6a8a', t: '#c83a5a', W: '#fff8e0', E: '#ffe040' }),
    frames: [[
      '................',
      '...GDDDDDDDDG...',
      '..GdDEkDDEkDdG..',
      '..GGGGGGGGGGGG..',
      '..WMWMWMWMWMWM..',
      '..MMMMMMMMMMMM..',
      '..MMMMMTTMMMMM..',
      '..WMWMTTTTWMWM..',
      '..gGGGTttTGGGg..',
      '..GDDDTTTTDDDG..',
      '..GDDDDTtDDDDG..',
      '..GdDDDDTDDDdG..',
      '..gGGGGGGGGGGg..',
      '................',
      '................',
      '................',
    ], [
      '................',
      '................',
      '................',
      '...GDDDDDDDDG...',
      '..GdDEkDDEkDdG..',
      '..GGGGGGGGGGGG..',
      '..WMWMWMWMWMWM..',
      '..MMMMMTTMMMMM..',
      '..gWGWGTTGWGWg..',
      '..GDDDTTTTDDDG..',
      '..GDDDDTtDDDDG..',
      '..GdDDDDTDDDdG..',
      '..gGGGGGGGGGGg..',
      '................',
      '................',
      '................',
    ]],
  };

  // ---------------- Dungeon bosses (24×24, drawn ~1.5 tiles tall)
  DEFS.b_minotaur = {
    pal: pal({ F: '#7a4a2a', f: '#52301a', Q: '#a06a3e', H: '#efe6cc', h: '#b0a482', N: '#c89a7a', n: '#6a3a2a', E: '#ff3a2a', P: '#6a4424', L: '#8a2a2a', l: '#5a1a1a', k: '#1a0e0e' }),
    legs: [19, 12],
    rows: [
      '........................',
      '...H................H...',
      '...HH..............HH...',
      '....HHh..........hHH....',
      '.....hHHh.fFFFf.hHHh....',
      '.......hHFFFFFFFHh......',
      '..P.....FQFFFFFFF.......',
      '.mPm....FEkFFFEkF.......',
      'mMPMm...FFFFFFFFF.......',
      'MWPWM...fFNNNNNFf.......',
      'MWPWM....FNnNnNF........',
      'mMPMm....fNNGNNf........',
      '.mPm..FFFFFFFFFFFFFF....',
      '..PffFFQFFFFFFFFFFFFf...',
      '..PfFFQQFFFFFFFFFFFFFf..',
      '..P..FFFFFFFFFFFFFFfFf..',
      '..P..fFFFFFFFFFFFFf.Ff..',
      '..P...LLLLGLLLLLLl..ff..',
      '..P...lLLLLLLLLLLl......',
      '..p....FFFf..FFFf.......',
      '.......FFFf..FFFf.......',
      '.......fFFf..fFFf.......',
      '.......kkkk..kkkk.......',
      '........................',
    ],
  };
  DEFS.b_lich = {
    pal: pal({ R: '#2c2240', r: '#181226', Q: '#4a3a66', P: '#8a4ac0', W: '#e6e0cc', w: '#a8a08a', X: '#a8ff9a', x: '#3ad04a', Z: '#e8ffe0', T: '#6a4a2a', k: '#0c0810' }),
    frames: [[
      '.........x...x...x......',
      '........xXx.xXx.xXx.....',
      '..Z.....xZXxXZXxXZx.....',
      '.xXx....GXGGXGGXGG......',
      '..T.....GGGGGGGGGG......',
      '..T....rRRRRRRRRRRr.....',
      '..T...rRWWWWWWWWRRr.....',
      '..T...RWWWWWWWWWWRr.....',
      '..T...RWkkWWWkkWWRr.....',
      '..T...RWkXWWWkXWWRr.....',
      '..T...RWWWWkWWWWWRr.....',
      '..T...rRWkWkWkWWRRr.....',
      '..T..rRRRWWWWWRRRRRr....',
      '..WW.RRRPRRRRRPRRRRRr...',
      '..TWWRRRPRRRRRRPRRRRr...',
      '..T..RRPQRRRRRRPQRRRRr..',
      '..T..rRPRRRRRRRRPRRRRr..',
      '..T..RRPRRRRRRRRPRRRRRr.',
      '..T..rRRPRRRRRRPRRRRRr..',
      '..T...rRRRRRRRRRRRRRr...',
      '..T....rRRrRRRrRRrRr....',
      '..t.....rr.rRr.rr.r.....',
      '...........r............',
      '........................',
    ], [
      '........x...x...x.......',
      '.........xXx.xXx.xXx....',
      '..Z.....xXZxXZXxZXx.....',
      '.xXx....GXGGXGGXGG......',
      '..T.....GGGGGGGGGG......',
      '..T....rRRRRRRRRRRr.....',
      '..T...rRWWWWWWWWRRr.....',
      '..T...RWWWWWWWWWWRr.....',
      '..T...RWkkWWWkkWWRr.....',
      '..T...RWkXWWWkXWWRr.....',
      '..T...RWWWWkWWWWWRr.....',
      '..T...rRWkWkWkWWRRr.....',
      '..T..rRRRWWWWWRRRRRr....',
      '..WW.RRRPRRRRRPRRRRRr...',
      '..TWWRRRPRRRRRRPRRRRr...',
      '..T..RRPQRRRRRRPQRRRRr..',
      '..T..rRPRRRRRRRRPRRRRr..',
      '..T..RRPRRRRRRRRPRRRRRr.',
      '..T..rRRPRRRRRRPRRRRRr..',
      '..T...rRRRRRRRRRRRRRr...',
      '..T....rRrRRRRrRRrRr....',
      '..t.....r.rRr..rr.r.....',
      '..........r.............',
      '........................',
    ]],
  };
  // ---------------- Objects (16×16)
  const CHEST_PAL = pal({ D: '#8a5a2c', d: '#5e3a1a', Q: '#b07a40', G: '#e8b84a', g: '#a07a22', K: '#241410' });
  DEFS.o_chest = {
    pal: CHEST_PAL,
    rows: [
      '................',
      '................',
      '................',
      '................',
      '...GDDDDDDDDG...',
      '..GQQQQQQQQQQG..',
      '..GDDDDGGDDDDG..',
      '..GdDDDGGDDDdG..',
      '..gGGGGggGGGGg..',
      '..GDDDDkkDDDDG..',
      '..GDDDDGGDDDDG..',
      '..GDDDDDDDDDDG..',
      '..GdDDDDDDDDdG..',
      '..gGGGGGGGGGGg..',
      '................',
      '................',
    ],
  };
  DEFS.o_chest_open = {
    pal: CHEST_PAL,
    rows: [
      '................',
      '................',
      '...GdddddddddG..',
      '..GdDDDDDDDDdG..',
      '..GGGGGGGGGGGG..',
      '..GKKKKKKKKKKG..',
      '..GKKKKKKKKKKG..',
      '..GKKKKKKKKKKG..',
      '..gGGGGggGGGGg..',
      '..GDDDDkkDDDDG..',
      '..GDDDDGGDDDDG..',
      '..GDDDDDDDDDDG..',
      '..GdDDDDDDDDdG..',
      '..gGGGGGGGGGGg..',
      '................',
      '................',
    ],
  };
  DEFS.o_torch = {
    pal: pal({ I: '#4a4452', i: '#2c2832', J: '#7a7486', E: '#ff8a2a', e: '#c0401a' }),
    rows: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '....JIIIIIIi....',
      '....IeEEEEeI....',
      '.....iIIIIi.....',
      '.......Ii.......',
      '.......Ii.......',
      '.......Ii.......',
      '......JIIi......',
      '.....Ii..Ii.....',
      '....Ii....Ii....',
      '................',
    ],
  };
  const BAR_PAL = pal({ D: '#9a6a36', d: '#5e3c1a', Q: '#c08a4e', I: '#5a5664', i: '#34303c', N: '#8a8a96' });
  DEFS.o_barricade = {
    pal: BAR_PAL,
    rows: [
      '................',
      '................',
      '..d..........d..',
      '..Dd........dD..',
      '.QDDDDDDDDDDDDd.',
      '.QDDNDDDDDDNDDd.',
      '.dddddddddddddd.',
      '..DD.DdQd.dDD...',
      '.QDDDDDDDDDDDDd.',
      '.QDDNDDDDDDNDDd.',
      '.dddddddddddddd.',
      '..DD.DdQd.dDD...',
      '.QDDDDDDDDDDDDd.',
      '.QDDNDDDDDDNDDd.',
      '.dddddddddddddd.',
      '..d..........d..',
    ],
  };
  DEFS.o_barricade2 = {
    pal: BAR_PAL,
    rows: [
      '................',
      '................',
      '..d.............',
      '..Dd........d...',
      '.QDDDDDDD..DDDd.',
      '.QDDNDDDd...DDd.',
      '.dddddddd..dddd.',
      '..DD.Dd......D..',
      '.QDDDDDD.DDDDDd.',
      '.QDDNDDd..DNDDd.',
      '.ddddddd.ddddddd',
      '..DD.DdQd.dDD...',
      '.QDDDDDDDDDDDDd.',
      '.QDDNDDDDDDNDDd.',
      '.dddddddddddddd.',
      '..d..........d..',
    ],
  };
  DEFS.o_barricade3 = {
    pal: BAR_PAL,
    rows: [
      '................',
      '................',
      '................',
      '............d...',
      '.QDDDD......DDd.',
      '.QDDNd.......Dd.',
      '.ddddd.......dd.',
      '..DD............',
      '.QDDDd.....DDDd.',
      '.QDDd.......DDd.',
      '.dddd......dddd.',
      '..DD.D......D...',
      '.QDDDDDD.DDDDDd.',
      '.QDDNDDd.DNDDDd.',
      '.dddddddddddddd.',
      '..d..........d..',
    ],
  };
  DEFS.o_barricade_broken = {
    pal: BAR_PAL,
    rows: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '..........Dd....',
      '...Qd......Dd...',
      '....DDd.....d...',
      '.......d........',
      '..dd.......QDDd.',
      '.QDDdd..Dd..ddd.',
      '..ddDDd..dD.....',
      '....dd.....d....',
      '................',
    ],
  };
  DEFS.o_lair = {
    pal: pal({ D: '#5a4030', d: '#3a281c', Q: '#7a5a40', K: '#0a060c', k: '#1c1216', W: '#e6dfc8', w: '#a8a088' }),
    rows: [
      '................',
      '................',
      '.....dDDDDd.....',
      '...dDQQQQQDDd...',
      '..dDQDDDDDDQDd..',
      '..DQDkkkkkkDQD..',
      '.dDDkKKKKKKkDDd.',
      '.DQkKKKKKKKKkQD.',
      '.DDkKKKKKKKKkDd.',
      '.dDkKKKKKKKKkDd.',
      '..DDkkKKKKkkDD..',
      '..dDDDkkkkDDDd..',
      '.W.ddDDDDDDdd.w.',
      'WwW..dddddd..WwW',
      '.w............W.',
      '................',
    ],
  };

  // ---------------- Traps (16×16, full-tile art, no auto outline)
  DEFS.t_pit = {
    outline: false,
    pal: pal({ F: '#4a4452', f: '#2a2530', D: '#5c4632', d: '#3e2e20', Q: '#6e563e', I: '#6a6676' }),
    rows: [
      '................',
      '.ffffffffffffff.',
      '.fFFFFFFFFFFFFf.',
      '.fFdDDdDDdDDdFf.',
      '.fFdQDdQDdQDdFf.',
      '.fFdDDdDDdDDdFf.',
      '.fFIDDdDDdDDIFf.',
      '.fFdDDdDDdDDdFf.',
      '.fFdDDdDDdDDdFf.',
      '.fFIDDdDDdDDIFf.',
      '.fFdDDdDDdDDdFf.',
      '.fFdDDdDDdDDdFf.',
      '.fFdddddddddFFf.',
      '.fFFFFFFFFFFFFf.',
      '.ffffffffffffff.',
      '................',
    ],
  };
  DEFS.t_pit_open = {
    outline: false,
    pal: pal({ F: '#4a4452', f: '#2a2530', K: '#050308', k: '#141018', j: '#221c28', D: '#5c4632', d: '#3e2e20' }),
    rows: [
      '................',
      '.ffffffffffffff.',
      '.fFFFFFFFFFFFFf.',
      '.fFjjjjjjjjjjFf.',
      '.fFjkkkkkkkkjFf.',
      '.fFdkKKKKKKkjFf.',
      '.fDdkKKKKKKkjFf.',
      '.fFjkKKKKKKkjFf.',
      '.fFjkKKKKKKkdFf.',
      '.fFjkKKKKKKkdDf.',
      '.fFjkKKKKKKkjFf.',
      '.fFjkkkkkkkkjFf.',
      '.fFjjjjjjjjjjFf.',
      '.fFFFFFFFFFFFFf.',
      '.ffffffffffffff.',
      '................',
    ],
  };
  DEFS.t_fire = {
    outline: false,
    pal: pal({ I: '#4c4650', i: '#26222c', J: '#6e6878', E: '#ff7a1f', e: '#9a2e14', y: '#ffc050' }),
    rows: [
      '................',
      '................',
      '..iiiiiiiiiiii..',
      '..iJJJJJJJJJJi..',
      '..iJeIeIeIeIIi..',
      '..iJEIyIEIyIIi..',
      '..iJeIEIeIEIIi..',
      '..iJyIeIyIeIIi..',
      '..iJEIyIEIyIIi..',
      '..iJeIEIeIEIIi..',
      '..iJEIeIyIeIIi..',
      '..iJeIyIEIyIIi..',
      '..iIIIIIIIIIIi..',
      '..iiiiiiiiiiii..',
      '................',
      '................',
    ],
  };
  DEFS.t_boulder = {
    pal: pal({ B: '#8a8078', b: '#5e5650', Q: '#b4aca2', q: '#d2cabe', k: '#3a3430' }),
    rows: [
      '................',
      '................',
      '.....bBBBBb.....',
      '....BQQQBBBb....',
      '...BQqQBBBBBb...',
      '..bBQQBBkBBBBb..',
      '..BBQBBBkBBBBb..',
      '..BBBBBkBBBBbb..',
      '..BBBBBBBBbBbb..',
      '..bBBBkBBBBbbb..',
      '...BBBBkBBbbb...',
      '....bBBBbbbb....',
      '.....bbbbbb.....',
      '................',
      '................',
      '................',
    ],
  };
  DEFS.t_boulder_empty = {
    outline: false,
    pal: pal({ B: '#6a625c', b: '#3e3834', f: '#221e28' }),
    rows: [
      '................',
      '................',
      '................',
      '................',
      '.....ffffff.....',
      '....ff....ff....',
      '...f..B.....f...',
      '...f.....b..f...',
      '...f..b.....f...',
      '....f...B..f....',
      '.....ffffff.....',
      '..B.........b...',
      '.......b........',
      '................',
      '................',
      '................',
    ],
  };
  DEFS.arrow_emblem = {
    pal: pal({ I: '#4a4654', i: '#2a2632', J: '#8a8696', h: '#0a080e', r: '#b0acb8' }),
    rows: [
      '..........',
      '.iiiiiiii.',
      '.iJJJJJJi.',
      '.iJrhhrIi.',
      '.iJhhhhIi.',
      '.iJhhhhIi.',
      '.iJrhhrIi.',
      '.iIIIIIIi.',
      '.iiiiiiii.',
      '..........',
    ],
  };

  // ---------------- Misc props
  DEFS.bones = {
    pal: pal({ W: '#e9e3cc', w: '#aaa184', k: '#1c1418' }),
    rows: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '.......WWW......',
      '......WkWkW.....',
      '..w...WWWWw..W..',
      '...W...wWw..W...',
      '.wWWWw.....WwW..',
      '....W.wWWWWWw...',
      '..WwW..W..W..wW.',
      '................',
      '................',
    ],
  };
  DEFS.remains = {
    outline: false,
    pal: pal({ R: '#4a0e16c0', r: '#300a10a0', W: '#c8c2ae', w: '#8a846e' }),
    rows: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '.......rr.......',
      '.....rRRRr......',
      '....rRRWRRr.....',
      '...rRRRRwRRr....',
      '....rRWWRRr.r...',
      '.....rrRRr......',
      '................',
      '................',
      '................',
      '................',
    ],
  };
  // ---------------- Small icons (status, badges, markers)
  DEFS.i_burn = { pal: pal({ R: '#ff5a1a', Y: '#ffd24a', w: '#fff6c8' }), rows: ['...R...', '..RR...', '..RYR..', '.RYYR.R', '.RYwYRR', '.RYwYR.', '..RRR..'] };
  DEFS.i_bleed = { pal: pal({ R: '#e0203a', r: '#8a0a1e', w: '#ff9aa8' }), rows: ['...R...', '..RRR..', '..RRR..', '.RwRRR.', '.RwRRr.', '.RRRrr.', '..rrr..'] };
  DEFS.i_slow = { pal: pal({ B: '#5ab8ff', b: '#2a70c0', w: '#d8f0ff' }), rows: ['.b...b.', '.bb.bb.', '..bBb..', '.bwBwb.', '.BBBBB.', '..BwB..', '...B...'] };
  DEFS.i_fear = { pal: pal({ P: '#c07aff', p: '#7a3ac0', k: '#1a0a24' }), rows: ['..PPP..', '.PPPPP.', '.PkPkP.', '.PkPkP.', '.PPPPP.', '.PpkpP.', '..P.P..'] };
  DEFS.i_root = { pal: pal({ W: '#f0f0f8', w: '#a0a0b8' }), rows: ['W..W..W', '.W.W.W.', '..wWw..', 'WWWWWWW', '..wWw..', '.W.W.W.', 'W..W..W'] };
  DEFS.i_eye = { pal: pal({ Y: '#ffe36a', y: '#c09a20', k: '#1a1020', w: '#ffffff' }), rows: ['.......', '..yyy..', '.yYYYy.', 'yYkwkYy', '.yYkYy.', '..yyy..', '.......'] };
  DEFS.i_buff = { pal: pal({ R: '#ff4a3a', r: '#a01a10', Y: '#ffd24a' }), rows: ['...R...', '..RRR..', '.RRYRR.', 'RRRYRRR', '..RYR..', '..RRR..', '..rrr..'] };
  DEFS.i_invis = { pal: pal({ P: '#b8a8e8', p: '#6a5a9a' }), rows: ['.......', '..ppp..', '.p...p.', 'p.P.P.p', '.p...p.', '..ppp..', '.......'] };
  DEFS.i_hidden = { pal: pal({ P: '#d8c8ff', p: '#7a6aa8' }), rows: ['.......', '.......', 'P.....P', '.PPPPP.', 'p.p.p.p', '.......', '.......'] };
  DEFS.i_known = { pal: pal({ Y: '#ffe36a', y: '#b08a20', k: '#1a1020' }), rows: ['.......', '..yyy..', '.yYYYy.', 'yYYkYYy', '.yYYYy.', '..yyy..', '.......'] };
  DEFS.i_bang = { pal: pal({ Y: '#ffd24a', y: '#c08a10', k: '#2a1804' }), rows: ['..yyyy..', '.yYYYYy.', 'yYYkkYYy', 'yYYkkYYy', 'yYYkkYYy', 'yYYYYYYy', '.yYkkYy.', '..yyyy..'] };
  DEFS.i_disarm = { pal: pal({ R: '#ff3a3a', r: '#901818', W: '#ffffff' }), rows: ['.rrrrrr.', 'rRRRRRRr', 'rRWRRWRr', 'rRRWWRRr', 'rRRWWRRr', 'rRWRRWRr', 'rRRRRRRr', '.rrrrrr.'] };
  DEFS.i_sack = { pal: pal({ B: '#b08040', b: '#7a5220', Y: '#ffd84a', k: '#3a2410' }), rows: ['...kk...', '..kYYk..', '...bb...', '..BBBB..', '.BBYBBB.', '.BBBBBb.', '.bBBBbb.', '..bbbb..'] };
  DEFS.i_coin = { pal: pal({ Y: '#ffd84a', y: '#b08a20', w: '#fff6c0' }), rows: ['.yyyy.', 'yYwYYy', 'yYwYYy', 'yYYYYy', 'yYYYYy', '.yyyy.'] };
  DEFS.i_wrench = { pal: pal({ C: '#9ae8ff', c: '#3a90b0' }), rows: ['.C..C.', '.CccC.', '..CC..', '..Cc..', '..Cc..', '..cc..'] };
  DEFS.i_blast = { pal: pal({ P: '#d08aff', w: '#ffffff' }), rows: ['..P...', 'P.P.P.', '.PwP..', 'PwwwPP', '.PwP..', 'P.P.P.'] };
  DEFS.i_pick = { pal: pal({ M: '#c8ccd8', P: '#a06a3a' }), rows: ['MMMMM.', 'M.P.M.', '..P...', '..P...', '..P...', '..P...'] };
  DEFS.i_skull = { pal: pal({ W: '#f0ead8', k: '#1a1020' }), rows: ['.WWWWW.', 'WWWWWWW', 'WkkWkkW', 'WkkWkkW', '.WWkWW.', '.WkWkW.', '..WWW..'] };
  DEFS.i_star = { outline: false, pal: pal({ Y: '#ffe86a', w: '#ffffff' }), rows: ['.Y.', 'YwY', '.Y.'] };
  DEFS.i_bolt = { pal: pal({ Y: '#ffe86a', w: '#ffffff' }), rows: ['...YY', '..YY.', '.YwY.', 'YYYY.', '..YY.', '.YY..', 'YY...'] };

  /* ---- 1.4 Procedural sprite painters -------------------------------------
   * Round/organic shapes are cleaner painted with code. A painter writes hex
   * colours into a pixel buffer; the result goes through the same pipeline
   * (outline, variants) as grid sprites.                                      */
  function newBuf(w, h) { return { w, h, px: new Uint32Array(w * h), edge: null }; }
  function painter(b) {
    const set = (x, y, c) => { x |= 0; y |= 0; if (x >= 0 && y >= 0 && x < b.w && y < b.h) b.px[y * b.w + x] = c ? u32(c) : 0; };
    return {
      set,
      rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, c); },
      line(x0, y0, x1, y1, c) {
        x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
        const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
        let err = dx + dy;
        for (;;) {
          set(x0, y0, c);
          if (x0 === x1 && y0 === y1) break;
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; x0 += sx; }
          if (e2 <= dx) { err += dx; y0 += sy; }
        }
      },
      /** Filled ellipse; `shade(nx, ny)` (normalized -1..1) may return a colour per pixel. */
      ellipse(cx, cy, rx, ry, c, shade) {
        for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
          for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
            const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
            if (nx * nx + ny * ny <= 1) set(x, y, shade ? shade(nx, ny) || c : c);
          }
      },
      /** Filled polygon (even-odd rule), points = [[x,y],...]. */
      poly(pts, c) {
        let minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9;
        for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); }
        for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++)
          for (let x = Math.floor(minX); x <= Math.ceil(maxX); x++) {
            const px = x + 0.5, py = y + 0.5;
            let inside = false;
            for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
              const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
              if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
            }
            if (inside) set(x, y, c);
          }
      },
      get(x, y) { return x >= 0 && y >= 0 && x < b.w && y < b.h ? b.px[y * b.w + x] : 0; },
    };
  }

  const PROCS = {};
  /** Spider: round abdomen, eight jointed legs (two leg poses), red eyes. */
  PROCS.m_spider = { frames: 2, w: 18, h: 16, paint(p, f) {
    const legs = [
      [[7, 8], [3, 5], [1, 8]],
      [[7, 9], [2, 9], [0, 12]],
      [[7, 10], [3, 12], [1, 15]],
      [[8, 11], [5, 14], [4, 15]],
    ];
    for (let side = 0; side < 2; side++) for (let li = 0; li < 4; li++) {
      const k = (li + side + f) % 2 ? -1 : 1; // alternate knees rise/fall per frame
      const [a, b, c] = legs[li];
      const X = x => (side ? 17 - x : x);
      p.line(X(a[0]), a[1], X(b[0]), b[1] + k, '#5a4a70');
      p.line(X(b[0]), b[1] + k, X(c[0]), c[1], '#43365a');
      p.set(X(b[0]), b[1] + k, '#8a78a8');
    }
    p.ellipse(9, 5, 4.2, 4, '#2a1c3a', (nx, ny) => nx + ny < -0.75 ? '#6a4a8a' : nx + ny < -0.25 ? '#44305c' : nx + ny > 0.95 ? '#1a1024' : null);
    p.set(8, 3, '#b04ac8'); p.set(9, 3, '#b04ac8'); p.set(8, 4, '#d070e8'); p.set(9, 6, '#b04ac8'); p.set(8, 7, '#b04ac8'); p.set(9, 7, '#b04ac8');
    p.ellipse(9, 10.5, 3, 2.4, '#2a1c3a', (nx, ny) => ny < -0.45 && nx < 0.3 ? '#4a3462' : null);
    p.set(7, 10, '#ff3030'); p.set(10, 10, '#ff3030'); p.set(8, 9, '#ff8a6a'); p.set(9, 9, '#ff8a6a');
    p.set(8, 12 + f, '#e8e0d0'); p.set(9, 12 + f, '#e8e0d0');
  } };
  /** Imp: small red devil, horns, tail, bat wings up (frame 0) / down (frame 1). */
  PROCS.m_imp = { frames: 2, w: 18, h: 16, paint(p, f) {
    const V = '#8a1a2a', v = '#561020', bone = '#c83a2a';
    const up = f === 0;
    const wing = up ? [[6, 8], [2, 1], [1, 4], [0, 8], [3, 8], [5, 10]] : [[6, 8], [1, 9], [0, 13], [3, 12], [4, 14], [6, 11]];
    for (const side of [0, 1]) {
      const pts = wing.map(q => [side ? 18 - q[0] : q[0], q[1]]);
      p.poly(pts, V);
      p.line(pts[0][0], pts[0][1], pts[1][0], pts[1][1], bone);
      p.line(pts[0][0], pts[0][1], pts[3][0], pts[3][1], v);
    }
    const g = [
      '.......k..k.......',
      '.......Hr.rH......',
      '......RQRRRRr.....',
      '......RERkREk.....',
      '......RRRRRRr.....',
      '.......rWWWr......',
      '......RRRRRRr.....',
      '.....rRQRRRRRr....',
      '.....R.RRRRRr.R...',
      '.......RRRRr......',
      '.......r...r.rr...',
      '.......k...k...r..',
      '................R.',
    ];
    const cp = { k: '#2a1414', H: '#3a2020', r: '#98281a', R: '#d8402a', Q: '#ff7a4a', E: '#ffe040', W: '#fff4d8' };
    for (let y = 0; y < g.length; y++) for (let x = 0; x < g[y].length; x++) {
      const ch = g[y][x]; if (ch !== '.') p.set(x, y + 2, cp[ch]);
    }
  } };
  /** Dragon (24×24): crimson body with a fiery belly; wings (drawn behind) up / spread. */
  const DRAGON_BODY = [
    '........................',
    '........................',
    '...................HH...',
    '..................HRRH..',
    '.................RRRRRR.',
    '................RQRREkRR',
    '................RRRRRRRR',
    '...............rRRRRWrWr',
    '...............RRRrrrrr.',
    '..............RRRr......',
    '.............RRRr.......',
    '.......rRRRRRRRr........',
    '.....RRQQRRRRRRRr.......',
    '....RRRRYYYYYYRRRr......',
    '...RRRRYYyYYyYYRRr......',
    '..RRr.RYYYYYYYYRRr......',
    '.RRr..rRYYyYYYRRr.......',
    'RRr....rRRRRRRRr........',
    'Rr.....RRr...RRr........',
    'r......RRr...RRr........',
    '.......kkk...kkk........',
    '........................',
  ];
  const DRAGON_PAL = { R: '#b8202e', r: '#7a1020', Q: '#e2504e', Y: '#ffb040', y: '#e07020', H: '#efe6cc', E: '#ffe040', W: '#fff8e0', k: '#1a0608' };
  PROCS.b_dragon = { frames: 2, w: 24, h: 24, paint(p, f) {
    const up = f === 0;
    const mem = '#8a1428', dark = '#5a0a1a', bone = '#c8303a';
    if (up) {
      p.poly([[14, 11], [16, 9], [18, 3], [15, 6]], dark); // far wing peeking out
      p.poly([[9, 13], [13, 11], [11, 5], [9, 0], [7, 4], [2, 1], [3, 7], [1, 9], [6, 10]], mem);
      p.poly([[9, 13], [13, 11], [8, 9], [3, 8], [6, 11]], dark);
      p.line(12, 11, 9, 0, bone); p.line(11, 11, 2, 1, bone); p.line(10, 12, 1, 9, bone);
    } else {
      p.poly([[9, 13], [13, 11], [10, 9], [4, 8], [0, 11], [1, 14], [4, 13], [6, 15]], mem);
      p.poly([[9, 13], [13, 11], [7, 12], [3, 14], [6, 15]], dark);
      p.line(12, 11, 4, 8, bone); p.line(11, 12, 0, 11, bone); p.line(10, 12, 3, 14, bone);
    }
    for (let y = 0; y < DRAGON_BODY.length; y++) for (let x = 0; x < 24; x++) {
      const ch = DRAGON_BODY[y][x];
      if (ch !== '.') p.set(x, y + (up ? 0 : 1), DRAGON_PAL[ch]);
    }
  } };
  /** Slime puddle: irregular translucent blob with a darker rim, sheen and bubbles. */
  PROCS.t_slime = { frames: 1, w: 16, h: 16, outline: false, paint(p) {
    const body = '#3aa02ad0';
    p.ellipse(8, 9, 6.8, 4.3, body); p.ellipse(4, 11.6, 3, 1.9, body); p.ellipse(11.8, 6.4, 2.8, 2, body); p.ellipse(12.8, 11.8, 2.2, 1.5, body);
    const px = [];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (p.get(x, y)) px.push([x, y]);
    for (const [x, y] of px) {
      const edge = !p.get(x - 1, y) || !p.get(x + 1, y) || !p.get(x, y - 1) || !p.get(x, y + 1) || x === 0 || y === 0 || x === 15 || y === 15;
      if (edge) p.set(x, y, '#1f6a1ae0');
      else if (Math.hypot(x - 7, (y - 8.5) * 1.4) < 2.8) p.set(x, y, '#5ccc40d8');
    }
    p.set(5, 7, '#d8ffc0'); p.set(6, 6, '#d8ffc0'); p.set(11, 4, '#b8f8a0');
    for (const [bx, by] of [[9, 10], [4, 11], [12, 6]]) { p.set(bx, by - 1, '#a8f088'); p.set(bx - 1, by, '#a8f088'); p.set(bx + 1, by, '#a8f088'); p.set(bx, by + 1, '#2f8a24'); }
  } };
  /** Dungeon Heart: faceted crimson crystal heart (24×24). */
  PROCS.heart = { frames: 1, w: 24, h: 24, paint(p) {
    const inHeart = (x, y) => {
      const X = (x - 12) / 9.6, Y = -(y - 10.5) / 9.2;
      const a = X * X + Y * Y - 1;
      return a * a * a - X * X * Y * Y * Y <= 0;
    };
    for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
      if (!inHeart(x + 0.5, y + 0.5)) continue;
      const dx = x + 0.5 - 12, dy = y + 0.5 - 11;
      let c;
      if (Math.abs(dx) < 0.8) c = '#b01030';
      else if (dx < 0) c = dy < -2 ? '#ff5a78' : dy < 4 ? '#e82848' : '#b8163a';
      else c = dy < -2 ? '#d01c3c' : dy < 4 ? '#a80e2e' : '#7a0822';
      if ((dx < 0 && Math.abs(dx + dy + 2) < 0.7) || (dx > 0 && Math.abs(dx - dy - 2) < 0.7)) c = dx < 0 ? '#ff8a9e' : '#c01838';
      p.set(x, y, c);
    }
    p.set(7, 6, '#ffe0e6'); p.set(8, 6, '#ffe0e6'); p.set(6, 7, '#ffe0e6'); p.set(7, 7, '#ffb8c6'); p.set(6, 8, '#ffb8c6');
    p.set(15, 6, '#ff8aa0'); p.set(10, 15, '#ff6a84');
  } };
  /** Crack overlays for the Heart (stages 1-3), drawn over the heart sprite. */
  const HEART_CRACKS = [
    [[9, 4, 11, 9], [11, 9, 9, 13]],
    [[15, 5, 13, 10], [13, 10, 15, 14], [6, 10, 9, 12], [11, 9, 13, 10]],
    [[12, 2, 12, 7], [9, 13, 12, 19], [15, 14, 17, 12], [4, 7, 6, 10], [17, 5, 19, 8]],
  ];
  for (let st = 0; st < 3; st++) {
    PROCS['heart_crack' + (st + 1)] = { frames: 1, w: 24, h: 24, outline: false, paint(p) {
      for (let s = 0; s <= st; s++) for (const c of HEART_CRACKS[s]) p.line(c[0], c[1], c[2], c[3], '#2a0010');
      for (let s = 0; s <= st; s++) for (const c of HEART_CRACKS[s]) p.set((c[0] + c[2]) >> 1, (c[1] + c[3]) >> 1, '#ffd0a0');
    } };
  }
  /** Shattered heart (after destruction). */
  PROCS.heart_shards = { frames: 1, w: 24, h: 24, paint(p) {
    const shard = (pts, c) => p.poly(pts, c);
    shard([[5, 16], [9, 12], [10, 18]], '#b8163a');
    shard([[12, 18], [15, 13], [17, 19]], '#7a0822');
    shard([[8, 20], [12, 19], [10, 22]], '#e82848');
    shard([[15, 20], [19, 17], [19, 21]], '#a80e2e');
    shard([[3, 20], [6, 19], [5, 22]], '#d01c3c');
  } };
  /** Altar beneath the Heart: round stone dais with a rune ring (26×14). */
  PROCS.altar = { frames: 1, w: 28, h: 16, paint(p) {
    p.ellipse(14, 9.5, 13.4, 6, '#2a2432');
    p.ellipse(14, 8.5, 13, 5.6, '#5a5266', (nx, ny) => ny < -0.55 ? '#7a7288' : ny > 0.6 ? '#3e3848' : null);
    p.ellipse(14, 7.5, 10, 4.2, '#6e6680', (nx, ny) => ny < -0.5 ? '#8e86a0' : ny > 0.55 ? '#4a4456' : null);
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2;
      p.set(14 + Math.cos(a) * 11.4, 8.8 + Math.sin(a) * 4.7, i % 2 ? '#ff4a6a' : '#a01830');
    }
  } };
  /** Mana well: stone ring around glowing water (two shimmer frames). */
  PROCS.o_well = { frames: 2, w: 16, h: 16, paint(p, f) {
    p.ellipse(8, 9, 7, 5.6, '#5a5468', (nx, ny) => ny < -0.4 ? '#7e7890' : ny > 0.55 ? '#3a3446' : null);
    for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; p.set(8 + Math.cos(a) * 6.3, 9 + Math.sin(a) * 5, '#2e2a38'); }
    p.ellipse(8, 8.8, 4.6, 3.4, '#1e7ad8', (nx, ny) => (nx * 3 + ny * 2 + f * 2) % 2 > 1.2 ? '#52b8ff' : ny < -0.5 ? '#8ae4ff' : null);
    p.set(6 + f, 8, '#e0fbff'); p.set(10 - f, 10, '#c0f0ff');
  } };
  /** Alarm rune: purple glyph circle (drawn translucent, pulsing). */
  PROCS.t_alarm = { frames: 1, w: 16, h: 16, outline: false, paint(p) {
    const c = '#b070ff', d = '#6a3aa8';
    for (let i = 0; i < 28; i++) { const a = i / 28 * Math.PI * 2; p.set(7.5 + Math.cos(a) * 6.2 + 0.5, 7.5 + Math.sin(a) * 6.2 + 0.5, i % 7 === 0 ? '#e8c8ff' : c); }
    for (let i = 0; i < 20; i++) { const a = i / 20 * Math.PI * 2; p.set(7.5 + Math.cos(a) * 4.2 + 0.5, 7.5 + Math.sin(a) * 4.2 + 0.5, d); }
    p.line(8, 3, 5, 11, c); p.line(8, 3, 11, 11, c); p.line(4, 7, 12, 7, c); p.line(5, 11, 11, 11, d);
    p.set(8, 7, '#ffffff');
  } };
  /** Teleporter pad base (stone disc with blue rim) and a swirl overlay (4 rotation frames). */
  PROCS.t_teleport = { frames: 1, w: 16, h: 16, outline: false, paint(p) {
    p.ellipse(8, 8, 7, 7, '#2a2436');
    p.ellipse(8, 8, 6.2, 6.2, '#3a4a78', (nx, ny) => nx * nx + ny * ny > 0.72 ? '#5ab4ff' : nx + ny < -0.6 ? '#4a6aa8' : null);
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; p.set(8 + Math.cos(a) * 5.4, 8 + Math.sin(a) * 5.4, '#c8f0ff'); }
  } };
  PROCS.tele_swirl = { frames: 4, w: 16, h: 16, outline: false, paint(p, f) {
    for (let arm = 0; arm < 3; arm++) for (let t = 0; t < 1; t += 0.04) {
      const a = t * 4.2 + arm * (Math.PI * 2 / 3) + f * (Math.PI / 2);
      const r = 0.6 + t * 4.4;
      p.set(8 + Math.cos(a) * r, 8 + Math.sin(a) * r, t < 0.35 ? '#ffffff' : t < 0.7 ? '#9ae4ff' : '#3a9aff');
    }
  } };
  /** Small flame, 3 flicker frames (torches, burning). */
  PROCS.flame = { frames: 3, w: 8, h: 12, outline: false, paint(p, f) {
    const sway = [0, 1, -1][f];
    for (let y = 0; y < 12; y++) {
      const t = y / 11, wdt = Math.sin(t * Math.PI * 0.95) * 3.4 * (0.6 + t * 0.5);
      const cx = 4 + sway * (1 - t) * 1.2;
      for (let x = 0; x < 8; x++) {
        const d = Math.abs(x + 0.5 - cx);
        if (d > wdt) continue;
        const k = d / Math.max(0.5, wdt);
        p.set(x, y, k < 0.35 && t > 0.35 ? '#fff4b0' : k < 0.7 && t > 0.2 ? '#ffb040' : '#ff5a1a');
      }
    }
  } };
  /** Tall flame column for an erupting Fire Vent (12×28), 3 frames. */
  PROCS.flamecol = { frames: 3, w: 12, h: 28, outline: false, paint(p, f) {
    for (let y = 0; y < 28; y++) {
      const t = y / 27;
      const wdt = 1.2 + t * 4.4 + Math.sin(y * 0.9 + f * 2.1) * 0.8;
      const cx = 6 + Math.sin(y * 0.45 + f * 1.7) * (1 - t) * 1.6;
      for (let x = 0; x < 12; x++) {
        const d = Math.abs(x + 0.5 - cx);
        if (d > wdt) continue;
        const k = d / wdt;
        p.set(x, y, k < 0.3 && t > 0.25 ? '#fff6c0' : k < 0.65 && t > 0.1 ? '#ffb040' : '#ff5a1a');
      }
    }
  } };
  /** Party-leader pennant (5 colours) — cloth colour set per frame index. */
  const PENNANT_COLS = ['#ffd84a', '#4ac8ff', '#ff6a9a', '#8aff6a', '#c08aff'];
  PROCS.pennant = { frames: 10, w: 7, h: 10, paint(p, f) {
    const col = PENNANT_COLS[f % 5], wave = f >= 5 ? 1 : 0;
    p.line(0, 0, 0, 9, '#c8b890');
    p.rect(1, 0, 4, 1, col); p.rect(1, 1, 5, 1, col); p.rect(1, 2, 4 + wave, 1, col); p.rect(1, 3, 3, 1, col);
    p.set(5 - wave, 3, col);
  } };
  /** Spike plate: iron plate with holes (frame 0) / steel spikes thrust up (frame 1). */
  const SPIKE_HOLES = [[5, 5], [8, 5], [11, 5], [6, 8], [9, 8], [12, 8], [5, 11], [8, 11], [11, 11]];
  PROCS.t_spike = { frames: 2, w: 16, h: 16, outline: false, paint(p, f) {
    p.rect(2, 2, 12, 12, '#2e2b36'); p.rect(3, 3, 10, 10, '#4a4654');
    p.rect(3, 3, 10, 1, '#6c6878'); p.rect(3, 3, 1, 10, '#5e5a6a'); p.rect(3, 12, 10, 1, '#3a3644'); p.rect(12, 3, 1, 10, '#3a3644');
    p.set(3, 3, '#8a8696'); p.set(12, 3, '#8a8696'); p.set(3, 12, '#8a8696'); p.set(12, 12, '#8a8696');
    for (const [x, y] of SPIKE_HOLES) { p.set(x, y, '#0e0c12'); p.set(x + 1, y, '#18151e'); }
    if (f === 1) for (const [x, y] of SPIKE_HOLES) {
      p.set(x, y - 3, '#ffffff'); p.set(x, y - 2, '#e8ecf4'); p.set(x + 1, y - 2, '#9aa2b2');
      p.set(x, y - 1, '#d8dde8'); p.set(x + 1, y - 1, '#8a92a2'); p.set(x, y, '#c8ced8'); p.set(x + 1, y, '#7a8292');
    }
  } };
  /** Rubble wall left by Collapse: a heap of broken cut-stone chunks. */
  PROCS.rubble = { frames: 1, w: 16, h: 16, paint(p) {
    const chunk = (pts, c, hi) => { p.poly(pts, c); p.line(pts[0][0], pts[0][1], pts[1][0], pts[1][1], hi); };
    p.ellipse(8, 11, 7.4, 4.4, '#3a3342');
    chunk([[2, 12], [5, 8], [8, 10], [7, 14], [3, 14]], '#6e657e', '#9a90aa');
    chunk([[7, 9], [10, 4], [14, 7], [13, 12], [8, 12]], '#7e7590', '#aaa0ba');
    chunk([[4, 6], [7, 3], [9, 6], [6, 9]], '#877e98', '#b4aac4');
    chunk([[9, 12], [13, 11], [14, 14], [10, 15]], '#5e566c', '#857c96');
    chunk([[1, 9], [3, 7], [4, 10]], '#5e566c', '#857c96');
    p.set(6, 5, '#c9b99a'); p.set(11, 8, '#c9b99a'); p.set(4, 12, '#2a2432'); p.set(12, 10, '#4a4456');
  } };
  /** Cut-stone gate pillar framing the entrance (8×14). */
  PROCS.pillar = { frames: 1, w: 8, h: 14, paint(p) {
    p.rect(0, 0, 8, 6, '#a89eb4'); p.rect(0, 0, 8, 1, '#c8bed4'); p.rect(0, 0, 1, 6, '#bab0c6'); p.rect(7, 0, 1, 6, '#7a7088');
    p.rect(0, 6, 8, 8, '#3a3342');
    for (let r = 0; r < 2; r++) for (let bx = r ? -2 : 0; bx < 8; bx += 5) { p.rect(bx + 1, 7 + r * 4, 4, 3, '#6d6378'); p.rect(bx + 1, 7 + r * 4, 4, 1, '#857b90'); }
  } };
  /** Soft round shadow under entities (drawn with alpha). */
  PROCS.shadow = { frames: 1, w: 16, h: 6, outline: false, paint(p) {
    p.ellipse(8, 3, 7.5, 2.6, '#00000060'); p.ellipse(8, 3, 5.5, 1.8, '#00000080');
  } };

  /* ---- 1.5 Rasterizer -------------------------------------------------------- */
  const V = { NORMAL: 0, WHITE: 1, ELITE: 2, RISEN: 3, GREY: 4, CORPSE: 5, RIM: 6 };
  const recs = {};
  let ready = false;

  function fromRows(rows, palette, w) {
    const h = rows.length;
    w = w || rows.reduce((a, r) => Math.max(a, r.length), 0);
    const b = newBuf(w, h);
    for (let y = 0; y < h; y++) {
      const row = rows[y];
      for (let x = 0; x < w; x++) {
        const ch = row.charAt(x);
        if (!ch || ch === '.' || ch === ' ') continue;
        const col = palette[ch];
        if (col) b.px[y * w + x] = u32(col);
      }
    }
    return b;
  }
  function applyPatch(b, patches, palette) {
    for (const [px0, py0, rows] of patches) for (let y = 0; y < rows.length; y++) for (let x = 0; x < rows[y].length; x++) {
      const ch = rows[y][x];
      if (ch === '.' || !palette[ch]) continue;
      const X = px0 + x, Y = py0 + y;
      if (X < b.w && Y < b.h) b.px[Y * b.w + X] = u32(palette[ch]);
    }
  }
  /** Walk frame: shift one leg's pixels up by one row (the foot lifts). */
  function liftLeg(b, legRow, split, left) {
    const out = newBuf(b.w, b.h);
    out.px.set(b.px);
    const x0 = left ? 0 : split, x1 = left ? split : b.w;
    for (let x = x0; x < x1; x++) for (let y = legRow; y < b.h; y++) out.px[y * b.w + x] = y + 1 < b.h ? b.px[(y + 1) * b.w + x] : 0;
    return out;
  }
  /** Add a 1px dark outline around opaque pixels (orthogonal neighbours). */
  function addOutline(b) {
    const { w, h, px } = b, out = new Uint32Array(px), edge = new Uint8Array(w * h), oc = u32(OUTLINE);
    const solid = i => (px[i] >>> 24) > 150;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (px[i] >>> 24) continue;
      if ((x > 0 && solid(i - 1)) || (x < w - 1 && solid(i + 1)) || (y > 0 && solid(i - w)) || (y < h - 1 && solid(i + w))) { out[i] = oc; edge[i] = 1; }
    }
    b.px = out; b.edge = edge;
  }
  function footRow(b) {
    for (let y = b.h - 1; y >= 0; y--) for (let x = 0; x < b.w; x++) if (b.px[y * b.w + x] >>> 24) return y + 1;
    return b.h;
  }
  function register(name, frames, outline) {
    if (outline !== false) for (const f of frames) addOutline(f);
    recs[name] = { name, w: frames[0].w, h: frames[0].h, foot: footRow(frames[0]), frames, cache: [] };
  }
  function buildDef(name, d) {
    let frames;
    if (d.frames) frames = d.frames.map(r => fromRows(r, d.pal));
    else {
      const b = fromRows(d.rows, d.pal);
      if (d.patch) applyPatch(b, d.patch, d.pal);
      frames = d.legs ? [b, liftLeg(b, d.legs[0], d.legs[1], true), b, liftLeg(b, d.legs[0], d.legs[1], false)] : [b];
    }
    register(name, frames, d.outline);
  }
  function buildProc(name, d) {
    const frames = [];
    for (let f = 0; f < d.frames; f++) { const b = newBuf(d.w, d.h); d.paint(painter(b), f); frames.push(b); }
    register(name, frames, d.outline);
  }

  /** Recolour one pixel for a variant. */
  function variantPixel(v, isEdge, variant) {
    const a = v >>> 24;
    let r = v & 255, g = (v >>> 8) & 255, b = (v >>> 16) & 255;
    switch (variant) {
      case V.WHITE: return pack(255, 255, 255, a);
      case V.ELITE: return isEdge ? pack(255, 214, 72, 255) : v;
      case V.RIM: return isEdge ? pack(255, 200, 58, 255) : 0;
      case V.RISEN:
        if (isEdge) return pack(40, 8, 56, a);
        return pack(Math.min(255, r * 0.55 + 60) | 0, Math.min(255, g * 0.4 + 22) | 0, Math.min(255, b * 0.7 + 110) | 0, a);
      case V.GREY: { const l = (r * 0.3 + g * 0.59 + b * 0.11) * 0.8; return pack((l * 0.85 + r * 0.15) | 0, (l * 0.85 + g * 0.15) | 0, (l * 0.9 + b * 0.1) | 0, a); }
      case V.CORPSE: { const l = r * 0.3 + g * 0.59 + b * 0.11; return pack(((l * 0.5 + r * 0.5) * 0.55) | 0, ((l * 0.5 + g * 0.5) * 0.5) | 0, ((l * 0.5 + b * 0.5) * 0.55) | 0, a); }
      default: return v;
    }
  }
  function makeCanvas(rec, fi, variant, flip) {
    const b = rec.frames[fi], w = b.w, h = b.h, rot = variant === V.CORPSE;
    const cw = rot ? h : w, ch = rot ? w : h;
    const c = mk(cw, ch), g = c.getContext('2d');
    const img = g.createImageData(cw, ch), out = new Uint32Array(img.data.buffer);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = b.px[y * w + x];
      if (!(v >>> 24)) continue;
      const sx = flip ? w - 1 - x : x;
      const nv = variantPixel(v, b.edge ? b.edge[y * w + x] === 1 : false, variant);
      if (!nv) continue;
      if (rot) out[sx * cw + (h - 1 - y)] = nv; else out[y * cw + sx] = nv;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  /* ---- 1.6 Procedural tiles --------------------------------------------------
   * 16×16 art-pixel textures drawn into canvases once; the Render static layer
   * composes them per tile (neighbour-aware wall faces, shadows, decals).     */
  const TEX = { floor: [], decal: [], wallTop: [], wallFront: [], rockTop: [], rockFront: [] };
  const FLOOR_BASES = ['#3a3542', '#37333f', '#3c3744', '#36323e', '#3a3440'];
  function shadeHex(hex, d) {
    const c = rgbaOf(hex);
    const f = v => Math.max(0, Math.min(255, v + d)).toString(16).padStart(2, '0');
    return '#' + f(c[0]) + f(c[1]) + f(c[2]);
  }
  function texCanvas(fn) {
    const b = newBuf(16, 16); fn(painter(b), b);
    const c = mk(16, 16), g = c.getContext('2d'), img = g.createImageData(16, 16);
    new Uint32Array(img.data.buffer).set(b.px);
    g.putImageData(img, 0, 0);
    return c;
  }
  function genFloor(seed) {
    const R = mulberry32(seed * 7919 + 131);
    return texCanvas(p => {
      p.rect(0, 0, 16, 16, '#1d1922');
      const slabs = [];
      const split = (x, y, w, h, d) => {
        if (d < 2 && w >= 10 && (h < 10 || R() < 0.5) && R() < 0.85) { const s = 5 + ((R() * (w - 9)) | 0); split(x, y, s, h, d + 1); split(x + s, y, w - s, h, d + 1); }
        else if (d < 2 && h >= 10 && R() < 0.85) { const s = 5 + ((R() * (h - 9)) | 0); split(x, y, w, s, d + 1); split(x, y + s, w, h - s, d + 1); }
        else slabs.push([x, y, w, h]);
      };
      split(0, 0, 16, 16, 0);
      for (const [x, y, w, h] of slabs) {
        const base = shadeHex(FLOOR_BASES[(R() * FLOOR_BASES.length) | 0], ((R() * 9) | 0) - 4);
        p.rect(x + 1, y + 1, w - 1, h - 1, base);
        p.rect(x + 1, y + 1, w - 1, 1, shadeHex(base, 9));
        p.rect(x + 1, y + 1, 1, h - 1, shadeHex(base, 5));
        p.rect(x + 1, y + h - 1, w - 1, 1, shadeHex(base, -7));
        p.rect(x + w - 1, y + 1, 1, h - 1, shadeHex(base, -5));
        const n = 2 + ((R() * 4) | 0);
        for (let i = 0; i < n; i++) p.set(x + 2 + R() * (w - 3), y + 2 + R() * (h - 3), shadeHex(base, R() < 0.5 ? -8 : 7));
      }
    });
  }
  function genDecals() {
    const R = mulberry32(99);
    return [
      texCanvas(p => { p.line(3, 4, 6, 7, '#17131b'); p.line(6, 7, 6, 10, '#17131b'); p.line(6, 7, 9, 8, '#17131b'); p.set(7, 8, '#4a4452'); }),
      texCanvas(p => { p.line(10, 3, 12, 6, '#17131b'); p.line(12, 6, 11, 11, '#17131b'); p.line(11, 11, 13, 13, '#17131b'); }),
      texCanvas(p => { for (let i = 0; i < 14; i++) p.set(2 + R() * 5, 10 + R() * 5, R() < 0.5 ? '#3a5a34' : '#2c4628'); p.set(4, 12, '#5a7a44'); }),
      texCanvas(p => { for (let i = 0; i < 12; i++) p.set(10 + R() * 5, 1 + R() * 4, R() < 0.5 ? '#3a5a34' : '#2c4628'); p.set(12, 2, '#5a7a44'); }),
      texCanvas(p => { p.set(4, 9, '#5a5464'); p.set(5, 9, '#48424f'); p.set(11, 5, '#5a5464'); p.set(9, 12, '#5a5464'); p.set(10, 12, '#3a3442'); }),
      texCanvas(p => { p.line(5, 10, 9, 8, '#b8b09a'); p.set(4, 10, '#d8d0b8'); p.set(10, 8, '#d8d0b8'); p.set(11, 11, '#d8d0b8'); }),
    ];
  }
  function genWallTop(seed) {
    const R = mulberry32(seed * 313 + 7);
    return texCanvas(p => {
      // Top of a built wall seen from above: two rows of dressed stone blocks.
      p.rect(0, 0, 16, 16, '#4e475c');
      const off = seed % 2 ? 4 : 0;
      for (let row = 0; row < 2; row++) {
        const y = row * 8, sh = row ? off : (off + 6) % 8;
        for (let bx = -8 + sh; bx < 16; bx += 8) {
          const base = shadeHex('#7c7390', ((R() * 9) | 0) - 4);
          p.rect(bx + 1, y + 1, 7, 7, base);
          p.rect(bx + 1, y + 1, 7, 1, shadeHex(base, 16));
          p.rect(bx + 1, y + 1, 1, 7, shadeHex(base, 9));
          p.rect(bx + 1, y + 7, 7, 1, shadeHex(base, -12));
          p.rect(bx + 7, y + 1, 1, 7, shadeHex(base, -8));
          for (let i = 0; i < 3; i++) p.set(bx + 2 + R() * 5, y + 2 + R() * 5, shadeHex(base, R() < 0.5 ? -9 : 8));
        }
      }
    });
  }
  function genWallFront() {
    return texCanvas(p => {
      p.rect(0, 0, 16, 16, '#3a3342');
      for (let row = 0; row < 4; row++) {
        const y = row * 4, off = row % 2 ? 4 : 0;
        for (let bx = -off; bx < 16; bx += 8) {
          p.rect(bx + 1, y + 1, 7, 3, '#6d6378');
          p.rect(bx + 1, y + 1, 7, 1, '#80768b');
          p.rect(bx + 1, y + 3, 7, 1, '#5a5166');
        }
      }
    });
  }
  function genRockTop(seed) {
    const R = mulberry32(seed * 977 + 3);
    return texCanvas(p => {
      // Rough natural rock: lumpy, darker and more purple than dressed walls.
      p.rect(0, 0, 16, 16, '#3d364c');
      for (let i = 0; i < 7; i++) {
        const cx = R() * 16, cy = R() * 16, r = 1.8 + R() * 3.2;
        const base = R() < 0.5 ? '#463e57' : '#373045';
        p.ellipse(cx, cy, r, r * 0.8, base, (nx, ny) => nx + ny < -0.7 ? shadeHex(base, 16) : nx + ny > 0.8 ? shadeHex(base, -12) : null);
      }
      for (let i = 0; i < 12; i++) p.set(R() * 16, R() * 16, R() < 0.5 ? '#2c2638' : '#5a5070');
    });
  }
  function genRockFront(seed) {
    const R = mulberry32(seed * 541 + 9);
    return texCanvas(p => {
      // Jagged cliff face with vertical fissures.
      p.rect(0, 0, 16, 16, '#2a2433');
      for (let x = 0; x < 16; x++) {
        const hgt = 1 + ((R() * 4) | 0);
        for (let y = 0; y < hgt; y++) p.set(x, y, '#3a3346');
        if (R() < 0.3) p.line(x, 2 + R() * 3, x, 8 + R() * 8, '#1c1823');
      }
      for (let i = 0; i < 5; i++) p.set(R() * 16, 3 + R() * 10, '#433b50');
    });
  }
  /**
   * Draw a solid block (player wall or natural rock) at art-pixel coords.
   * `open` bitmask: 1 up, 2 right, 4 down (front face visible), 8 left.
   */
  function drawSolid(g, x, y, kind, deco, open) {
    const rock = kind === 'rock';
    const top = rock ? TEX.rockTop[deco % TEX.rockTop.length] : TEX.wallTop[deco % TEX.wallTop.length];
    const front = rock ? TEX.rockFront[deco % TEX.rockFront.length] : TEX.wallFront[0];
    const fh = open & 4 ? (rock ? 5 : 6) : 0, th = 16 - fh;
    g.drawImage(top, 0, 0, 16, th, x, y, 16, th);
    if (fh) g.drawImage(front, 0, (deco % 2) * 4, 16, fh, x, y + th, 16, fh);
    const hi = rock ? '#6a5f80' : '#b4aac6', lo = rock ? '#1e1928' : '#3a3346', sideLo = rock ? '#1a1622' : '#2c2634';
    g.fillStyle = hi;
    if (open & 1) g.fillRect(x, y, 16, 1);
    if (open & 8) g.fillRect(x, y, 1, th);
    g.fillStyle = lo;
    if (open & 2) g.fillRect(x + 15, y, 1, th);
    if (fh) {
      g.fillStyle = rock ? '#5a5070' : '#a89ebc'; g.fillRect(x, y + th - 1, 16, 1);
      g.fillStyle = sideLo;
      if (open & 8) g.fillRect(x, y + th, 1, fh);
      if (open & 2) g.fillRect(x + 15, y + th, 1, fh);
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x, y + 15, 16, 1);
    }
    if (rock && (open & 1)) { g.fillStyle = '#2c2638'; for (let i = (deco % 5); i < 16; i += 5) g.fillRect(x + i, y, 2, 1); }
  }
  /** Floor tile (variant + decal chosen from tile.deco). */
  function drawFloor(g, x, y, deco) {
    g.drawImage(TEX.floor[deco % TEX.floor.length], x, y);
    const d = (deco >> 4) % 22;
    if (d < TEX.decal.length && !(d === 5 && deco % 3)) g.drawImage(TEX.decal[d], x, y);
  }

  /* ---- 1.7 Glow sprites ------------------------------------------------------ */
  const glows = new Map();
  /** Soft radial glow sprite (64×64) in a colour — for additive light & auras. */
  function glow(color) {
    let c = glows.get(color);
    if (!c) {
      c = mk(64, 64);
      const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, cssA(color, 1)); gr.addColorStop(0.2, cssA(color, 0.7));
      gr.addColorStop(0.5, cssA(color, 0.28)); gr.addColorStop(0.8, cssA(color, 0.07)); gr.addColorStop(1, cssA(color, 0));
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      glows.set(color, c);
    }
    return c;
  }
  let lightPunch = null;
  /** White radial falloff used to cut light pools out of the darkness layer. */
  function punch() {
    if (!lightPunch) {
      lightPunch = mk(64, 64);
      const g = lightPunch.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.9)');
      gr.addColorStop(0.7, 'rgba(255,255,255,0.4)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    }
    return lightPunch;
  }

  /* ---- 1.8 Init & lookup ------------------------------------------------------ */
  function init() {
    if (ready) return;
    ready = true;
    for (const name of Object.keys(DEFS)) buildDef(name, DEFS[name]);
    for (const name of Object.keys(PROCS)) buildProc(name, PROCS[name]);
    for (const id of Object.keys(HERO_BOSS_SKINS)) {
      const sk = HERO_BOSS_SKINS[id], base = DEFS[sk.base];
      buildDef('hb_' + id, { rows: base.rows, legs: base.legs, pal: Object.assign({}, base.pal, sk.pal), patch: sk.patch });
    }
    for (let i = 0; i < 12; i++) TEX.floor.push(genFloor(i + 1));
    TEX.decal = genDecals();
    for (let i = 0; i < 3; i++) TEX.wallTop.push(genWallTop(i + 1));
    TEX.wallFront.push(genWallFront());
    for (let i = 0; i < 4; i++) TEX.rockTop.push(genRockTop(i + 1));
    for (let i = 0; i < 2; i++) TEX.rockFront.push(genRockFront(i + 1));
  }
  /** Sprite record by name (w, h, foot row, frame count) or null. */
  function rec(name) { if (!ready) init(); return recs[name] || null; }
  /** Cached canvas for a sprite record/frame/variant/mirror. */
  function canvasOf(r, frame, variant, flip) {
    const fi = r.frames.length > 1 ? ((frame % r.frames.length) + r.frames.length) % r.frames.length : 0;
    const key = fi * 16 + (variant | 0) * 2 + (flip ? 1 : 0);
    let c = r.cache[key];
    if (!c) c = r.cache[key] = makeCanvas(r, fi, variant | 0, !!flip);
    return c;
  }

  /* ---- 1.9 UI icons (cached PNG data URLs) --------------------------------------- */
  const icons = {};
  const ICON = 72;
  const ICON_PREFIX = { hero: 'h_', monster: 'm_', object: 'o_' };
  /** Draw a sprite centred into an icon canvas at an integer scale (dy nudges it vertically). */
  function iconSprite(g, name, scale, frame = 0, dy = 0) {
    const r = rec(name); if (!r) return;
    const c = canvasOf(r, frame, 0, false);
    const w = r.w * scale, h = r.h * scale;
    g.drawImage(c, Math.round((ICON - w) / 2), Math.round((ICON - h) / 2) + dy, w, h);
  }
  /** Render a UI icon for (kind, id) into a 72×72 canvas. */
  function paintIcon(g, kind, id) {
    g.imageSmoothingEnabled = false;
    const tileAt = (fn) => { g.save(); g.setTransform(4, 0, 0, 4, 4, 4); fn(); g.restore(); };
    if (kind === 'wall' || (kind === 'tile' && id === 'wall')) { tileAt(() => drawSolid(g, 0, 0, 'wall', 1, 15)); return; }
    if (kind === 'tile') {
      tileAt(() => {
        if (id === 'rock') drawSolid(g, 0, 0, 'rock', 1, 15);
        else {
          drawFloor(g, 0, 0, 3);
          if (id === 'rubble') g.drawImage(canvasOf(rec('rubble'), 0, 0, false), 0, 0);
          if (id === 'entrance') { g.fillStyle = 'rgba(200,228,255,0.55)'; g.fillRect(0, 0, 5, 16); g.fillStyle = 'rgba(200,228,255,0.25)'; g.fillRect(5, 0, 5, 16); }
        }
      });
      if (id === 'heart') { // altar + crystal heart, scaled to fill the icon
        g.globalAlpha = 0.5; g.drawImage(glow('#ff1a3c'), 0, 0, ICON, ICON); g.globalAlpha = 1;
        g.drawImage(canvasOf(rec('altar'), 0, 0, false), 8, 44, 56, 32);
        g.drawImage(canvasOf(rec('heart'), 0, 0, false), 12, 4, 48, 48);
      }
      return;
    }
    if (kind === 'trap') {
      tileAt(() => {
        if (id === 'arrow') { drawSolid(g, 0, 0, 'wall', 2, 15); g.drawImage(canvasOf(rec('arrow_emblem'), 0, 0, false), 3, 2); g.fillStyle = '#0a080e'; g.fillRect(6, 12, 4, 2); }
        else {
          drawFloor(g, 0, 0, 5);
          const r = rec('t_' + id);
          if (r) g.drawImage(canvasOf(r, id === 'spike' ? 1 : 0, 0, false), 0, 0);
          if (id === 'teleport') g.drawImage(canvasOf(rec('tele_swirl'), 0, 0, false), 0, 0);
          if (id === 'fire') { g.globalAlpha = 0.9; g.drawImage(canvasOf(rec('flame'), 1, 0, false), 4, 1, 8, 12); g.globalAlpha = 1; }
        }
      });
      return;
    }
    if (kind === 'object' && id === 'torch') { iconSprite(g, 'o_torch', 4); iconSprite(g, 'flame', 4, 1, -18); return; }
    if (kind === 'boss') { iconSprite(g, 'b_' + id, 3); return; }
    if (kind === 'heroBoss') {
      const sk = HERO_BOSS_SKINS[id];
      if (sk) { g.globalAlpha = 0.55; g.drawImage(glow(sk.aura), 0, 0, ICON, ICON); g.globalAlpha = 1; }
      iconSprite(g, 'hb_' + id, 4);
      return;
    }
    const name = ICON_PREFIX[kind] ? ICON_PREFIX[kind] + id : null;
    if (name && rec(name)) iconSprite(g, name, 4);
  }
  /** Cached PNG data URL for a UI icon: kinds wall|trap|monster|boss|object|hero|heroBoss|tile. */
  function iconURL(kind, id) {
    const key = kind + ':' + id;
    if (icons[key] !== undefined) return icons[key];
    init();
    let url = '';
    try {
      const c = mk(ICON, ICON);
      paintIcon(c.getContext('2d'), kind, id);
      url = c.toDataURL('image/png');
    } catch (e) { url = ''; }
    icons[key] = url;
    return url;
  }

  return {
    V, init, rec, canvasOf, glow, punch, iconURL, drawSolid, drawFloor,
    /** Aura colour of a hero boss (drawn behind it and used for its name/cooldown ring). */
    heroBossAura(id) { const sk = HERO_BOSS_SKINS[id]; return sk ? sk.aura : '#ffffff'; },
    /** Names of every sprite (Render resolves its lookup tables from this). */
    names() { init(); return Object.keys(recs); },
  };
})();

/* -----------------------------------------------------------------------------
 * 2. RENDER
 * -------------------------------------------------------------------------- */
const Render = (() => {
  /* ---- 2.1 Constants & state ---------------------------------------------- */
  const RS = 2;                 // backing-store scale (crisp text)
  const ART = 2;                // canvas px per art pixel
  const LPT = 8;                // light-map pixels per tile
  const FOOT = 10;              // feet sit this many px below an entity's centre
  const TAU = Math.PI * 2;
  const DARK = '#07050d';
  const FONT_STACK = 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const V = Sprites.V;
  const DASH = [5, 4], NODASH = [];

  let canvas = null, ctx = null;
  let cols = 0, rows = 0, W = 0, H = 0;
  let time = 0, frameNo = 0, dt = 0;
  let lastPW = -1, lastPH = -1;
  const pad = { l: 0, t: 0, r: 0, b: 0 };

  // Offscreen layers
  let stat = null, sctx = null, statS = null, statVer = -1;
  let lightC = null, lctx = null;
  let dangerC = null, dctx = null, dangerImg = null, dangerS = null, dangerVer = -1;
  let gridC = null, vignette = null;

  // Sprite records resolved once (no string building per frame)
  const R = {}, HERO = {}, HBOSS = {}, MON = {}, BOSS = {};
  const HBOSS_AURA = {};
  const HBOSS_SHORT = {};
  const CRACKS = [];            // Heart crack overlays by stage (1..3)

  // Re-used per-frame scratch
  const drawList = [];
  const heartMarker = { y: 0, dead: false }; // stands in for the Heart in the depth sort
  const fonts = [];
  const LMAX = 700;
  const lx = new Float32Array(LMAX), ly = new Float32Array(LMAX), lr = new Float32Array(LMAX);
  const la = new Float32Array(LMAX), lg = new Float32Array(LMAX), lcol = new Uint8Array(LMAX);
  let ln = 0;
  const LCOL = ['#ffffff', '#ff9a3c', '#ff2a4a', '#9ac4ff', '#ff7a1f', '#3aa0ff', '#b060ff', '#6cff7a', '#6a8aff', '#fff0a0', '#a04aff', '#5ad8ff', '#ffd84a'];
  const L_TORCH = 1, L_HEART = 2, L_DAY = 3, L_FIRE = 4, L_WELL = 5, L_ALARM = 6, L_GREEN = 7, L_BOLT = 8, L_HOLY = 9, L_SHADOW = 10, L_TELE = 11, L_GOLD = 12;

  function mk(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0); return c; }
  const snap = v => Math.round(v * RS) / RS;
  const font = size => fonts[size] || (fonts[size] = `800 ${size}px ${FONT_STACK}`);

  function prepare() {
    for (const n of Sprites.names()) R[n] = Sprites.rec(n);
    for (const id of Object.keys(HERO_CLASSES)) HERO[id] = R['h_' + id];
    for (const id of Object.keys(HERO_BOSSES)) {
      HBOSS[id] = R['hb_' + id];
      HBOSS_AURA[id] = Sprites.heroBossAura(id);
      HBOSS_SHORT[id] = HERO_BOSSES[id].name.split(/,| the /)[0].trim().split(' ').pop(); // 'Aldric', 'Velyra', …
    }
    for (const id of Object.keys(MONSTERS)) MON[id] = R['m_' + id];
    for (const id of Object.keys(BOSSES)) BOSS[id] = R['b_' + id];
    for (let i = 1; i <= 3; i++) CRACKS[i] = R['heart_crack' + i];
  }

  /* ---- 2.2 Canvas sizing & input mapping ------------------------------------ */
  /** Bind the board canvas and build sprite caches. */
  function init(c) {
    canvas = c || null;
    Sprites.init();
    prepare();
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    canvas.style.imageRendering = 'auto';
    window.addEventListener('resize', () => { if (S && cols) fit(); });
    if (S && S.cols) resize();
  }

  /** (Re)allocate the backing store for the current grid size and fit it on screen. */
  function resize() {
    if (!canvas || !S || !S.cols) return;
    if (S.cols !== cols || S.rows !== rows || !stat) {
      cols = S.cols; rows = S.rows; W = cols * TS; H = rows * TS;
      canvas.width = W * RS; canvas.height = H * RS;
      ctx.imageSmoothingEnabled = false;
      stat = mk(W * RS, H * RS); sctx = stat.getContext('2d'); statVer = -1; statS = null;
      lightC = mk(cols * LPT, rows * LPT); lctx = lightC.getContext('2d');
      dangerC = mk(cols, rows); dctx = dangerC.getContext('2d'); dangerImg = dctx.createImageData(cols, rows); dangerVer = -1; dangerS = null;
      gridC = buildGrid();
      vignette = buildVignette();
    }
    fit();
  }

  /** Size taken by the canvas's in-flow siblings (they share the container with the board). */
  function siblingSpace(parent) {
    let w = 0, h = 0, n = 0;
    for (const c of parent.children) {
      if (c === canvas) continue;
      const cs = getComputedStyle(c);
      if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue;
      const r = c.getBoundingClientRect();
      w += r.width + (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0);
      h += r.height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
      n++;
    }
    return { w, h, n };
  }
  /**
   * Fit the canvas (CSS size) into its parent's content box keeping the aspect
   * ratio, preferring integer pixel scales, and centre it (relative offsets, so
   * it works for block, flex and grid parents alike).
   */
  function fit() {
    if (!canvas || !W) return;
    const parent = canvas.parentElement;
    const st = canvas.style;
    // Collapse first so a content-sized parent reports the space it really has.
    st.width = '0px'; st.height = '0px'; st.position = 'relative'; st.left = '0px'; st.top = '0px'; st.display = 'block';
    const useWindow = !parent || parent === document.body || parent === document.documentElement;
    let bl = 0, bt = 0, bw = window.innerWidth, bh = window.innerHeight, shared = false;
    if (!useWindow) {
      const cs = getComputedStyle(parent), pr = parent.getBoundingClientRect();
      const pl = parseFloat(cs.paddingLeft) || 0, pt = parseFloat(cs.paddingTop) || 0;
      bl = pr.left + parent.clientLeft + pl; bt = pr.top + parent.clientTop + pt;
      bw = parent.clientWidth - pl - (parseFloat(cs.paddingRight) || 0);
      bh = parent.clientHeight - pt - (parseFloat(cs.paddingBottom) || 0);
      const sib = siblingSpace(parent);
      if (sib.n) { // share the box with other in-flow children; let the layout place us
        shared = true;
        if (cs.display.indexOf('flex') >= 0 && cs.flexDirection.indexOf('row') === 0) bw -= sib.w; else bh -= sib.h;
      }
      if (!(bw > 60 && bh > 60)) { bw = window.innerWidth; bh = window.innerHeight; shared = true; }
    }
    const own = getComputedStyle(canvas);
    pad.l = (parseFloat(own.paddingLeft) || 0) + (parseFloat(own.borderLeftWidth) || 0);
    pad.r = (parseFloat(own.paddingRight) || 0) + (parseFloat(own.borderRightWidth) || 0);
    pad.t = (parseFloat(own.paddingTop) || 0) + (parseFloat(own.borderTopWidth) || 0);
    pad.b = (parseFloat(own.paddingBottom) || 0) + (parseFloat(own.borderBottomWidth) || 0);
    let s = Math.max(0.1, Math.min((bw - pad.l - pad.r) / W, (bh - pad.t - pad.b) / H));
    // Prefer an integer number of device pixels per art pixel when it costs little space.
    const dpr = window.devicePixelRatio || 1;
    const snapS = Math.floor(s * ART * dpr) / (ART * dpr);
    if (snapS > 0 && snapS >= s * 0.9) s = snapS;
    const cw = Math.max(1, Math.floor(W * s)), ch = Math.max(1, Math.floor(H * s));
    st.width = cw + 'px'; st.height = ch + 'px';
    // Upscaling: keep pixels crisp; downscaling: let the browser filter smoothly.
    st.imageRendering = s * dpr >= RS - 1e-6 ? 'pixelated' : 'auto';
    if (!shared) {
      const cr = canvas.getBoundingClientRect();
      st.left = Math.round(bl + Math.max(0, (bw - cr.width) / 2) - cr.left) + 'px';
      st.top = Math.round(bt + Math.max(0, (bh - cr.height) / 2) - cr.top) + 'px';
    }
    if (useWindow) { lastPW = window.innerWidth; lastPH = window.innerHeight; } else { lastPW = parent.clientWidth; lastPH = parent.clientHeight; }
  }
  /** Cheap periodic check: refit when the container changed size (layout changes, panels). */
  function checkParent() {
    const parent = canvas && canvas.parentElement;
    if (!parent) return;
    const useWindow = parent === document.body || parent === document.documentElement;
    const w = useWindow ? window.innerWidth : parent.clientWidth, h = useWindow ? window.innerHeight : parent.clientHeight;
    if (w !== lastPW || h !== lastPH) fit();
  }

  /** Client (mouse) coordinates → world/tile coordinates. Exact inverse of fit(). */
  function screenToWorld(clientX, clientY) {
    if (!canvas || !S || !cols) return { wx: 0, wy: 0, tx: 0, ty: 0, inside: false };
    const r = canvas.getBoundingClientRect();
    const ow = canvas.offsetWidth || r.width || 1, oh = canvas.offsetHeight || r.height || 1;
    const kx = r.width / ow, ky = r.height / oh; // CSS transforms on the canvas, if any
    const x0 = r.left + pad.l * kx, y0 = r.top + pad.t * ky;
    const cw = (ow - pad.l - pad.r) * kx, ch = (oh - pad.t - pad.b) * ky;
    const fx = cw > 0 ? (clientX - x0) / cw : -1, fy = ch > 0 ? (clientY - y0) / ch : -1;
    const wx = fx * S.cols, wy = fy * S.rows;
    const tx = Math.floor(wx), ty = Math.floor(wy);
    return { wx, wy, tx, ty, inside: fx >= 0 && fx < 1 && fy >= 0 && fy < 1 };
  }

  /* ---- 2.3 Cached layers --------------------------------------------------------- */
  const fullAt = (x, y) => {
    if (x < 0 || y < 0 || x >= S.cols || y >= S.rows) return true;
    const t = S.tiles[y * S.cols + x];
    return t.type === T.ROCK || (t.type === T.WALL && !t.rubble);
  };
  /** Static tile layer: floors, contact shadows, wall/rock blocks, rubble, gate, altar. */
  function buildStatic() {
    statS = S; statVer = S.pathVersion;
    const g = sctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, stat.width, stat.height);
    g.imageSmoothingEnabled = false;
    const k = RS * TS / 16;
    g.setTransform(k, 0, 0, k, 0, 0);
    const tiles = S.tiles;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const t = tiles[y * cols + x];
      if (!fullAt(x, y)) Sprites.drawFloor(g, x * 16, y * 16, t.deco);
    }
    // Contact shadows where floor meets solid blocks (depth cue).
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (fullAt(x, y)) continue;
      const X = x * 16, Y = y * 16;
      if (fullAt(x, y - 1)) {
        g.fillStyle = 'rgba(6,4,10,0.5)'; g.fillRect(X, Y, 16, 1);
        g.fillStyle = 'rgba(6,4,10,0.3)'; g.fillRect(X, Y + 1, 16, 1);
        g.fillStyle = 'rgba(6,4,10,0.14)'; g.fillRect(X, Y + 2, 16, 1);
      }
      if (fullAt(x - 1, y)) { g.fillStyle = 'rgba(6,4,10,0.32)'; g.fillRect(X, Y, 1, 16); g.fillStyle = 'rgba(6,4,10,0.14)'; g.fillRect(X + 1, Y, 1, 16); }
      if (fullAt(x + 1, y)) { g.fillStyle = 'rgba(6,4,10,0.2)'; g.fillRect(X + 15, Y, 1, 16); }
    }
    // Entrance: a fan of cold daylight spilling into the dungeon (under the rock).
    const ex = S.entrance.x, ey = S.entrance.y, EX = ex * 16, EY = ey * 16;
    const gr = g.createLinearGradient(EX, 0, EX + 44, 0);
    gr.addColorStop(0, 'rgba(214,234,255,0.6)'); gr.addColorStop(0.3, 'rgba(176,208,255,0.26)'); gr.addColorStop(1, 'rgba(150,190,255,0)');
    g.fillStyle = gr;
    g.beginPath(); g.moveTo(EX, EY + 2); g.lineTo(EX + 44, EY - 8); g.lineTo(EX + 44, EY + 24); g.lineTo(EX, EY + 14); g.closePath(); g.fill();
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (!fullAt(x, y)) continue;
      const t = tiles[y * cols + x];
      const open = (fullAt(x, y - 1) ? 0 : 1) | (fullAt(x + 1, y) ? 0 : 2) | (fullAt(x, y + 1) ? 0 : 4) | (fullAt(x - 1, y) ? 0 : 8);
      Sprites.drawSolid(g, x * 16, y * 16, t.type === T.ROCK ? 'rock' : 'wall', t.deco, open);
    }
    const rub = R.rubble;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const t = tiles[y * cols + x];
      if (t.type === T.WALL && t.rubble) g.drawImage(Sprites.canvasOf(rub, 0, 0, t.deco % 2 === 1), x * 16, y * 16);
    }
    // Gate: bright opening framed by two cut-stone pillars.
    g.fillStyle = '#eef7ff'; g.fillRect(EX, EY + 2, 3, 12);
    g.fillStyle = 'rgba(226,240,255,0.55)'; g.fillRect(EX + 3, EY + 2, 3, 12);
    const pil = Sprites.canvasOf(R.pillar, 0, 0, false);
    g.drawImage(pil, EX + 4, EY - 12);
    g.drawImage(pil, EX + 4, EY + 14);
    // Heart altar (the crystal itself is animated in the entity pass).
    g.drawImage(Sprites.canvasOf(R.altar, 0, 0, false), S.heart.x * 16 - 6, S.heart.y * 16 + 1);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  /** Subtle build-phase grid (cached per size). */
  function buildGrid() {
    const c = mk(W * RS, H * RS), g = c.getContext('2d');
    g.fillStyle = 'rgba(255,240,220,0.07)';
    for (let x = 1; x < cols; x++) g.fillRect(x * TS * RS, 0, 1, H * RS);
    for (let y = 1; y < rows; y++) g.fillRect(0, y * TS * RS, W * RS, 1);
    return c;
  }
  function buildVignette() {
    const w = cols * LPT, h = rows * LPT;
    const c = mk(w, h), g = c.getContext('2d');
    const gr = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.55);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(4,2,8,0.55)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    return c;
  }
  /** Danger-memory heat layer (one pixel per tile, rebuilt when memory changes). */
  function updateDanger() {
    if (dangerS === S && dangerVer === S.dangerVersion) return;
    dangerS = S; dangerVer = S.dangerVersion;
    const d = dangerImg.data, dz = S.danger;
    for (let i = 0, n = cols * rows; i < n; i++) {
      const v = dz && i < dz.length ? dz[i] : 0;
      const o = i * 4;
      const tt = S.tiles[i].type;
      if (v < 0.15 || tt === T.WALL || tt === T.ROCK) { d[o + 3] = 0; continue; }
      const k = Math.min(1, v / 14);
      d[o] = 255; d[o + 1] = Math.round(170 - 150 * k); d[o + 2] = Math.round(60 - 50 * k);
      d[o + 3] = Math.round(255 * (0.16 + 0.5 * k));
    }
    dctx.putImageData(dangerImg, 0, 0);
  }

  /* ---- 2.4 Entity helpers -------------------------------------------------------- */
  let lungeX = 0, lungeY = 0;
  /** Attack lunge offset (px) toward the entity's target while animT runs. */
  function computeLunge(e) {
    lungeX = 0; lungeY = 0;
    if (!(e.animT > 0) || e.dead) return;
    const k = Math.sin(Math.min(1, e.animT / 0.3) * Math.PI) * 4;
    let dx = e.face < 0 ? -1 : 1, dy = 0;
    const t = e.target;
    if (t && typeof t.x === 'number' && !t.dead && !t.removed) {
      const tx = t.cat ? t.x + 0.5 : t.x, ty = t.cat ? t.y + 0.5 : t.y;
      const ddx = tx - e.x, ddy = ty - e.y, d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d > 0.01) { dx = ddx / d; dy = ddy / d; }
    } else if (e.team === 'hero' && e.state === 'heart' && S.heart) {
      const ddx = S.heart.x + 0.5 - e.x, ddy = S.heart.y + 0.5 - e.y, d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d > 0.01) { dx = ddx / d; dy = ddy / d; }
    }
    lungeX = dx * k; lungeY = dy * k;
  }
  /** Track movement between frames → walk phase; returns true while walking. */
  function trackWalk(e) {
    let moved = 0;
    if (e._rlx === undefined) e._ridle = 1; // first sighting: standing still
    else {
      const dx = e.x - e._rlx, dy = e.y - e._rly;
      moved = Math.sqrt(dx * dx + dy * dy);
      if (moved > 1.5) moved = 0; // teleported
    }
    e._rlx = e.x; e._rly = e.y;
    if (moved > 0.0004) { e._rwalk = (e._rwalk || 0) + moved; e._ridle = 0; }
    else e._ridle = (e._ridle || 0) + dt;
    return e._ridle < 0.12 && !e.dead;
  }
  function drawShadow(px, py, w, a) {
    ctx.globalAlpha = 0.9 * a;
    ctx.drawImage(Sprites.canvasOf(R.shadow, 0, 0, false), px - w / 2, py - w * 0.19, w, w * 0.38);
  }
  /** Draw a sprite record bottom-centred at (px, footY). */
  function drawSprite(r, frame, variant, flip, px, footY, scale) {
    const c = Sprites.canvasOf(r, frame, variant, flip);
    const w = r.w * scale, h = r.h * scale;
    const x = snap(px - w / 2), y = snap(footY - r.foot * scale);
    ctx.drawImage(c, x, y, w, h);
    return y;
  }
  /** Dying bodies tip over and fade: draw rotated around the feet. */
  function drawFalling(r, frame, variant, flip, px, footY, scale, t, face) {
    const c = Sprites.canvasOf(r, frame, variant, flip);
    const w = r.w * scale, h = r.h * scale;
    const ang = Math.min(1, t / 0.22) * (Math.PI / 2) * (face < 0 ? -1 : 1);
    ctx.save();
    ctx.translate(px, footY);
    ctx.rotate(ang);
    ctx.drawImage(c, -w / 2, -r.foot * scale, w, h);
    ctx.restore();
  }

  /* ---- 2.5 Heroes, monsters, the Heart -------------------------------------------- */
  function drawHero(h) {
    let alpha = 1;
    if (h.dead) { alpha = 1 - (h.deadT || 0) / 0.7; if (alpha <= 0) { h._rvis = false; return; } }
    const st = h.st || null;
    if (st && st.invisT > 0) alpha *= 0.35;
    const boss = h.boss && HBOSS[h.boss] ? h.boss : null;
    const r = boss ? HBOSS[boss] : (HERO[h.type] || HERO.warrior);
    const scale = boss ? 3 : 2;
    const walking = trackWalk(h);
    computeLunge(h);
    const fi = walking ? Math.floor(h._rwalk * 6) & 3 : 0;
    const bob = walking ? (fi & 1 ? 1 : 0) : (Math.sin(time * 2.4 + h.bob) > 0.7 ? 0.5 : 0);
    const px = h.x * TS + lungeX, py = h.y * TS + lungeY + FOOT + (boss ? 2 : 0);
    const flip = h.face < 0;
    let variant = h.flashT > 0 ? V.WHITE : h.elite ? V.ELITE : h.risen ? V.RISEN : V.NORMAL;
    if (!h.dead) drawShadow(px, py, boss ? 34 : 22, alpha);
    if (boss && !h.dead) {
      const pulse = 0.5 + 0.2 * Math.sin(time * 3 + h.bob);
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = pulse * alpha;
      ctx.drawImage(Sprites.glow(HBOSS_AURA[boss]), px - 36, py - 58, 72, 72);
      ctx.globalCompositeOperation = 'source-over';
    } else if (h.elite && !h.dead) {
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = (0.32 + 0.1 * Math.sin(time * 4 + h.bob)) * alpha;
      ctx.drawImage(Sprites.glow('#ffc83a'), px - 22, py - 36, 44, 44);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = alpha;
    if (h.dead) {
      drawFalling(r, 0, V.NORMAL, flip, px, py, scale, h.deadT || 0, h.face);
      h._rvis = false;
    } else {
      const top = drawSprite(r, fi, variant, flip, px, py - bob * ART, scale);
      if (st && st.rootT > 0) { ctx.globalAlpha = 0.85 * alpha; ctx.drawImage(Sprites.canvasOf(R.i_root, 0, 0, false), snap(px - 8), snap(py - 9), 16, 16); }
      h._rvis = true; h._rpx = px; h._rpy = py; h._rtop = top;
      h._rrec = r; h._rfr = fi; h._rflip = flip; h._rsc = scale; h._rfoot = py - bob * ART;
    }
    ctx.globalAlpha = 1;
  }

  const FLYERS = { imp: 1, wraith: 1, lich: 1 };
  function drawMonster(m) {
    const r0 = m.isBoss ? BOSS[m.type] : MON[m.type];
    const r = r0 || MON.goblin;
    m._rvis = false;
    // Mimic in disguise looks EXACTLY like a closed treasure chest.
    if (m.disguised && !m.dead) {
      const x = snap((m.x - 0.5) * TS), y = snap((m.y - 0.5) * TS);
      ctx.drawImage(Sprites.canvasOf(R.o_chest, 0, 0, false), x, y, 32, 32);
      chestGlint(x, y, m.uid);
      m._rlx = m.x; m._rly = m.y;
      return;
    }
    // Skeleton reassembling at its post.
    if ((m.state === 'respawn' || m.respawnT > 0) && (!m.dead || (m.deadT || 0) > 0.35)) {
      const soon = m.respawnT > 0 && m.respawnT < 1.2;
      const jx = soon ? Math.sin(time * 40 + m.uid) * 1.2 : 0;
      const hx = m.post ? m.post.x + 0.5 : (m.homeX ?? m.x), hy = m.post ? m.post.y + 0.5 : (m.homeY ?? m.y);
      ctx.globalAlpha = 1;
      ctx.drawImage(Sprites.canvasOf(R.bones, 0, 0, false), snap(hx * TS - 16 + jx), snap(hy * TS - 18), 32, 32);
      return;
    }
    let alpha = 1;
    if (m.dead) {
      alpha = 1 - (m.deadT || 0) / 0.7;
      if (alpha <= 0) {
        if (!m.temp && m.post) { ctx.globalAlpha = 0.85; ctx.drawImage(Sprites.canvasOf(R.remains, 0, 0, false), m.post.x * TS, m.post.y * TS, 32, 32); ctx.globalAlpha = 1; }
        return;
      }
    }
    const flyer = FLYERS[m.type] === 1;
    const walking = trackWalk(m);
    computeLunge(m);
    let fi = 0, bob = 0;
    const nf = r.frames.length;
    if (flyer) {
      bob = Math.sin(time * 3.2 + m.bob) * 2 + 3;
      fi = m.type === 'imp' ? Math.floor(time * 9 + m.bob) & 1 : Math.floor(time * (m.type === 'lich' ? 6 : 3) + m.bob) & 1;
    } else if (m.type === 'dragon') { fi = Math.floor(time * 2.2 + m.bob) & 1; bob = fi ? 1 : 0; }
    else if (m.type === 'mimic') fi = (m.animT > 0 || m.state === 'attack' || m.state === 'ambush') ? Math.floor(time * 6) & 1 : 1;
    else if (walking) { fi = nf === 4 ? Math.floor(m._rwalk * 6) & 3 : Math.floor(m._rwalk * 8) & 1; bob = nf === 4 && (fi & 1) ? ART : 0; }
    else bob = Math.sin(time * 2 + m.bob) > 0.75 ? 1 : 0;
    const scale = 2;
    const px = m.x * TS + lungeX, py = m.y * TS + lungeY + FOOT + (m.isBoss ? 4 : 0);
    const flip = m.face < 0;
    const variant = m.flashT > 0 ? V.WHITE : m.risen ? V.RISEN : V.NORMAL;
    if (!m.dead) drawShadow(px, py, m.isBoss ? 40 : (m.type === 'orc' ? 26 : 22), 1);
    const st = m.st;
    if (!m.dead && st && st.buffT > 0) {
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.45 + 0.15 * Math.sin(time * 10 + m.uid);
      ctx.drawImage(Sprites.glow('#ff3a1a'), px - 22, py - 38, 44, 44);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (m.risen && !m.dead) {
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.35;
      ctx.drawImage(Sprites.glow('#9a4aff'), px - 18, py - 34, 36, 36);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = alpha * (m.type === 'wraith' ? 0.8 : 1);
    if (m.dead) drawFalling(r, 0, V.NORMAL, flip, px, py, scale, m.deadT || 0, m.face);
    else {
      const top = drawSprite(r, fi, variant, flip, px, py - bob, scale);
      if (m.type === 'wraith') { // ghostly glow over the translucent body
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.18;
        ctx.drawImage(Sprites.glow('#9adfff'), px - 18, top - 2, 36, 36);
        ctx.globalCompositeOperation = 'source-over';
      }
      if (m.state === 'breath' || m.state === 'cast' || m.state === 'charge') {
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.55 + 0.25 * Math.sin(time * 20);
        const col = m.state === 'breath' ? '#ff7a1f' : m.state === 'cast' ? '#6cff7a' : '#ffd0a0';
        const gx = m.state === 'breath' ? px + (flip ? -18 : 18) : px;
        ctx.drawImage(Sprites.glow(col), gx - 20, top + 4, 40, 40);
        ctx.globalCompositeOperation = 'source-over';
      }
      if (st && st.rootT > 0) { ctx.globalAlpha = 0.85; ctx.drawImage(Sprites.canvasOf(R.i_root, 0, 0, false), snap(px - 8), snap(py - 9), 16, 16); }
      m._rvis = true; m._rpx = px; m._rpy = py; m._rtop = top;
      m._rrec = r; m._rfr = fi; m._rflip = flip; m._rsc = scale; m._rfoot = py - bob;
    }
    ctx.globalAlpha = 1;
  }

  function chestGlint(x, y, seed) {
    const t = (time * 0.6 + (seed % 97) * 0.173) % 3;
    if (t > 0.35) return;
    const k = Math.sin(t / 0.35 * Math.PI);
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = k;
    ctx.fillStyle = '#fff6c0';
    const gx = x + 22, gy = y + 11;
    ctx.fillRect(gx - 3 * k, gy - 0.5, 6 * k + 1, 1); ctx.fillRect(gx, gy - 3 * k - 0.5, 1, 6 * k + 1);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }

  let heartBeat = 0;
  const heartRect = { x: 0, y: 0, w: 0, h: 0, on: false };
  function drawHeart() {
    heartRect.on = false;
    const cx = (S.heart.x + 0.5) * TS, cy = (S.heart.y + 0.5) * TS;
    const max = Math.max(1, S.heartMax), ratio = Math.max(0, S.heartHp) / max;
    if (S.heartHp <= 0 && (S.phase === 'gameover' || S.endingT >= 0)) {
      ctx.globalAlpha = 1;
      ctx.drawImage(Sprites.canvasOf(R.heart_shards, 0, 0, false), snap(cx - 24), snap(cy - 34), 48, 48);
      heartBeat = 0;
      return;
    }
    const period = 1.25 - 0.55 * (1 - ratio);
    const ph = (time % period) / period;
    heartBeat = ph < 0.14 ? Math.sin(ph / 0.14 * Math.PI) : (ph > 0.2 && ph < 0.3 ? 0.5 * Math.sin((ph - 0.2) / 0.1 * Math.PI) : 0);
    const hover = Math.sin(time * 1.7) * 1.5;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.45 + 0.35 * heartBeat + (S.heartHitT > 0 ? 0.4 : 0);
    const gs = 70 + heartBeat * 12;
    ctx.drawImage(Sprites.glow('#ff1a3c'), cx - gs / 2, cy - 14 - gs / 2 - hover, gs, gs);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const sc = 1 + 0.06 * heartBeat;
    const w = 48 * sc, h = 48 * sc;
    const x = snap(cx - w / 2), y = snap(cy - 6 - hover - h + 8 * sc);
    const variant = S.heartHitT > 0 ? V.WHITE : V.NORMAL;
    ctx.drawImage(Sprites.canvasOf(R.heart, 0, variant, false), x, y, w, h);
    heartRect.x = x; heartRect.y = y; heartRect.w = w; heartRect.h = h; heartRect.on = true;
    const stage = ratio < 0.25 ? 3 : ratio < 0.5 ? 2 : ratio < 0.75 ? 1 : 0;
    if (stage && variant === V.NORMAL) ctx.drawImage(Sprites.canvasOf(CRACKS[stage], 0, 0, false), x, y, w, h);
    // Rune ring on the altar glows with the beat.
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.25 + 0.3 * heartBeat;
    ctx.drawImage(Sprites.glow('#ff2a4a'), cx - 30, cy - 4, 60, 22);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }

  const sortKey = e => (e.dead ? e.y - 0.6 : e.y);
  /** In-place insertion sort by depth (stable, allocation-free; n is at most a few hundred). */
  function sortByDepth(arr) {
    for (let i = 1; i < arr.length; i++) {
      const e = arr[i], k = sortKey(e);
      let j = i - 1;
      while (j >= 0 && sortKey(arr[j]) > k) { arr[j + 1] = arr[j]; j--; }
      arr[j + 1] = e;
    }
  }
  function drawEntities() {
    drawList.length = 0;
    const hs = S.heroes, ms = S.monsters;
    for (let i = 0; i < hs.length; i++) { const h = hs[i]; if (!h.removed && !h.escaped) drawList.push(h); else h._rvis = false; }
    for (let i = 0; i < ms.length; i++) { const m = ms[i]; if (!m.removed) drawList.push(m); else m._rvis = false; }
    heartMarker.y = S.heart.y + 0.8;
    drawList.push(heartMarker);
    sortByDepth(drawList);
    for (let i = 0; i < drawList.length; i++) {
      const e = drawList[i];
      if (e === heartMarker) drawHeart();
      else if (e.team === 'hero') drawHero(e);
      else drawMonster(e);
    }
    ctx.globalAlpha = 1;
  }

  function drawCorpses() {
    const cs = S.corpses;
    if (!cs || !cs.length) return;
    const rm = Sprites.canvasOf(R.remains, 0, 0, false);
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i], r = HERO[c.type];
      const a = Math.max(0, Math.min(1, c.t / 2.5));
      if (a <= 0) continue;
      const x = c.x * TS, y = c.y * TS;
      ctx.globalAlpha = a * 0.9;
      ctx.drawImage(rm, snap(x - 16), snap(y - 12), 32, 32);
      if (r) {
        const cv = Sprites.canvasOf(r, 0, V.CORPSE, (c.uid & 1) === 1);
        ctx.drawImage(cv, snap(x - cv.width), snap(y - cv.height + 8), cv.width * 2, cv.height * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ---- 2.6 Structures (traps & objects) ------------------------------------------- */
  const DIR_OPEN = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  function tileOpen(x, y) { return Grid.inb(x, y) && !Grid.isSolid(x, y); }

  /** Arrow Wall: iron emblem on the wall plus a slit on each face that opens onto floor. */
  function drawArrowTrap(s, x, y, variant) {
    ctx.drawImage(Sprites.canvasOf(R.arrow_emblem, 0, variant, false), x + 6, y + 4, 20, 20);
    ctx.fillStyle = '#07050a';
    for (let d = 0; d < 4; d++) {
      const dx = DIR_OPEN[d][0], dy = DIR_OPEN[d][1];
      if (!tileOpen(s.x + dx, s.y + dy)) continue;
      if (dy === 1) ctx.fillRect(x + 12, y + 24, 8, 4);
      else if (dy === -1) ctx.fillRect(x + 12, y, 8, 3);
      else if (dx === 1) ctx.fillRect(x + 29, y + 8, 3, 8);
      else ctx.fillRect(x, y + 8, 3, 8);
    }
    if (s.animT > 0 && variant === V.NORMAL) {
      const dir = s.data && s.data.lastDir;
      const dx = dir ? dir[0] : 0, dy = dir ? dir[1] : 1;
      const k = Math.min(1, s.animT / 0.3);
      const fx = x + 16 + dx * 17, fy = y + 16 + dy * 17;
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = k;
      ctx.drawImage(Sprites.glow('#ffd070'), fx - 14, fy - 14, 28, 28);
      ctx.fillStyle = '#fff4c0'; ctx.fillRect(fx - 2 + dx * 3, fy - 2 + dy * 3, 4, 4);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    }
  }

  function drawTrap(s, x, y) {
    const hidden = s.hidden && !s.revealed;
    const grey = s.disarmed || (s.broken && s.id !== 'pit');
    const variant = grey ? V.GREY : V.NORMAL;
    const base = hidden ? 0.55 : 1;
    const d = s.data || {};
    ctx.globalAlpha = base;
    switch (s.id) {
      case 'spike':
        ctx.drawImage(Sprites.canvasOf(R.t_spike, s.animT > 0 && !grey ? 1 : 0, variant, false), x, y, 32, 32);
        break;
      case 'arrow':
        drawArrowTrap(s, x, y, variant);
        break;
      case 'pit': {
        const open = s.broken || d.rearmT > 0 || s.animT > 0;
        ctx.drawImage(Sprites.canvasOf(open ? R.t_pit_open : R.t_pit, 0, s.disarmed ? V.GREY : V.NORMAL, false), x, y, 32, 32);
        if (d.rearmT > 0) { // trapdoor planks sliding back into place
          const k = 1 - Math.min(1, d.rearmT / 8);
          ctx.globalAlpha = base * 0.9; ctx.fillStyle = '#5c4632';
          ctx.fillRect(x + 6, y + 6, 20 * k, 20); ctx.fillStyle = '#3e2e20';
          for (let i = 0; i < 3; i++) ctx.fillRect(x + 6, y + 10 + i * 6, 20 * k, 1);
        }
        break;
      }
      case 'slime': {
        ctx.drawImage(Sprites.canvasOf(R.t_slime, 0, variant, false), x, y, 32, 32);
        if (!grey) { // bubbles rising and popping
          ctx.fillStyle = '#b8ff90';
          for (let i = 0; i < 3; i++) {
            const t = (time * 0.8 + i * 0.37 + (s.uid % 7) * 0.11) % 1;
            const bx = x + 9 + ((i * 7 + s.uid * 3) % 14), by = y + 18 - ((i * 5) % 8);
            const r = t < 0.8 ? 1 + t * 1.6 : 0;
            if (r > 0) { ctx.globalAlpha = base * (0.8 - t * 0.6); ctx.fillRect(bx - r / 2, by - r / 2 - t * 2, r, r); }
          }
        }
        break;
      }
      case 'fire': {
        ctx.drawImage(Sprites.canvasOf(R.t_fire, 0, variant, false), x, y, 32, 32);
        if (!grey && !s.broken) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = base * (0.28 + 0.14 * Math.sin(time * 5 + s.uid) + (d.flameT > 0 ? 0.4 : 0));
          ctx.drawImage(Sprites.glow('#ff6a1a'), x + 2, y + 2, 28, 28);
          ctx.globalCompositeOperation = 'source-over';
        }
        break;
      }
      case 'alarm': {
        const ring = d.ringT > 0;
        const pulse = 0.55 + 0.25 * Math.sin(time * 2.5 + s.uid);
        ctx.globalAlpha = base * (grey ? 0.5 : ring ? 1 : pulse);
        ctx.drawImage(Sprites.canvasOf(R.t_alarm, 0, variant, false), x, y, 32, 32);
        if (!grey) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = base * (ring ? 0.7 + 0.3 * Math.sin(time * 24) : 0.18 * pulse);
          ctx.drawImage(Sprites.glow('#b060ff'), x - 4, y - 4, 40, 40);
          ctx.globalCompositeOperation = 'source-over';
          if (ring) {
            ctx.strokeStyle = '#d0a0ff'; ctx.lineWidth = 2;
            for (let i = 0; i < 2; i++) {
              const t = (time * 1.6 + i * 0.5) % 1;
              ctx.globalAlpha = (1 - t) * 0.8; ctx.beginPath(); ctx.arc(x + 16, y + 16, 6 + t * 26, 0, TAU); ctx.stroke();
            }
          }
        }
        break;
      }
      case 'boulder':
        if ((S.phase !== 'wave' || d.ready) && !grey && !d.rolling) ctx.drawImage(Sprites.canvasOf(R.t_boulder, 0, 0, false), x, y - 2, 32, 32);
        else ctx.drawImage(Sprites.canvasOf(R.t_boulder_empty, 0, 0, false), x, y, 32, 32);
        break;
      case 'teleport': {
        ctx.drawImage(Sprites.canvasOf(R.t_teleport, 0, variant, false), x, y, 32, 32);
        if (!grey) {
          ctx.globalAlpha = base * 0.9;
          ctx.drawImage(Sprites.canvasOf(R.tele_swirl, Math.floor(time * 8 + s.uid) & 3, 0, false), x, y, 32, 32);
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = base * (0.25 + 0.1 * Math.sin(time * 4) + (s.animT > 0 ? 0.7 : 0));
          ctx.drawImage(Sprites.glow('#4ab8ff'), x - 2, y - 2, 36, 36);
          ctx.globalCompositeOperation = 'source-over';
        }
        break;
      }
      default: {
        const r = R['t_' + s.id];
        if (r) ctx.drawImage(Sprites.canvasOf(r, 0, variant, false), x, y, 32, 32);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawObject(s, x, y) {
    const d = s.data || {};
    switch (s.id) {
      case 'chest':
        if (d.empty) ctx.drawImage(Sprites.canvasOf(R.o_chest_open, 0, 0, false), x, y, 32, 32);
        else { ctx.drawImage(Sprites.canvasOf(R.o_chest, 0, 0, false), x, y, 32, 32); chestGlint(x, y, s.uid); }
        break;
      case 'torch': {
        ctx.drawImage(Sprites.canvasOf(R.o_torch, 0, s.broken ? V.GREY : V.NORMAL, false), x, y, 32, 32);
        if (!s.broken) {
          const f = Math.floor(time * 10 + s.uid) % 3;
          ctx.drawImage(Sprites.canvasOf(R.flame, f, 0, false), x + 8, y - 8, 16, 24);
        }
        break;
      }
      case 'barricade': {
        let r = R.o_barricade;
        if (s.broken) r = R.o_barricade_broken;
        else if (s.maxHp) { const k = s.hp / s.maxHp; r = k > 0.66 ? R.o_barricade : k > 0.33 ? R.o_barricade2 : R.o_barricade3; }
        const jx = s.animT > 0 && !s.broken ? Math.sin(time * 70) * 1.5 : 0;
        ctx.drawImage(Sprites.canvasOf(r, 0, 0, false), snap(x + jx), y, 32, 32);
        break;
      }
      case 'well':
        ctx.drawImage(Sprites.canvasOf(R.o_well, Math.floor(time * 2.5 + s.uid) & 1, s.broken ? V.GREY : V.NORMAL, false), x, y, 32, 32);
        break;
      case 'lair': {
        ctx.drawImage(Sprites.canvasOf(R.o_lair, 0, s.broken ? V.GREY : V.NORMAL, false), x, y, 32, 32);
        if (S.phase === 'wave' && !s.broken) { // eyes blinking in the burrow; brighter just before a spawn
          const soon = d.spawnT > 0 && d.spawnT < 1.5;
          const blink = Math.sin(time * 1.3 + s.uid) > -0.85;
          if (blink || soon) {
            ctx.fillStyle = soon ? '#ffe040' : '#ff5030';
            ctx.globalAlpha = soon ? 0.7 + 0.3 * Math.sin(time * 18) : 0.8;
            ctx.fillRect(x + 12, y + 15, 2, 2); ctx.fillRect(x + 18, y + 15, 2, 2);
            ctx.globalAlpha = 1;
          }
        }
        break;
      }
      default: {
        const r = R['o_' + s.id];
        if (r) ctx.drawImage(Sprites.canvasOf(r, 0, 0, false), x, y, 32, 32);
      }
    }
  }

  function drawStructs() {
    const ss = S.structs;
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i];
      const x = s.x * TS, y = s.y * TS;
      if (s.cat === 'trap') drawTrap(s, x, y);
      else if (s.cat === 'object') drawObject(s, x, y);
    }
    ctx.globalAlpha = 1;
  }

  /** Fire Vent flame columns (drawn over entities standing in them). */
  function drawFlames() {
    const ss = S.structs;
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i];
      if (s.cat !== 'trap' || s.id !== 'fire' || !s.data || !(s.data.flameT > 0)) continue;
      const k = Math.min(1, s.data.flameT / 0.25);
      const x = s.x * TS, y = s.y * TS;
      const f = Math.floor(time * 14 + s.uid) % 3;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.6 * k;
      ctx.drawImage(Sprites.glow('#ff6a1a'), x - 24, y - 40, 80, 80);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.95 * k;
      ctx.drawImage(Sprites.canvasOf(R.flamecol, f, 0, false), x + 4, y + 30 - 56 * k, 24, 56 * k);
      for (let d = 0; d < 4; d++) {
        const nx = s.x + DIR_OPEN[d][0], ny = s.y + DIR_OPEN[d][1];
        if (!tileOpen(nx, ny)) continue;
        ctx.globalAlpha = 0.75 * k;
        ctx.drawImage(Sprites.canvasOf(R.flame, (f + d) % 3, 0, (d & 1) === 1), nx * TS + 8, ny * TS + 4, 16, 24);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ---- 2.7 Projectiles -------------------------------------------------------------- */
  const PROJ_COL = { bolt: '#6a9aff', fire: '#ff7a1f', shadow: '#a04aff', holy: '#fff0a0', magic: '#8af0ff', web: '#e8e8f0' };
  function drawProjectiles() {
    const ps = S.projectiles;
    if (!ps || !ps.length) return;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.dead) continue;
      const x = p.x * TS, y = p.y * TS;
      const dx = p.dx || 0, dy = p.dy || 0;
      switch (p.kind) {
        case 'arrow': {
          ctx.globalAlpha = 0.35; ctx.strokeStyle = '#fff6d8'; ctx.lineWidth = 1; // motion streak
          ctx.beginPath(); ctx.moveTo(x - dx * 18, y - dy * 18); ctx.lineTo(x - dx * 9, y - dy * 9); ctx.stroke();
          ctx.globalAlpha = 1; ctx.strokeStyle = '#1a1014'; ctx.lineWidth = 3.5;
          ctx.beginPath(); ctx.moveTo(x - dx * 10, y - dy * 10); ctx.lineTo(x + dx * 4, y + dy * 4); ctx.stroke();
          ctx.strokeStyle = '#e0cc9a'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(x - dx * 10, y - dy * 10); ctx.lineTo(x + dx * 3, y + dy * 3); ctx.stroke();
          ctx.fillStyle = '#f4f7fc'; ctx.fillRect(x + dx * 4 - 2, y + dy * 4 - 2, 4, 4);
          ctx.fillStyle = '#ff5a4a'; ctx.fillRect(x - dx * 10 - 1.5, y - dy * 10 - 1.5, 3, 3);
          break;
        }
        case 'boulder': {
          const rad = (p.radius || 0.45) * TS;
          ctx.globalAlpha = 0.5; ctx.drawImage(Sprites.canvasOf(R.shadow, 0, 0, false), x - rad, y + rad * 0.55, rad * 2, rad * 0.6);
          ctx.globalAlpha = 1;
          ctx.save(); ctx.translate(snap(x), snap(y)); ctx.rotate((p.travelled || 0) * 2.2 * (dx + dy >= 0 ? 1 : -1));
          ctx.drawImage(Sprites.canvasOf(R.t_boulder, 0, 0, false), -rad * 1.15, -rad * 1.15, rad * 2.3, rad * 2.3);
          ctx.restore();
          break;
        }
        case 'web': {
          ctx.globalAlpha = 0.9;
          ctx.drawImage(Sprites.canvasOf(R.i_root, 0, 0, false), snap(x - 6), snap(y - 6), 12, 12);
          break;
        }
        default: {
          const col = PROJ_COL[p.kind] || '#ffffff';
          ctx.globalCompositeOperation = 'lighter';
          for (let k = 3; k >= 1; k--) { // short fading trail
            ctx.globalAlpha = 0.18 * (4 - k);
            ctx.drawImage(Sprites.glow(col), x - dx * k * 4 - 7, y - dy * k * 4 - 7, 14, 14);
          }
          ctx.globalAlpha = 0.95;
          ctx.drawImage(Sprites.glow(col), x - 12, y - 12, 24, 24);
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1; ctx.fillStyle = '#ffffff';
          ctx.fillRect(snap(x - 1.5), snap(y - 1.5), 3, 3);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ---- 2.8 Lighting ---------------------------------------------------------------- */
  function addLight(x, y, r, a, col, glowA) {
    if (ln >= LMAX) return;
    lx[ln] = x; ly[ln] = y; lr[ln] = r; la[ln] = a; lcol[ln] = col; lg[ln] = glowA; ln++;
  }
  function collectLights() {
    ln = 0;
    addLight(S.entrance.x + 0.7, S.entrance.y + 0.5, 3.6, 0.95, L_DAY, 0.2);
    if (S.heartHp > 0 || (S.phase !== 'gameover' && S.endingT < 0)) addLight(S.heart.x + 0.5, S.heart.y + 0.2, 3.1 + heartBeat * 0.4, 1, L_HEART, 0.3 + 0.25 * heartBeat);
    const ss = S.structs;
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i], d = s.data || {};
      const cx = s.x + 0.5, cy = s.y + 0.5;
      if (s.cat === 'object') {
        if (s.id === 'torch' && !s.broken) {
          const fl = 1 + 0.05 * Math.sin(time * 13 + s.uid) + 0.04 * Math.sin(time * 7.3 + s.uid * 1.7);
          addLight(cx, cy - 0.2, CFG.torchRadius * fl + 0.3, 1, L_TORCH, 0.3 * fl);
        } else if (s.id === 'well' && !s.broken) addLight(cx, cy, 1.9, 0.8, L_WELL, 0.26);
        else if (s.id === 'chest' && !d.empty) addLight(cx, cy, 0.8, 0.25, L_GOLD, 0.06);
      } else if (s.cat === 'trap' && !s.broken && !s.disarmed) {
        if (s.id === 'fire') {
          if (d.flameT > 0) addLight(cx, cy - 0.4, 3, 1, L_FIRE, 0.5);
          else addLight(cx, cy, 0.8, s.hidden && !s.revealed ? 0.2 : 0.35, L_FIRE, 0.08);
        } else if (s.id === 'alarm' && d.ringT > 0) addLight(cx, cy, 2.4, 0.9, L_ALARM, 0.4);
        else if (s.id === 'teleport') addLight(cx, cy, s.animT > 0 ? 2.2 : 1.0, 0.6, L_TELE, s.animT > 0 ? 0.5 : 0.12);
      }
    }
    const hs = S.heroes;
    for (let i = 0; i < hs.length; i++) {
      const h = hs[i];
      if (h.dead || h.removed || h.escaped) continue;
      if (h.boss) addLight(h.x, h.y - 0.3, 2.2, 0.8, 0, 0);
      else addLight(h.x, h.y - 0.2, 1.4, 0.62, 0, 0);
      if (h.st && h.st.burnT > 0) addLight(h.x, h.y - 0.2, 1.1, 0.4, L_FIRE, 0.22);
    }
    const ms = S.monsters;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (m.dead || m.removed) continue;
      if (m.disguised) { addLight(m.x, m.y, 0.8, 0.25, L_GOLD, 0.06); continue; } // same faint glint as a real chest
      if (m.type === 'lich') addLight(m.x, m.y - 0.9, 1.8, 0.6, L_GREEN, 0.28);
      else if (m.type === 'dragon') addLight(m.x, m.y - 0.3, 1.6, 0.5, L_FIRE, m.state === 'breath' ? 0.5 : 0.15);
      else if (m.type === 'imp') addLight(m.x, m.y - 0.4, 1.0, 0.4, L_FIRE, 0.12);
      else if (m.type === 'wraith') addLight(m.x, m.y - 0.4, 1.1, 0.35, L_TELE, 0.1);
      if (m.risen) addLight(m.x, m.y - 0.3, 0.9, 0.3, L_SHADOW, 0.12);
    }
    const ps = S.projectiles;
    if (ps) for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.dead) continue;
      switch (p.kind) {
        case 'fire': addLight(p.x, p.y, 1.5, 0.8, L_FIRE, 0.45); break;
        case 'bolt': addLight(p.x, p.y, 1.1, 0.6, L_BOLT, 0.35); break;
        case 'shadow': addLight(p.x, p.y, 1.1, 0.5, L_SHADOW, 0.35); break;
        case 'holy': addLight(p.x, p.y, 1.2, 0.7, L_HOLY, 0.4); break;
        case 'magic': addLight(p.x, p.y, 0.9, 0.5, L_TELE, 0.3); break;
      }
    }
    const bs = FX.beams;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (!b.jag) continue;
      const k = b.life / b.max;
      addLight((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, 3.5, k, L_HOLY, 0.5 * k);
    }
  }
  function darknessFor(phase) {
    switch (phase) {
      case 'build': return 0.4;
      case 'wave': return 0.56;
      case 'title': return 0.5;
      case 'gameover': return 0.62;
      default: return 0.5;
    }
  }
  /** Darkness layer with light pools cut out, then additive coloured glows. */
  function drawLighting() {
    collectLights();
    const lc = lctx, lw = lightC.width, lh = lightC.height;
    lc.globalCompositeOperation = 'source-over';
    lc.globalAlpha = 1;
    lc.clearRect(0, 0, lw, lh);
    lc.fillStyle = DARK; lc.globalAlpha = darknessFor(S.phase);
    lc.fillRect(0, 0, lw, lh);
    lc.globalCompositeOperation = 'destination-out';
    const pn = Sprites.punch();
    for (let i = 0; i < ln; i++) {
      const r = lr[i] * LPT;
      lc.globalAlpha = la[i];
      lc.drawImage(pn, lx[i] * LPT - r, ly[i] * LPT - r, r * 2, r * 2);
    }
    lc.globalCompositeOperation = 'source-over'; lc.globalAlpha = 1;
    lc.drawImage(vignette, 0, 0, lw, lh); // vignette baked into the (low-res) light map: one full-screen pass
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(lightC, 0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < ln; i++) {
      if (!lcol[i] || lg[i] <= 0) continue;
      const r = lr[i] * TS * 0.85;
      ctx.globalAlpha = lg[i];
      ctx.drawImage(Sprites.glow(LCOL[lcol[i]]), lx[i] * TS - r, ly[i] * TS - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
    // Dust motes drifting in the entrance daylight.
    const ex = (S.entrance.x + 0.2) * TS, ey = (S.entrance.y + 0.5) * TS;
    ctx.fillStyle = '#e8f2ff';
    for (let i = 0; i < 7; i++) {
      const t = (time * 0.12 + i * 0.143) % 1;
      ctx.globalAlpha = Math.sin(t * Math.PI) * 0.55;
      ctx.fillRect(ex + t * 58 + Math.sin(time + i) * 4, ey + Math.sin(i * 2.3 + time * 0.7) * 12, 1, 1);
    }
    ctx.globalAlpha = 1;
  }

  /* ---- 2.9 Readability overlays: bars, statuses, badges (drawn after lighting) ------ */
  const CH_COL = { loot: '#ffd84a', disarm: '#7ae8ff', blast: '#d08aff', dig: '#d8a070' };
  const CH_ICON = { loot: 'i_coin', disarm: 'i_wrench', blast: 'i_blast', dig: 'i_pick' };
  const icoBuf = [];
  let icoN = 0;
  const hpColor = k => (k > 0.6 ? '#5ee06a' : k > 0.3 ? '#ffd24a' : '#ff4a3a');
  function bar(x, y, w, h, k, col) {
    k = k > 1 ? 1 : k < 0 ? 0 : k;
    ctx.fillStyle = '#0b060d'; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = '#3a2430'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = col; ctx.fillRect(x, y, Math.round(w * k * RS) / RS, h);
    ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fillRect(x, y, Math.round(w * k * RS) / RS, 0.5);
  }
  function cdRing(cx, cy, r, k, col) {
    k = k > 1 ? 1 : k < 0 ? 0 : k;
    ctx.globalAlpha = 0.9; ctx.fillStyle = '#0b060d';
    ctx.beginPath(); ctx.arc(cx, cy, r + 1.5, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#3a2a40'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
    ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + TAU * k); ctx.stroke();
    if (k >= 1) {
      ctx.globalAlpha = 0.6 + 0.4 * Math.sin(time * 9);
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cx, cy, r * 0.5, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function pushIcon(name) { if (icoN < 12) icoBuf[icoN++] = R[name]; }
  function drawIconRow(cx, y, alpha) {
    if (!icoN) return;
    const sz = 10.5, gap = 9.5;
    const x0 = cx - (icoN * gap) / 2 + (gap - sz) / 2;
    ctx.globalAlpha = alpha;
    for (let i = 0; i < icoN; i++) ctx.drawImage(Sprites.canvasOf(icoBuf[i], 0, 0, false), snap(x0 + i * gap), snap(y - sz), sz, sz);
    ctx.globalAlpha = 1;
  }
  function statusIcons(e, hero) {
    icoN = 0;
    const st = e.st;
    if (!st) return;
    if (st.burnT > 0) pushIcon('i_burn');
    if (st.bleedT > 0) pushIcon('i_bleed');
    if (st.slowT > 0 && st.slow > 0) pushIcon('i_slow');
    if (st.fearT > 0) pushIcon('i_fear');
    if (st.rootT > 0) pushIcon('i_root');
    if (st.buffT > 0) pushIcon('i_buff');
    if (hero && st.exposed) pushIcon('i_eye');
    if (st.invisT > 0) pushIcon('i_invis');
  }
  function stunStars(cx, cy) {
    const st = R.i_star;
    for (let i = 0; i < 3; i++) {
      const a = time * 5 + i * (TAU / 3);
      const x = cx + Math.cos(a) * 8, y = cy + Math.sin(a) * 2.5;
      ctx.globalAlpha = Math.sin(a) > 0 ? 1 : 0.6;
      ctx.drawImage(Sprites.canvasOf(st, 0, 0, false), snap(x - 3), snap(y - 3), 6, 6);
    }
    ctx.globalAlpha = 1;
  }
  /** Channel bars accept `t` counting up to `max` or down from it (direction auto-detected). */
  function channelProgress(h) {
    const c = h.channel, t = +c.t || 0, max = +c.max || 1;
    if (h._rch !== c) { h._rch = c; h._rchT = t; h._rchDown = t > max * 0.5; }
    else if (t !== h._rchT) { h._rchDown = t < h._rchT; h._rchT = t; }
    const k = Math.max(0, Math.min(1, t / max));
    return h._rchDown ? 1 - k : k;
  }
  /** Post-lighting accents so they always pop: hit flashes, elite gold rims, Heart hit flash. */
  function drawAccents() {
    const hs = S.heroes;
    for (let i = 0; i < hs.length; i++) {
      const h = hs[i];
      if (!h._rvis || h.dead || h.removed || h.escaped || !h._rrec) continue;
      const a = h.st && h.st.invisT > 0 ? 0.35 : 1;
      if (h.flashT > 0) { ctx.globalAlpha = 0.85 * a; drawSprite(h._rrec, h._rfr, V.WHITE, h._rflip, h._rpx, h._rfoot, h._rsc); }
      else if (h.elite) { ctx.globalAlpha = (0.5 + 0.2 * Math.sin(time * 4 + h.uid)) * a; drawSprite(h._rrec, h._rfr, V.RIM, h._rflip, h._rpx, h._rfoot, h._rsc); }
    }
    const ms = S.monsters;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!m._rvis || m.dead || m.removed || m.disguised || !m._rrec || !(m.flashT > 0)) continue;
      ctx.globalAlpha = 0.85; drawSprite(m._rrec, m._rfr, V.WHITE, m._rflip, m._rpx, m._rfoot, m._rsc);
    }
    if (heartRect.on && S.heartHitT > 0) {
      ctx.globalAlpha = Math.min(1, S.heartHitT / 0.25) * 0.8;
      ctx.drawImage(Sprites.canvasOf(R.heart, 0, V.WHITE, false), heartRect.x, heartRect.y, heartRect.w, heartRect.h);
    }
    ctx.globalAlpha = 1;
  }
  function drawEntityHUD() {
    const wave = S.phase === 'wave';
    const hs = S.heroes;
    for (let i = 0; i < hs.length; i++) {
      const h = hs[i];
      if (!h._rvis || h.dead || h.removed || h.escaped) continue;
      const boss = h.boss && HBOSS[h.boss] ? h.boss : null;
      const invis = h.st && h.st.invisT > 0;
      const a = invis ? 0.45 : 1;
      const w = boss ? 30 : 18, bh = boss ? 3 : 2;
      const x = snap(h._rpx - w / 2);
      let y = snap(h._rtop - (boss ? 6 : 4));
      ctx.globalAlpha = a;
      bar(x, y, w, bh, h.hp / Math.max(1, h.maxHp), hpColor(h.hp / Math.max(1, h.maxHp)));
      if (boss) {
        const cd = h.abilityCd > 0 ? 1 - Math.max(0, h.abilityT || 0) / h.abilityCd : 1;
        cdRing(x - 6, y + 1.5, 3.5, cd, HBOSS_AURA[boss]);
        ctx.font = font(8); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.lineWidth = 2.5; ctx.strokeStyle = '#0b060d'; ctx.lineJoin = 'round';
        ctx.globalAlpha = a;
        ctx.strokeText(HBOSS_SHORT[boss], h._rpx, y - 3); ctx.fillStyle = HBOSS_AURA[boss]; ctx.fillText(HBOSS_SHORT[boss], h._rpx, y - 3);
        y -= 10;
      }
      if (h.channel && h.channel.max > 0) {
        const kind = h.channel.kind;
        bar(x + 3, y - 4, w - 3, 2, channelProgress(h), CH_COL[kind] || '#ffffff');
        const ic = R[CH_ICON[kind]];
        if (ic) ctx.drawImage(Sprites.canvasOf(ic, 0, 0, false), x - 5, y - 6.5, 7.5, 7.5);
        y -= 6;
      }
      statusIcons(h, true);
      drawIconRow(h._rpx, y - 1.5, a);
      if (h.st && h.st.stunT > 0) stunStars(h._rpx, h._rtop - 1);
      if (h.loot > 0) { // loot sack slung on the back
        const bx = h._rpx - (h.face < 0 ? -1 : 1) * 9;
        ctx.globalAlpha = a;
        ctx.drawImage(Sprites.canvasOf(R.i_sack, 0, 0, false), snap(bx - 6), snap(h._rpy - 20), 12, 12);
      }
      if (h.leader && !boss) {
        let pc = 0;
        const pid = h.party && h.party.id;
        if (typeof pid === 'number') pc = pid % 5; else if (typeof pid === 'string') pc = pid.length % 5;
        const f = pc + (Math.floor(time * 3 + h.uid) & 1) * 5;
        const fx = h._rpx - (h.face < 0 ? -1 : 1) * 7;
        ctx.globalAlpha = a;
        ctx.drawImage(Sprites.canvasOf(R.pennant, f, 0, h.face < 0), snap(fx - 1), snap(h._rtop - 9), 7, 10);
      }
      ctx.globalAlpha = 1;
    }
    const ms = S.monsters;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!m._rvis || m.dead || m.removed || m.disguised) continue;
      const hurt = m.hp < m.maxHp - 0.5;
      const w = m.isBoss ? 30 : 16, bh = m.isBoss ? 3 : 2;
      const x = snap(m._rpx - w / 2);
      let y = snap(m._rtop - (m.isBoss ? 3 : 3));
      if (hurt || (m.isBoss && wave)) bar(x, y, w, bh, m.hp / Math.max(1, m.maxHp), m.isBoss ? '#ff6a2a' : '#e8384a');
      if (m.isBoss && m.abilityCd > 0) cdRing(x - 6, y + 1.5, 3.5, 1 - Math.max(0, m.abilityT || 0) / m.abilityCd, '#ff9a3c');
      statusIcons(m, false);
      drawIconRow(m._rpx, y - 2, 1);
      if (m.st && m.st.stunT > 0) stunStars(m._rpx, m._rtop);
      if (m.level > 1) {
        ctx.fillStyle = '#0b060d';
        for (let l = 1; l < m.level; l++) ctx.fillRect(snap(m._rpx - 4 + (l - 1) * 5 - 0.5) + (m.level === 2 ? 2.5 : 0), snap(m._rpy + 1.5), 4, 4);
        ctx.fillStyle = '#ffd24a';
        for (let l = 1; l < m.level; l++) ctx.fillRect(snap(m._rpx - 4 + (l - 1) * 5) + (m.level === 2 ? 2.5 : 0), snap(m._rpy + 2), 3, 3);
      }
    }
  }
  /** Trap/object badges: secret (closed eye), visible-in-torchlight (eye), revealed '!', disarmed tag, broken cracks, level pips, barricade HP. */
  function drawStructHUD() {
    const ss = S.structs;
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i];
      const x = s.x * TS, y = s.y * TS;
      if (s.cat === 'trap') {
        let badge = null;
        if (s.disarmed) badge = R.i_disarm;
        else if (s.hidden && s.revealed && !s.broken) badge = R.i_bang;
        else if (s.hidden && !s.revealed && !s.broken) badge = trapKnown(s) ? R.i_known : R.i_hidden;
        if (badge) {
          const bob = badge === R.i_bang ? Math.round(Math.sin(time * 6 + s.uid) * 1) : 0;
          ctx.globalAlpha = badge === R.i_hidden ? 0.85 : 1;
          ctx.drawImage(Sprites.canvasOf(badge, 0, 0, false), x + 21, y + 1 + bob, badge.w * 1.5, badge.h * 1.5);
          ctx.globalAlpha = 1;
        }
        if (s.broken && s.id !== 'pit') {
          ctx.fillStyle = '#120a14';
          ctx.fillRect(x + 7, y + 9, 6, 1.5); ctx.fillRect(x + 12, y + 10, 1.5, 6); ctx.fillRect(x + 12, y + 15, 7, 1.5);
          ctx.fillRect(x + 18, y + 16, 1.5, 7); ctx.fillRect(x + 19, y + 22, 5, 1.5);
        }
      }
      if (s.cat === 'object' && s.id === 'barricade' && !s.broken && s.maxHp && s.hp < s.maxHp) bar(x + 6, y + 1, 20, 2, s.hp / s.maxHp, '#d8a050');
      if ((s.cat === 'trap' || s.cat === 'object') && s.level > 1) {
        for (let l = 1; l < s.level; l++) {
          ctx.fillStyle = '#0b060d'; ctx.fillRect(x + 2 + (l - 1) * 5, y + 26, 4, 4);
          ctx.fillStyle = '#ffd24a'; ctx.fillRect(x + 2.5 + (l - 1) * 5, y + 26.5, 3, 3);
        }
      }
    }
  }

  /* ---- 2.10 FX ------------------------------------------------------------------------ */
  function drawFX() {
    const tf = FX.tileFlashes;
    for (let i = 0; i < tf.length; i++) {
      const f = tf[i];
      ctx.globalAlpha = Math.max(0, f.life / f.max) * 0.6;
      ctx.fillStyle = f.color; ctx.fillRect(f.x * TS, f.y * TS, TS, TS);
    }
    const rs = FX.rings;
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      const p = 1 - Math.max(0, r.life / r.max), e = 1 - (1 - p) * (1 - p);
      ctx.globalAlpha = (1 - p) * 0.9;
      ctx.strokeStyle = r.color; ctx.lineWidth = Math.max(0.75, r.width * (1 - p * 0.6));
      ctx.beginPath(); ctx.arc(r.x * TS, r.y * TS, Math.max(0.5, (r.r0 + (r.r1 - r.r0) * e) * TS), 0, TAU); ctx.stroke();
    }
    const bs = FX.beams;
    if (bs.length) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (let i = 0; i < bs.length; i++) {
        const b = bs[i];
        const k = Math.max(0, b.life / b.max);
        for (let pass = 0; pass < 3; pass++) {
          ctx.beginPath();
          const x0 = b.x0 * TS, y0 = b.y0 * TS, x1 = b.x1 * TS, y1 = b.y1 * TS;
          if (b.jag) {
            const n = b.jag.length - 1, dx = x1 - x0, dy = y1 - y0, len = Math.sqrt(dx * dx + dy * dy) || 1;
            const nx = -dy / len, ny = dx / len;
            for (let j = 0; j <= n; j++) {
              const t = j / n, o = b.jag[j] * TS;
              const px = x0 + dx * t + nx * o, py = y0 + dy * t + ny * o;
              if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
          } else { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
          if (pass === 0) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.35 * k; ctx.strokeStyle = b.color; ctx.lineWidth = b.width * 4; }
          else if (pass === 1) { ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = k; ctx.strokeStyle = b.color; ctx.lineWidth = b.width; }
          else { ctx.globalAlpha = k; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(0.75, b.width * 0.35); }
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = 'source-over'; ctx.lineCap = 'butt';
    }
    // Particles: solid pass, then additive glow pass.
    const ps = FX.parts;
    let last = null, anyGlow = false;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.glow) { anyGlow = true; continue; }
      const a = p.life / p.max;
      if (a <= 0) continue;
      ctx.globalAlpha = a < 0.5 ? a * 2 : 1;
      if (p.color !== last) { ctx.fillStyle = p.color; last = p.color; }
      const s = Math.max(1, p.size * (0.55 + 0.45 * a));
      ctx.fillRect(Math.round(p.x * TS - s / 2), Math.round(p.y * TS - s / 2), s, s);
    }
    if (anyGlow) {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        if (!p.glow) continue;
        const a = p.life / p.max;
        if (a <= 0) continue;
        const s = p.size * 3;
        ctx.globalAlpha = a * 0.8;
        ctx.drawImage(Sprites.glow(p.color), p.x * TS - s, p.y * TS - s, s * 2, s * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    // Floating text with a dark outline (pops in, fades out).
    const ts = FX.texts;
    if (ts.length) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      ctx.strokeStyle = '#0b060d';
      let lastF = -1;
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        const k = t.life / t.max, age = t.max - t.life;
        const size = Math.max(6, Math.round(t.size * (age < 0.1 ? 0.7 + age * 3 : 1)));
        if (size !== lastF) { ctx.font = font(size); ctx.lineWidth = Math.max(2, size * 0.3); lastF = size; }
        ctx.globalAlpha = k < 0.35 ? k / 0.35 : 1;
        const x = t.x * TS, y = t.y * TS;
        ctx.strokeText(t.str, x, y);
        ctx.fillStyle = t.color; ctx.fillText(t.str, x, y);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ---- 2.11 Build overlays: route preview, danger, ghost, ranges, selection --------- */
  const RAMP = [];
  for (let i = 0; i < 16; i++) {
    const t = i / 15;
    const r = Math.round(t < 0.5 ? 140 + t * 2 * 115 : 255), g = Math.round(t < 0.5 ? 210 + t * 2 * 16 : 226 - (t - 0.5) * 2 * 150), b = Math.round(t < 0.5 ? 255 - t * 2 * 180 : 75 - (t - 0.5) * 2 * 20);
    RAMP.push(`rgb(${r},${g},${b})`);
  }
  function drawPathPreview() {
    const path = Path.preview();
    if (!path || !path.length) return;
    const n = path.length, total = n * TS, spacing = 9;
    const off = (time * 22) % spacing;
    for (let d = off; d < total; d += spacing) {
      const seg = (d / TS) | 0, f = (d - seg * TS) / TS;
      const a = seg === 0 ? S.entrance : path[seg - 1], b = path[seg];
      if (!a || !b) continue;
      const x = (a.x + 0.5 + (b.x - a.x) * f) * TS, y = (a.y + 0.5 + (b.y - a.y) * f) * TS;
      const k = d / total;
      const big = ((d - off) / spacing | 0) % 4 === 0; // every 4th dot is larger: reads as flow
      const rr = big ? 3 : 2;
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = '#0b060d'; ctx.fillRect(Math.round(x) - rr, Math.round(y) - rr, rr * 2, rr * 2);
      ctx.fillStyle = RAMP[(k * 15) | 0]; ctx.fillRect(Math.round(x) - rr + 1, Math.round(y) - rr + 1, rr * 2 - 2, rr * 2 - 2);
    }
    ctx.globalAlpha = 1;
  }
  function drawDanger() {
    updateDanger();
    ctx.globalAlpha = 0.85 + 0.15 * Math.sin(time * 2);
    ctx.drawImage(dangerC, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  /** Stat lookup that prefers the Traps/Monsters modules (perk-aware) and falls back to the tables. */
  function trapNum(id, key, level) {
    try {
      const st = typeof Traps !== 'undefined' && Traps.stats ? Traps.stats(id, level) : null;
      if (st && typeof st[key] === 'number') return st[key];
    } catch (e) { /* fall back to the table */ }
    const v = TRAPS[id] && TRAPS[id][key];
    return Array.isArray(v) ? v[Math.max(0, Math.min(v.length - 1, level - 1))] : (typeof v === 'number' ? v : 0);
  }
  function monNum(cat, id, key, level) {
    try {
      const st = typeof Monsters !== 'undefined' && Monsters.stats ? Monsters.stats(id, level) : null;
      if (st && typeof st[key] === 'number') return st[key];
    } catch (e) { /* fall back to the table */ }
    const d = contentDef(cat, id);
    return d && typeof d[key] === 'number' ? d[key] : 0;
  }
  function circle(cx, cy, r, col, a, dashed) {
    ctx.globalAlpha = a * 0.12; ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
    ctx.globalAlpha = a; ctx.strokeStyle = col; ctx.lineWidth = 1.5;
    if (dashed) { ctx.setLineDash(DASH); ctx.lineDashOffset = -time * 10; }
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
    if (dashed) ctx.setLineDash(NODASH);
    ctx.globalAlpha = 1;
  }
  function tileFill(x, y, col, a) { ctx.globalAlpha = a; ctx.fillStyle = col; ctx.fillRect(x * TS + 1, y * TS + 1, TS - 2, TS - 2); }
  /** Straight firing/rolling lines in 4 directions until a solid tile. */
  function lines(tx, ty, range, col, a, fromSelf) {
    for (let d = 0; d < 4; d++) {
      const dx = DIR_OPEN[d][0], dy = DIR_OPEN[d][1];
      for (let i = fromSelf ? 0 : 1; i <= range; i++) {
        const x = tx + dx * i, y = ty + dy * i;
        if (i > 0 && Grid.isSolid(x, y)) break;
        if (i > 0 || fromSelf) tileFill(x, y, col, a * (0.28 - i * 0.012));
      }
    }
    ctx.globalAlpha = 1;
  }
  /** Range preview for a tool or a placed structure. */
  function drawRange(cat, id, tx, ty, level, a) {
    const cx = (tx + 0.5) * TS, cy = (ty + 0.5) * TS;
    if (cat === 'trap') {
      switch (id) {
        case 'arrow': lines(tx, ty, trapNum('arrow', 'range', level), '#ffb050', a, false); break;
        case 'boulder': lines(tx, ty, trapNum('boulder', 'range', level), '#d8c8a8', a, false); break;
        case 'alarm': circle(cx, cy, trapNum('alarm', 'radius', level) * TS, '#b070ff', a, true); break;
        case 'fire':
          tileFill(tx, ty, '#ff7a1f', a * 0.3);
          for (let d = 0; d < 4; d++) { const x = tx + DIR_OPEN[d][0], y = ty + DIR_OPEN[d][1]; if (tileOpen(x, y)) tileFill(x, y, '#ff7a1f', a * 0.22); }
          break;
        case 'teleport': {
          ctx.globalAlpha = a * 0.8; ctx.strokeStyle = '#5ab4ff'; ctx.lineWidth = 1.5;
          ctx.setLineDash(DASH); ctx.lineDashOffset = time * 14;
          ctx.beginPath(); ctx.moveTo(cx, cy);
          const ex = (S.entrance.x + 0.5) * TS, ey = (S.entrance.y + 0.5) * TS;
          ctx.quadraticCurveTo((cx + ex) / 2, Math.min(cy, ey) - 2.5 * TS, ex, ey); ctx.stroke();
          ctx.setLineDash(NODASH);
          tileFill(S.entrance.x, S.entrance.y, '#5ab4ff', a * 0.3);
          break;
        }
        default: tileFill(tx, ty, '#ffffff', a * 0.12);
      }
    } else if (cat === 'object') {
      if (id === 'torch') {
        const r = CFG.torchRadius;
        for (let y = Math.floor(ty - r); y <= Math.ceil(ty + r); y++) for (let x = Math.floor(tx - r); x <= Math.ceil(tx + r); x++)
          if (Grid.inb(x, y) && !Grid.isSolid(x, y) && dist(x, y, tx, ty) <= r) tileFill(x, y, '#ffb347', a * 0.16);
        circle(cx, cy, (r + 0.5) * TS, '#ffb347', a * 0.8, true);
      } else if (id === 'chest') circle(cx, cy, Lures.radius() * TS, '#ffd84a', a * 0.8, true);
      else if (id === 'lair') circle(cx, cy, 8 * TS, '#c86a4a', a * 0.5, true);
    } else if (cat === 'monster' || cat === 'boss') {
      const d = contentDef(cat, id);
      if (!d) return;
      const guard = monNum(cat, id, 'guard', level) || d.guard || 0;
      if (guard) circle(cx, cy, guard * TS, '#ff5a5a', a, true);
      if (d.leash) { ctx.globalAlpha = a * 0.35; ctx.strokeStyle = '#ff5a5a'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, d.leash * TS, 0, TAU); ctx.stroke(); }
      const rng = monNum(cat, id, 'range', level) || d.range || 0;
      if (d.ranged && rng > 1.5) circle(cx, cy, rng * TS, '#ffb050', a * 0.8, false);
      if (d.webRange) circle(cx, cy, d.webRange * TS, '#e8e8f0', a * 0.7, false);
      if (id === 'minotaur') lines(tx, ty, d.chargeRange || 6, '#ffb070', a, false);
      else if (id === 'lich') circle(cx, cy, (d.raiseRange || 6) * TS, '#6cff7a', a * 0.8, false);
      else if (id === 'dragon') circle(cx, cy, (d.breathLen || 5) * TS, '#ff7a1f', a * 0.8, false);
    }
    ctx.globalAlpha = 1;
  }
  /** Draw a structure/wall as it would look once placed (ghost). */
  function drawPreviewStruct(cat, id, tx, ty) {
    const x = tx * TS, y = ty * TS;
    if (cat === 'wall') {
      ctx.save(); ctx.translate(x, y); ctx.scale(ART, ART);
      Sprites.drawSolid(ctx, 0, 0, 'wall', 1, 15);
      ctx.restore();
    } else if (cat === 'trap') {
      if (id === 'arrow') ctx.drawImage(Sprites.canvasOf(R.arrow_emblem, 0, 0, false), x + 6, y + 4, 20, 20);
      else {
        const r = R['t_' + id];
        if (r) ctx.drawImage(Sprites.canvasOf(r, 0, 0, false), x, y, 32, 32);
        if (id === 'teleport') ctx.drawImage(Sprites.canvasOf(R.tele_swirl, Math.floor(time * 8) & 3, 0, false), x, y, 32, 32);
      }
    } else if (cat === 'monster' || cat === 'boss') {
      const r = cat === 'boss' ? BOSS[id] : MON[id];
      if (r) drawSprite(r, 0, V.NORMAL, false, x + 16, y + 16 + FOOT + (cat === 'boss' ? 4 : 0), 2);
    } else if (cat === 'object') {
      const r = R['o_' + id];
      if (r) ctx.drawImage(Sprites.canvasOf(r, 0, 0, false), x, y, 32, 32);
      if (id === 'torch') ctx.drawImage(Sprites.canvasOf(R.flame, Math.floor(time * 10) % 3, 0, false), x + 8, y - 8, 16, 24);
    }
  }

  const ghostC = { cat: null, id: null, tx: -1, ty: -1, ver: -1, gold: -1, s: null, phase: '', unl: -1, perks: -1, res: null };
  function canPlaceCached(cat, id, tx, ty) {
    const g = ghostC;
    if (g.cat !== cat || g.id !== id || g.tx !== tx || g.ty !== ty || g.ver !== S.pathVersion || g.gold !== S.gold ||
        g.s !== S || g.phase !== S.phase || g.unl !== S.unlocked.size || g.perks !== S.perkOrder.length) {
      g.cat = cat; g.id = id; g.tx = tx; g.ty = ty; g.ver = S.pathVersion; g.gold = S.gold; g.s = S; g.phase = S.phase;
      g.unl = S.unlocked.size; g.perks = S.perkOrder.length;
      g.res = Build.canPlace(cat, id, tx, ty);
    }
    return g.res;
  }
  function label(str, x, y, col, size) {
    ctx.font = font(size || 8); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = '#0b060d';
    ctx.strokeText(str, x, y); ctx.fillStyle = col; ctx.fillText(str, x, y);
  }
  function drawGhost() {
    const tool = S.ui.tool, hv = S.ui.hover;
    if (!tool || !hv || !Grid.inb(hv.tx, hv.ty)) return;
    const tx = hv.tx, ty = hv.ty, x = tx * TS, y = ty * TS;
    const res = canPlaceCached(tool.cat, tool.id, tx, ty) || { ok: false };
    const ok = !!res.ok;
    drawRange(tool.cat, tool.id, tx, ty, 1, ok ? 0.95 : 0.45);
    ctx.globalAlpha = 0.55 + 0.12 * Math.sin(time * 6);
    drawPreviewStruct(tool.cat, tool.id, tx, ty);
    const col = ok ? '#5dff8a' : '#ff4a4a';
    ctx.globalAlpha = ok ? 0.16 : 0.22; ctx.fillStyle = col; ctx.fillRect(x, y, TS, TS);
    ctx.globalAlpha = 1; ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, TS - 2, TS - 2);
    if (res.blocks) {
      // Hatched red tile + "blocks path" callout: this wall would seal the Heart.
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, TS, TS); ctx.clip();
      ctx.globalAlpha = 0.7; ctx.strokeStyle = '#ff2a2a'; ctx.lineWidth = 3;
      const o = (time * 16) % 8;
      for (let i = -TS; i < TS * 2; i += 8) { ctx.beginPath(); ctx.moveTo(x + i + o, y); ctx.lineTo(x + i + o - TS, y + TS); ctx.stroke(); }
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(x + 16, y + 16, 7, 0, TAU); ctx.moveTo(x + 11, y + 21); ctx.lineTo(x + 21, y + 11); ctx.stroke();
      label('BLOCKS PATH', x + 16, y - 6, '#ff6a6a', 8);
    } else if (contentDef(tool.cat, tool.id)) {
      label(Build.cost(tool.cat, tool.id) + 'g', x + 16, y + TS + 5, ok ? '#ffd84a' : '#ff6a6a', 8);
    }
    ctx.globalAlpha = 1;
  }
  function drawSelection() {
    const sel = S.ui.selected;
    if (!sel || !Grid.inb(sel.x, sel.y)) return;
    const s = Build.structAt(sel.x, sel.y);
    if (s) drawRange(s.cat, s.id, sel.x, sel.y, s.level || 1, 0.85);
    const x = sel.x * TS, y = sel.y * TS, o = 1 + Math.sin(time * 5) * 1.2, L = 7;
    ctx.fillStyle = '#ffd84a'; ctx.globalAlpha = 1;
    const x0 = x - o, y0 = y - o, x1 = x + TS + o, y1 = y + TS + o;
    ctx.fillRect(x0, y0, L, 2); ctx.fillRect(x0, y0, 2, L);
    ctx.fillRect(x1 - L, y0, L, 2); ctx.fillRect(x1 - 2, y0, 2, L);
    ctx.fillRect(x0, y1 - 2, L, 2); ctx.fillRect(x0, y1 - L, 2, L);
    ctx.fillRect(x1 - L, y1 - 2, L, 2); ctx.fillRect(x1 - 2, y1 - L, 2, L);
  }

  /* ---- 2.12 Power targeting reticles ---------------------------------------------------- */
  const colC = { tx: -1, ty: -1, ver: -1, s: null, ok: false };
  function drawPowerReticle() {
    const pw = S.ui.power, hv = S.ui.hover;
    if (!pw || !hv) return;
    const def = POWERS[pw];
    if (!def) return;
    const wx = hv.wx, wy = hv.wy, cx = wx * TS, cy = wy * TS;
    if (pw === 'lightning') {
      const r = (def.radius || 1.25) * TS;
      if (hasPerk('chain_lightning')) { ctx.globalAlpha = 0.3; ctx.strokeStyle = '#fff0a0'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, 3 * TS, 0, TAU); ctx.stroke(); }
      circle(cx, cy, r, '#fff0a0', 0.95, true);
      const hs = S.heroes;
      for (let i = 0; i < hs.length; i++) {
        const h = hs[i];
        if (h.dead || h.removed || h.escaped) continue;
        if (dist(h.x, h.y, wx, wy) <= (def.radius || 1.25)) {
          ctx.globalAlpha = 0.9; ctx.strokeStyle = '#fff6b0'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(h.x * TS, h.y * TS, 11, 0, TAU); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.drawImage(Sprites.canvasOf(R.i_bolt, 0, 0, false), snap(cx - 7), snap(cy - 7 - r - 12), 10, 14);
    } else if (pw === 'collapse') {
      const tx = hv.tx, ty = hv.ty;
      if (!Grid.inb(tx, ty)) return;
      if (colC.tx !== tx || colC.ty !== ty || colC.ver !== S.pathVersion || colC.s !== S) {
        colC.tx = tx; colC.ty = ty; colC.ver = S.pathVersion; colC.s = S; colC.ok = Grid.canCollapse(tx, ty).ok;
      }
      const col = colC.ok ? '#ffb070' : '#ff4a4a';
      const x = tx * TS, y = ty * TS;
      ctx.globalAlpha = 0.22; ctx.fillStyle = col; ctx.fillRect(x, y, TS, TS);
      ctx.globalAlpha = 1; ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.setLineDash(DASH); ctx.lineDashOffset = -time * 12; ctx.strokeRect(x + 1, y + 1, TS - 2, TS - 2); ctx.setLineDash(NODASH);
      // falling pebbles hint
      ctx.fillStyle = '#c8bca8';
      for (let i = 0; i < 4; i++) { const t = (time * 1.4 + i * 0.25) % 1; ctx.globalAlpha = 1 - t; ctx.fillRect(x + 6 + i * 6, y - 10 + t * 22, 3, 3); }
      ctx.globalAlpha = 1;
    } else if (pw === 'fear') {
      const h = Spatial.nearestHero(wx, wy, 0.9);
      if (h) {
        const immune = HERO_CLASSES[h.type] && (HERO_CLASSES[h.type].fearImmune || h.boss);
        const col = immune ? '#9a9aa8' : '#c07aff';
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.globalAlpha = 0.95;
        ctx.setLineDash(DASH); ctx.lineDashOffset = -time * 12;
        ctx.beginPath(); ctx.arc(h.x * TS, h.y * TS, h.boss ? 20 : 13, 0, TAU); ctx.stroke(); ctx.setLineDash(NODASH);
        ctx.drawImage(Sprites.canvasOf(R.i_fear, 0, immune ? V.GREY : V.NORMAL, false), snap(h.x * TS - 7), snap(h.y * TS - (h.boss ? 60 : 38)), 14, 14);
        if (immune) label('Immune', h.x * TS, h.y * TS + 18, '#d0d0dc', 8);
      } else {
        ctx.globalAlpha = 0.6; ctx.strokeStyle = '#c07aff'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(cx, cy, 0.9 * TS, 0, TAU); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (def.target === 'tile' && Grid.inb(hv.tx, hv.ty)) {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.strokeRect(hv.tx * TS + 1, hv.ty * TS + 1, TS - 2, TS - 2);
    }
  }

  /* ---- 2.13 Frame ----------------------------------------------------------------------- */
  /** Draw one frame. `dtReal` = real seconds since the last frame (drives purely visual animation). */
  function draw(dtReal) {
    if (!ctx) return;
    dt = dtReal > 0 ? Math.min(0.1, dtReal) : 0;
    time += dt; frameNo++;
    if (!S || !S.tiles || !S.tiles.length || !S.cols) {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = DARK; ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (S.cols !== cols || S.rows !== rows || !stat) resize();
    else if ((frameNo & 31) === 0) checkParent();
    if (statS !== S || statVer !== S.pathVersion) buildStatic();
    const phase = S.phase;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = false;
    const sx = Math.round((FX.shakeX || 0) * RS) / RS, sy = Math.round((FX.shakeY || 0) * RS) / RS;
    // The static layer is opaque; the backdrop only shows at the edges while the camera shakes.
    if (sx || sy) { ctx.fillStyle = DARK; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.setTransform(RS, 0, 0, RS, sx * RS, sy * RS);
    ctx.drawImage(stat, 0, 0, W, H);
    if (phase === 'build') ctx.drawImage(gridC, 0, 0, W, H);
    if (S.ui.showDanger) drawDanger();
    drawStructs();
    if (phase === 'build' && S.ui.showPath) drawPathPreview();
    drawCorpses();
    drawEntities();
    drawFlames();
    drawProjectiles();
    drawLighting();
    drawAccents();
    drawStructHUD();
    drawEntityHUD();
    drawFX();
    if (phase === 'build') drawGhost();
    else if (phase === 'wave') drawPowerReticle();
    drawSelection();
    ctx.setTransform(RS, 0, 0, RS, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if (phase === 'title') {
      ctx.fillStyle = 'rgba(5,3,10,0.42)'; ctx.fillRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = true; ctx.drawImage(vignette, 0, 0, W, H); ctx.drawImage(vignette, 0, 0, W, H); ctx.imageSmoothingEnabled = false;
    }
    const f = FX.screenFlash;
    if (f && f.max > 0) {
      ctx.globalAlpha = Math.max(0, Math.min(1, f.life / f.max)) * 0.6;
      ctx.fillStyle = f.color; ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  return { init, resize, draw, screenToWorld };
})();
