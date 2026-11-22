import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { HandTracker } from './hands.js';

/* =====================================================================
 * 基础参数
 * ===================================================================== */
const IS_MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 560;
const TREE_COUNT = IS_MOBILE ? 10000 : 18000;
const SNOW_COUNT = IS_MOBILE ? 700 : 1400;
const FW_MAX = IS_MOBILE ? 9000 : 16000;
const TEXT_COUNT = IS_MOBILE ? 1900 : 3400;
const MAX_PHOTOS = 10;
let textInfo = null; // 「圣诞快乐」点阵（结尾时生成）

const TREE_H = 10;
const TREE_BASE = -5;
const TREE_R = 3.8;
const FORM_DUR = 2.4;    // 每个粒子飞行时长
const FORM_SPREAD = 2.6; // 从底到顶的延迟跨度
const FORM_TOTAL = FORM_SPREAD + 0.6 + FORM_DUR;

const $ = (id) => document.getElementById(id);
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const gauss = () => {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);

/* =====================================================================
 * 渲染器 / 场景 / 相机 / 泛光
 * ===================================================================== */
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, IS_MOBILE ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x000000, 1);
renderer.autoClear = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#03060e');
const photoScene = new THREE.Scene(); // 照片单独渲染，不参与泛光，保持清晰
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200);
const LOOK = new THREE.Vector3(0, 0.2, 0);
const view = { dist: 20, visH: 16, visW: 10, pxScale: 1 };

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.75, 0.38, 0.16);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const treeGroup = new THREE.Group();
scene.add(treeGroup);

/* =====================================================================
 * 圣诞树粒子（GPU 动画：聚合 / 旋绕 / 闪烁 / 散开）
 * ===================================================================== */
const treeUniforms = {
  uTime: { value: 0 },
  uClock: { value: 0 },
  uScatter: { value: 0 },
  uFade: { value: 1 },
  uDur: { value: FORM_DUR },
  uSize: { value: 3.0 },
  uScale: { value: 18 },
  uPR: { value: renderer.getPixelRatio() },
};

