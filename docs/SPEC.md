# Dungeon Heart — Module Contract (for implementers)

This is the binding contract between the source parts in `src/`. `node build.mjs` concatenates
`src/*.js` in filename order into ONE `<script>` inside `src/shell.html` → `index.html`.
**All files share one global scope.** Read `src/00_data.js`, `src/05_engine.js`, `src/08_fx.js`,
`src/90_game.js`, `src/99_main.js` in full before writing code — they are the source of truth
for every name referenced below.

## 0. Ground rules (every module)

1. **One file, one module family.** Define ONLY the top-level names you own, each as
   `const Name = { ... };` starting at column 0 (build tooling detects modules that way).
   Put every helper function/constant INSIDE your module object or inside an IIFE whose result
   is assigned to your module name. Never declare other top-level `const/let/function/class`
   names (collisions break the whole game). Exception: none.
2. Always read the live state through the global `S` at call time. Never cache `S`.
3. Coordinates: world units = tiles (floats). Entity `x,y` is its centre. Tile of an entity:
   `Math.floor(e.x), Math.floor(e.y)`. Tile centre = `tx + 0.5`.
4. Time: all timers in simulation seconds; you get `dt` (always `SIM_DT` = 1/60).
5. Performance: 60+ entities at 4× speed (4 updates / frame). Don't run A* per entity per tick —
   cache paths and repath on a timer (~0.6–1.2 s, staggered) or when `S.pathVersion` changes.
6. No external assets. Emoji are OK in DOM text only.
7. No placeholders. Every trap/monster/class/perk/power listed as yours must fully work.
8. Robustness: guard against dead/removed targets (`e.dead`, `e.removed`, `e.escaped`), and
   against entities whose struct was sold.
9. Code style: 2-space indent, semicolons, single quotes, section comments like the core files,
   JSDoc-ish one-liners on public methods. Readable, well organized, commented where non-obvious.
