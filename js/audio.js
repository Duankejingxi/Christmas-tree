// 实时合成的圣诞小乐队（无需音频文件）
// 编曲：Jingle Bells（公有领域）— 八音盒+钟琴旋律、雪橇铃、拨弦贝斯、柔和和弦
const F = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI → Hz
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const m = (s) => { // 'E5' → midi
  const n = NOTE[s[0]] + (s[1] === '#' ? 1 : 0);
  return 12 * (parseInt(s.slice(-1), 10) + 1) + n;
};

// 旋律 [音, 拍]，null 为休止
const MELODY = [
  // 副歌 A
  ['E5', 1], ['E5', 1], ['E5', 2], ['E5', 1], ['E5', 1], ['E5', 2],
  ['E5', 1], ['G5', 1], ['C5', 1.5], ['D5', 0.5], ['E5', 4],
  ['F5', 1], ['F5', 1], ['F5', 1.5], ['F5', 0.5], ['F5', 1], ['E5', 1], ['E5', 1], ['E5', 0.5], ['E5', 0.5],
  ['E5', 1], ['D5', 1], ['D5', 1], ['E5', 1], ['D5', 2], ['G5', 2],
  // 副歌 B
  ['E5', 1], ['E5', 1], ['E5', 2], ['E5', 1], ['E5', 1], ['E5', 2],
  ['E5', 1], ['G5', 1], ['C5', 1.5], ['D5', 0.5], ['E5', 4],
  ['F5', 1], ['F5', 1], ['F5', 1.5], ['F5', 0.5], ['F5', 1], ['E5', 1], ['E5', 1], ['E5', 0.5], ['E5', 0.5],
  ['G5', 1], ['G5', 1], ['F5', 1], ['D5', 1], ['C5', 3], [null, 1],
];
// 每小节和弦（16 小节）
const CHORDS = ['C', 'C', 'C', 'C', 'F', 'C', 'D7', 'G7', 'C', 'C', 'C', 'C', 'F', 'C', 'G7', 'C'];
const CHORD_NOTES = {
  C: ['C4', 'E4', 'G4'], F: ['F3', 'A3', 'C4'], G7: ['G3', 'B3', 'F4'], D7: ['D4', 'F#4', 'C5'],
};
const BASS = { C: ['C3', 'G2'], F: ['F2', 'C3'], G7: ['G2', 'D3'], D7: ['D3', 'A2'] };
const BEAT = 0.4; // 150 BPM
const BAR = BEAT * 4;
const PENTA = [72, 74, 76, 79, 81, 84];

export class Sound {
  constructor() {
    this.ctx = null;
    let pref = null;
    try { pref = localStorage.getItem('xmas.sound'); } catch (e) { /* ignore */ }
    this.enabled = pref !== 'off';
    this.playing = false;
  }

  _init() {
    if (this.ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.9 : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);
    // 混响
    const len = Math.floor(ctx.sampleRate * 2.2);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    this.verb = ctx.createConvolver();
    this.verb.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.28;
    this.verb.connect(wet).connect(this.master);
    this.dry = ctx.createGain();
    this.dry.connect(this.master);
    // 白噪声（雪橇铃 / 烟花）
    const nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.noise = nb;
    return true;
  }

  unlock() {
    if (!this._init()) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  _env(t, a, peak, dur, dest, wetToo = true) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(dest || this.dry);
    if (wetToo) g.connect(this.verb);
    return g;
  }
  _osc(type, freq, t, dur, g, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // 八音盒 + 钟琴（高八度）
  _bell(midi, t, dur, vol) {
    const f = F(midi);
    const g = this._env(t, 0.003, vol, dur);
    [[1, 1], [2, 0.28], [3, 0.08], [4.2, 0.05]].forEach(([k, a]) => {
      const og = this.ctx.createGain();
      og.gain.value = a;
      og.connect(g);
      this._osc('sine', f * k, t, dur, og);
    });
    const g2 = this._env(t, 0.002, vol * 0.35, dur * 0.6);
    this._osc('triangle', f * 2, t, dur * 0.6, g2);
  }
  _bass(midi, t) {
    const g = this._env(t, 0.005, 0.16, 0.55, this.dry, false);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + 0.4);
    lp.connect(g);
    this._osc('triangle', F(midi), t, 0.55, lp);
    this._osc('sine', F(midi) / 2, t, 0.55, lp);
  }
  _pad(notes, t, dur) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.028, t + 0.25);
    g.gain.setValueAtTime(0.028, t + dur - 0.2);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.3);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    lp.connect(g);
    g.connect(this.dry);
    g.connect(this.verb);
    notes.forEach((n) => {
      this._osc('sawtooth', F(m(n)), t, dur + 0.3, lp, -7);
      this._osc('sawtooth', F(m(n)), t, dur + 0.3, lp, 7);
    });
  }
  _jingle(t, vol) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 7800;
    bp.Q.value = 1.4;
    const g = this._env(t, 0.002, vol, 0.12, this.dry, false);
    src.connect(bp).connect(g);
    src.start(t, Math.random() * 0.5, 0.15);
  }

  startMusic() {
    if (!this._init() || this.playing) return;
    this.playing = true;
    this.t0 = this.ctx.currentTime + 0.1;
    this.mi = 0;
    this.mt = this.t0;
    this.bar = 0;
    this.tick = () => {
      if (!this.playing) return;
      const horizon = this.ctx.currentTime + 0.5;
      // 旋律
      while (this.mt < horizon) {
        const [n, beats] = MELODY[this.mi];
        if (n) this._bell(m(n), this.mt, 0.9 + beats * 0.25, 0.085);
        this.mt += beats * BEAT;
        this.mi = (this.mi + 1) % MELODY.length;
      }
      // 伴奏按小节排
      while (this.t0 + this.bar * BAR < horizon) {
        const t = this.t0 + this.bar * BAR;
        const ch = CHORDS[this.bar % CHORDS.length];
        this._pad(CHORD_NOTES[ch], t, BAR);
        const [r, f] = BASS[ch];
        this._bass(m(r), t);
        this._bass(m(f), t + BEAT * 2);
        for (let k = 0; k < 8; k++) this._jingle(t + k * BEAT / 2, k % 2 ? 0.032 : 0.058);
        this.bar++;
      }
    };
    this.timer = setInterval(this.tick, 80);
    this.tick();
  }

  stopMusic() {
    this.playing = false;
    clearInterval(this.timer);
  }

  chime(count = 3) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < count; i++) {
      this._bell(PENTA[(Math.random() * PENTA.length) | 0] + 12, t + i * 0.06 + Math.random() * 0.03, 0.9, 0.04);
    }
  }

  boom(strength = 1) {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.8);
    const g = this._env(t, 0.005, 0.12 * strength, 1.0);
    src.connect(lp).connect(g);
    src.start(t, 0, 1);
    for (let i = 0; i < 6; i++) this._jingle(t + 0.25 + Math.random() * 0.6, 0.03 * strength);
  }

  toggle() {
    this.enabled = !this.enabled;
    try { localStorage.setItem('xmas.sound', this.enabled ? 'on' : 'off'); } catch (e) { /* ignore */ }
    if (this.ctx) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(this.enabled ? 0.9 : 0, this.ctx.currentTime, 0.15);
    }
    return this.enabled;
  }
}