function buildTree() {
  const N = TREE_COUNT;
  const target = new Float32Array(N * 3);
  const start = new Float32Array(N * 3);
  const color = new Float32Array(N * 3);
  const rnd = new Float32Array(N * 4);

  const iceA = new THREE.Color('#f2fbff');
  const iceB = new THREE.Color('#8fd6ff');
  const gold = new THREE.Color('#ffd98a');
  const ornaments = ['#ff4d6d', '#ffd166', '#7bdff2', '#ff8fab', '#b8f2e6', '#ffe29a', '#c77dff'].map((c) => new THREE.Color(c));
  const c = new THREE.Color();

  for (let i = 0; i < N; i++) {
    const r = Math.random();
    let x, y, z, u, size;
    if (r < 0.44) {
      // 螺旋光带（两条交错）
      const strand = i % 2;
      u = 1 - Math.sqrt(Math.random());
      const ang = u * 9 * Math.PI * 2 + strand * Math.PI;
      const rad = TREE_R * (1 - u) + gauss() * 0.06 + 0.04;
      x = Math.cos(ang) * rad;
      z = Math.sin(ang) * rad;
      y = TREE_BASE + u * TREE_H + gauss() * 0.05;
      size = rand(0.8, 1.5);
      c.copy(iceA).lerp(iceB, Math.random() * 0.35).multiplyScalar(rand(0.6, 0.9));
    } else if (r < 0.78) {
      // 圆锥表面
      u = 1 - Math.sqrt(Math.random());
      const ang = Math.random() * Math.PI * 2;
      const rad = TREE_R * (1 - u) * rand(0.8, 1.02);
      x = Math.cos(ang) * rad;
      z = Math.sin(ang) * rad;
      y = TREE_BASE + u * TREE_H;
      size = rand(0.5, 1.2);
      c.copy(iceB).lerp(iceA, Math.random()).multiplyScalar(rand(0.3, 0.6));
      if (Math.random() < 0.1) c.copy(gold).multiplyScalar(rand(0.7, 1));
    } else if (r < 0.9) {
      // 内部体积
      u = 1 - Math.cbrt(Math.random());
      const ang = Math.random() * Math.PI * 2;
      const rad = TREE_R * (1 - u) * Math.sqrt(Math.random()) * 0.85;
      x = Math.cos(ang) * rad;
      z = Math.sin(ang) * rad;
      y = TREE_BASE + u * TREE_H;
      size = rand(0.4, 0.9);
      c.copy(iceB).multiplyScalar(rand(0.15, 0.3));
    } else if (r < 0.955) {
      // 彩色小挂饰
      u = 1 - Math.sqrt(Math.random());
      const ang = Math.random() * Math.PI * 2;
      const rad = TREE_R * (1 - u) * rand(0.95, 1.05);
      x = Math.cos(ang) * rad;
      z = Math.sin(ang) * rad;
      y = TREE_BASE + u * TREE_H;
      size = rand(1.6, 2.6);
      c.copy(ornaments[(Math.random() * ornaments.length) | 0]);
    } else {
      // 树底光环
      u = 0;
      const ang = Math.random() * Math.PI * 2;
      const rad = TREE_R * (0.5 + Math.pow(Math.random(), 0.7) * 1.0);
      x = Math.cos(ang) * rad;
      z = Math.sin(ang) * rad;
      y = TREE_BASE - 0.1 + gauss() * 0.05;
      size = rand(0.4, 1.0);
      c.copy(iceB).lerp(iceA, Math.random()).multiplyScalar(rand(0.2, 0.45) * (1.4 - rad / (TREE_R * 1.5)));
    }
    target[i * 3] = x; target[i * 3 + 1] = y; target[i * 3 + 2] = z;

    // 起点：散落在四周的星尘
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(rand(-1, 1));
    const R = rand(9, 24);
    start[i * 3] = Math.sin(ph) * Math.cos(th) * R;
    start[i * 3 + 1] = Math.cos(ph) * R * 0.75 + 1;
    start[i * 3 + 2] = Math.min(6, Math.sin(ph) * Math.sin(th) * R) - 4;

    color[i * 3] = c.r; color[i * 3 + 1] = c.g; color[i * 3 + 2] = c.b;
    rnd[i * 4] = u * FORM_SPREAD + Math.random() * 0.6; // 延迟：自下而上
    rnd[i * 4 + 1] = size;
    rnd[i * 4 + 2] = Math.random() * Math.PI * 2;
    rnd[i * 4 + 3] = rand(0.5, 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(target, 3));
  geo.setAttribute('aStart', new THREE.BufferAttribute(start, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
  geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 4));

  const mat = new THREE.ShaderMaterial({
    uniforms: treeUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uTime, uClock, uScatter, uFade, uDur, uSize, uScale, uPR;
      attribute vec3 aStart;
      attribute vec3 aColor;
      attribute vec4 aRnd;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float t = clamp((uTime - aRnd.x) / uDur, 0.0, 1.0);
        float e = t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) * 0.5;
        vec3 p = mix(aStart, position, e);
        // 飞行时绕树轴旋转汇聚
        float ang = (1.0 - e) * (2.4 + aRnd.w * 0.9);
        float s = sin(ang), c = cos(ang);
        p.xz = mat2(c, -s, s, c) * p.xz;
        // 呼吸般的微动
        float w = aRnd.w;
        p += 0.03 * vec3(sin(uClock * w + aRnd.z), sin(uClock * w * 0.8 + aRnd.z * 1.7), cos(uClock * w * 0.9 + aRnd.z));
        // 照片出现时：粒子向外散成星云
        float rr = fract(aRnd.z * 3.713);
        vec3 dir = normalize(vec3(position.x, (fract(aRnd.z * 7.13) - 0.5) * 2.2, position.z) + vec3(1e-3, 0.0, 1e-3));
        p += dir * uScatter * (1.6 + 4.2 * rr);
        p.y += uScatter * sin(uClock * 0.7 + aRnd.z) * 0.5;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float tw = 0.6 + 0.4 * sin(uClock * w * 1.7 + aRnd.z * 3.0);
        gl_PointSize = min(uSize * aRnd.y * uPR * (0.6 + tw * 0.5) * (uScale / -mv.z), 48.0 * uPR);
        vColor = aColor;
        vAlpha = tw * mix(0.16, 1.0, e * e) * uFade;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d);
        a *= a;
        float core = smoothstep(0.16, 0.0, d);
        gl_FragColor = vec4((vColor * a + core * 0.55) * vAlpha, 1.0);
      }
    `,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}
treeGroup.add(buildTree());

/* =====================================================================
 * 顶部星星
 * ===================================================================== */
function makeStarTexture() {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,252,235,1)');
  grd.addColorStop(0.14, 'rgba(255,235,170,0.85)');
  grd.addColorStop(0.42, 'rgba(255,205,120,0.16)');
  grd.addColorStop(1, 'rgba(255,180,80,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  g.save();
  g.translate(s / 2, s / 2);
  g.beginPath();
  for (let k = 0; k < 10; k++) {
    const r = k % 2 ? 24 : 62;
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.shadowColor = '#fff1b8';
  g.shadowBlur = 24;
  g.fillStyle = '#fffbea';
  g.fill();
  g.restore();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function makeFlareTexture() {
  const s = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  g.translate(s / 2, s / 2);
  g.globalCompositeOperation = 'lighter';
  const spikes = [[0, 1, 5], [Math.PI / 2, 1, 5], [Math.PI / 4, 0.5, 3], [-Math.PI / 4, 0.5, 3]];
  for (const [a, len, w] of spikes) {
    g.save();
    g.rotate(a);
    const L = (s / 2) * len;
    const grd = g.createLinearGradient(-L, 0, L, 0);
    grd.addColorStop(0, 'rgba(255,240,200,0)');
    grd.addColorStop(0.5, 'rgba(255,250,235,0.95)');
    grd.addColorStop(1, 'rgba(255,240,200,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(-L, 0);
    g.lineTo(0, -w);
    g.lineTo(L, 0);
    g.lineTo(0, w);
    g.closePath();
    g.fill();
    g.restore();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const starCore = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeStarTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0,
}));
const starFlare = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeFlareTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0,
}));
starCore.position.set(0, TREE_BASE + TREE_H + 0.15, 0);
starFlare.position.copy(starCore.position);
treeGroup.add(starCore, starFlare);
const star = { v: 0, target: 0 };

/* =====================================================================
 * 背景雪花 / 星尘
 * ===================================================================== */
function buildSnow() {
  const pos = new Float32Array(SNOW_COUNT * 3);
  const rnd = new Float32Array(SNOW_COUNT * 4);
  const col = new Float32Array(SNOW_COUNT * 3);
  const palette = ['#ffffff', '#cfeeff', '#ffd6e7', '#d7ffe9', '#fff1c2'].map((c) => new THREE.Color(c));
  for (let i = 0; i < SNOW_COUNT; i++) {
    pos[i * 3] = rand(-32, 32);
    pos[i * 3 + 1] = rand(-20, 20);
    pos[i * 3 + 2] = rand(-30, 6);
    rnd[i * 4] = rand(0.25, 0.9);
    rnd[i * 4 + 1] = rand(0.5, 1.6);
    rnd[i * 4 + 2] = Math.random() * 6.28;
    rnd[i * 4 + 3] = rand(0.5, 2);
    const c = Math.random() < 0.8 ? palette[0] : palette[(Math.random() * palette.length) | 0];
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 4));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: treeUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uClock, uScale, uPR;
      attribute vec4 aRnd;
      attribute vec3 aColor;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        p.y = mod(p.y - uClock * aRnd.x + 20.0, 40.0) - 20.0;
        p.x += sin(uClock * 0.3 * aRnd.w + aRnd.z) * 0.8;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = min(2.2 * aRnd.y * uPR * (uScale / -mv.z), 20.0 * uPR);
        vColor = aColor;
        vAlpha = 0.22 + 0.18 * sin(uClock * aRnd.w + aRnd.z);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor * a * a * vAlpha, 1.0);
      }
    `,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}
