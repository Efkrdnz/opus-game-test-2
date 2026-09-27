/* =============================================================================
 *  99 MAIN — boot and the fixed-timestep loop.
 *  Simulation runs at 60 Hz (SIM_DT); speed controls run 1/2/4 steps per tick.
 * ========================================================================== */
const Main = {
  last: 0,
  acc: 0,
  errors: 0,

  boot() {
    Save.load();
    SFX.muted = !!Save.data.muted;
    Render.init(document.getElementById('board'));
    UI.init();
    Game.toTitle();
    const unlockAudio = () => SFX.unlock();
    window.addEventListener('pointerdown', unlockAudio);
    window.addEventListener('keydown', unlockAudio);
    requestAnimationFrame(t => { Main.last = t; requestAnimationFrame(Main.frame); });
  },

  frame(t) {
    const dtReal = Math.min(0.1, Math.max(0, (t - Main.last) / 1000));
    Main.last = t;
    try {
      if (S && !S.paused) {
        const mult = S.phase === 'wave' ? S.speed : 1;
        Main.acc += dtReal * mult;
        let steps = 0;
        while (Main.acc >= SIM_DT && steps < 16) { Game.update(SIM_DT); Main.acc -= SIM_DT; steps++; }
        if (steps >= 16) Main.acc = 0; // don't spiral if the tab stalls
      }
      Render.draw(dtReal);
      UI.update(dtReal);
    } catch (e) {
      // Keep the game alive; surface the first few errors for debugging.
      if (Main.errors++ < 5) console.error(e);
    }
    requestAnimationFrame(Main.frame);
  },
};

// Debug / automated-test handle (harmless in normal play).
window.DH = {
  get S() { return S; },
  Game, Build, Grid, Path, Danger, Combat, Status, Econ, Heart, FX, SFX, Save,
  get Heroes() { return Heroes; }, get Monsters() { return Monsters; }, get Traps() { return Traps; },
  get Objects() { return Objects; }, get Waves() { return Waves; }, get Perks() { return Perks; },
  get Powers() { return Powers; }, get Render() { return Render; }, get UI() { return UI; },
  /** Advance the simulation synchronously (for tests): n steps of SIM_DT. */
  step(n = 1) { for (let i = 0; i < n; i++) Game.update(SIM_DT); },
};

window.addEventListener('load', () => Main.boot());
