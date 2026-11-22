// 八音盒音乐 + 音效（全部用 WebAudio 实时合成，无需音频文件）
// 旋律：Jingle Bells（公有领域）

const N = { C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, C6: 1046.5,
  C3: 130.81, F3: 174.61, G3: 196.0, G2: 98.0 };

// [音, 拍数]
const MELODY = [
  ['E5', 1], ['E5', 1], ['E5', 2], ['E5', 1], ['E5', 1], ['E5', 2],
  ['E5', 1], ['G5', 1], ['C5', 1.5], ['D5', 0.5], ['E5', 4],
  ['F5', 1], ['F5', 1], ['F5', 1.5], ['F5', 0.5], ['F5', 1], ['E5', 1], ['E5', 1], ['E5', 0.5], ['E5', 0.5],
  ['E5', 1], ['D5', 1], ['D5', 1], ['E5', 1], ['D5', 2], ['G5', 2],
  ['E5', 1], ['E5', 1], ['E5', 2], ['E5', 1], ['E5', 1], ['E5', 2],
  ['E5', 1], ['G5', 1], ['C5', 1.5], ['D5', 0.5], ['E5', 4],
  ['F5', 1], ['F5', 1], ['F5', 1.5], ['F5', 0.5], ['F5', 1], ['E5', 1], ['E5', 1], ['E5', 0.5], ['E5', 0.5],
  ['G5', 1], ['G5', 1], ['F5', 1], ['D5', 1], ['C5', 4],
];
const BASS = ['C3', 'C3', 'C3', 'C3', 'F3', 'C3', 'G3', 'G3', 'C3', 'C3', 'C3', 'C3', 'F3', 'C3', 'G3', 'C3'];
const BEAT = 0.52;
const PENTA = [N.C5, N.D5, N.E5, N.G5, N.A5, N.C6];

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
    this.master.gain.value = this.enabled ? 1 : 0;
    this.master.connect(ctx.destination);
    // 简易混响
    const len = Math.floor(ctx.sampleRate * 2.6);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    this.verb = ctx.createConvolver();
    this.verb.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    this.verb.connect(wet).connect(this.master);
    this.dry = ctx.createGain();
    this.dry.gain.value = 0.8;
    this.dry.connect(this.master);
    return true;
  }

  // 用户手势后调用
  unlock() {
    if (!this._init()) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  _bell(freq, t, dur = 1.6, vol = 0.12) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(this.dry);
    g.connect(this.verb);
    const partials = [[1, 1], [2.01, 0.32], [3.0, 0.12], [4.17, 0.06]];
    for (const [m, a] of partials) {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq * m;
      og.gain.value = a;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  startMusic() {
    if (!this._init() || this.playing) return;
    this.playing = true;
    this.nextTime = this.ctx.currentTime + 0.15;
    this.idx = 0;
    this.beatPos = 0;
    const tick = () => {
      if (!this.playing) return;
      while (this.nextTime < this.ctx.currentTime + 0.4) this._scheduleNext();
    };
    this.timer = setInterval(tick, 90);
    tick();
  }

  _scheduleNext() {
    if (this.idx >= MELODY.length) {
      this.idx = 0;
      this.beatPos = 0;
      this.nextTime += BEAT * 4; // 一小节休止后循环
      return;
    }
    const [note, beats] = MELODY[this.idx++];
    const t = this.nextTime;
    this._bell(N[note], t, 1.4 + beats * 0.3, 0.07);
    // 每两拍一个低音
    const b0 = this.beatPos;
    const b1 = b0 + beats;
    for (let b = Math.ceil(b0); b < b1; b++) {
      if (b % 2 === 0) {
        const bar = Math.floor(b / 4) % BASS.length;
        this._bell(N[BASS[bar]], t + (b - b0) * BEAT, 1.8, 0.035);
      }
    }
    this.beatPos = b1;
    this.nextTime += beats * BEAT;
  }

  stopMusic() {
    this.playing = false;
    clearInterval(this.timer);
  }

  chime(count = 3) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < count; i++) {
      this._bell(PENTA[(Math.random() * PENTA.length) | 0] * 2, t + i * 0.07 + Math.random() * 0.03, 1.2, 0.045);
    }
  }

  boom(strength = 1) {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 1.2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.8);
    const g = ctx.createGain();
    g.gain.value = 0.12 * strength;
    src.connect(lp).connect(g);
    g.connect(this.dry);
    g.connect(this.verb);
    src.start(t);
    // 噼啪声
    for (let i = 0; i < 6; i++) {
      const tt = t + 0.25 + Math.random() * 0.7;
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.type = 'square';
      o.frequency.value = 2000 + Math.random() * 3000;
      og.gain.setValueAtTime(0.006 * strength, tt);
      og.gain.exponentialRampToValueAtTime(0.0001, tt + 0.03);
      o.connect(og).connect(this.dry);
      o.start(tt);
      o.stop(tt + 0.05);
    }
  }

  toggle() {
    this.enabled = !this.enabled;
    try { localStorage.setItem('xmas.sound', this.enabled ? 'on' : 'off'); } catch (e) { /* ignore */ }
    if (this.ctx) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(this.enabled ? 1 : 0, this.ctx.currentTime, 0.15);
    }
    return this.enabled;
  }
}