scene.add(buildSnow());

/* =====================================================================
 * 烟花粒子系统（CPU 模拟）
 * ===================================================================== */
class Fireworks {
  constructor(max) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.tgt = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.base = new Float32Array(max);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.age = new Float32Array(max);
    this.seed = new Float32Array(max);
    this.kind = new Uint8Array(max);
    this.alive = new Uint8Array(max);
    this.free = [];
    for (let i = max - 1; i >= 0; i--) this.free.push(i);
    this.cb = new Map();
    this.liveCount = 0;
    this.tn = new Float32Array(max * 2); // 文字粒子的归一化坐标（用于重新排版）

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
      uniforms: treeUniforms,
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

  add(kind, x, y, z, vx, vy, vz, color, size, life) {
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
    for (let i = 0; i < this.max; i++) this.kill(i);
  }

  burst(x, y, z, { count = 160, speed = 7, colors, size = 1, life = 1.7 } = {}) {
    const c = new THREE.Color();
    for (let k = 0; k < count; k++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(rand(-1, 1));
      const sp = speed * (Math.random() < 0.75 ? rand(0.85, 1) : rand(0.2, 0.85));
      c.copy(colors[(Math.random() * colors.length) | 0]);
      this.add(0, x, y, z,
        Math.sin(ph) * Math.cos(th) * sp, Math.cos(ph) * sp, Math.sin(ph) * Math.sin(th) * sp,
        c, size * rand(0.7, 1.3), life * rand(0.7, 1.2));
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
    const trailColor = new THREE.Color();
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i]) continue;
      const j = i * 3;
      const k = this.kind[i];
      const age = (this.age[i] += dt);
      if (k === 2) {
        // 上升的火箭 + 拖尾
        vel[j + 1] -= 4 * dt;
        pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;
        this.alpha[i] = 1;
        trailColor.setRGB(this.col[j] * 0.9, this.col[j + 1] * 0.75, this.col[j + 2] * 0.55);
        for (let n = 0; n < 2; n++) {
          this.add(3, pos[j] + rand(-0.04, 0.04), pos[j + 1] - n * 0.06, pos[j + 2],
            rand(-0.25, 0.25), rand(-0.9, -0.2), rand(-0.25, 0.25), trailColor, rand(0.5, 0.9), rand(0.35, 0.7));
        }
        if (age >= this.maxLife[i]) {
          const cb = this.cb.get(i);
          const x = pos[j], y = pos[j + 1], z = pos[j + 2];
          this.kill(i);
          cb && cb(x, y, z);
        }
        continue;
      }
      if (k === 1) {
        // 烟花粒子 → 汇聚成文字
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
      // 普通火花(0) / 拖尾(3)
      const life = (this.life[i] -= dt);
      if (life <= 0) { this.kill(i); continue; }
      const t = life / this.maxLife[i];
      if (k === 0) {
        vel[j] *= drag; vel[j + 1] *= drag; vel[j + 2] *= drag;
        vel[j + 1] -= 1.6 * dt;
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
const fw = new Fireworks(FW_MAX);
scene.add(fw.points);

const PALETTES = [
  ['#ff4d6d', '#ffb3c1', '#fff0f3'],
  ['#ffd166', '#fff3c4', '#ffb703'],
  ['#7bdff2', '#e0fbff', '#4cc9f0'],
  ['#c77dff', '#efe3ff', '#ff8fab'],
  ['#80ffb4', '#e6fff0', '#b8f2e6'],
  ['#ff9f43', '#ffe0b8', '#ff6b6b'],
].map((p) => p.map((c) => new THREE.Color(c)));
const GOLD_SPARK = ['#fff3c4', '#ffd77a', '#ffffff'].map((c) => new THREE.Color(c));

/* =====================================================================
 * 布局 / 尺寸
 * ===================================================================== */
function layout() {
  const w = innerWidth, h = innerHeight;
  const aspect = w / h;
  camera.aspect = aspect;
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  // 宽屏（横屏手机/电脑）时整体上移，给底部标题留出空间
  const wide = clamp01((aspect - 0.9) / 0.6);
  const halfH = 7.6 + 0.5 * wide;
  LOOK.set(0, 0.2 - 0.75 * wide, 0);
  const dist = Math.max(halfH / t, 5.0 / (t * aspect));
  camera.position.set(0, LOOK.y + 0.6, dist);
  camera.lookAt(LOOK);
  camera.updateProjectionMatrix();
  view.dist = dist;
  view.visH = 2 * t * dist;
  view.visW = view.visH * aspect;
  const treePx = h * (TREE_H / view.visH);
  treeUniforms.uScale.value = dist * Math.max(0.55, treePx / 620);
  treeUniforms.uPR.value = renderer.getPixelRatio();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  if (textInfo) fw.relayoutText(textLayout());
}
layout();
addEventListener('resize', layout);
addEventListener('orientationchange', () => setTimeout(layout, 300));

/* =====================================================================
 * 照片
 * ===================================================================== */
const photos = []; // { file, url, tex, aspect, mesh, local, state, t, resolve }

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function framedCanvas(img) {
  const max = IS_MOBILE ? 720 : 960;
  let w = img.naturalWidth, h = img.naturalHeight;
  const s = Math.min(1, max / Math.max(w, h));
  w = Math.max(1, Math.round(w * s));
  h = Math.max(1, Math.round(h * s));
  const b = Math.round(Math.max(w, h) * 0.05);
  const cv = document.createElement('canvas');
  cv.width = w + b * 2;
  cv.height = h + b * 2;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, cv.width, cv.height);
  grad.addColorStop(0, '#9c6b1c');
  grad.addColorStop(0.22, '#ffe7a3');
  grad.addColorStop(0.45, '#c9902c');
  grad.addColorStop(0.7, '#fff2c4');
  grad.addColorStop(1, '#a3721f');
  g.fillStyle = grad;
  g.fillRect(0, 0, cv.width, cv.height);
  g.strokeStyle = 'rgba(255,248,220,0.9)';
  g.lineWidth = Math.max(1, b * 0.08);
  g.strokeRect(b * 0.3, b * 0.3, cv.width - b * 0.6, cv.height - b * 0.6);
  g.fillStyle = '#2a1905';
  g.fillRect(b * 0.78, b * 0.78, w + b * 0.44, h + b * 0.44);
  g.drawImage(img, b, b, w, h);
  return cv;
}

async function preparePhoto(p) {
  const img = await loadImage(p.url);
  const cv = framedCanvas(img);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  p.aspect = cv.width / cv.height;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
  p.mesh = new THREE.Mesh(new THREE.PlaneGeometry(p.aspect, 1), mat);
  p.mesh.visible = false;
  photoScene.add(p.mesh);
}

// 在圆锥表面上用「最佳候选」采样：分布均匀，但不会排成整齐的一排排
function placePhotos(list) {
  const n = list.length;
  const yMin = TREE_BASE + 1.4;
  const yMax = TREE_BASE + TREE_H * 0.74;
  const u0 = (yMin - TREE_BASE) / TREE_H;
  const u1 = (yMax - TREE_BASE) / TREE_H;
  const a = 1 - u1, b = 1 - u0;
  const sample = () => {
    const s = Math.sqrt(a * a + Math.random() * (b * b - a * a)); // 按面积加权
    const u = 1 - s;
    const ang = Math.random() * Math.PI * 2;
    const r = TREE_R * s + 0.35;
    return new THREE.Vector3(Math.cos(ang) * r, TREE_BASE + u * TREE_H, Math.sin(ang) * r);
  };
  const pts = [];
  for (let i = 0; i < n; i++) {
    let best = sample();
    if (pts.length) {
      let bestD = -1;
      for (let k = 0; k < 80; k++) {
        const c = sample();
        let d = Infinity;
        for (const p of pts) d = Math.min(d, c.distanceTo(p));
        if (d > bestD) { bestD = d; best = c; }
      }
    }
    pts.push(best);
  }
  // 打乱顺序，让照片飞向的位置也是随机的
  pts.sort(() => Math.random() - 0.5);
  list.forEach((p, i) => { p.local = pts[i]; });
}

const hungHeight = () => {
  const n = photos.length;
  return n <= 3 ? 1.55 : n <= 6 ? 1.3 : 1.1;
};

function showPhoto(p) {
  return new Promise((resolve) => {
    p.state = 'show';
    p.t = 0;
    p.resolve = resolve;
    p.mesh.visible = true;
  });
}

function hangPhoto(p, delay) {
  p.state = 'hang';
  p.t = -delay;
  p.mesh.visible = false;
}

const SHOW_IN = 0.75, SHOW_HOLD = 1.9, SHOW_OUT = 1.0;
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();

function updatePhotos(dt) {
  let scatterWanted = 0;
  const showPos = tmpV2.copy(camera.position).lerp(LOOK, 0.5);
  const dShow = camera.position.distanceTo(showPos);
  const visH = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dShow;
  const visW = visH * camera.aspect;
  const gScale = treeGroup.scale.x;

  for (const p of photos) {
    if (!p.mesh || p.state === 'idle' || p.state === 'gone') continue;
    const m = p.mesh;
    const world = treeGroup.localToWorld(tmpV.copy(p.local));
    let rotZ = 0;
    if (p.state === 'show') {
      p.t += dt;
      const t = p.t;
      const showH = Math.min(visH * 0.5, (visW * 0.8) / p.aspect);
      m.material.color.setScalar(1);
      if (t < SHOW_IN) {
        const k = t / SHOW_IN;
        const s = easeOutBack(k);
        m.position.copy(showPos);
        m.scale.setScalar(showH * (0.2 + 0.8 * s));
        m.material.opacity = smooth(0, 0.6, k);
        rotZ = (1 - easeOutCubic(k)) * -0.25;
        scatterWanted = 1;
      } else if (t < SHOW_IN + SHOW_HOLD) {
        const k = t - SHOW_IN;
        m.position.copy(showPos);
        m.position.y += Math.sin(k * 1.6) * 0.06;
        m.scale.setScalar(showH * (1 + 0.012 * Math.sin(k * 2.2)));
        m.material.opacity = 1;
        rotZ = Math.sin(k * 1.2) * 0.012;
        scatterWanted = 1;
      } else if (t < SHOW_IN + SHOW_HOLD + SHOW_OUT) {
        const k = (t - SHOW_IN - SHOW_HOLD) / SHOW_OUT;
        const e = easeInOutCubic(k);
        m.position.copy(showPos).lerp(world, e);
        m.scale.setScalar(showH * (1 - e) + hungHeight() * gScale * 0.2 * e);
        m.material.opacity = 1 - smooth(0.55, 1, k);
        rotZ = e * 0.35;
      } else {
        p.state = 'gone';
        m.visible = false;
        fw.burst(world.x, world.y, world.z, { count: IS_MOBILE ? 50 : 80, speed: 3.2, colors: GOLD_SPARK, size: 0.8, life: 1.1 });
        const r = p.resolve;
        p.resolve = null;
        r && r();
        continue;
      }
    } else if (p.state === 'hang') {
      p.t += dt;
      if (p.t < 0) continue;
      if (!m.visible) {
        m.visible = true;
        fw.burst(world.x, world.y, world.z, { count: IS_MOBILE ? 40 : 70, speed: 2.6, colors: GOLD_SPARK, size: 0.8, life: 1.0 });
      }
      const k = clamp01(p.t / 0.8);
      const s = easeOutBack(k);
      m.position.copy(world);
      m.scale.setScalar(Math.max(0.001, hungHeight() * gScale * s));
      rotZ = Math.sin(clock * 1.3 + p.local.x * 3) * 0.06;
      // 转到树后面的照片变暗，营造前后层次
      const front = (world.z - treeGroup.position.z) / (TREE_R * gScale + 0.4);
      const f = smooth(-0.9, 0.9, front);
      m.material.color.setScalar(0.28 + 0.72 * f);
      m.material.opacity = smooth(0, 0.3, k) * (0.55 + 0.45 * f);
    }
    m.quaternion.copy(camera.quaternion);
    m.rotateZ(rotZ);
  }
  return scatterWanted;
}

/* =====================================================================
 * 文字「圣诞快乐」点阵
 * ===================================================================== */
function sampleText(text, count) {
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

/* =====================================================================
 * 简易时间线工具（基于渲染时钟，和动画完全同步）
 * ===================================================================== */
let clock = 0;
let timers = [];
let tweens = [];
let generation = 0;
const after = (sec, fn) => { timers.push({ at: clock + sec, fn, gen: generation }); };
const sleep = (sec) => new Promise((r) => after(sec, r));
function tween(dur, fn, ease = easeInOutCubic) {
  return new Promise((resolve) => tweens.push({ t: 0, dur, fn, ease, resolve, gen: generation }));
}
function runTimers(dt) {
  if (timers.length) {
    const due = timers.filter((t) => t.at <= clock);
    if (due.length) {
      timers = timers.filter((t) => t.at > clock);
      due.forEach((t) => t.gen === generation && t.fn());
    }
  }
  if (tweens.length) {
    tweens = tweens.filter((tw) => {
      if (tw.gen !== generation) return false;
      tw.t += dt;
      const k = clamp01(tw.t / tw.dur);
      tw.fn(tw.ease(k));
      if (k >= 1) { tw.resolve(); return false; }
      return true;
    });
  }
}

/* =====================================================================
 * UI
 * ===================================================================== */
const ui = {
  setup: $('setup'), nick: $('nick'), file: $('file'), grid: $('grid'), addTile: $('addTile'), count: $('count'),
  go: $('go'), ask: $('ask'), camYes: $('camYes'), camNo: $('camNo'), hint: $('hint'), cam: $('cam'),
  camCanvas: $('camCanvas'), camStatus: $('camStatus'), video: $('video'), loading: $('loading'),
  loadingText: $('loadingText'), toast: $('toast'), title: $('title'), dear: $('dear'), end: $('end'),
  again: $('again'), restart: $('restart'),
};
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');
let toastTimer = 0;
function toast(msg, ms = 2600) {
  ui.toast.textContent = msg;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), ms);
}

function refreshGrid() {
  ui.grid.querySelectorAll('.thumb').forEach((n) => n.remove());
  photos.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'thumb';
    const img = document.createElement('img');
    img.src = p.url;
    img.alt = '';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '×';
    b.title = '移除';
    b.onclick = () => {
      URL.revokeObjectURL(p.url);
      photos.splice(i, 1);
      refreshGrid();
    };
    d.append(img, b);
    ui.grid.insertBefore(d, ui.addTile);
  });
  ui.count.textContent = `${photos.length} / ${MAX_PHOTOS}`;
  ui.addTile.classList.toggle('full', photos.length >= MAX_PHOTOS);
}

