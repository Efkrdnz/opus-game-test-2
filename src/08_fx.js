/* =============================================================================
 *  08 FX & AUDIO — visual effect data (drawn by Render) and a tiny Web Audio
 *  synthesizer for sound effects (no audio files).
 * ========================================================================== */

/* -----------------------------------------------------------------------------
 * 1. VISUAL EFFECTS
 *    Everything lives in world (tile) coordinates and simulation time.
 *    Render reads: FX.parts, FX.texts, FX.rings, FX.beams, FX.tileFlashes,
 *                  FX.screenFlash, FX.shakeX/shakeY.
 * -------------------------------------------------------------------------- */
const FX = {
  parts: [],       // {x,y,vx,vy,life,max,size,color,grav,drag,glow}
  texts: [],       // {x,y,vy,str,color,size,life,max}
  rings: [],       // {x,y,r0,r1,color,width,life,max}
  beams: [],       // {x0,y0,x1,y1,color,width,life,max,jag:[offsets]}
  tileFlashes: [], // {x,y,color,life,max}
  screenFlash: null, // {color,life,max}
  shakeMag: 0, shakeX: 0, shakeY: 0,
  MAX_PARTS: 900,

  clear() {
    this.parts.length = 0; this.texts.length = 0; this.rings.length = 0;
    this.beams.length = 0; this.tileFlashes.length = 0; this.screenFlash = null; this.shakeMag = 0;
  },

  /**
   * Particle burst. o: { n, color|colors[], speed, life, size, grav, drag, glow,
   *                      dir:[dx,dy] + spread (radians) for directional sprays }
   */
  burst(x, y, o = {}) {
    const n = o.n ?? 8;
    const cols = o.colors || [o.color || '#fff'];
    for (let i = 0; i < n; i++) {
      if (this.parts.length >= this.MAX_PARTS) this.parts.shift();
      let ang = Math.random() * Math.PI * 2;
      if (o.dir) ang = Math.atan2(o.dir[1], o.dir[0]) + (Math.random() - 0.5) * (o.spread ?? 0.8);
      const sp = (o.speed ?? 2) * (0.35 + Math.random() * 0.8);
      const life = (o.life ?? 0.6) * (0.6 + Math.random() * 0.6);
      this.parts.push({
        x: x + (Math.random() - 0.5) * (o.jitter ?? 0.15), y: y + (Math.random() - 0.5) * (o.jitter ?? 0.15),
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        life, max: life, size: (o.size ?? 2) * (0.7 + Math.random() * 0.6),
        color: cols[(Math.random() * cols.length) | 0], grav: o.grav ?? 0, drag: o.drag ?? 1.5, glow: !!o.glow,
      });
    }
  },
  /** Floating text (damage numbers, gold, callouts). o: {size, vy, life} */
  text(x, y, str, color = '#fff', o = {}) {
    if (this.texts.length > 120) this.texts.shift();
    // Lift the new text above any text that just appeared at the same spot, so simultaneous
    // hits read as separate numbers (e.g. "10" and "3", not "103").
    for (let pass = 0; pass < 6; pass++) {
      let bumped = false;
      for (const t of this.texts) {
        if (t.max - t.life < 0.35 && Math.abs(t.x - x) < 0.7 && Math.abs(t.y - y) < 0.3) { y = t.y - 0.34; bumped = true; }
      }
      if (!bumped) break;
    }
    const life = o.life ?? 0.9;
    this.texts.push({ x, y, vy: o.vy ?? -1.1, str: String(str), color, size: o.size ?? 11, life, max: life });
  },
  /** Expanding ring. o: {color, r0, r1, life, width} (radii in tiles) */
  ring(x, y, o = {}) {
    const life = o.life ?? 0.5;
    this.rings.push({ x, y, r0: o.r0 ?? 0.2, r1: o.r1 ?? 1.5, color: o.color || '#fff', width: o.width ?? 2, life, max: life });
  },
  /** Beam / bolt between two points. o: {color, width, life, jag (bool: lightning zig-zag)} */
  beam(x0, y0, x1, y1, o = {}) {
    const life = o.life ?? 0.25;
    let jag = null;
    if (o.jag) { jag = []; const segs = Math.max(3, Math.round(dist(x0, y0, x1, y1) * 2.5)); for (let i = 0; i <= segs; i++) jag.push(i === 0 || i === segs ? 0 : (Math.random() - 0.5) * 0.5); }
    this.beams.push({ x0, y0, x1, y1, color: o.color || '#fff', width: o.width ?? 2, life, max: life, jag });
  },
  /** Briefly tint a tile (e.g. rejected placement). */
  flashTile(x, y, color = '#ff2020', life = 0.5) { this.tileFlashes.push({ x, y, color, life, max: life }); },
  shake(mag) { this.shakeMag = Math.min(18, Math.max(this.shakeMag, mag)); },
  flash(color = '#fff', life = 0.2) { this.screenFlash = { color, life, max: life }; },

  update(dt) {
    // Floating text and camera shake are for the player's eyes: at 2×/4× speed they advance at
    // real-time pace (the sim runs several steps per frame), so numbers stay readable.
    const k = (S && S.phase === 'wave' && S.speed > 1) ? 1 / S.speed : 1;
    const dtr = dt * k;
    for (const p of this.parts) {
      p.life -= dt;
      p.vy += p.grav * dt;
      const d = Math.max(0, 1 - p.drag * dt);
      p.vx *= d; p.vy *= d;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    this.parts = this.parts.filter(p => p.life > 0);
    for (const t of this.texts) { t.life -= dtr; t.y += t.vy * dtr; t.vy *= Math.max(0, 1 - 1.8 * dtr); }
    this.texts = this.texts.filter(t => t.life > 0);
    for (const r of this.rings) r.life -= dt;
    this.rings = this.rings.filter(r => r.life > 0);
    for (const b of this.beams) b.life -= dt;
    this.beams = this.beams.filter(b => b.life > 0);
    for (const f of this.tileFlashes) f.life -= dt;
    this.tileFlashes = this.tileFlashes.filter(f => f.life > 0);
    if (this.screenFlash) { this.screenFlash.life -= dt; if (this.screenFlash.life <= 0) this.screenFlash = null; }
    if (this.shakeMag > 0.05) {
      this.shakeX = (Math.random() * 2 - 1) * this.shakeMag;
      this.shakeY = (Math.random() * 2 - 1) * this.shakeMag;
      this.shakeMag *= Math.max(0, 1 - 9 * dtr);
    } else { this.shakeMag = 0; this.shakeX = this.shakeY = 0; }
  },
};

/* -----------------------------------------------------------------------------
 * 2. SOUND — synthesized with the Web Audio API. SFX.play(name) is safe to call
 *    any time (no-ops until the first user gesture unlocks audio, or if muted).
 * -------------------------------------------------------------------------- */
const SFX = {
  ctx: null, master: null, muted: false, _last: {}, _noiseBuf: null, _active: 0,

  /** Must be called from a user gesture (click/keydown) to satisfy autoplay rules. */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.35;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 1.0;
      this._noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this._noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { this.ctx = null; }
  },
  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.35;
  },

  /** Oscillator voice with pitch slide and exponential decay. */
  tone(freq, dur, type = 'square', vol = 0.2, slideTo = null, delay = 0) {
    const c = this.ctx, t0 = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  },
  /** Filtered noise burst. */
  noise(dur, vol = 0.2, freq = 1200, ftype = 'lowpass', delay = 0, q = 1) {
    const c = this.ctx, t0 = c.currentTime + delay;
    const src = c.createBufferSource(); src.buffer = this._noiseBuf;
    const f = c.createBiquadFilter(); f.type = ftype; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t0, Math.random() * 0.5); src.stop(t0 + dur + 0.02);
  },

  play(name) {
    if (!this.ctx || this.muted || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const gap = { gold: 0.06, hit: 0.05, heroHit: 0.05, arrow: 0.05, spike: 0.05, fire: 0.08, heart: 0.08 }[name] ?? 0.035;
    if (this._last[name] && now - this._last[name] < gap) return;
    this._last[name] = now;
    try {
      switch (name) {
        case 'click': this.tone(660, 0.05, 'square', 0.08); break;
        case 'place': this.tone(220, 0.08, 'square', 0.12, 140); this.noise(0.06, 0.08, 900); break;
        case 'sell': this.tone(520, 0.07, 'square', 0.1, 780); this.tone(900, 0.06, 'square', 0.07, null, 0.05); break;
        case 'error': this.tone(160, 0.14, 'sawtooth', 0.12, 110); break;
        case 'upgrade': [523, 659, 784].forEach((f, i) => this.tone(f, 0.1, 'square', 0.09, null, i * 0.06)); break;
        case 'spike': this.noise(0.08, 0.25, 3200, 'highpass'); this.tone(900, 0.05, 'square', 0.08, 300); break;
        case 'arrow': this.noise(0.12, 0.15, 2500, 'bandpass', 0, 2); break;
        case 'pit': this.tone(400, 0.5, 'triangle', 0.18, 60); this.noise(0.3, 0.1, 400); break;
        case 'fire': this.noise(0.45, 0.22, 700, 'lowpass'); this.tone(90, 0.3, 'sawtooth', 0.06, 60); break;
        case 'slime': this.tone(180, 0.12, 'sine', 0.12, 90); break;
        case 'boulder': this.noise(0.6, 0.3, 220, 'lowpass'); this.tone(60, 0.5, 'triangle', 0.2, 40); break;
        case 'teleport': this.tone(300, 0.25, 'sine', 0.14, 1400); this.tone(600, 0.25, 'triangle', 0.08, 2000, 0.05); break;
        case 'alarm': [880, 660, 880, 660].forEach((f, i) => this.tone(f, 0.09, 'square', 0.1, null, i * 0.1)); break;
        case 'hit': this.noise(0.05, 0.16, 1500); this.tone(180, 0.05, 'square', 0.06, 120); break;
        case 'heroHit': this.noise(0.05, 0.12, 2000); break;
        case 'heroDie': this.tone(420, 0.3, 'square', 0.12, 90); this.noise(0.15, 0.1, 900); break;
        case 'monsterDie': this.tone(200, 0.25, 'sawtooth', 0.1, 70); break;
        case 'gold': this.tone(1320, 0.05, 'square', 0.06); this.tone(1760, 0.07, 'square', 0.05, null, 0.04); break;
        case 'steal': this.tone(700, 0.25, 'square', 0.1, 200); break;
        case 'heart': this.tone(70, 0.25, 'sine', 0.35, 45); this.noise(0.1, 0.12, 300); break;
        case 'waveStart': this.tone(196, 0.5, 'sawtooth', 0.12); this.tone(294, 0.6, 'sawtooth', 0.1, null, 0.18); this.noise(0.4, 0.06, 500); break;
        case 'waveEnd': [392, 494, 587, 784].forEach((f, i) => this.tone(f, 0.18, 'square', 0.09, null, i * 0.09)); break;
        case 'boss': this.tone(98, 0.8, 'sawtooth', 0.18, 49); this.noise(0.6, 0.15, 300); this.tone(147, 0.6, 'square', 0.08, null, 0.2); break;
        case 'lightning': this.noise(0.5, 0.4, 5000, 'highpass'); this.noise(0.6, 0.3, 200, 'lowpass', 0.03); break;
        case 'fear': this.tone(300, 0.5, 'sine', 0.12, 150); this.tone(311, 0.5, 'sine', 0.12, 140); break;
        case 'collapse': this.noise(0.5, 0.35, 300, 'lowpass'); this.tone(55, 0.4, 'triangle', 0.25, 35); break;
        case 'reset': [300, 450, 600, 900].forEach((f, i) => this.tone(f, 0.08, 'triangle', 0.1, null, i * 0.05)); break;
        case 'perk': [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.16, 'triangle', 0.11, null, i * 0.07)); break;
        case 'gameover': [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.4, 'sawtooth', 0.1, null, i * 0.25)); break;
        case 'heal': this.tone(700, 0.15, 'sine', 0.07, 1100); break;
        case 'blast': this.noise(0.4, 0.3, 900); this.tone(120, 0.3, 'sawtooth', 0.15, 50); break;
        case 'dig': this.noise(0.07, 0.2, 1200, 'bandpass', 0, 3); break;
        case 'magic': this.tone(900, 0.12, 'sine', 0.07, 500); break;
        case 'web': this.noise(0.1, 0.1, 3000, 'bandpass', 0, 4); break;
        case 'roar': this.tone(90, 0.6, 'sawtooth', 0.18, 60); this.noise(0.5, 0.15, 400); break;
        case 'bite': this.noise(0.08, 0.25, 800); this.tone(140, 0.1, 'square', 0.12, 80); break;
        case 'unlock': [659, 784, 988].forEach((f, i) => this.tone(f, 0.12, 'square', 0.08, null, i * 0.08)); break;
        case 'charge': this.noise(0.5, 0.25, 400); this.tone(110, 0.4, 'sawtooth', 0.15, 180); break;
        case 'breath': this.noise(0.9, 0.35, 900, 'lowpass'); this.tone(80, 0.8, 'sawtooth', 0.12, 50); break;
        case 'raise': this.tone(200, 0.6, 'triangle', 0.12, 400); this.tone(207, 0.6, 'sine', 0.1, 420); break;
        case 'loot': this.tone(988, 0.06, 'square', 0.07); this.tone(1319, 0.08, 'square', 0.06, null, 0.06); break;
        case 'disarm': this.tone(1200, 0.05, 'square', 0.06); this.tone(800, 0.05, 'square', 0.06, null, 0.06); break;
        case 'reveal': this.tone(1500, 0.08, 'sine', 0.06, 1000); break;
      }
    } catch (e) { /* ignore audio errors */ }
  },
};
