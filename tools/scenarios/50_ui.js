// UI flow sanity (DOM-level; independent of exact markup where possible).
(() => {
  const add = (name, run, tags = ['ui']) => window.SCENARIOS.push({ name, run, tags });
  const visibleText = () => document.body.innerText || '';

  add('ui: reward modal offers 3 perk cards and picking one advances', async H => {
    const S = H.S;
    H.startWave();
    const h = H.hero('rogue', 3, S.entrance.y);
    H.DH.Combat.damage(h, 9999, { team: 'dm', kind: 'power', id: 'x' });
    H.until(() => S.phase === 'reward', 10);
    const cards = [...document.querySelectorAll('[data-perk]')].filter(e => e.offsetParent !== null);
    H.assert(cards.length === 3, 'three visible perk cards (' + cards.length + ')');
    const id = cards[1].getAttribute('data-perk');
    await new Promise(r => setTimeout(r, 1200)); // the UI ignores clicks for a moment to prevent accidental picks
    cards[1].click();
    await new Promise(r => setTimeout(r, 100));
    H.assert(S.phase === 'build' && S.perks[id], 'picked ' + id);
  });

  add('ui: game over screen offers a restart', H => {
    const S = H.S;
    H.startWave();
    H.DH.Heart.damage(9999);
    H.until(() => S.phase === 'gameover', 5);
    H.assert(/restart|new run|try again/i.test(visibleText()), 'restart visible');
  });

  add('ui: toasts do not throw and HUD shows gold', H => {
    H.DH.UI.toast('Test toast', 'good');
    H.DH.UI.update(0.2); H.DH.UI.update(0.2);
    H.assert(visibleText().includes(String(H.S.gold)) || visibleText().includes(H.S.gold.toLocaleString('en-US')), 'gold shown');
  });

  add('ui: every build item has an icon data URL', H => {
    for (const tab of BUILD_TABS) for (const [cat, id] of tab.items) {
      const url = typeof Sprites !== 'undefined' ? Sprites.iconURL(cat === 'wall' ? 'wall' : cat, id) : '';
      H.assert(typeof url === 'string' && url.startsWith('data:image'), `icon ${cat}:${id}`);
    }
    for (const id of Object.keys(HERO_CLASSES)) H.assert(Sprites.iconURL('hero', id).startsWith('data:image'), 'hero icon ' + id);
    for (const id of Object.keys(HERO_BOSSES)) H.assert(Sprites.iconURL('heroBoss', id).startsWith('data:image'), 'hero boss icon ' + id);
  });
})();