ui.file.addEventListener('change', () => {
  const files = [...ui.file.files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(f.name));
  const room = MAX_PHOTOS - photos.length;
  if (files.length > room) toast(`最多 ${MAX_PHOTOS} 张，已为你保留前 ${room} 张`);
  files.slice(0, room).forEach((file) => photos.push({ file, url: URL.createObjectURL(file), state: 'idle' }));
  ui.file.value = '';
  refreshGrid();
});

/* =====================================================================
 * 手势
 * ===================================================================== */
let hands = null;
let mode = 'none'; // 'cam' | 'auto'
let camQueue = null; // { next, resolveAll, busy }

function onTriggerNext() {
  if (mode !== 'cam' || !camQueue || camQueue.busy) return;
  const q = camQueue;
  if (q.next >= photos.length) return;
  const p = photos[q.next++];
  q.busy = true;
  updateHint();
  showPhoto(p).then(() => {
    q.busy = false;
    if (q.next >= photos.length) q.resolveAll();
    else updateHint();
  });
}

function updateHint() {
  if (mode !== 'cam' || !camQueue) return;
  const left = photos.length - camQueue.next;
  ui.hint.innerHTML = left > 0
    ? `👌 捏合手指，展示下一张 · <b>${camQueue.next + 1} / ${photos.length}</b>`
    : '✨ 照片全部展示完啦';
  show(ui.hint);
}

