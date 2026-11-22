// 烟花 / 火花粒子系统 + 文字点阵采样
import * as THREE from 'three';

const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

// kind: 0 火花  1 汇聚成文字  2 火箭  3 拖尾/微光  4 流星
export class Fireworks {
  constructor(max, uniforms) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.tgt = new Float32Array(max * 3);
    this.tn = new Float32Array(max * 2);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.base = new Float32Array(max);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.age = new Float32Array(max);
    this.seed = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.kind = new Uint8Array(max);
    this.alive = new Uint8Array(max);
    this.free = [];
    for (let i = max - 1; i >= 0; i--) this.free.push(i);
    this.cb = new Map();
    this.liveCount = 0;
    this.onExplode = null;

    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aColor', this.aCol);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aAlpha', this.aAlpha);
    const mat = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uScale, uPR;
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min(3.2 * aSize * uPR * (uScale / -mv.z), 56.0 * uPR);
          vColor = aColor;
          vAlpha = aAlpha;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.001) discard;
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.0, d);
          a *= a;
          float core = smoothstep(0.15, 0.0, d);
          gl_FragColor = vec4((vColor * a + core * 0.6) * vAlpha, 1.0);
        }
      `,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  add(kind, x, y, z, vx, vy, vz, color, size, life, grav = 1.6) {
    const i = this.free.pop();
    if (i === undefined) return -1;
    const j = i * 3;
    this.pos[j] = x; this.pos[j + 1] = y; this.pos[j + 2] = z;
    this.vel[j] = vx; this.vel[j + 1] = vy; this.vel[j + 2] = vz;
    this.col[j] = color.r; this.col[j + 1] = color.g; this.col[j + 2] = color.b;
    this.kind[i] = kind;
    this.base[i] = size;
    this.size[i] = size;
    this.alpha[i] = 0;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.age[i] = 0;
    this.grav[i] = grav;
    this.seed[i] = Math.random();
    this.alive[i] = 1;
    this.liveCount++;
    return i;
  }

  kill(i) {
    if (!this.alive[i]) return;
    this.alive[i] = 0;
    this.alpha[i] = 0;
    this.size[i] = 0;
    this.free.push(i);
    this.cb.delete(i);
    this.liveCount--;
  }

  clear() {
    for (let i = 0; i < this.max; i++) {
      if (this.alive[i]) this.kill(i);
      this.alpha[i] = 0;
      this.size[i] = 0;
    }
    this.cb.clear();
    this.aPos.needsUpdate = true;
    this.aAlpha.needsUpdate = true;
    this.aSize.needsUpdate = true;
  }

  meteor(x, y, z, vx, vy, life) {
    const c = { r: 1, g: 0.97, b: 0.9 };
    this.add(4, x, y, z, vx, vy, 0, c, 1.3, life, 0);
  }

  // 文字粒子炸开后重新汇聚成新的字；targets 同 textBurst
  morphText(targets, L, colorFn, origin) {
    const idx = [];
    for (let i = 0; i < this.max; i++) if (this.alive[i] && this.kind[i] === 1) idx.push(i);
    let k = 0;
    for (; k < targets.length; k++) {
      let i;
      if (k < idx.length) i = idx[k];
      else {
        const src = idx.length ? idx[k % idx.length] : -1;
        const sx = src >= 0 ? this.pos[src * 3] : origin.x;
        const sy = src >= 0 ? this.pos[src * 3 + 1] : origin.y;
        i = this.add(1, sx, sy, 0, 0, 0, 0, colorFn(targets[k]), rand(1.1, 1.7), 1e9);
        if (i < 0) break;
      }
      const j = i * 3;
      const t = targets[k];
      // 以手指为中心向外炸开
      let dx = this.pos[j] - origin.x, dy = this.pos[j + 1] - origin.y;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d; dy /= d;
      const sp = rand(3, 9) * (0.6 + 0.8 * Math.exp(-d * 0.25));
      this.vel[j] = dx * sp + rand(-2, 2);
      this.vel[j + 1] = dy * sp + rand(-2, 2);
      this.vel[j + 2] = rand(-3, 3);
      this.age[i] = 0.05;
      const c = colorFn(t);
      this.col[j] = c.r; this.col[j + 1] = c.g; this.col[j + 2] = c.b;
      this.tn[i * 2] = t[0]; this.tn[i * 2 + 1] = t[1];
      this.tgt[j] = t[0] * L.W; this.tgt[j + 1] = L.cy + t[1] * L.W; this.tgt[j + 2] = t[2];
    }
    for (; k < idx.length; k++) {
      // 多余的粒子变成普通火花慢慢熄灭
      const i = idx[k];
      this.kind[i] = 0;
      this.life[i] = this.maxLife[i] = rand(0.6, 1.4);
      this.vel[i * 3] = rand(-4, 4);
      this.vel[i * 3 + 1] = rand(-4, 4);
    }
    this.aCol.needsUpdate = true;
  }

  // 被手指扫过的文字粒子轻轻推开
  repel(x, y, radius, strength) {
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i] || this.kind[i] !== 1) continue;
      const j = i * 3;
      const dx = this.pos[j] - x, dy = this.pos[j + 1] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > radius * radius) continue;
      const d = Math.sqrt(d2) || 0.001;
      const f = (1 - d / radius) * strength;
      this.pos[j] += (dx / d) * f;
      this.pos[j + 1] += (dy / d) * f;
    }
  }

  burst(x, y, z, { count = 160, speed = 7, colors, size = 1, life = 1.7, grav = 1.6, flat = 1 } = {}) {
    for (let k = 0; k < count; k++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(rand(-1, 1));
      const sp = speed * (Math.random() < 0.75 ? rand(0.85, 1) : rand(0.2, 0.85));
      const c = colors[(Math.random() * colors.length) | 0];
      this.add(0, x, y, z,
        Math.sin(ph) * Math.cos(th) * sp, Math.cos(ph) * sp * flat, Math.sin(ph) * Math.sin(th) * sp,
        c, size * rand(0.7, 1.3), life * rand(0.7, 1.2), grav);
    }
  }

  rocket(x0, y0, z, x1, y1, t, color, onExplode) {
    const G = 4;
    const vx = (x1 - x0) / t;
    const vy = (y1 - y0) / t + 0.5 * G * t;
    const i = this.add(2, x0, y0, z, vx, vy, 0, color, 1.6, t);
    if (i >= 0) this.cb.set(i, onExplode);
  }

  // targets: [nx, ny, dz] 归一化坐标；L: { W, cy }
  textBurst(x, y, z, targets, L, colorFn) {
    for (let k = 0; k < targets.length; k++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(rand(-1, 1));
      const sp = rand(2.5, 7.5);
      const i = this.add(1, x, y, z,
        Math.sin(ph) * Math.cos(th) * sp, Math.cos(ph) * sp, Math.sin(ph) * Math.sin(th) * sp,
        colorFn(targets[k]), rand(1.1, 1.7), 1e9);
      if (i < 0) break;
      const t = targets[k];
      this.tn[i * 2] = t[0]; this.tn[i * 2 + 1] = t[1];
      this.tgt[i * 3] = t[0] * L.W; this.tgt[i * 3 + 1] = L.cy + t[1] * L.W; this.tgt[i * 3 + 2] = t[2];
    }
  }

  relayoutText(L) {
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i] || this.kind[i] !== 1) continue;
      this.tgt[i * 3] = this.tn[i * 2] * L.W;
      this.tgt[i * 3 + 1] = L.cy + this.tn[i * 2 + 1] * L.W;
    }
  }

  update(dt, clock) {
    if (this.liveCount === 0) return;
    const { pos, vel, tgt } = this;
    const drag = Math.pow(0.28, dt);
    const dragText = Math.pow(0.12, dt);
    const trail = new THREE.Color();
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i]) continue;
      const j = i * 3;
      const k = this.kind[i];
      const age = (this.age[i] += dt);
      if (k === 2) {
        vel[j + 1] -= 4 * dt;
        pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;
        this.alpha[i] = 1;
        trail.setRGB(this.col[j] * 0.9, this.col[j + 1] * 0.75, this.col[j + 2] * 0.55);
        for (let n = 0; n < 2; n++) {
          this.add(3, pos[j] + rand(-0.04, 0.04), pos[j + 1] - n * 0.06, pos[j + 2],
            rand(-0.25, 0.25), rand(-0.9, -0.2), rand(-0.25, 0.25), trail, rand(0.5, 0.9), rand(0.35, 0.7));
        }
        if (age >= this.maxLife[i]) {
          const cb = this.cb.get(i);
          const x = pos[j], y = pos[j + 1], z = pos[j + 2];
          this.kill(i);
          this.onExplode && this.onExplode();
          cb && cb(x, y, z);
        }
        continue;
      }
      if (k === 4) {
        pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt;
        const life = (this.life[i] -= dt);
        const t = life / this.maxLife[i];
        this.alpha[i] = Math.min(1, age * 6) * Math.max(0, t);
        trail.setRGB(0.75, 0.85, 1);
        this.add(3, pos[j], pos[j + 1], pos[j + 2], vel[j] * 0.04, vel[j + 1] * 0.04, 0, trail, 0.9 * t + 0.2, 0.5);
        if (life <= 0) this.kill(i);
        continue;
      }
      if (k === 1) {
        if (age < 0.6) {
          vel[j] *= dragText; vel[j + 1] *= dragText; vel[j + 2] *= dragText;
          pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;
        } else {
          const ramp = clamp01((age - 0.6) / 1.4);
          const f = 1 - Math.exp(-dt * (1.2 + 5.5 * ramp * ramp));
          pos[j] += (tgt[j] - pos[j]) * f;
          pos[j + 1] += (tgt[j + 1] - pos[j + 1]) * f;
          pos[j + 2] += (tgt[j + 2] - pos[j + 2]) * f;
        }
        const s = this.seed[i];
        this.alpha[i] = Math.min(1, age * 3) * (0.72 + 0.28 * Math.sin(clock * (2 + s * 4) + s * 40));
        this.size[i] = this.base[i] * (0.85 + 0.25 * Math.sin(clock * 3 + s * 17));
        continue;
      }
      const life = (this.life[i] -= dt);
      if (life <= 0) { this.kill(i); continue; }
      const t = life / this.maxLife[i];
      if (k === 0) {
        vel[j] *= drag; vel[j + 1] *= drag; vel[j + 2] *= drag;
        vel[j + 1] -= this.grav[i] * dt;
        this.alpha[i] = Math.min(1, age * 12) * t * (0.75 + 0.25 * Math.sin(age * 28 + this.seed[i] * 50));
        this.size[i] = this.base[i] * (0.45 + 0.55 * t);
      } else {
        this.alpha[i] = t * t * 0.7;
        this.size[i] = this.base[i] * t;
      }
      pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;
    }
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aAlpha.needsUpdate = true;
  }
}

export function sampleText(text, count) {
  const cw = 1400, ch = 400;
  const cv = document.createElement('canvas');
  cv.width = cw;
  cv.height = ch;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '900 300px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", sans-serif';
  g.fillText(text, cw / 2, ch / 2 + 10);
  const data = g.getImageData(0, 0, cw, ch).data;
  const filled = [];
  let minX = cw, maxX = 0, minY = ch, maxY = 0;
  for (let y = 0; y < ch; y += 2) {
    for (let x = 0; x < cw; x += 2) {
      if (data[(y * cw + x) * 4 + 3] > 140) {
        filled.push(x, y);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const pts = [];
  const total = filled.length / 2;
  for (let k = 0; k < count && total > 0; k++) {
    const idx = (Math.random() * total) | 0;
    pts.push([(filled[idx * 2] - cx + rand(-1, 1)) / bw, -(filled[idx * 2 + 1] - cy + rand(-1, 1)) / bw]);
  }
  return { pts, aspect: bw / bh };
}
