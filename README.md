# Dungeon Heart

A roguelike **reverse dungeon crawler** in a single HTML file. You are the Dungeon Master: build a deadly
maze, fill it with traps, monsters and treasure, and keep waves of adventurers away from your
**Dungeon Heart**. Survive as long as you can, growing stronger through perks between waves.

**To play:** open `index.html` in any modern browser. No install, no server, no assets. It works offline.

## How a run plays

1. **Build phase.** Spend gold on walls, traps, monsters, a boss, and objects. There's no time limit.
   The incoming wave's composition is shown on the right so you can plan. Press **Start Wave**.
2. **Wave phase.** Adventurer parties enter from the left and make for the Heart. You can't build,
   but you can use **Dungeon Master powers** (Q/W/E/R), which cost mana.
3. **Reward phase.** You get a summary of the wave, then pick **1 of 3 perks**.
   Every 5th wave is a **Hero Boss** wave. Every 10 waves the dungeon **expands**.

The run ends when the Heart's HP reaches zero. Your best run is saved in your browser.

## Key mechanics

- **You must leave a path.** Every wall placement is checked with a breadth-first search from the
  Entrance to the Heart. A placement that would seal the Heart is rejected with a red flash.
  Barricades don't count as blocking because heroes can smash through them.
- **Heroes learn.** Adventurers pathfind with weighted A*, and the weights include a persistent
  **danger memory**. Tiles where heroes died or traps were revealed become costly, and that memory
  fades a little after each wave. Reusing one kill-zone loses effectiveness. Moving your traps to where
  heroes *feel* safe pays off. Toggle **Memory** in the top bar to see what they remember. Heroes in
  early waves are naive; later heroes are much more cautious.
- **Hidden traps.** Most traps are hidden until they trigger or are detected. Rogues can spot and
  disarm them, and Rangers reveal them. Torchlight exposes them to heroes, but heroes standing in
  torchlight also take +25% damage.
- **Greed.** Treasure Chests (and Mimics) pull greedy heroes off-route. That's great for luring them
  into trap corridors, but a hero who escapes carrying treasure steals your gold.
- **The Adventurers' Guild adapts.** It notices what you build and sends counters. Trap-heavy
  dungeons draw Rogues and Rangers, long mazes draw Mages who blast walls and Dwarf Miners who dig,
  and monster-heavy dungeons draw Warriors, Paladins and Clerics.

## Controls

| Action | Input |
|---|---|
| Select build item | Click a card in the build panel |
| Place / paint | Left click / drag on the board |
| Inspect, upgrade, sell, repair | Click a built tile with no tool selected |
| Quick sell | Right click |
| Cancel tool / targeting | Esc or right click on empty floor |
| Start wave | Enter |
| DM powers | Q Collapse · W Fear · E Lightning · R Reset Traps |
| Pause / speed | Space · 1 / 2 / 3 (1×, 2×, 4×) |
| Help · Mute | H · M |

## Development

The shipped game is the single file `index.html`. It's assembled from organized sources:

```
src/shell.html        HTML + CSS layout
src/00_data.js        utilities, tuning constants, all content definitions (heroes, traps, monsters, perks…)
src/05_engine.js      grid, pathfinding (BFS validation + weighted A*), danger memory, combat, economy, building
src/08_fx.js          particles/floating text/screen shake + Web Audio synthesized sound
src/20_heroes.js      adventurer AI
src/30_traps.js       traps and dungeon objects
src/31_monsters.js    monsters and dungeon bosses
src/40_director.js    wave generation (adaptive guild), perks, Dungeon Master powers
src/50_render.js      procedural pixel-art sprites and canvas renderer
src/60_ui.js          DOM interface, tooltips and input
src/90_game.js        phase state machine and saving
src/99_main.js        boot and fixed-timestep loop
```

```sh
node build.mjs                       # rebuild index.html
node tools/smoke.mjs index.html      # headless smoke test (needs Playwright + Chromium)
node tools/playtest.mjs index.html --waves 25 --strategy mixed   # bot playthrough for balance
```

See `docs/SPEC.md` for the contract between modules.