async function startHands() {
  ui.loadingText.textContent = '正在启动摄像头和手势识别…';
  show(ui.loading);
  try {
    hands = new HandTracker(ui.video, ui.camCanvas, ui.camStatus);
    hands.onPinch = onTriggerNext;
    hands.onPinchChange = (on) => ui.cam.classList.toggle('pinch', on);
    await hands.start();
    hide(ui.loading);
    show(ui.cam);
    return true;
  } catch (e) {
    console.warn(e);
    hide(ui.loading);
    if (hands) hands.stop();
    hands = null;
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    toast(denied ? '没有获得摄像头权限，已切换为自动播放' : '摄像头或手势识别启动失败，已切换为自动播放', 3200);
    return false;
  }
}

function stopHands() {
  if (hands) hands.stop();
  hands = null;
  hide(ui.cam);
  ui.cam.classList.remove('pinch');
}

/* =====================================================================
 * 主流程
 * ===================================================================== */
let forming = false;
let formTime = 0;
let finale = null; // { nextLaunch }
let nickname = '';

function askCamera() {
  return new Promise((resolve) => {
    show(ui.ask);
    ui.title.classList.add('away');
    const done = (v) => { hide(ui.ask); ui.title.classList.remove('away'); resolve(v); };
    ui.camYes.onclick = () => done(true);
    ui.camNo.onclick = () => done(false);
  });
}