10. Test in isolation with `node build.mjs --dev --only <your files> --out build/<you>.html &&
    node tools/smoke.mjs build/<you>.html --waves 3 [--shots]` — this bundles the core + ONLY your
    parts; every other module is auto-stubbed from `tools/stubs.js` (other engineers are editing their
    files concurrently, so don't build their in-progress files). The smoke run must print no ERRORS.
    `--shots` saves build/smoke-title.png and build/smoke-wave.png (viewable with the Read tool).
    You may write extra throwaway test scripts under `build/` (gitignored) — don't modify
    `tools/smoke.mjs`, `tools/stubs.js`, `build.mjs` or any core file (00/05/08/90/99).
    If you believe a core change is REQUIRED, don't make it — describe it precisely in your final
    report (file, function, exact change) and work around it meanwhile.

## 1. Ownership

| File | Owns (top-level names) |
|---|---|
| `src/00_data.js` (core) | utils, `TS`, `SIM_DT`, `CFG`, `T`, content tables (`WALL_DEF`, `HERO_CLASSES`, `HERO_BOSSES`, `HERO_BOSS_ORDER`, `TRAPS`, `MONSTERS`, `BOSSES`, `OBJECTS`, `BUILD_TABS`, `POWERS`, `RARITY`, `PERKS`, `PERK_BY_ID`), `contentDef`, `hasPerk`, `heroWaveScale`, `heroStatMuls` |
| `src/05_engine.js` (core) | `S`, `makeState`, `Grid`, `MinHeap`, `Path`, `heroSmartness`, `Danger`, `Light`, `trapKnown`, `Lures`, `makeStatus`, `makeEntity`, `Spatial`, `Status`, `Combat`, `Proj`, `Heart`, `Econ`, `Build` |
| `src/08_fx.js` (core) | `FX`, `SFX` |
| `src/20_heroes.js` | `Heroes` |
| `src/30_traps.js` | `Traps`, `Objects` |
| `src/31_monsters.js` | `Monsters` |
| `src/40_director.js` | `Waves`, `Perks`, `Powers` |
| `src/50_render.js` | `Render`, `Sprites` |
| `src/60_ui.js` + `src/shell.html` | `UI` (+ all HTML/CSS) |
| `src/90_game.js` (core) | `Save`, `Game` |
| `src/99_main.js` (core) | `Main`, `window.DH` debug handle |

## 2. Frame / phase flow (core, already written)

`Game.update(dt)` during `S.phase === 'wave'`, in this order:
`Status.tick` (every living hero & monster: timers, DoTs, `st.exposed` from torchlight) →
`Waves.update` → `Powers.update` → `Heroes.update` → `Monsters.update` → `Traps.update` →
`Objects.update` → `Proj.update` → `Heart.update` → corpse decay → cleanup
(heroes removed when `removed || escaped || (dead && deadT > 0.7)`; monsters removed when
`removed || (temp && dead && deadT > 0.7)`) → wave-end check (`Waves.done()` and no living heroes).
In build/title/reward phases only `Monsters.idle(dt)` and `FX.update` run.

`Game.startWave()` calls, in order: `Traps.onWaveStart()`, `Objects.onWaveStart()`,
`Monsters.onWaveStart()`, `Heroes.onWaveStart()`, `Powers.onWaveStart()`, `Waves.begin(S.nextWave)`.
`Game.endWave()` calls `Traps.onWaveEnd()`, `Objects.onWaveEnd()`, `Monsters.onWaveEnd()`,
`Heroes.onWaveEnd()`, then `Perks.roll(3)` → `UI.showReward(summary, choices)`.
`Game.pickPerk(id)` → `Perks.take(id)`, `S.wave++`, maybe `Grid.expand`, `Game.checkUnlocks`,
`S.nextWave = Waves.generate(S.wave)`, phase `build`.
`Game.heroEscaped(h)` — call when a living hero exits via the entrance (handles theft/stats).
`Game.heartDestroyed()` / `Game.gameOver()` — core.

## 3. Shared data shapes

### 3.1 Tile — `S.tiles[y*S.cols+x]`
`{ x, y, type: T.FLOOR|T.WALL|T.ROCK|T.ENTRANCE|T.HEART, s: Structure|null, paid, rubble, deco }`
Player walls are `T.WALL` (`rubble` = created by Collapse). `T.ROCK` = natural/border, indestructible.
An Arrow Wall is a Structure on a WALL/ROCK tile.

### 3.2 Structure — `S.structs[]`, also `tile.s`
```
{ uid, cat:'trap'|'object'|'monster'|'boss', id, x, y (tile ints), level (1..3), spent,
  broken,     // needs repair (Build.repair) — inactive until repaired
  hidden,     // trap is secret this wave (set by Traps.onWaveStart from def.hidden || perk hidden_depths)
  revealed,   // heroes discovered it this wave (triggered, detected, ranger)
  disarmed,   // a rogue disabled it for the rest of this wave
  cd,         // remaining cooldown (traps)
  animT,      // >0 while a trigger/hit animation plays (Render reads it; set it to ~0.3–0.6 on trigger)
  hp, maxHp,  // barricades only
  ent,        // monster entity for cat monster/boss
  data: {}    // module-private runtime state — documented fields below
}
```
Documented `data` fields (Render/UI may read them):
- chest: `data.empty` (looted this wave), `data.claimedBy` (hero uid heading to it, or null)
- boulder: `data.ready` (boulder present & armed), `data.rolling` (a boulder projectile is out)
- arrow: `data.lastDir` ([dx,dy] of last shot, for the muzzle animation)
- fire: `data.flameT` (>0 while the flame column is active)
- teleport: nothing extra. alarm: `data.ringT` (>0 while alarm rings)
- lair: `data.spawnT` (seconds until next spawn), `data.alive` (count)
- pit: `broken` after use (shows open pit); with Trapmaster, `data.rearmT` (>0 while rearming)
`trapKnown(s)` (core) = heroes know about it → heroes path around it.

### 3.3 Entities (heroes & monsters) — created with `makeEntity(team, type, x, y)`
Common fields: `uid, team ('hero'|'dm'), type, x, y, hp, maxHp, dmg, atkCd, atkT, range, speed,
dead, deadT, removed, flashT, animT, face (±1), st (status block), path, pathIdx, state, target, bob`.

**Hero** (made by `Heroes.create`) additionally has:
```
name       // e.g. 'Brenna' (short random fantasy name)
elite      // bool
boss       // HERO_BOSSES id or null
party      // party object (see Heroes)
leader     // bool
state      // 'advance'|'loot'|'fight'|'retreat'|'rush'|'heart'|'fear'|'disarm'|'blast'|'dig'|'escape'|'stunned'
loot       // gold carried from a chest (0 = none)
lure       // current lure target {kind,x,y,struct?,ent?} or null
channel    // {kind:'loot'|'disarm'|'blast'|'dig', t, max} while channeling, else null (Render draws a bar)
abilityT, abilityCd   // hero bosses: time until ability ready / its full cooldown
escaped    // set by Game.heroEscaped
heartDmg   // damage per hit on the Heart
```
**Monster** (made by `Monsters.create` / `Monsters.summon`) additionally has:
```
isBoss     // player boss (Minotaur/Lich/Dragon)
post       // Structure it guards (null for summons)
homeX, homeY // world coords it returns to
level
temp       // summoned for this wave only (removed at wave end)
risen      // raised from a corpse (Necromancy / Lich / Legion) — draw with a purple tint
lair       // Structure that spawned it (lair summons), else undefined
undead, phasing
disguised  // Mimic currently looks like a chest
state      // 'idle'|'chase'|'attack'|'return'|'ambush'|'charge'|'breath'|'cast'|'respawn'
respawnT   // skeletons waiting to reassemble (>0), else 0
abilityT, abilityCd, abilityName  // bosses: time until ready / full cooldown / name
dmgTakenMul // optional incoming-damage multiplier used by Combat
```
Status block `e.st` (core `makeStatus`): `slow, slowT, burn, burnT, burnSrc, bleed, bleedT,
bleedSrc, stunT, rootT, fearT, fearX, fearY, buffT, buffDmg, buffSpd, dotT, exposed, invisT`.
Use `Status.apply(e, kind, opts)` / `Status.speedMul(e)` / `Status.dmgMul(e)` / `Status.canAct(e)`.

### 3.4 Damage sources — `Combat.damage(target, amount, src)`
`src = { team:'dm'|'hero', kind:'trap'|'monster'|'boss'|'power'|'heart'|'hero'|'object', id, ent?, elem:'phys'|'fire'|'holy'|'magic', noText? }`
Always pass `kind` and `id` for DM-side damage (stats: "favourite trap", kills by source).
For DoTs pass the ORIGINAL source as `src` in `Status.apply(e,'burn',{dps,dur,src})`.
Core already applies: torch Exposed (+25%), Glass Cannon (+60% trap dmg), elite trap resist,
Paladin fire resist, holy ×2 vs undead, Warcry orc −20%, `dmgTakenMul`, Paladin save via
`Heroes.preventDeath`. On death core handles bounty+loot gold, stats, danger memory, corpses,
Necromancy, Soul Harvest, Legion, boss-kill fanfare, then calls `Heroes.onDeath(h, src)` /
`Monsters.onDeath(m, src)`.

### 3.5 Projectiles — `Proj.spawn({...})` (see core for fields)
Kinds Render must draw: `'arrow'` (hero ranger & Arrow Wall), `'bolt'` (mage, blue),
`'fire'` (imp, orange), `'web'` (spider, white), `'shadow'` (lich, purple), `'boulder'`
(rolling boulder, big, `pierce:true`), `'magic'` (generic sparkle), `'holy'` (yellow-white).

### 3.6 Wave preview — `Waves.generate(n)` returns
```
{ wave:n, boss: heroBossId|null,
  parties: [ { members:[ {cls, elite:bool, boss:heroBossId|null} ], delay: seconds after the previous party } ],
  counts: { warrior:3, rogue:2, ... }, elites: n, total: n, threat: n,
  guildNotes: [ 'The Guild noticed your traps: more Rogues and Rangers.' ] }
```
Must be deterministic for a given `(S.seed, n)` when regenerated during the same build phase.

## 4. Module specifications

### 4.1 `Heroes` (src/20_heroes.js)
Exports: `create(cls, opts)`, `spawnParty(memberSpecs)`, `update(dt)`, `onWaveStart()`,
`onWaveEnd()`, `onDeath(h, src)`, `preventDeath(h, src)`, `stateLabel(h)`, `costFn(h)`.
- `create(cls,{elite,boss})`: stats = class base × `(1 + CFG.heroHpPerWave*(S.wave-1))` HP,
  × `(1 + CFG.heroDmgPerWave*(S.wave-1))` dmg; elite × `CFG.eliteHpMul/eliteDmgMul/eliteSpeedMul`;
  hero boss × `hpMul/dmgMul/speedMul` from `HERO_BOSSES` (boss uses the `base` class);
  perk `midas` → ×1.2 HP. `heartDmg` scales with dmg multiplier. Random name. Not pushed anywhere.
- `spawnParty(specs)`: create each, place at entrance tile centre (tiny jitter), push to
  `S.heroes`, create party `{id, members, leader, goal}` in `S.parties`, `S.ws.spawned += n`.
  Leader = boss if present, else sturdiest (paladin > warrior > miner > …).
- **Pathing**: weighted A* via `Path.astar(sx,sy,gx,gy,cost)`. `costFn(h)`:
  `Path.baseCost` (walls/rock = Infinity, barricade extra cost) plus, unless Paranoia is active
  (`hasPerk('paranoia') && S.time < 10`) or the hero is rushing:
  `+ S.danger[i] * cls.dangerW * h.smart` and `+ 5 * cls.trapW * h.smart` for tiles with a
  `trapKnown` trap (not Arrow Walls — those are on walls; instead add `2*trapW*smart` to floor
  tiles in a known Arrow Wall's firing lines within range, optional). `h.smart = heroSmartness(h.elite)`.
  Dwarf Miner: player WALL tiles (not ROCK, not heart/entrance) are passable at cost
  `3 + digTime*2` (they dig them). Repath every ~0.8–1.2 s (staggered) and immediately when
  `S.pathVersion` changed or the next step became solid.
- **Movement**: steer toward next path tile centre at `speed × Status.speedMul(h)` (×1.25 rushing,
  ×0.85 `time_warp`, ×0.6 when carrying loot with `cursed_gold`). Light separation between heroes
  so they don't stack perfectly. Set `face`. `st.fearT>0` → state `fear`: path toward entrance
  (away from `fearX,fearY`), no attacking. `st.stunT>0` → nothing.
- **States**: `advance` (to party goal = Heart), `loot`, `fight`, `retreat` (HP < 30% and
  `Path.heartDist > 6` and not boss → path to entrance; resume `advance` at > 65% HP), `rush`
  (`Path.heartDist ≤ 6`: ignore danger & traps, +25% speed, never retreats), `heart` (within
  ~1.3 of Heart centre: attack it every `atkCd` for `heartDmg` via `Heart.damage(h.heartDmg, src)`),
  `escape` (carrying loot to the exit). Reaching the entrance tile while retreating/escaping/feared →
  `Game.heroEscaped(h)`.
- **Party cohesion**: members share the leader's goal; a member > 3 tiles ahead (by
  `Path.heartDist`) of the leader waits; the leader waits (max ~2 s at a time) for members > 4
  behind. Rushing ignores cohesion. On leader death, promote next (`onDeath`).
- **Combat**: melee/ranged attack monsters in range (ranged need `Grid.los`). Warriors/Paladins
  (`engageR`) charge monsters within 2.5 tiles (leash 3 tiles off their route). Others fight
  when a monster is within their range or when attacked. A living monster within 0.9 tiles that
  targets this hero **blocks** its movement (hero must fight) — except Rogues (50% slip past,
  re-rolled every 2 s) and rushing heroes. Invisible monsters don't exist; ignore `disguised`
  mimics (they look like chests). Taunt: with `warcry`, heroes within 2 tiles of an Orc must
  target that Orc. Attack damage × `Status.dmgMul(h)`; src `{team:'hero',kind:'hero',id:type,ent:h,elem: holy classes → 'holy', mage → 'magic', else 'phys'}`.
  Ranged attacks use `Proj.spawn` (ranger `'arrow'`, mage `'bolt'`, homing on target).
  Barricade on the next path tile → stop and hit it (`Combat.hitStruct(s, dmg)`).
- **Greed**: when a lure from `Lures.list()` is within `Lures.radius()` (straight-line, with a
  reachable path) and not claimed, roll `cls.greed` once per hero per lure → go loot it
  (`chest.data.claimedBy = h.uid`). Standing at a chest: channel 1.2 s (`channel.kind='loot'`) →
  `h.loot = Objects.loot(chestStruct, h)`. Rogues then `escape` to the entrance with it; others
  continue to the Heart carrying it (they drop it on death — core handles). Going to a Mimic:
  when the mimic ambushes (`disguised` becomes false) abandon the lure and fight.
- **Class kits** (all required):
  - Rogue: each second, for each hidden un-revealed trap within `detectR`, roll
    `detect` (halved with `hidden_depths`) → `Traps.reveal(s, h)`. When the next path tile holds
    a known, armed, non-broken trap: roll `disarm` once per trap → channel `disarmTime`
    (`channel.kind='disarm'`) → `Traps.disarm(s, h)`; on failure just walk (it may trigger).
  - Ranger: continuously reveals hidden traps within `revealR` (`Traps.reveal`).
  - Mage: every `blastCd` s, if the current route is long, test each player WALL tile within
    1–2 tiles: path length with that wall removed (A* with that tile's cost = 1) vs current;
    if it saves ≥ `blastMinGain` tiles, channel `blastTime` (×2 with `reinforced`) then
    `Grid.destroyWall(x, y, 'a Mage')` + FX/SFX `blast`.
  - Cleric: every `healCd` heal the most-injured ally (≤ 90% HP) within `healR` for `healAmt`
    (scaled like dmg) with a `FX.beam` + `SFX.play('heal')`.
  - Paladin: `preventDeath(h)`: if a living Paladin within 4 tiles has not used Lay on Hands
    this wave, set that ally's HP to `lohPct` × maxHp, FX, return true.
  - Dwarf Miner: digs through walls on its route: when the next tile is a WALL, channel
    `digTime` (×2 `reinforced`), then `Grid.destroyWall(x,y,'a Dwarf Miner')`. Immune to pits
    (Traps checks `cls.pitImmune`).
  - Warrior: low trap weight (walks through), charges monsters.
- **Hero bosses** (`h.boss`), ability every `abilityCd` (`h.abilityT` counts down):
  champion Shield Bash (monsters within 1.8: `2.5×dmg` + stun 2 s, ring FX, shake);
  archmage Blink (teleport up to 4 tiles along its route toward the Heart, passing walls, landing
  on an open tile; purple FX); saint Sanctuary (heal allies within 5 by 40 + `Status.cleanse`);
  shadow Shadowstep (`Traps.disarm` every armed trap within 3 + `Status.apply(h,'invis',{dur:3})`
  — monsters ignore invisible heroes). Hero bosses never retreat and cannot be one-shot by pits
  (Traps handles).
- Perks here: `paranoia`, `greedy_gods`/`cursed_gold` (via `Lures.radius`), `cursed_gold` slow,
  `time_warp`, `midas` HP, `reinforced` (blast/dig time), `hidden_depths` (rogue detection),
  `warcry` taunt.
- `stateLabel(h)` → friendly text ('Advancing', 'Looting chest', 'Fleeing in terror', …).
- Use SFX names from `08_fx.js` (`heroHit`, `magic`, `heal`, `blast`, `dig`, `disarm`, `reveal`, `loot`, …).

### 4.2 `Traps` and `Objects` (src/30_traps.js)
Traps exports: `onPlace(s)`, `update(dt)`, `onWaveStart()`, `onWaveEnd()`, `reveal(s, by)`,
`disarm(s, by)`, `resetAll()`, `describe(s)` → string[], `stats(id, level)` → object.
- Traps only act during waves, only when `!broken && !disarmed`, and damage only heroes.
  Heroes on a tile: `Spatial.heroesOnTile(tx,ty)`. Triggering reveals the trap
  (`s.revealed = true`) and adds danger `Danger.add(x,y,3,0)`. Set `s.animT` and FX/SFX on trigger.
  Record stats implicitly by passing `src={team:'dm',kind:'trap',id,elem}`.
- **spike**: hero on tile & cd ≤ 0 → `dmg[L]` to all heroes on it (`whetstone` ×1.4),
  `rusted_blades` → bleed 4/s 4 s; cd = `cd[L]`.
- **arrow** (on a wall): cd ≤ 0 → find nearest living hero that shares a row or column with
  the trap, within `range[L]`, with clear line (no solid tiles between) → `Proj.spawn` a straight
  `'arrow'` from the wall face toward it (hits first hero). `echoing_halls` → second volley 0.25 s
  later. cd = `cd[L]` × (0.7 with `quick_reload`).
- **pit**: one use. Hero steps on: if `cls.pitImmune` (miner) → reveal only, no trigger. If hero is
  not a boss and `hp ≤ killHp[L]` (whetstone ×1.4) → instant kill (`Combat.damage(h, h.hp+999, src)`),
  else `dmg[L]` (×1.4 whetstone) + stun 1.5 s. Then `s.broken = true` (with `trapmaster`: rearm
  after 8 s instead, `data.rearmT`).
- **slime**: heroes on tile get `slow` `slow[L]` (+0.15 `sticky`) for `linger` (+2 `sticky`) s
  refreshed each tick. Always active, never breaks.
- **fire**: hero on tile & cd ≤ 0 → erupt: flame column 1.5 s (`data.flameT`), heroes on the tile
  AND the 4 orthogonal neighbours get burn `burn[L]` dps for `burnDur` s (`kindling`: +3 dps, +3 s),
  src elem 'fire'. cd = `cd[L]`.
- **alarm**: hero on tile & cd ≤ 0 → `Monsters.alarm(x+0.5, y+0.5, radius[L], buffDur[L])`,
  ring FX, `SFX.play('alarm')`, cd = `cd`.
- **boulder**: when `data.ready` and a hero is in a straight open line (row/column) within
  `range` → `Proj.spawn({kind:'boulder', pierce:true, speed:7, dmg:dmg[L], radius:0.45, ...})`
  in that direction; on each hero hit: damage + stun 0.5 s + shake; stops at the first solid
  tile (rubble FX). Re-forms after `cd[L]` (×0.75 with `stonemason`). Never breaks.
- **teleport**: hero on tile, cd ≤ 0, hero advancing/rushing (not retreating/escaping/feared;
  hero bosses ARE affected) → move to entrance tile centre, `h.path=null`,
  stun 0.5 s, FX at both ends, cd = `cd[L]`.
- `onWaveStart`: `cd=0, revealed=false, disarmed=false, hidden=def.hidden||hidden_depths`,
  boulder `ready=true`. `onWaveEnd`: clear transient data (flames, rolling), keep `broken`.
- `resetAll()` (Reset Traps power): every trap: `cd=0`, repair broken (`broken=false`),
  `revealed=false`, `disarmed=false`, boulders ready; FX on each.
- `reveal(s)`: if not already revealed & hidden → `revealed=true`, `Danger.add(s.x,s.y,3,0)`,
  FX '!' text + `SFX.play('reveal')`. `disarm(s)`: `disarmed=true`, `revealed=true`, FX + `SFX.play('disarm')`.
- `stats(id, level)` returns the numbers for that level (with active perks applied), e.g.
  `{dmg, cd, range, killHp, slow, burn, radius, ...}`; `describe(s)` returns human strings
  for tooltips/inspector ('Damage: 36', 'Cooldown: 1.5s', 'Status: Revealed', …).

Objects exports: `onPlace(s)`, `update(dt)`, `onWaveStart()`, `onWaveEnd()`, `loot(s, hero)` → gold
value, `describe(s)` → string[].
- chest: `loot()` marks `data.empty=true`, `claimedBy=null`, returns `Lures.chestValue()`,
  coin FX + `SFX.play('loot')`. `onWaveStart` refills (`empty=false, claimedBy=null`).
- torch: purely passive (core `Light`); `update` may emit ember particles occasionally.
- barricade: HP handled by `Combat.hitStruct`; broken barricades stay broken until repaired.
- well: passive (Powers adds the regen); sparkle particles.
- lair: during waves every `spawnCd` s, if fewer than `maxAlive` of its summons are alive,
  `Monsters.summon(pick(['goblin','skeleton']), x+0.5, y+0.5, {temp:true, lair:s})`.

### 4.3 `Monsters` (src/31_monsters.js)
Exports: `create(struct)`, `summon(type, x, y, opts)`, `refreshStats(m)`, `revive(m)`, `update(dt)`,
`idle(dt)`, `onWaveStart()`, `onWaveEnd()`, `onDeath(m, src)`, `alarm(x, y, radius, dur)`,
`stateLabel(m)`, `describe(m)` → string[], `stats(type, level)` → object.
- `create(s)`: entity for `MONSTERS[s.id]` or `BOSSES[s.id]` at the post tile centre, stats ×
  `CFG.levelStatMul[level]`, pushes into `S.monsters`, returns it. `summon`: temp monster
  (level 1), cap ~40 total summons alive; returns entity or null.
- **AI**: `idle` near post (small wander ≤ 0.8 tiles) → `chase` a visible hero within `guard`
  (needs `Grid.los` unless phasing; ignore heroes with `st.invisT > 0`) → `attack` in range →
  `return` when the target is lost for 2 s or the monster is beyond `leash` from home
  (return home and slowly regen 5%/s at home). Path with `Path.astar` + `Path.baseCost`
  (repath on timer). Phasing (Wraith) moves straight through walls. Temp summons without a post
  treat their spawn point as home but hunt with a larger radius (8).
- Attack damage × level mul × `Status.dmgMul(m)` × perks: `pack_tactics` (+12% per other monster
  within 2, max +48%), `adrenaline` (Heart < 50%: +35% dmg and speed), Dragon `dragons_hoard`
  (+10% per chest). src `{team:'dm', kind: isBoss?'boss':'monster', id:type, ent:m, elem}`.
- Kits: skeleton respawns at post after `respawn` s (4 s `bone_yard`) — state `respawn`,
  `respawnT`; goblin (`sticky_fingers` → `Econ.gain(2, …)` per hit); orc knockback 0.6 tile on hit
  (don't push into walls) + `warcry` taunt handled by Heroes; spider web every `webCd` at a hero
  within `webRange` (`Proj` kind 'web', on hit slow `webSlow` for `webDur`; `web_weaver`: root 1 s
  + splash radius 1); imp keeps 2.5–4 tiles away, fire bolts (`infernal_pact`: +1 range, burn 4/s 3 s);
  wraith phasing + life drain (`drain`), `spectral_host` 25% fear 1.5 s on hit;
  mimic: `disguised=true` at wave start; ambush when a hero comes within 1.1 tiles: bite
  `ambushDmg` (×1.5 `mimicry`) + root 1 s, roar, then fights; re-disguises after 5 s with no heroes
  within 3 and back at post.
- **Bosses** (`abilityT` counts down from `abilityCd`, show `abilityName`):
  Minotaur Charge (hero in a straight open row/column within `chargeRange`: dash at ~9 tiles/s
  until a wall or range end, `chargeDmg` + stun 1 s + knockback to all heroes passed; cd ×0.65
  `labyrinth_lord`), Lich Raise Dead (up to `raiseCount` (+1 `dark_pact`) corpses from
  `S.corpses` within `raiseRange` → remove corpse, `summon('skeleton', …, {temp:true, risen:true})`;
  shadow-bolt ranged attack), Dragon Fire Breath (cone toward the densest nearby group:
  length `breathLen`, half-angle ~35°, `breathDmg` + burn 8/s 3 s; heavy FX: many fire
  particles along the cone, shake).
- `alarm(x,y,r,dur)`: every living monster within r gets `Status.apply(m,'buff',{dmg:1.5, spd:1.3, dur})`
  and moves to (x,y) (state chase toward that point; engages heroes it sees).
- `onWaveStart`: all placed monsters alive, full HP, at post, statuses cleared, bosses' ability ready
  after 2 s, mimics disguised (posts marked `broken` stay down). `onWaveEnd`: remove temp summons;
  heal surviving placed monsters at their posts; a slain placed non-skeleton monster or boss marks
  its post `broken` (revived only by `Build.repair`, cost = 30% of gold invested, via
  `Monsters.revive(m)`); skeletons always reassemble.
- `idle(dt)`: build-phase: keep monsters at posts, gentle bob (no AI).

### 4.4 `Waves`, `Perks`, `Powers` (src/40_director.js)
**Waves**: `generate(n)`, `begin(preview)`, `update(dt)`, `done()`, `remaining()` (heroes not yet spawned).
- Seeded by `mulberry32(S.seed * 31 + n * 977)`. Budget ≈ `5 + 3n + floor(n^1.5 / 2)` threat points
  (tune so waves 1–3 are small: w1 ≈ 3 heroes, w5 ≈ 8 + boss, w10 ≈ 14, w20 ≈ 26).
  Classes allowed when `n ≥ minWave`. Elites from wave 6: chance `min(0.4, 0.04 + 0.025(n-6))`.
  Every 5th wave: a hero boss from `HERO_BOSS_ORDER[(n/5 - 1) % 4]` leading the first party, and a
  slightly smaller escort budget.
- **Adaptive Guild** (from wave 4, stronger from 8): score the player's build — traps
  (count/value, hidden ones), monsters (count/value), walls (count / path length vs straight
  distance), chests. Bias class weights to counter it: many traps → Rogues/Rangers (and Miners if
  walls are long), many monsters → Warriors/Mages/Clerics/Paladins, long mazes → Mages/Miners,
  many chests → Rogues. Produce 1–2 `guildNotes` explaining the counter.
- Parties of 2–5, first leaves immediately, then every 5–9 s (`delay`). `begin` schedules them;
  `update` spawns via `Heroes.spawnParty`. `done()` true once all spawned.
**Perks**: `roll(n)` → up to n distinct offerable ids; `take(id)`; `available()` → offerable perk
defs; `rarityWeight(r)`.
- Offerable: not owned (unless `repeatable`), `req` unlocked, `unlocks` → at least one target still
  locked. Rarity weighting from `RARITY` (after boss waves: legendary/epic weight ×2 and at least
  one rare+). Prefer not to offer two repeatables in one roll. If the pool runs dry, fill with
  repeatables.
- `take(id)`: `S.perks[id]=(S.perks[id]||0)+1`, `S.perkOrder.push(id)`, immediate effects:
  treasury (+150 gold via `Econ.gain`), mend (`heartMax += 10`, heal 35), glass_cannon
  (`heartMax = round(heartMax*0.7)`, clamp hp), reinforced (double `maxHp`/`hp` of existing
  barricades), unlock perks (`Game.unlock(cat,id)` for each + toast). Toast the perk name.
**Powers**: `onWaveStart()`, `update(dt)`, `cost(id)`, `canCast(id)` → `{ok, reason}`, `ready(id)`,
`cast(id, wx, wy)` → bool, `cooldown(id)` → remaining s.
- Mana regen `CFG.manaRegen` × (1.4 `mana_spring`) + 0.5 per Mana Well (unbroken) per second,
  cap `S.manaMax`. Cooldowns in `S.powerCd`. Cost × 0.7 `overcharge` (round).
- collapse: `Grid.collapse(tx, ty, POWERS.collapse.dmg)` (validates path; if it returns false,
  refund nothing and report reason from `Grid.canCollapse`).
- fear: nearest living hero within 0.9 of the click → `Status.apply(h,'fear',{dur, x:h.x, y:h.y})`
  (if immune → reason 'Immune to fear', no mana spent); purple FX + `SFX.play('fear')`.
- lightning: heroes within `radius` of (wx,wy): `dmg` + stun; `chain_lightning` → up to 3 more
  heroes within 3 tiles of the strike take 50% (FX.beam jag between them). Big FX: beam from
  above, flash, shake, `SFX.play('lightning')`.
- reset: `Traps.resetAll()`, FX + `SFX.play('reset')`.
- Only during `S.phase === 'wave'` and not while `S.endingT >= 0`.

### 4.5 `Render` & `Sprites` (src/50_render.js)
Render exports: `init(canvas)`, `resize()`, `draw(dtReal)`, `screenToWorld(clientX, clientY)` →
`{wx, wy, tx, ty, inside}`. Sprites exports: `iconURL(kind, id)` → PNG data URL (cached) for
kinds `'wall','trap','monster','boss','object','hero','heroBoss','tile'`, plus anything else you
need internally.
- Canvas backing size = `S.cols*TS*RS × S.rows*TS*RS`; RS is 2 for crisp text, dropping to 1 automatically when the board is shown at ≤ 1 device px per canvas px (no visible loss, far fewer pixels to rasterize);
  `imageSmoothingEnabled=false`. The canvas is CSS-scaled by the UI layout to fit its container
  (keep aspect ratio; do the fitting in `resize()` using the parent element's size, and call it
  on window resize). `screenToWorld` must invert that exactly.
- **Pixel-art sprites** generated at init from small pixel maps (e.g. 16×16 char grids + palette)
  drawn to offscreen canvases. Distinct silhouettes & colours: 7 hero classes (use
  `HERO_CLASSES[].color` as the main accent), 4 hero bosses (bigger, crowned/aura), 7 monsters,
  3 bosses (drawn ~1.6× tile), 8 traps (armed / triggered frames), 5 objects, tiles (floor
  variants by `deco`, brick wall with top face, natural rock, rubble, entrance archway/portal,
  Heart). Dark dungeon palette with warm torch accents.
- Static layer (tiles + structures that don't animate) cached to an offscreen canvas and
  redrawn only when `S.pathVersion`/grid size changes; animated things each frame.
- Draw order: floor → danger overlay (`S.ui.showDanger`: red tint by `S.danger`) → traps/objects
  (hidden traps drawn at ~55% alpha with a small closed-eye mark; revealed with a '!' badge;
  broken with cracks/grey; disarmed with a crossed tag) → build-phase path preview
  (`S.ui.showPath`: animated dotted line along `Path.preview()`) → corpses → entities sorted by y
  (monsters incl. disguised mimic drawn as a chest; heroes with class sprite, elite gold outline,
  boss scale/aura, walking bob, facing flip, hit flash white, `risen` purple tint, invisible heroes
  at 35% alpha) → projectiles → walls' top faces over entities if you do pseudo-3D → lighting
  overlay (darkness with light pools: torches (flicker), Heart (red, pulsing), entrance, fire
  vents/flames, mana wells, fire projectiles, heroes carry a faint lantern) → HP bars (heroes
  green/yellow/red; monsters red; bosses bigger), status icons (burn, bleed, slow, stun stars,
  fear, root/web, exposed eye, loot sack, buff), channel progress bars, boss ability cooldown
  rings → FX (particles, rings, beams incl. jagged lightning, tile flashes, floating text with
  dark outline) → UI overlays: hover ghost of `S.ui.tool` at `S.ui.hover` (green if
  `Build.canPlace` ok, red otherwise, plus a 'blocks path' warning style when `.blocks`), range
  preview (arrow lines, alarm/torch/guard radii) for the tool and for the selected structure
  (`S.ui.selected`), subtle grid lines in build phase, power targeting reticle for `S.ui.power`
  (radius for lightning, tile for collapse, hero highlight for fear) → screen flash.
  Apply `FX.shakeX/Y` (pixels) as a translate for the world layers.
- The Heart pulses (scale + glow), shows cracks as HP drops, flashes on `S.heartHitT`.
- Title phase: draw the dungeon dimmed (the UI overlay sits on top).
- Target 60 fps with ~80 entities + 900 particles: avoid per-frame allocations, avoid
  `shadowBlur` in hot loops, reuse gradients where possible.

### 4.6 `UI` (src/60_ui.js + src/shell.html)
Exports: `init()`, `update(dtReal)`, `onPhase(phase)`, `showTitle()`, `showReward(summary,
choices)`, `showGameOver(report)`, `toast(msg, kind)` (kind: 'info'|'good'|'warn'|'bad'),
`refresh()` (rebuild panels).
- `shell.html`: full document (doctype, meta viewport, `<title>Dungeon Heart</title>`, all CSS
  inline in `<style>`), the layout markup, and the `<!--GAME_SCRIPT-->` placeholder right before
  `</body>`. Contains `<canvas id="board">` inside a board container. No external resources
  (system font stack; a pixel-ish look via CSS). Dark dungeon theme, warm gold accents, rarity
  colours from `RARITY`.
- Layout: top bar (logo, Wave N (+boss badge), Gold, Mana bar, Heart HP bar, best wave, speed
  1×/2×/4×, pause, mute, overlay toggles Path/Memory, help) · left: build panel with tabs from
  `BUILD_TABS` — item cards with `Sprites.iconURL` icon, name, cost (red if unaffordable, perk-
  adjusted via `Build.cost`), short desc, lock state + unlock wave; below it the **inspector** for
  `S.ui.selected` (name, level, `Traps.describe/Monsters.describe/Objects.describe` lines, Upgrade
  (cost), Repair (cost), Sell (value) buttons) and a "Repair all (Xg)" button when anything is broken ·
  centre: canvas board, big **Start Wave** button + hint text under it · right: during build the
  **Incoming wave** preview (party rows with hero icons, elite markers, boss card with its
  ability, guild notes, total count) and during waves the live status (heroes left incl. unspawned
  `Waves.remaining()`, boss HP bar, **DM Powers** buttons with icon, key, mana cost, cooldown
  sweep, disabled state) · **Perks** sidebar (icons with rarity-coloured borders, stack count,
  tooltip) · toast stack.
- Modals: Title (logo, tagline, New Run, best run from `Save.data`, how-to-play), Reward
  (summary stats: kills, gold from kills, wave income, interest, Heart damage, escaped/stolen,
  boss result, broken traps & repair cost, "dungeon expands" notice; then 3 perk cards
  (rarity colour, icon, name, desc, tradeoff badge, unlock badge); each card has
  `data-perk="<id>"`; click or keys 1/2/3 → `Game.pickPerk(id)`), Game Over (waves survived,
  heroes slain, elites, bosses, gold earned, gold stolen, favourite trap, perks list, best run,
  "New best!" badge, Restart → `Game.newRun()`), Help overlay.
- **Input** (canvas): `Render.screenToWorld` → keep `S.ui.hover` updated (null when outside).
  Build phase: left click / drag = place `S.ui.tool` (drag paints walls/any tool across tiles,
  one attempt per tile per drag); with no tool, left click selects a tile's structure/wall
  (`S.ui.selected`); right click = sell what's under the cursor (or cancel the tool on empty
  tiles); Esc = clear tool/selection. Show `Build.canPlace(...).reason` as a toast on failed
  placement (throttled). Wave phase: Q/W/E/R or power buttons arm `S.ui.power`; next click on the
  board calls `Powers.cast(id, wx, wy)` (for 'none' targets cast immediately); right click/Esc
  cancels. Space = pause/resume (wave), Enter = Start Wave (build). Speed keys 1/2/3 during waves
  are fine (reward-phase 1/2/3 pick perks instead). H or ? toggles help. M toggles mute
  (`SFX.setMuted`, persist in `Save.data.muted` + `Save.write()`).
- **Tooltips** (DOM, follows mouse, never off-screen): board hover → entity under cursor
  (`Spatial.entityAt`) else tile structure/wall: heroes (name, class, elite/boss, HP, state via
  `Heroes.stateLabel`, loot carried, active statuses), monsters (name, level, HP, state, ability
  cooldown), structures (name, level, describe lines, hidden/revealed/broken/disarmed status,
  sell value), walls/rock/entrance/Heart (short text; Heart shows HP). Build cards, power buttons,
  perk icons, wave-preview icons all have tooltips.
- `update(dtReal)`: refresh HUD numbers/bars at ~10 Hz (cheap DOM writes only when values
  change), power cooldown sweeps, button enabled states, affordability colouring.
- Must work at 1280×720 and scale up nicely to 1920×1080; on narrow screens (< 1100 px) stack
  panels so nothing overflows horizontally.