async function runShow() {
  const gen = generation;
  const alive = () => gen === generation;

  forming = true;
  formTime = 0;
  await sleep(FORM_TOTAL - 1.4);
  if (!alive()) return;
  star.target = 1;
  await sleep(0.6);
  ui.dear.textContent = nickname ? `— 致 ${nickname} —` : '';
  ui.title.classList.add('show');
  await sleep(1.6);
  if (!alive()) return;

  if (photos.length) {
    let useCam = await askCamera();
    if (!alive()) return;
    if (useCam) useCam = await startHands();
    if (!alive()) { stopHands(); return; }
    mode = useCam ? 'cam' : 'auto';

    if (mode === 'cam') {
      await new Promise((resolveAll) => {
        camQueue = { next: 0, busy: false, resolveAll };
        updateHint();
      });
      camQueue = null;
      if (!alive()) return;
      await sleep(0.6);
      hide(ui.hint);
      stopHands();
    } else {
      ui.hint.innerHTML = '✨ 照片回忆播放中';
      show(ui.hint);
      await sleep(0.4);
      for (let i = 0; i < photos.length; i++) {
        if (!alive()) return;
        ui.hint.innerHTML = `✨ 照片回忆 · <b>${i + 1} / ${photos.length}</b>`;
        await showPhoto(photos[i]);
        await sleep(0.35);
      }
      hide(ui.hint);
    }
    mode = 'none';
    if (!alive()) return;

    // 所有照片一起挂上圣诞树
    await sleep(0.4);
    photos.forEach((p, i) => hangPhoto(p, i * 0.18));
    await sleep(photos.length * 0.18 + 1.6);
  } else {
    await sleep(1.0);
  }
  if (!alive()) return;
  startFinale();
}

// 「圣诞快乐」放在树顶与屏幕顶部之间，随屏幕尺寸自动排版
const FINALE_SCALE = 0.66, FINALE_Y = -1.15;
function textLayout() {
  const aspect = textInfo ? textInfo.aspect : 4;
  const topY = LOOK.y + view.visH / 2 - Math.max(0.6, view.visH * 0.06);
  const treeTop = FINALE_Y + (TREE_BASE + TREE_H + 0.6) * FINALE_SCALE;
  const avail = Math.max(1.2, topY - treeTop);
  const W = Math.min(view.visW * 0.86, avail * 0.9 * aspect, 16);
  return { W, cy: treeTop + avail / 2 };
}

async function startFinale() {
  const gen = generation;
  // 树缩小下移，把上方留给「圣诞快乐」
  const s0 = treeGroup.scale.x, y0 = treeGroup.position.y;
  const s1 = FINALE_SCALE, y1 = FINALE_Y;
  tween(1.6, (e) => {
    treeGroup.scale.setScalar(s0 + (s1 - s0) * e);
    treeGroup.position.y = y0 + (y1 - y0) * e;
  });

  ui.title.classList.add('finale');
  textInfo = sampleText('圣诞快乐', TEXT_COUNT);
  const aspect = textInfo.aspect;
  const targets = textInfo.pts.map(([x, y]) => [x, y, rand(-0.12, 0.12)]);
  targets.sort((a, b) => a[0] - b[0]);

  const gold = new THREE.Color('#ffd166');
  const red = new THREE.Color('#ff4d5e');
  const white = new THREE.Color('#fff6dc');
  const colorFn = (t) => {
    if (Math.random() < 0.12) return white;
    const k = 0.5 + 0.5 * Math.sin(t[0] * Math.PI * 2.2 + t[1] * aspect);
    return gold.clone().lerp(red, k * 0.75);
  };

  // 四发火箭，各自炸开成一个字
  const groups = 4;
  const per = Math.ceil(targets.length / groups);
  for (let g = 0; g < groups; g++) {
    const part = targets.slice(g * per, (g + 1) * per);
    if (!part.length) continue;
    const nx = part.reduce((s, t) => s + t[0], 0) / part.length;
    const delay = g * 0.32 + rand(0, 0.1);
    after(delay, () => {
      const L = textLayout();
      const ex = nx * L.W;
      const x0 = ex * 0.6 + rand(-0.5, 0.5);
      fw.rocket(x0, LOOK.y - view.visH / 2 - 0.5, 0, ex, L.cy + rand(-0.3, 0.3), 1.15, gold, (x, y, z) => {
        fw.textBurst(x, y, z, part, textLayout(), colorFn);
        fw.burst(x, y, z, { count: IS_MOBILE ? 90 : 160, speed: 8, colors: PALETTES[(g * 2 + 1) % PALETTES.length], size: 1, life: 1.6 });
      });
    });
  }

  await sleep(3.2);
  if (gen !== generation) return;
  finale = { nextLaunch: clock + 0.2 };
  show(ui.end);
}

function launchRandomFirework() {
  const x1 = rand(-0.45, 0.45) * view.visW;
  const top = LOOK.y + view.visH / 2;
  const y1 = rand(top - view.visH * 0.42, top - view.visH * 0.08);
  const z = rand(-7, -1);
  const pal = PALETTES[(Math.random() * PALETTES.length) | 0];
  fw.rocket(x1 + rand(-1.5, 1.5), LOOK.y - view.visH / 2 - 1, z, x1, y1, rand(1.0, 1.4), pal[0], (x, y, zz) => {
    fw.burst(x, y, zz, { count: IS_MOBILE ? 110 : 200, speed: rand(5.5, 8.5), colors: pal, size: 1, life: rand(1.4, 2.0) });
  });
}

function resetShow() {
  generation++;
  timers = [];
  tweens = [];
  stopHands();
  mode = 'none';
  camQueue = null;
  finale = null;
  fw.clear();
  textInfo = null;
  forming = false;
  formTime = 0;
  star.target = 0;
  star.v = 0;
  treeGroup.scale.setScalar(1);
  treeGroup.position.y = 0;
  treeUniforms.uScatter.value = 0;
  ui.title.classList.remove('show', 'finale', 'away');
  [ui.end, ui.hint, ui.ask].forEach(hide);
  photos.forEach((p) => {
    p.state = 'idle';
    if (p.mesh) p.mesh.visible = false;
  });
}

ui.go.addEventListener('click', async () => {
  const nick = ui.nick.value.trim();
  if (!nick) {
    ui.nick.classList.remove('shake');
    void ui.nick.offsetWidth;
    ui.nick.classList.add('shake');
    ui.nick.focus();
    toast('先写下你的昵称吧 ✍️');
    return;
  }
  nickname = nick;
  ui.go.disabled = true;
  ui.go.textContent = '准备中…';
  const results = await Promise.allSettled(photos.map(preparePhoto));
  // 移除无法解码的照片（例如部分浏览器不支持 HEIC）
  const bad = results.filter((r) => r.status === 'rejected').length;
  for (let i = photos.length - 1; i >= 0; i--) if (!photos[i].mesh) photos.splice(i, 1);
  if (bad) toast(`有 ${bad} 张照片无法读取，已跳过`);
  placePhotos(photos);
  hide(ui.setup);
  resetShow();
  runShow();
});
ui.nick.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.go.click(); });

ui.again.addEventListener('click', () => {
  resetShow();
  placePhotos(photos);
  runShow();
});
ui.restart.addEventListener('click', () => location.reload());

/* =====================================================================
 * 拖拽旋转 + 点击（摄像头模式下点击也可以切换照片）
 * ===================================================================== */
let drag = null;
let yawVel = 0;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, sx: e.clientX, sy: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  drag.x = e.clientX;
  if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 8) drag.moved = true;
  const d = (dx / innerWidth) * Math.PI * 1.6;
  treeGroup.rotation.y += d;
  yawVel = d * 30;
});
canvas.addEventListener('pointerup', () => {
  if (drag && !drag.moved) onTriggerNext();
  drag = null;
});
canvas.addEventListener('pointercancel', () => { drag = null; });
addEventListener('keydown', (e) => {
  if (e.code === 'Space' && document.activeElement !== ui.nick) {
    e.preventDefault();
    onTriggerNext();
  }
});

/* =====================================================================
 * 渲染循环
 * ===================================================================== */
// 自适应画质：帧率偏低时自动降低渲染分辨率，保证手机上也流畅
const perf = { acc: 0, frames: 0, pr: renderer.getPixelRatio(), cooldown: 3 };
function adaptQuality(rawDt) {
  if (document.hidden) return;
  perf.acc += rawDt;
  perf.frames++;
  if (perf.acc < 2) return;
  const fps = perf.frames / perf.acc;
  perf.acc = 0;
  perf.frames = 0;
  if (perf.cooldown > 0) { perf.cooldown--; return; }
  const minPR = IS_MOBILE ? 0.75 : 1;
  if (fps < 42 && perf.pr > minPR) {
    perf.pr = Math.max(minPR, perf.pr - 0.25);
    renderer.setPixelRatio(perf.pr);
    layout();
    perf.cooldown = 1;
  }
}

// 「Merry Christmas」标题始终贴在树底下方
const titleV = new THREE.Vector3();
let titleTop = -1;
function placeTitle() {
  titleV.set(0, treeGroup.position.y + (TREE_BASE - 0.55) * treeGroup.scale.y - 0.15, 0).project(camera);
  const y = Math.round((0.5 - titleV.y * 0.5) * innerHeight);
  if (y !== titleTop) {
    titleTop = y;
    ui.title.style.top = y + 'px';
  }
}

const TIME_SCALE = Math.min(8, Math.max(0.1, +new URLSearchParams(location.search).get('speed') || 1));
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = Math.max(0, (now - last) / 1000);
  const dt = Math.min(0.05, rawDt) * TIME_SCALE;
  last = now;
  adaptQuality(Math.min(rawDt, 0.25));
  placeTitle();
  clock += dt;

  runTimers(dt);
  if (forming) formTime += dt;
  treeUniforms.uTime.value = formTime;
  treeUniforms.uClock.value = clock;

  // 自转 + 拖拽惯性
  treeGroup.rotation.y += (0.2 + yawVel) * dt;
  yawVel *= Math.exp(-dt * 2.5);

  // 星星
  star.v += (star.target - star.v) * (1 - Math.exp(-dt * 2.2));
  const pulse = 1 + 0.06 * Math.sin(clock * 3);
  starCore.material.opacity = star.v;
  starFlare.material.opacity = star.v * 0.9;
  starCore.scale.setScalar(Math.max(0.001, 1.7 * easeOutBack(clamp01(star.v)) * pulse));
  starFlare.scale.setScalar(Math.max(0.001, 5.2 * star.v * (1 + 0.1 * Math.sin(clock * 2.1))));
  starFlare.material.rotation = clock * 0.15;

  // 照片 & 散开
  const scatterWanted = updatePhotos(dt);
  const sc = treeUniforms.uScatter;
  sc.value += (scatterWanted - sc.value) * (1 - Math.exp(-dt * (scatterWanted > sc.value ? 2.6 : 1.8)));

  if (hands) hands.update();

  if (finale && clock >= finale.nextLaunch) {
    launchRandomFirework();
    finale.nextLaunch = clock + rand(0.55, 1.3);
  }
  fw.update(dt, clock);

  renderer.clear();
  composer.render();
  renderer.clearDepth();
  renderer.render(photoScene, camera);
}
requestAnimationFrame(frame);

// 方便调试：?demo 直接跳过表单
if (new URLSearchParams(location.search).has('demo')) {
  ui.nick.value = '小雪';
  setTimeout(() => ui.go.click(), 300);
}
window.__xmas = { photos, startFinale, view };
