import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Fireworks, sampleText } from './fx.js';
import { Sound } from './audio.js';
import { api, cloudEnabled, MAX_FRIENDS, TreeFullError, rememberMyTree, isMyTree, myTrees, hasDecorated, markDecorated, compressImage } from './api.js';

/* =====================================================================
 * 参数
 * ===================================================================== */
const IS_MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 560;
const Q = IS_MOBILE ? 0.58 : 1;
const COUNT = {
  ribbon: Math.round(9000 * (IS_MOBILE ? 0.78 : 1)),
  sparkle: Math.round(4800 * Q),
  glow: Math.round(420 * Q),
  ornament: Math.round(220 * Q),
  base: Math.round(2200 * Q),
};
const SNOW_COUNT = IS_MOBILE ? 600 : 1200;
const FW_MAX = IS_MOBILE ? 9000 : 16000;
const TEXT_COUNT = IS_MOBILE ? 1900 : 3400;
const MAX_LOCAL = 10;

const TREE_H = 10;
const TREE_BASE = -5;
const TREE_R = 3.8;
const TURNS = 7;
const TAU = Math.PI * 2;
const STRANDS = [0, Math.PI];

const params = new URLSearchParams(location.search);
const TIME_SCALE = Math.min(8, Math.max(0.1, +params.get('speed') || 1));
const BASE_URL = location.origin + location.pathname;

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
const easeInOutSine = (x) => -(Math.cos(Math.PI * x) - 1) / 2;
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
const C = (list) => list.map((c) => new THREE.Color(c));
function seeded(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

/* =====================================================================
 * 渲染基础
 * ===================================================================== */
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, IS_MOBILE ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.autoClear = false;

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  let last = 0;
  try { last = +sessionStorage.getItem('xmas.lost') || 0; sessionStorage.setItem('xmas.lost', String(Date.now())); } catch (err) { /* ignore */ }
  const el = document.getElementById('toast');
  // 短时间内反复出错就不再自动刷新，避免死循环
  if (Date.now() - last < 30000) {
    if (el) { el.textContent = '手机内存有点紧张，关掉其他页面后刷新试试'; el.classList.add('show'); }
    return;
  }
  if (el) { el.textContent = '画面出了点问题，正在恢复…'; el.classList.add('show'); }
  setTimeout(() => location.reload(), 900);
});
const scene = new THREE.Scene();
scene.background = new THREE.Color('#03050b');
const photoScene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200);
const LOOK = new THREE.Vector3(0, 0.2, 0);
const view = { dist: 20, visH: 16, visW: 10 };

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.85, 0.42, 0.14);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const treeGroup = new THREE.Group();
scene.add(treeGroup);

const U = {
  uClock: { value: 0 },
  uReveal: { value: 0 },
  uIntro: { value: 0 },
  uScatter: { value: 0 },
  uFade: { value: 1 },
  uSize: { value: IS_MOBILE ? 3.4 : 3.0 },
  uScale: { value: 18 },
  uPR: { value: renderer.getPixelRatio() },
  uCenterZ: { value: -20 },
  uGS: { value: 1 },
  uBurst: { value: 0 },
  uBurstDir: { value: 1 },
  uThemeA: { value: new THREE.Vector3(0.6, 0.82, 1.0) },
  uThemeB: { value: new THREE.Vector3(1.0, 0.97, 0.93) },
  uTint: { value: new THREE.Vector3(1, 1, 1) },
};

/* =====================================================================
 * 圣诞树：流动的螺旋光带 + 闪粉 + 暖色灯珠 + 柔光 + 地面光尘
 * ===================================================================== */
function buildTree() {
  const total = COUNT.ribbon + COUNT.sparkle + COUNT.glow + COUNT.ornament + COUNT.base;
  const pos = new Float32Array(total * 3);
  const A = new Float32Array(total * 4);
  const B = new Float32Array(total * 4);
  const Cc = new Float32Array(total * 3);
  let i = 0;
  const put = (p, a, b, c) => {
    pos.set(p, i * 3); A.set(a, i * 4); B.set(b, i * 4); Cc.set(c, i * 3); i++;
  };
  const cone = (u, k = 1) => {
    const ang = Math.random() * TAU;
    const r = TREE_R * (1 - u) * k;
    return [Math.cos(ang) * r, TREE_BASE + u * TREE_H, Math.sin(ang) * r];
  };
  const col = new THREE.Color();
  const ice = new THREE.Color('#bfe4ff');
  const white = new THREE.Color('#ffffff');
  const gold = new THREE.Color('#ffd79a');
  const warm = ['#ffcf70', '#ffb36b', '#ff7a6b', '#ffe1a8', '#ff9fb2', '#a8e4ff', '#c9a7ff', '#9ff0d0'].map((c) => new THREE.Color(c));
  const pastel = ['#ffc8dd', '#cdb4db', '#b9fbc0', '#ffd6a5', '#a0c4ff', '#fdffb6'].map((c) => new THREE.Color(c));
  const deep = [[0.1, 0.22, 0.42], [0.22, 0.12, 0.38], [0.06, 0.26, 0.3], [0.3, 0.12, 0.24]];

  for (let n = 0; n < COUNT.ribbon; n++) {
    const halo = Math.random() < 0.3;
    const dr = halo ? gauss() * 0.16 : gauss() * 0.035;
    const dy = halo ? gauss() * 0.1 : gauss() * 0.03;
    const b = halo ? rand(0.3, 0.55) : rand(0.8, 1.05);
    put([dy, gauss() * 0.01, 0], [0, Math.random(), STRANDS[n % STRANDS.length], dr],
      [halo ? rand(0.5, 0.9) : rand(0.85, 1.6), Math.random() * TAU, rand(1, 3), 0], [b, b, b]);
  }
  for (let n = 0; n < COUNT.sparkle; n++) {
    const u = 1 - Math.sqrt(Math.random());
    col.copy(ice).lerp(white, Math.random());
    const r = Math.random();
    if (r < 0.13) col.copy(gold);
    else if (r < 0.45) col.lerp(pastel[(Math.random() * pastel.length) | 0], 0.75);
    col.multiplyScalar(rand(0.7, 1));
    put(cone(u, rand(0.86, 1.04)), [1, u, 0, 0], [rand(0.6, 1.35), Math.random() * TAU, rand(0.5, 2.2), 0], [col.r, col.g, col.b]);
  }
  for (let n = 0; n < COUNT.glow; n++) {
    const u = 1 - Math.cbrt(Math.random());
    const ang = Math.random() * TAU;
    const r = TREE_R * (1 - u) * Math.sqrt(Math.random()) * 0.75;
    const k = rand(0.5, 1);
    put([Math.cos(ang) * r, TREE_BASE + u * TREE_H, Math.sin(ang) * r], [2, u, 0, 0],
      [rand(9, 18), Math.random() * TAU, 0.5, 0], deep[(Math.random() * deep.length) | 0].map((v) => v * k));
  }
  for (let n = 0; n < COUNT.ornament; n++) {
    const u = (1 - Math.sqrt(Math.random())) * 0.95;
    col.copy(warm[(Math.random() * warm.length) | 0]);
    put(cone(u, rand(0.97, 1.04)), [3, u, 0, 0], [rand(2.0, 3.4), Math.random() * TAU, rand(0.8, 2), 0], [col.r, col.g, col.b]);
  }
  for (let n = 0; n < COUNT.base; n++) {
    const ang = Math.random() * TAU;
    const r = TREE_R * (0.25 + 1.5 * Math.pow(Math.random(), 0.6));
    const k = rand(0.25, 0.6) * Math.max(0.15, 1.25 - r / (TREE_R * 1.8));
    col.copy(ice).multiplyScalar(k);
    put([Math.cos(ang) * r, TREE_BASE - 0.04 + gauss() * 0.03, Math.sin(ang) * r], [4, 0, 0, 0],
      [rand(0.4, 1.1), Math.random() * TAU, rand(0.6, 2), 0], [col.r, col.g, col.b]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aA', new THREE.BufferAttribute(A, 4));
  geo.setAttribute('aB', new THREE.BufferAttribute(B, 4));
  geo.setAttribute('aColor', new THREE.BufferAttribute(Cc, 3));

  const mat = new THREE.ShaderMaterial({
    uniforms: U,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uClock, uReveal, uIntro, uScatter, uFade, uSize, uScale, uPR, uCenterZ, uGS, uBurst, uBurstDir;
      uniform vec3 uThemeA, uThemeB, uTint;
      attribute vec4 aA;
      attribute vec4 aB;
      attribute vec3 aColor;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vSoft;
      const float TAU = 6.28318530718;
      const float TURNS = ${TURNS.toFixed(1)};
      const float H = ${TREE_H.toFixed(1)};
      const float BASE = ${TREE_BASE.toFixed(1)};
      const float RAD = ${TREE_R.toFixed(2)};
      void main() {
        float type = aA.x;
        float u;
        vec3 p;
        vec3 col = aColor;
        float alpha = 1.0;
        float sizeMul = 1.0;
        float tw;
        if (type < 0.5) {
          // 螺旋光带：粒子沿着螺旋缓缓向上流动
          float v = fract(aA.y + uClock * 0.016);
          u = 1.0 - sqrt(1.0 - v * 0.9992);
          float ang = u * TURNS * TAU + aA.z + position.y;
          float r = RAD * (1.0 - u) + aA.w;
          p = vec3(cos(ang) * r, BASE + u * H + position.x, sin(ang) * r);
          alpha = smoothstep(0.0, 0.03, v) * (1.0 - smoothstep(0.96, 1.0, v));
          float front = uReveal - u;
          alpha *= smoothstep(-0.004, 0.012, front);
          float drawing = 1.0 - step(0.999, uReveal);
          float head = (1.0 - smoothstep(0.0, 0.05, abs(front))) * drawing;
          sizeMul += head * 1.6;
          // 淡淡的彩虹色沿着光带缓缓流动
          vec3 pastel = 0.5 + 0.5 * cos(TAU * (vec3(0.0, 0.33, 0.67) + fract(u * 1.4 + aA.z * 0.16 - uClock * 0.025)));
          pastel = mix(vec3(1.0), pastel, 0.6);
          vec3 base = mix(uThemeA, uThemeB, smoothstep(0.0, 0.95, u));
          col = mix(base, pastel, 0.42) * aColor + head * vec3(0.6, 0.5, 0.3);
          tw = 0.78 + 0.22 * sin(uClock * aB.z + aB.y);
        } else {
          p = position;
          u = aA.y;
          float k = type > 3.5 ? uIntro : clamp((uReveal - u) * 5.0, 0.0, 1.0);
          float ke = k * k * (3.0 - 2.0 * k);
          vec3 outw = normalize(vec3(p.x, 0.0, p.z) + vec3(1e-4, 0.0, 1e-4));
          if (type < 3.5) p += (outw * 1.0 + vec3(0.0, 0.9, 0.0)) * (1.0 - ke);
          alpha = ke;
          if (type < 2.5) col = mix(col, col * uTint * 1.1, 0.7);
          if (type < 1.5) tw = 0.16 + 1.3 * pow(max(0.0, sin(uClock * aB.z + aB.y)), 12.0);
          else if (type < 2.5) tw = 0.8 + 0.2 * sin(uClock * 0.6 + aB.y);
          else if (type < 3.5) tw = 0.6 + 0.4 * sin(uClock * aB.z * 0.6 + aB.y);
          else tw = 0.55 + 0.45 * sin(uClock * aB.z + aB.y);
        }
        p += 0.022 * vec3(sin(uClock * aB.z * 0.7 + aB.y), sin(uClock * aB.z * 0.5 + aB.y * 1.7), cos(uClock * aB.z * 0.6 + aB.y));
        // 照片出现时：整棵树旋转着散成星云
        float rr = fract(aB.y * 3.713);
        if (uScatter > 0.001) {
          vec3 dir = normalize(vec3(p.x, (fract(aB.y * 7.13) - 0.5) * 2.4, p.z) + vec3(1e-3, 0.0, 1e-3));
          p += dir * uScatter * (1.3 + 4.2 * rr);
          float sw = uScatter * (0.5 + rr) * 1.4;
          float s = sin(sw), c = cos(sw);
          p.xz = mat2(c, -s, s, c) * p.xz;
          p.y += uScatter * sin(uClock * 0.7 + aB.y) * 0.5;
        }
        // 手指上下拖动：粒子炸开，松手后弹回
        if (abs(uBurst) > 0.001) {
          float rb = fract(aB.y * 9.17);
          vec3 d2 = normalize(vec3(p.x, (fract(aB.y * 5.31) - 0.5) * 3.0, p.z) + vec3(1e-3, 0.0, 1e-3));
          p += d2 * uBurst * (1.5 + 9.0 * rb * rb);
          p.y += uBurstDir * uBurst * (0.5 + 5.0 * rb);
          float sw2 = uBurst * (0.6 + rb) * 1.8;
          float s2 = sin(sw2), c2 = cos(sw2);
          p.xz = mat2(c2, -s2, s2, c2) * p.xz;
        }
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        // 前亮后暗，增强立体感
        float depth = mv.z - uCenterZ;
        float df = smoothstep(-RAD * uGS, RAD * uGS, depth);
        alpha *= mix(0.3, 1.0, mix(df, 1.0, clamp(uScatter + abs(uBurst), 0.0, 1.0)));
        gl_PointSize = min(uSize * aB.x * sizeMul * uPR * (0.65 + 0.45 * min(tw, 1.4)) * (uScale / -mv.z), 64.0 * uPR);
        vColor = col;
        vAlpha = alpha * tw * uFade;
        vSoft = step(1.5, type) * (1.0 - step(2.5, type));
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vAlpha;
      varying float vSoft;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float sharp = smoothstep(0.5, 0.0, d);
        sharp *= sharp;
        float soft = smoothstep(0.5, 0.0, d);
        soft = soft * soft * soft * 0.35;
        float core = smoothstep(0.16, 0.0, d) * (1.0 - vSoft);
        float a = mix(sharp, soft, vSoft);
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
 * 星星、光笔
 * ===================================================================== */
function canvasTex(size, draw) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  draw(cv.getContext('2d'), size);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const glowTex = canvasTex(128, (g, s) => {
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,240,210,0.7)');
  grd.addColorStop(0.5, 'rgba(255,210,150,0.12)');
  grd.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
});
const starTex = canvasTex(256, (g, s) => {
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,252,235,1)');
  grd.addColorStop(0.14, 'rgba(255,235,170,0.8)');
  grd.addColorStop(0.42, 'rgba(255,205,120,0.14)');
  grd.addColorStop(1, 'rgba(255,180,80,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  g.translate(s / 2, s / 2);
  g.beginPath();
  for (let k = 0; k < 10; k++) {
    const r = k % 2 ? 22 : 58;
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.shadowColor = '#fff1b8';
  g.shadowBlur = 24;
  g.fillStyle = '#fffbea';
  g.fill();
});
const flareTex = canvasTex(512, (g, s) => {
  g.translate(s / 2, s / 2);
  g.globalCompositeOperation = 'lighter';
  for (const [a, len, w] of [[0, 1, 4], [Math.PI / 2, 1, 4], [Math.PI / 4, 0.45, 2.5], [-Math.PI / 4, 0.45, 2.5]]) {
    g.save();
    g.rotate(a);
    const L = (s / 2) * len;
    const grd = g.createLinearGradient(-L, 0, L, 0);
    grd.addColorStop(0, 'rgba(255,240,200,0)');
    grd.addColorStop(0.5, 'rgba(255,250,235,0.95)');
    grd.addColorStop(1, 'rgba(255,240,200,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(-L, 0); g.lineTo(0, -w); g.lineTo(L, 0); g.lineTo(0, w);
    g.closePath();
    g.fill();
    g.restore();
  }
});
const spriteMat = (map) => new THREE.SpriteMaterial({ map, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 });
const starCore = new THREE.Sprite(spriteMat(starTex));
const starFlare = new THREE.Sprite(spriteMat(flareTex));
const starFlash = new THREE.Sprite(spriteMat(glowTex));
const STAR_Y = TREE_BASE + TREE_H + 0.15;
[starCore, starFlare, starFlash].forEach((s) => { s.position.set(0, STAR_Y, 0); treeGroup.add(s); });
const star = { v: 0, target: 0, flash: 0 };

const heads = STRANDS.map(() => {
  const s = new THREE.Sprite(spriteMat(glowTex));
  s.scale.setScalar(0.9);
  treeGroup.add(s);
  return s;
});

/* =====================================================================
 * 背景雪尘
 * ===================================================================== */
function buildSnow() {
  const pos = new Float32Array(SNOW_COUNT * 3);
  const rnd = new Float32Array(SNOW_COUNT * 4);
  for (let i = 0; i < SNOW_COUNT; i++) {
    pos.set([rand(-34, 34), rand(-20, 20), rand(-32, 6)], i * 3);
    rnd.set([rand(0.2, 0.8), rand(0.5, 1.5), Math.random() * TAU, rand(0.5, 2)], i * 4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 4));
  const mat = new THREE.ShaderMaterial({
    uniforms: U,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uClock, uScale, uPR;
      attribute vec4 aRnd;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        p.y = mod(p.y - uClock * aRnd.x + 20.0, 40.0) - 20.0;
        p.x += sin(uClock * 0.3 * aRnd.w + aRnd.z) * 0.8;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = min(2.0 * aRnd.y * uPR * (uScale / -mv.z), 18.0 * uPR);
        vAlpha = 0.2 + 0.16 * sin(uClock * aRnd.w + aRnd.z);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vec3(0.85, 0.92, 1.0) * a * a * vAlpha, 1.0);
      }
    `,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}
scene.add(buildSnow());

/* =====================================================================
 * 氛围层：远处彩色光斑 / 近处大雪花 / 一直延伸到两边的地面闪光
 * ===================================================================== */
function ambientPoints(count, fill, vertexBody, fragBody) {
  const pos = new Float32Array(count * 3);
  const a = new Float32Array(count * 4);
  const c = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) fill(i, pos, a, c);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aP', new THREE.BufferAttribute(a, 4));
  geo.setAttribute('aColor', new THREE.BufferAttribute(c, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: U,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      uniform float uClock, uScale, uPR, uBurst;
      attribute vec4 aP;
      attribute vec3 aColor;
      varying vec3 vColor;
      varying float vAlpha;
      void main() { ${vertexBody} }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        ${fragBody}
      }
    `,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}
const BOKEH_COLORS = C(['#ffb3c6', '#ffd6a5', '#a0c4ff', '#cdb4db', '#9bf6ff', '#fdffb6', '#ffc8dd']);
const bokeh = ambientPoints(IS_MOBILE ? 12 : 20, (i, pos, a, c) => {
  // 避开画面中央，让光斑留在四周
  let x = rand(-44, 44);
  if (Math.abs(x) < 14) x = (x < 0 ? -1 : 1) * rand(14, 44);
  pos.set([x, rand(-18, 22), rand(-46, -22)], i * 3);
  a.set([rand(60, 150), Math.random() * TAU, rand(0.012, 0.035), rand(0.3, 1)], i * 4);
  const col = BOKEH_COLORS[(Math.random() * BOKEH_COLORS.length) | 0];
  c.set([col.r, col.g, col.b], i * 3);
}, `
  vec3 p = position;
  p.x += sin(uClock * 0.05 * aP.w + aP.y) * 2.0;
  p.y += cos(uClock * 0.04 * aP.w + aP.y) * 1.2;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(aP.x * uPR * (uScale / -mv.z), 260.0 * uPR);
  vColor = aColor;
  vAlpha = aP.z * (0.7 + 0.3 * sin(uClock * 0.3 * aP.w + aP.y));
`, `
  float a = smoothstep(0.5, 0.44, d) * 0.55 + smoothstep(0.5, 0.0, d) * 0.45;
  gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
`);
scene.add(bokeh);

const flakes = ambientPoints(IS_MOBILE ? 14 : 26, (i, pos, a, c) => {
  pos.set([rand(-9, 9), rand(-8, 8), rand(6, 12)], i * 3);
  a.set([rand(10, 22), Math.random() * TAU, rand(0.25, 0.6), rand(0.08, 0.2)], i * 4);
  c.set([0.9, 0.95, 1], i * 3);
}, `
  vec3 p = position;
  p.y = mod(p.y - uClock * aP.z + 9.0, 18.0) - 9.0;
  p.x += sin(uClock * 0.4 + aP.y) * 0.8;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(aP.x * uPR * (uScale / -mv.z), 200.0 * uPR);
  vColor = aColor;
  vAlpha = aP.w * smoothstep(9.0, 6.0, abs(p.y));
`, `
  float a = smoothstep(0.5, 0.05, d);
  gl_FragColor = vec4(vColor * a * a * vAlpha, 1.0);
`);
scene.add(flakes);

const GROUND_COLORS = C(['#ffffff', '#cfe9ff', '#ffe7b8', '#ffd1e3', '#d4ffe9']);
const groundGroup = new THREE.Group();
groundGroup.add(ambientPoints(IS_MOBILE ? 1400 : 2800, (i, pos, a, c) => {
  const near = Math.random() < 0.45;
  const x = near ? gauss() * 6 : rand(-32, 32);
  const z = near ? gauss() * 4 : rand(-26, 9);
  pos.set([x, gauss() * 0.02, z], i * 3);
  a.set([rand(0.5, 1.3), Math.random() * TAU, rand(0.4, 2.2), Math.max(0.12, 1 - Math.hypot(x, z) / 34)], i * 4);
  const col = Math.random() < 0.7 ? GROUND_COLORS[0] : GROUND_COLORS[(Math.random() * GROUND_COLORS.length) | 0];
  c.set([col.r, col.g, col.b], i * 3);
}, `
  vec3 p = position;
  p += normalize(vec3(p.x, 0.0, p.z) + vec3(1e-3)) * uBurst * 2.0 * fract(aP.y);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.12 + 1.2 * pow(max(0.0, sin(uClock * aP.z + aP.y)), 14.0);
  gl_PointSize = min(2.4 * aP.x * uPR * (uScale / -mv.z) * (0.7 + 0.5 * min(tw, 1.0)), 14.0 * uPR);
  vColor = aColor;
  vAlpha = tw * aP.w * 0.7;
`, `
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vColor * a * a * vAlpha, 1.0);
`));
scene.add(groundGroup);

/* =====================================================================
 * 烟花 & 声音
 * ===================================================================== */
const fw = new Fireworks(FW_MAX, U);
scene.add(fw.points);
const sound = new Sound();
fw.onExplode = () => sound.boom(0.7);

const PALETTES = [
  C(['#ff4d6d', '#ffb3c1', '#fff0f3']),
  C(['#ffd166', '#fff3c4', '#ffb703']),
  C(['#7bdff2', '#e0fbff', '#4cc9f0']),
  C(['#c77dff', '#efe3ff', '#ff8fab']),
  C(['#80ffb4', '#e6fff0', '#b8f2e6']),
  C(['#ff9f43', '#ffe0b8', '#ff6b6b']),
];
const GOLD_SPARK = C(['#fff3c4', '#ffd77a', '#ffffff']);
const ICE_SPARK = C(['#e8f6ff', '#bfe4ff', '#fff6dc']);

/* =====================================================================
 * 布局
 * ===================================================================== */
let FINALE_SCALE = 0.7, FINALE_Y = -0.95;
let textInfo = null;
function textLayout() {
  const aspect = textInfo ? textInfo.aspect : 4;
  const topY = LOOK.y + view.visH / 2 - Math.max(0.6, view.visH * 0.07);
  const treeTop = FINALE_Y + (TREE_BASE + TREE_H + 0.6) * FINALE_SCALE;
  const avail = Math.max(1.2, topY - treeTop);
  const W = Math.min(view.visW * 0.84, avail * 0.88 * aspect, 15);
  return { W, cy: treeTop + avail / 2 };
}

function layout() {
  const w = innerWidth, h = innerHeight;
  const aspect = w / h;
  camera.aspect = aspect;
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const wide = clamp01((aspect - 0.9) / 0.6);
  const halfH = 6.8 + 0.4 * wide;
  LOOK.set(0, 0.15 - 0.6 * wide, 0);
  const dist = Math.max(halfH / t, 4.45 / (t * aspect));
  // 结尾时树缩小让出祝福字的位置：竖屏上方空间多，缩得少一些
  FINALE_SCALE = aspect < 0.8 ? 0.82 : aspect < 1.2 ? 0.76 : 0.74;
  FINALE_Y = -4.45 - TREE_BASE * FINALE_SCALE;
  camera.position.set(0, LOOK.y + 0.6, dist);
  camera.lookAt(LOOK);
  camera.updateProjectionMatrix();
  view.dist = dist;
  view.visH = 2 * t * dist;
  view.visW = view.visH * aspect;
  const treePx = h * (TREE_H / view.visH);
  U.uScale.value = dist * Math.max(0.55, treePx / 620);
  U.uPR.value = renderer.getPixelRatio();
  renderer.setSize(w, h);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(w, h);
  if (textInfo) fw.relayoutText(textLayout());
}
layout();
addEventListener('resize', layout);
addEventListener('orientationchange', () => setTimeout(layout, 300));

/* =====================================================================
 * 照片（拍立得）
 * ===================================================================== */
// photo: { nickname, src, blob?, createdAt, mine, mesh, aspect, local, state, t }
const state = {
  mode: 'local', // local | visit | owner
  tree: null,
  remote: [],
  photos: [],
  nickname: '',
  pending: [], // 首页选择的照片 {file, url}
  uploading: null,
  shareP: null,
  theme: 'ice',
};

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith('blob:') && !src.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

const HAND_FONT = '"Kaiti SC","STKaiti","KaiTi","Great Vibes","Songti SC",serif';
function polaroidCanvas(img, caption) {
  const S = IS_MOBILE ? 520 : 680;
  const side = Math.round(S * 0.06);
  const bottom = Math.round(S * 0.24);
  const cv = document.createElement('canvas');
  cv.width = S + side * 2;
  cv.height = S + side + bottom;
  const g = cv.getContext('2d');
  g.fillStyle = '#f5f0e6';
  g.fillRect(0, 0, cv.width, cv.height);
  for (let k = 0; k < 900; k++) {
    g.fillStyle = `rgba(80,60,30,${Math.random() * 0.035})`;
    g.fillRect(Math.random() * cv.width, Math.random() * cv.height, 1.5, 1.5);
  }
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const sw = Math.min(iw, ih);
  g.drawImage(img, (iw - sw) / 2, (ih - sw) * 0.38, sw, sw, side, side, S, S);
  const vg = g.createRadialGradient(side + S / 2, side + S / 2, S * 0.35, side + S / 2, side + S / 2, S * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.18)');
  g.fillStyle = vg;
  g.fillRect(side, side, S, S);
  if (caption) {
    g.fillStyle = '#3a3027';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let fs = Math.round(S * 0.09);
    g.font = `${fs}px ${HAND_FONT}`;
    while (g.measureText(caption).width > S * 0.9 && fs > 12) {
      fs -= 2;
      g.font = `${fs}px ${HAND_FONT}`;
    }
    g.fillText(caption, cv.width / 2, side + S + bottom * 0.52);
  }
  // 纸胶带
  g.save();
  g.translate(cv.width / 2, side * 0.4);
  g.rotate(rand(-0.08, 0.08));
  g.fillStyle = 'rgba(255, 228, 160, 0.62)';
  g.fillRect(-S * 0.15, -S * 0.04, S * 0.3, S * 0.08);
  g.restore();
  return cv;
}

async function preparePhoto(p) {
  if (p.mesh) return;
  const img = await loadImage(p.src);
  const cv = polaroidCanvas(img, p.nickname);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  p.aspect = cv.width / cv.height;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
  p.mesh = new THREE.Mesh(new THREE.PlaneGeometry(p.aspect, 1), mat);
  p.mesh.visible = false;
  p.mesh.userData.photo = p;
  photoScene.add(p.mesh);
}

// 在圆锥表面做「最佳候选」采样：均匀但不会排成一排排；共享树用树 id 做种子，所有人看到同样的布局
function placePhotos(list, seed) {
  const rnd = seeded(seed);
  const yMin = TREE_BASE + 1.4;
  const yMax = TREE_BASE + TREE_H * 0.74;
  const a = 1 - (yMax - TREE_BASE) / TREE_H;
  const b = 1 - (yMin - TREE_BASE) / TREE_H;
  const sample = () => {
    const s = Math.sqrt(a * a + rnd() * (b * b - a * a));
    const ang = rnd() * TAU;
    const r = TREE_R * s + 0.4;
    return new THREE.Vector3(Math.cos(ang) * r, TREE_BASE + (1 - s) * TREE_H, Math.sin(ang) * r);
  };
  const pts = [];
  for (const p of list) {
    let best = sample();
    if (pts.length) {
      let bestD = -1;
      for (let k = 0; k < 70; k++) {
        const c = sample();
        let d = Infinity;
        for (const q of pts) d = Math.min(d, c.distanceTo(q));
        if (d > bestD) { bestD = d; best = c; }
      }
    }
    pts.push(best);
    p.local = best;
  }
}

const hungHeight = () => {
  const n = state.photos.length;
  return n <= 3 ? 1.95 : n <= 6 ? 1.68 : n <= 10 ? 1.45 : n <= 15 ? 1.26 : 1.12;
};

function showPhoto(p, quick = false) {
  p.dur = quick ? [0.45, 0.55, 0.55] : [SHOW_IN, SHOW_HOLD, SHOW_OUT];
  return new Promise((resolve) => {
    p.state = 'show';
    p.t = 0;
    p.resolve = resolve;
    p.mesh.visible = true;
    sound.chime(4);
  });
}
function hangPhoto(p, delay) {
  p.state = 'hang';
  p.t = -delay;
  p.mesh.visible = false;
}

const SHOW_IN = 0.8, SHOW_HOLD = 2.0, SHOW_OUT = 1.0; // 默认展示节奏
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();

function updatePhotos(dt) {
  let scatterWanted = 0;
  const showPos = tmpV2.copy(camera.position).lerp(LOOK, 0.5);
  const dShow = camera.position.distanceTo(showPos);
  const visH = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dShow;
  const visW = visH * camera.aspect;
  const gScale = treeGroup.scale.x;

  for (const p of state.photos) {
    if (!p.mesh || !p.state || p.state === 'idle' || p.state === 'gone') continue;
    const m = p.mesh;
    tmpV.copy(p.local);
    if (p.state === 'hang' && Math.abs(U.uBurst.value) > 0.001) {
      const b = U.uBurst.value;
      tmpV.x *= 1 + b * 1.4;
      tmpV.z *= 1 + b * 1.4;
      tmpV.y += U.uBurstDir.value * b * 2;
    }
    const world = treeGroup.localToWorld(tmpV);
    let rotZ = 0;
    if (p.state === 'show') {
      p.t += dt;
      const t = p.t;
      const [SHOW_IN, SHOW_HOLD, SHOW_OUT] = p.dur || [0.8, 2.0, 1.0];
      const showH = Math.min(visH * 0.6, (visW * 0.78) / p.aspect);
      m.material.color.setScalar(1);
      if (t < SHOW_IN) {
        const k = t / SHOW_IN;
        m.position.copy(showPos);
        m.position.y -= (1 - easeOutCubic(k)) * 0.6;
        m.scale.setScalar(showH * (0.35 + 0.65 * easeOutBack(k)));
        m.material.opacity = smooth(0, 0.5, k);
        rotZ = (1 - easeOutCubic(k)) * -0.3 + 0.03;
        scatterWanted = 1;
      } else if (t < SHOW_IN + SHOW_HOLD) {
        const k = t - SHOW_IN;
        m.position.copy(showPos);
        m.position.y += Math.sin(k * 1.6) * 0.05;
        m.scale.setScalar(showH * (1 + 0.01 * Math.sin(k * 2.2)));
        m.material.opacity = 1;
        rotZ = 0.03 + Math.sin(k * 1.2) * 0.015;
        scatterWanted = 1;
      } else if (t < SHOW_IN + SHOW_HOLD + SHOW_OUT) {
        const k = (t - SHOW_IN - SHOW_HOLD) / SHOW_OUT;
        const e = easeInOutCubic(k);
        m.position.copy(showPos).lerp(world, e);
        m.scale.setScalar(showH * (1 - e) + hungHeight() * gScale * 0.2 * e);
        m.material.opacity = 1 - smooth(0.55, 1, k);
        rotZ = 0.03 + e * 0.5;
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
        sound.chime(2);
      }
      const k = clamp01(p.t / 0.8);
      m.position.copy(world);
      m.scale.setScalar(Math.max(0.001, hungHeight() * gScale * easeOutBack(k) * (p.hover ? 1.12 : 1)));
      // 挂上时像钟摆一样晃两下，之后轻轻摇
      rotZ = Math.sin(clock * 1.3 + p.local.x * 3) * 0.05 + Math.exp(-p.t * 2.2) * Math.sin(p.t * 9) * 0.35;
      const front = (world.z - treeGroup.position.z) / (TREE_R * gScale + 0.4);
      const f = smooth(-0.9, 0.9, front);
      m.material.color.setScalar(0.3 + 0.7 * f);
      m.material.opacity = smooth(0, 0.3, k) * (0.55 + 0.45 * f);
      p.front = f;
    }
    m.quaternion.copy(camera.quaternion);
    m.rotateZ(rotZ);
  }
  return scatterWanted;
}

/* =====================================================================
 * 时间线工具
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
 * UI 基础
 * ===================================================================== */
const ui = {};
['landing', 'eyebrow', 'headline', 'lead', 'form', 'nickField', 'nick', 'nickTip', 'themes', 'slots', 'addSlot', 'file', 'note', 'go', 'goText', 'alt',
  'caption', 'hint', 'swipeTip', 'dock', 'fab', 'fabText',
  'cta', 'ctaCard', 'ctaClose', 'ctaFan', 'ctaScript', 'ctaTitle', 'ctaSub', 'ctaPrimary', 'ctaSecondary', 'ctaFoot',
  'deco', 'decoCard', 'decoClose', 'decoTitle', 'decoSlot', 'decoFile', 'decoImg', 'decoNameField', 'decoName', 'decoMsg', 'decoGo',
  'shotView', 'shotImg', 'shotTip', 'shotSave',
  'sheet', 'sheetTitle', 'sheetSub', 'qr', 'shareLink', 'copyBtn', 'nativeShare', 'demoNote',
  'album', 'albumTitle', 'albumGrid', 'zipBtn', 'lightbox', 'lbPrev', 'lbNext', 'lbImg', 'lbWho', 'lbMsg', 'lbWhen', 'lbDownload',
  'loading', 'loadingText', 'toast', 'soundBtn'].forEach((id) => { ui[id] = $(id); });

const on = (el, v = true) => el.classList.toggle('is-on', v);
let toastTimer = 0;
function toast(msg, ms = 2800) {
  ui.toast.textContent = msg;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), ms);
}
function loading(text) {
  if (text) ui.loadingText.textContent = text;
  on(ui.loading, !!text);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IS_WECHAT = /MicroMessenger/i.test(navigator.userAgent);
const rot = () => `${(Math.random() * 10 - 5).toFixed(1)}deg`;

function countdownText() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let xmas = new Date(now.getFullYear(), 11, 25);
  if (today > xmas) xmas = new Date(now.getFullYear() + 1, 11, 25);
  const days = Math.round((xmas - today) / 86400000);
  return days <= 0 ? '今天就是圣诞节' : `距离圣诞还有 ${days} 天`;
}

/* ---------- 颜色主题 ---------- */
const THEMES = {
  ice: { a: [0.6, 0.82, 1.0], b: [1.0, 0.97, 0.93], tint: [1, 1, 1] },
  gold: { a: [1.0, 0.68, 0.3], b: [1.0, 0.95, 0.8], tint: [1.0, 0.8, 0.5] },
  pink: { a: [1.0, 0.52, 0.74], b: [1.0, 0.92, 0.96], tint: [1.0, 0.72, 0.86] },
};
function applyTheme(name) {
  const t = THEMES[name] || THEMES.ice;
  state.theme = THEMES[name] ? name : 'ice';
  U.uThemeA.value.set(...t.a);
  U.uThemeB.value.set(...t.b);
  U.uTint.value.set(...t.tint);
}
ui.themes.addEventListener('click', (e) => {
  const b = e.target.closest('.theme');
  if (!b) return;
  ui.themes.querySelectorAll('.theme').forEach((n) => n.classList.toggle('on', n === b));
  applyTheme(b.dataset.theme);
});

/* ---------- 首页（做自己的树） ---------- */
function renderSlots() {
  ui.slots.querySelectorAll('.slot:not(.add)').forEach((n) => n.remove());
  state.pending.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'slot';
    d.style.setProperty('--r', p.r || (p.r = rot()));
    d.innerHTML = `<img alt="" src="${p.url}"><button class="rm" aria-label="移除"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
    d.querySelector('.rm').onclick = (e) => {
      e.preventDefault();
      URL.revokeObjectURL(p.url);
      state.pending.splice(i, 1);
      renderSlots();
    };
    ui.slots.insertBefore(d, ui.addSlot);
  });
  ui.addSlot.classList.toggle('full', state.pending.length >= MAX_LOCAL);
  ui.note.innerHTML = state.pending.length
    ? `已放入 <b>${state.pending.length}</b> 张 · 最多 ${MAX_LOCAL} 张`
    : '挂在树上的照片 · 可以不放 · 最多 10 张';
}
ui.file.addEventListener('change', () => {
  const files = [...ui.file.files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(f.name));
  const room = MAX_LOCAL - state.pending.length;
  if (files.length > room) toast(`最多 ${MAX_LOCAL} 张，已保留前 ${room} 张`);
  files.slice(0, room).forEach((file) => state.pending.push({ file, url: URL.createObjectURL(file) }));
  ui.file.value = '';
  renderSlots();
});

function savedNick() {
  try { return localStorage.getItem('xmas.nick') || ''; } catch (e) { return ''; }
}
function setLanding() {
  ui.eyebrow.textContent = countdownText();
  const fromFriend = params.has('from');
  if (fromFriend) {
    ui.headline.innerHTML = '轮到你了<br />种一棵自己的树';
    ui.lead.innerHTML = '种好后寄给朋友，请他们也挂上一张照片。';
  }
  if (!ui.nick.value) ui.nick.value = savedNick();
  ui.nickTip.hidden = !(fromFriend && ui.nick.value);
  ui.alt.textContent = '';
  ui.alt.onclick = null;
  const last = myTrees()[0];
  if (last && !fromFriend) {
    ui.alt.textContent = '打开我上次种的树';
    ui.alt.onclick = () => { location.href = shareLinkFor(last.id); };
  }
  renderSlots();
  document.body.classList.remove('booting');
}
ui.nick.addEventListener('input', () => { ui.nickTip.hidden = true; });

function requireName(input, field) {
  const v = input.value.trim();
  if (!v) {
    field.classList.remove('shake');
    void field.offsetWidth;
    field.classList.add('shake');
    input.focus();
    toast('先写下你的名字');
    return null;
  }
  try { localStorage.setItem('xmas.nick', v); } catch (e) { /* ignore */ }
  return v;
}

ui.go.addEventListener('click', () => {
  const nick = requireName(ui.nick, ui.nickField);
  if (!nick) return;
  state.nickname = nick;
  const photos = state.pending.map((p, i) => ({
    nickname: nick, src: p.url, blob: p.file, isOwner: true,
    createdAt: new Date(Date.now() + i).toISOString(),
  }));
  // 点亮的同时在后台把树存到云端，这样随时可以分享
  ensureShared(photos).catch(() => {});
  start({ featured: photos, prehung: [], seed: 'local-' + Math.random() });
});
ui.nick.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.go.click(); });

const remoteToPhoto = (r) => ({ nickname: r.nickname, src: r.url, createdAt: r.createdAt, id: r.id, isOwner: r.isOwner, message: r.message });
const friendCount = () => state.remote.filter((r) => !r.isOwner).length;
const ownerName = () => (state.tree ? state.tree.ownerName : state.nickname);

/* ---------- 存到云端（主人） ---------- */
function ensureShared(photos) {
  if (!state.shareP) {
    state.shareP = (async () => {
      const { tree, ownerKey } = await api.createTree(state.nickname, state.theme);
      rememberMyTree(tree, ownerKey);
      for (const p of photos) {
        const blob = await compressImage(p.blob);
        const row = await api.addPhoto(tree.id, state.nickname, blob, { ownerKey });
        p.id = row.id;
        p.remoteUrl = row.url;
      }
      state.tree = tree;
      history.replaceState(null, '', shareLinkFor(tree.id));
      return tree;
    })();
    state.shareP.catch((e) => { console.warn(e); state.shareP = null; });
  }
  return state.shareP;
}
async function myLink() {
  if (state.mode !== 'local') return shareLinkFor(state.tree.id);
  loading('正在生成分享链接');
  try {
    const tree = await ensureShared(state.photos.filter((p) => p.isOwner));
    return shareLinkFor(tree.id);
  } finally {
    loading();
  }
}
async function copyText(v) {
  try {
    await navigator.clipboard.writeText(v);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = v;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { /* ignore */ }
    ta.remove();
    return ok;
  }
}
async function inviteFriends() {
  let link;
  try {
    link = await myLink();
  } catch (e) {
    toast('分享链接生成失败：' + (e.message || '请检查网络'));
    return;
  }
  if (navigator.share && IS_MOBILE && !IS_WECHAT) {
    navigator.share({ title: `${ownerName()} 寄给你一棵圣诞树`, text: '来挂一张照片吧', url: link }).catch(() => {});
    return;
  }
  if (await copyText(link)) toast('链接已复制，发给朋友吧', 3200);
  else openSheet(link, true);
}

/* =====================================================================
 * 居中弹窗 + 收起后飞到右上角的按钮
 * ===================================================================== */
let fabCfg = null;
let sparkTimer = 0;
function setFan(srcs) {
  ui.ctaFan.innerHTML = '';
  const list = srcs.slice(0, 3);
  ui.ctaFan.classList.toggle('has', list.length > 0);
  list.forEach((src, i) => {
    const s = document.createElement('span');
    s.style.setProperty('--l', `${i * 58}px`);
    s.style.setProperty('--r', `${[-4, 3, -2][i]}deg`);
    s.innerHTML = '<i></i>';
    s.querySelector('i').style.backgroundImage = `url("${src}")`;
    ui.ctaFan.appendChild(s);
  });
}
// cfg: { fan, title, sub, primary: [text, fn], secondary?: [text, fn], foot, fab }
function openCta(cfg) {
  if (cfg.noFab) cfg.prev = fabCfg && !fabCfg.noFab ? fabCfg : (fabCfg && fabCfg.prev) || null;
  fabCfg = cfg;
  hideFab();
  setFan(cfg.fan || []);
  const d = new Date();
  $('pmDate').textContent = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  ui.ctaScript.textContent = cfg.label || '圣诞明信片';
  ui.ctaTitle.innerHTML = cfg.title;
  ui.ctaSub.innerHTML = cfg.sub || '';
  ui.ctaPrimary.textContent = cfg.primary[0];
  ui.ctaPrimary.onclick = cfg.primary[1];
  ui.ctaSecondary.hidden = !cfg.secondary;
  if (cfg.secondary) {
    ui.ctaSecondary.textContent = cfg.secondary[0];
    ui.ctaSecondary.onclick = cfg.secondary[1];
  }
  ui.ctaFoot.innerHTML = cfg.foot || '';
  ui.ctaCard.style.opacity = '';
  on(ui.cta);
}
function closeToFab(card, overlay, cfg) {
  if (cfg) fabCfg = cfg;
  ui.fabText.textContent = fabCfg ? fabCfg.fab : '';
  // 先把按钮放好（不可见）以便计算终点
  ui.fab.style.visibility = 'hidden';
  ui.fab.classList.add('is-on');
  const to = ui.fab.getBoundingClientRect();
  ui.fab.classList.remove('is-on');
  ui.fab.style.visibility = '';
  const from = card.getBoundingClientRect();
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const sx = to.width / from.width, sy = to.height / from.height;
  overlay.style.transition = 'background .5s, backdrop-filter .5s';
  overlay.style.background = 'transparent';
  overlay.style.backdropFilter = 'none';
  overlay.style.webkitBackdropFilter = 'none';
  const anim = card.animate([
    { transform: 'none', opacity: 1, borderRadius: '26px' },
    { transform: `translate(${dx * 0.55}px, ${dy * 0.35}px) scale(${0.5 + sx * 0.5}, ${0.45 + sy * 0.55})`, opacity: 0.9, borderRadius: '60px', offset: 0.55 },
    { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.25, borderRadius: '99px' },
  ], { duration: 720, easing: 'cubic-bezier(.65,0,.25,1)' });
  anim.onfinish = () => {
    card.style.opacity = '0';
    on(overlay, false);
    overlay.style.background = '';
    overlay.style.backdropFilter = '';
    overlay.style.webkitBackdropFilter = '';
    setTimeout(() => { card.style.opacity = ''; }, 700);
    showFab();
  };
}
function spawnSparks(n, spread = 1) {
  const r = ui.fab.getBoundingClientRect();
  for (let i = 0; i < n; i++) {
    const s = document.createElement('i');
    s.className = 'spark';
    const a = Math.random() * Math.PI * 2;
    const ex = r.left + r.width / 2 + Math.cos(a) * r.width * 0.5;
    const ey = r.top + r.height / 2 + Math.sin(a) * r.height * 0.5;
    const dist = (18 + Math.random() * 30) * spread;
    s.style.left = `${ex}px`;
    s.style.top = `${ey}px`;
    s.style.setProperty('--x', `${Math.cos(a) * dist}px`);
    s.style.setProperty('--y', `${Math.sin(a) * dist + 8}px`);
    s.style.setProperty('--d', `${0.8 + Math.random() * 0.8}s`);
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 1700);
  }
}
function showFab() {
  if (!fabCfg) return;
  ui.fabText.textContent = fabCfg.fab;
  on(ui.fab);
  sound.chime(3);
  setTimeout(() => spawnSparks(18, 1.6), 120);
  clearInterval(sparkTimer);
  sparkTimer = setInterval(() => { if (!document.hidden) spawnSparks(2); }, 260);
}
function hideFab() {
  on(ui.fab, false);
  clearInterval(sparkTimer);
}
ui.fab.addEventListener('click', () => { if (fabCfg) openCta(fabCfg); });
function dismissCta() {
  if (fabCfg && fabCfg.noFab) {
    // 确认类弹窗：直接关掉，恢复之前右上角的按钮
    on(ui.cta, false);
    fabCfg = fabCfg.prev;
    if (fabCfg) showFab();
    return;
  }
  closeToFab(ui.ctaCard, ui.cta);
}
ui.ctaClose.addEventListener('click', dismissCta);
ui.cta.addEventListener('click', (e) => { if (e.target === ui.cta) dismissCta(); });

/* ---------- 结束后根据身份弹出 ---------- */
function photoSrcs(filter) {
  return state.photos.filter(filter).map((p) => p.src);
}
function finaleModal() {
  if (state.mode === 'visit') {
    const owner = esc(state.tree.ownerName);
    const done = hasDecorated(state.tree.id);
    const full = friendCount() >= MAX_FRIENDS;
    const n = friendCount();
    if (done || full) {
      openCta({
        label: `来自 ${owner}`,
        fan: photoSrcs(() => true),
        title: done ? `你的照片已经挂在<br><b>${owner}</b> 的树上了` : `<b>${owner}</b> 的树<br>已经挂满了`,
        sub: '轮到你了。种一棵自己的，再寄给朋友。',
        primary: ['种我自己的树', goMine],
        secondary: ['存到相册', saveShot],
        fab: '种我的树',
      });
    } else {
      openCta({
        label: `来自 ${owner}`,
        fan: photoSrcs((p) => p.isOwner),
        title: `<b>${owner}</b> 寄给你<br>一棵圣诞树`,
        sub: n ? `树上已经挂了 ${n} 位朋友的照片。挂上你的一张，就能种一棵自己的。` : '你是第一个收到的人。挂上你的一张照片，就能种一棵自己的。',
        primary: ['挂一张照片，种我的树', openDeco],
        secondary: ['存到相册', saveShot],
        fab: '种我的树',
      });
    }
  } else {
    const n = friendCount();
    openCta({
      label: '你的树',
      fan: photoSrcs(() => true),
      title: state.mode === 'owner' && n ? `已经有 <b>${n} 位朋友</b><br>来挂过照片了` : '树种好了<br>寄给朋友吧',
      sub: `朋友打开链接，可以在你的树上挂一张照片、留一句话。最多 ${MAX_FRIENDS} 位。`,
      primary: ['复制链接，寄出去', inviteFriends],
      secondary: ['存一张到相册', saveShot],
      foot: '也可以 <button class="text-link" id="qrLink">用二维码寄</button>',
      fab: '寄出去',
    });
    $('qrLink').onclick = async () => {
      try { openSheet(await myLink(), true); } catch (e) { toast('分享链接生成失败'); }
    };
  }
}
function goMine() {
  location.href = state.tree ? `${BASE_URL}?from=${encodeURIComponent(state.tree.id)}` : BASE_URL;
}

/* ---------- 帮对方装饰（做自己的树之前必须完成） ---------- */
async function uploadMine(photo, file) {
  try {
    const blob = await compressImage(file);
    const row = await api.addPhoto(state.tree.id, photo.nickname, blob, { message: photo.message });
    photo.id = row.id;
    photo.remoteUrl = row.url;
    state.remote.push(row);
    return { ok: true };
  } catch (e) {
    console.warn(e);
    return { ok: false, full: e instanceof TreeFullError, error: e };
  }
}
const deco = { file: null, url: '' };
function openDeco() {
  on(ui.cta, false);
  hideFab();
  fabCfg = fabCfg || { fab: '做我的树' };
  ui.decoTitle.innerHTML = `挂一张照片到<br><b>${esc(state.tree.ownerName)}</b> 的树上`;
  if (!ui.decoName.value) ui.decoName.value = savedNick();
  ui.decoCard.style.opacity = '';
  on(ui.deco);
}
ui.decoClose.addEventListener('click', () => closeToFab(ui.decoCard, ui.deco));
ui.decoFile.addEventListener('change', () => {
  const f = ui.decoFile.files[0];
  ui.decoFile.value = '';
  if (!f) return;
  if (deco.url) URL.revokeObjectURL(deco.url);
  deco.file = f;
  deco.url = URL.createObjectURL(f);
  ui.decoImg.src = deco.url;
  ui.decoImg.hidden = false;
  ui.decoSlot.classList.add('has');
});
ui.decoGo.addEventListener('click', () => {
  if (!deco.file) {
    toast('先选一张照片');
    ui.decoSlot.animate([{ transform: 'rotate(-2deg) scale(1)' }, { transform: 'rotate(-2deg) scale(1.08)' }, { transform: 'rotate(-2deg) scale(1)' }], { duration: 400 });
    return;
  }
  const name = requireName(ui.decoName, ui.decoNameField);
  if (!name) return;
  on(ui.deco, false);
  runDecorate(name, ui.decoMsg.value.trim(), deco.file, deco.url);
  deco.file = null;
  deco.url = '';
  ui.decoImg.hidden = true;
  ui.decoSlot.classList.remove('has');
  ui.decoMsg.value = '';
});

async function runDecorate(name, message, file, url) {
  const gen = generation;
  on(ui.dock, false);
  const mine = { nickname: name, message, src: url, blob: file, createdAt: new Date().toISOString(), mine: true };
  const upload = uploadMine(mine, file);
  try {
    await preparePhoto(mine);
  } catch (e) {
    toast('这张照片读取失败，换一张试试');
    on(ui.dock);
    openDeco();
    return;
  }
  state.photos.push(mine);
  showArgs.prehung.push(mine);
  placePhotos([...state.photos].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)), state.tree.id);
  await showPhoto(mine);
  if (gen !== generation) return;
  hangPhoto(mine, 0.05);
  await sleep(1.2);
  const r = await upload;
  if (gen !== generation) return;
  on(ui.dock);
  if (r.ok) {
    markDecorated(state.tree.id);
    openCta({
      label: '已寄达',
      fan: [url],
      title: '挂好了，谢谢你',
      sub: `${esc(state.tree.ownerName)} 打开就能看到你的照片${message ? '和留言' : ''}。<br>现在，种一棵你自己的树吧。`,
      primary: ['种我自己的树', goMine],
      secondary: ['存一张 TA 的树', saveShot],
      fab: '种我的树',
    });
  } else if (r.full) {
    toast('这棵树刚刚被挂满了，照片没能保存', 4000);
    finaleModal();
  } else {
    toast('照片没能上传成功：' + (r.error && r.error.message ? r.error.message : '请检查网络'), 4500);
    finaleModal();
  }
}

/* =====================================================================
 * 保存图片：只截取画面（不含按钮），加上名字和二维码
 * ===================================================================== */
let shotRequest = null;
let shotBlob = null;
function captureFrame() {
  return new Promise((resolve, reject) => {
    shotRequest = resolve;
    setTimeout(() => {
      if (shotRequest === resolve) { shotRequest = null; reject(new Error('timeout')); }
    }, 4000);
  });
}
async function saveShot() {
  loading('正在生成图片');
  try {
    const frameCanvas = await captureFrame();
    const blob = await new Promise((res) => frameCanvas.toBlob(res, 'image/jpeg', 0.95));
    shotBlob = blob;
    if (ui.shotImg.src) URL.revokeObjectURL(ui.shotImg.src);
    ui.shotImg.src = URL.createObjectURL(blob);
    ui.shotTip.textContent = IS_MOBILE ? '长按图片，存到相册' : '右键图片另存，或点下面的按钮';
    ui.shotSave.hidden = IS_WECHAT;
    on(ui.shotView);
  } catch (e) {
    console.warn(e);
    toast('图片生成失败，请重试');
  }
  loading();
}
ui.shotSave.addEventListener('click', async () => {
  if (!shotBlob) return;
  const file = new File([shotBlob], 'christmas-tree.jpg', { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && IS_MOBILE) {
    try { await navigator.share({ files: [file], title: 'Merry Christmas' }); return; } catch (e) { /* 用户取消 */ return; }
  }
  saveBlob(shotBlob, 'christmas-tree.jpg');
});

/* ---------- 分享（链接 + 二维码） ---------- */
const shareLinkFor = (id) => `${BASE_URL}?t=${encodeURIComponent(id)}`;
const scriptCache = {};
function loadScript(src) {
  scriptCache[src] = scriptCache[src] || new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => { delete scriptCache[src]; rej(new Error('加载失败')); };
    document.head.appendChild(s);
  });
  return scriptCache[src];
}
async function openSheet(link, mine) {
  ui.shareLink.value = link;
  ui.sheetTitle.textContent = '把树寄给朋友';
  ui.sheetSub.textContent = mine ? `扫码或复制链接，朋友就能来挂照片（最多 ${MAX_FRIENDS} 位）` : '扫码或复制链接，转给更多朋友';
  ui.demoNote.hidden = cloudEnabled;
  ui.nativeShare.hidden = !navigator.share;
  ui.qr.innerHTML = '';
  ui.qr.hidden = false;
  on(ui.sheet);
  try {
    await loadScript('./lib/vendor/qrcode.js');
    const qr = window.qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    const img = new Image();
    img.alt = '二维码';
    img.src = qr.createDataURL(8, 0);
    ui.qr.appendChild(img);
  } catch (e) {
    ui.qr.hidden = true;
  }
}
ui.copyBtn.addEventListener('click', async () => {
  if (await copyText(ui.shareLink.value)) {
    ui.copyBtn.textContent = '已复制';
    setTimeout(() => { ui.copyBtn.textContent = '复制'; }, 1600);
  }
});
ui.nativeShare.addEventListener('click', () => {
  navigator.share({ title: 'Merry Christmas', text: '来帮我装饰圣诞树吧', url: ui.shareLink.value }).catch(() => {});
});

document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => on(b.closest('.overlay'), false)));
document.querySelectorAll('.overlay:not(.modal-wrap)').forEach((o) => o.addEventListener('click', (e) => { if (e.target === o) on(o, false); }));
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.overlay.is-on:not(.modal-wrap)').forEach((o) => on(o, false));
  if (ui.lightbox.classList.contains('is-on')) {
    if (e.key === 'ArrowLeft') lbGo(-1);
    if (e.key === 'ArrowRight') lbGo(1);
  }
});

/* ---------- 相册 & 大图 & 下载 ---------- */
const fmtDate = (s) => {
  const d = new Date(s);
  return isNaN(d) ? '' : `${d.getMonth() + 1}月${d.getDate()}日`;
};
function openAlbum() {
  const list = state.photos;
  ui.albumTitle.textContent = `${ownerName()} 的圣诞树 · ${list.length} 张照片`;
  ui.albumGrid.innerHTML = list.length ? '' : '<p class="album-empty">还没有照片</p>';
  list.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'polaroid';
    d.style.setProperty('--r', rot());
    d.style.animationDelay = `${i * 0.05}s`;
    d.innerHTML = `<div class="ph"></div><span class="nm">${esc(p.nickname || '')}</span>`;
    d.querySelector('.ph').style.backgroundImage = `url("${p.src}")`;
    d.onclick = () => openLightbox(i);
    ui.albumGrid.appendChild(d);
  });
  ui.zipBtn.hidden = list.length < 2;
  on(ui.album);
}

let lbIndex = 0;
function openLightbox(i) {
  const list = state.photos;
  if (!list.length) return;
  lbIndex = (i + list.length) % list.length;
  const p = list[lbIndex];
  ui.lbImg.src = p.src;
  ui.lbWho.textContent = p.nickname ? `— ${p.nickname}` : '';
  ui.lbMsg.textContent = p.message ? `「${p.message}」` : '';
  ui.lbWhen.textContent = fmtDate(p.createdAt);
  ui.lbPrev.hidden = ui.lbNext.hidden = list.length < 2;
  on(ui.lightbox);
}
function lbGo(d) { openLightbox(lbIndex + d); }
ui.lbPrev.addEventListener('click', () => lbGo(-1));
ui.lbNext.addEventListener('click', () => lbGo(1));
ui.lbDownload.addEventListener('click', () => downloadPhoto(state.photos[lbIndex], lbIndex));
let swipeX = null;
ui.lightbox.addEventListener('touchstart', (e) => { swipeX = e.touches[0].clientX; }, { passive: true });
ui.lightbox.addEventListener('touchend', (e) => {
  if (swipeX === null) return;
  const dx = e.changedTouches[0].clientX - swipeX;
  if (Math.abs(dx) > 50) lbGo(dx < 0 ? 1 : -1);
  swipeX = null;
});

const fileName = (p, i) => `${String(i + 1).padStart(2, '0')}-${(p.nickname || 'photo').replace(/[\\/:*?"<>|]/g, '')}.jpg`;
async function photoBlob(p) {
  if (p.blob) return p.blob;
  const res = await fetch(p.remoteUrl || p.src);
  if (!res.ok) throw new Error('下载失败');
  return res.blob();
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
async function downloadPhoto(p, i) {
  if (!p) return;
  if (IS_WECHAT) { toast('微信里请长按图片保存'); return; }
  try {
    saveBlob(await photoBlob(p), `christmas-photo-${String(i + 1).padStart(2, '0')}.jpg`);
  } catch (e) {
    toast('下载失败，可以长按或右键图片保存');
  }
}
ui.zipBtn.addEventListener('click', async () => {
  if (IS_WECHAT) { toast('微信里请点开照片后长按保存'); return; }
  loading('正在打包照片');
  try {
    await loadScript('./lib/vendor/jszip.min.js');
    const zip = new window.JSZip();
    const list = state.photos;
    for (let i = 0; i < list.length; i++) zip.file(fileName(list[i], i), await photoBlob(list[i]));
    const blob = await zip.generateAsync({ type: 'blob' });
    saveBlob(blob, 'christmas-tree-photos.zip');
  } catch (e) {
    toast('打包失败，可以逐张下载');
  }
  loading();
});

/* ---------- 小工具栏 ---------- */
let dockBusy = 0;
ui.dock.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const act = b.dataset.act;
  if (performance.now() - dockBusy < 400) return; // 防止连点
  dockBusy = performance.now();
  try {
    runDockAction(act);
  } catch (err) {
    console.warn(err);
    toast('出了点小问题，再点一次试试');
  }
});
function runDockAction(act) {
  if (act === 'replay') replay();
  else if (act === 'album') openAlbum();
  else if (act === 'save') saveShot();
  else if (act === 'redo') confirmRedo();
  else if (act === 'mine') {
    if (hasDecorated(state.tree.id) || friendCount() >= MAX_FRIENDS) goMine();
    else openDeco();
  }
}
function setupDock() {
  const owner = state.mode !== 'visit';
  ui.dock.querySelectorAll('[data-for]').forEach((b) => {
    b.hidden = (b.dataset.for === 'owner') !== owner;
  });
}

/* ---------- 重新做一棵 ---------- */
function confirmRedo() {
  openCta({
    label: '重新种',
    title: '再种一棵？',
    sub: '这棵树和朋友们的照片都会留着，首页随时能找回来。',
    primary: ['重新种一棵', () => { location.href = BASE_URL; }],
    secondary: ['算了，再看看', dismissCta],
    noFab: true,
  });
}

/* ---------- 做好之后继续加照片（主人） ---------- */
function ownerKeyFor(id) {
  const t = myTrees().find((x) => x.id === id);
  return t && t.key;
}
ui.addFile = $('addFile');
ui.addFile.addEventListener('click', (e) => e.stopPropagation());
ui.addFile.addEventListener('change', async () => {
  const files = [...ui.addFile.files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(f.name));
  ui.addFile.value = '';
  if (!files.length) return;
  const room = MAX_LOCAL - state.photos.filter((p) => p.isOwner).length;
  if (room <= 0) { toast(`你自己最多放 ${MAX_LOCAL} 张照片`); return; }
  if (files.length > room) toast(`还能放 ${room} 张，已保留前 ${room} 张`);
  addOwnerPhotos(files.slice(0, room));
});
async function addOwnerPhotos(files) {
  const gen = generation;
  let tree, key;
  try {
    tree = state.mode === 'local' ? await ensureShared(state.photos.filter((p) => p.isOwner)) : state.tree;
    key = ownerKeyFor(tree.id);
  } catch (e) {
    toast('保存失败：' + (e.message || '请检查网络'));
    return;
  }
  if (!key) {
    toast('这棵树是旧版本种的，不能再加照片了，点「重新种」种一棵新的吧', 4500);
    return;
  }
  const name = ownerName();
  loading('正在添加照片');
  const prepared = await Promise.all(files.map(async (f, i) => {
    const p = { nickname: name, src: URL.createObjectURL(f), blob: f, isOwner: true, createdAt: new Date(Date.now() + i).toISOString() };
    try { await preparePhoto(p); return p; } catch (e) { return null; }
  }));
  loading();
  const added = prepared.filter(Boolean);
  if (!added.length) { toast('照片读取失败，换一张试试'); return; }
  // 后台上传
  const uploads = added.map(async (p) => {
    const blob = await compressImage(p.blob);
    const row = await api.addPhoto(tree.id, name, blob, { ownerKey: key });
    p.id = row.id;
    p.remoteUrl = row.url;
    state.remote.push(row);
  });
  on(ui.dock, false);
  on(ui.cta, false);
  added.forEach((p) => { state.photos.push(p); showArgs.prehung.push(p); });
  placePhotos([...state.photos].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)), showArgs.seed);
  if (added.length === 1) {
    // 一张：快速放大一下再挂上
    await showPhoto(added[0], true);
    if (gen !== generation) return;
    hangPhoto(added[0], 0);
  } else {
    // 多张：直接依次弹上树
    added.forEach((p, i) => hangPhoto(p, i * 0.12));
  }
  await sleep(0.5);
  if (gen !== generation) return;
  on(ui.dock);
  const res = await Promise.allSettled(uploads);
  if (gen !== generation) return;
  const bad = res.filter((r) => r.status === 'rejected');
  if (!bad.length) toast('加好了，朋友打开就能看到');
  else if (bad.some((r) => r.reason instanceof TreeFullError)) toast('你自己最多放 10 张照片，多出的没有保存');
  else toast(`有 ${bad.length} 张没能保存，请检查网络后再试`);
}

/* ---------- 声音 ---------- */
ui.soundBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  sound.unlock();
  const en = sound.toggle();
  if (en) sound.startMusic();
  ui.soundBtn.classList.toggle('muted', !en);
});
// 第一次触碰屏幕时开始播放音乐（浏览器要求用户手势）
addEventListener('pointerdown', () => {
  sound.unlock();
  if (sound.enabled) sound.startMusic();
}, { once: true, capture: true });

/* =====================================================================
 * 主流程
 * ===================================================================== */
let finale = null;
let reveal = { active: false };
let showArgs = null;

async function start(args) {
  showArgs = args;
  sound.unlock();
  if (sound.enabled) sound.startMusic();
  ui.soundBtn.hidden = false;
  ui.soundBtn.classList.toggle('muted', !sound.enabled);
  ui.landing.classList.add('is-off');
  ui.go.disabled = true;

  const all = [...args.prehung, ...args.featured];
  const slow = setTimeout(() => loading('正在准备照片'), 600);
  const results = await Promise.allSettled(all.map(preparePhoto));
  clearTimeout(slow);
  loading();
  const bad = results.filter((r) => r.status === 'rejected').length;
  if (bad) toast(`有 ${bad} 张照片没能读取，已跳过`);
  args.prehung = args.prehung.filter((p) => p.mesh);
  args.featured = args.featured.filter((p) => p.mesh);
  state.photos = [...args.prehung, ...args.featured];
  setupDock();
  // 按上传时间顺序放置，保证每个人看到的位置一致
  const ordered = [...state.photos].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  placePhotos(ordered, args.seed);
  resetShow();
  runShow(args);
}

function replay() {
  resetShow();
  runShow(showArgs);
}

function captionText() {
  const n = state.tree ? friendCount() : 0;
  const name = ownerName();
  if (!name) return '';
  return n ? `${name} 的圣诞树 · ${n} 位朋友装饰` : `${name} 的圣诞树`;
}

async function runShow({ featured, prehung }) {
  const gen = generation;
  const alive = () => gen === generation;

  // 1. 地面光尘 → 两支光笔螺旋向上画出整棵树
  tween(1.4, (e) => { U.uIntro.value = e; });
  await sleep(0.9);
  reveal = { active: true };
  await tween(4.4, (e) => { U.uReveal.value = e; }, easeInOutSine);
  reveal = { active: false };
  if (!alive()) return;

  // 2. 星星点亮
  star.target = 1;
  star.flash = 1;
  const sp = treeGroup.localToWorld(tmpV.set(0, STAR_Y, 0));
  fw.burst(sp.x, sp.y, sp.z, { count: IS_MOBILE ? 90 : 160, speed: 4.5, colors: GOLD_SPARK, size: 0.9, life: 1.4, grav: 0.6 });
  sound.chime(6);
  await sleep(0.8);
  ui.caption.textContent = captionText();
  on(ui.caption, !!ui.caption.textContent);
  await sleep(0.6);
  if (!alive()) return;

  // 3. 照片一张张挂上树
  if (prehung.length) {
    prehung.forEach((p, i) => hangPhoto(p, i * 0.16));
    await sleep(prehung.length * 0.16 + 0.9);
    if (!alive()) return;
  }

  // 4. 主角照片逐张放大展示，然后飞回树上
  if (featured.length) {
    on(ui.caption, false);
    await sleep(0.3);
    for (let i = 0; i < featured.length; i++) {
      if (!alive()) return;
      if (featured.length > 1) {
        ui.hint.innerHTML = `<b>${i + 1} / ${featured.length}</b>`;
        on(ui.hint);
      }
      await showPhoto(featured[i]);
      await sleep(0.25);
    }
    on(ui.hint, false);
    if (!alive()) return;
    await sleep(0.3);
    featured.forEach((p, i) => hangPhoto(p, i * 0.18));
    await sleep(featured.length * 0.18 + 1.2);
    on(ui.caption, !!ui.caption.textContent);
    if (!alive()) return;
  }

  startFinale();
}

const BLESSINGS = ['圣诞快乐', '天天开心', '心想事成'];
const BLESS_COLORS = {
  '圣诞快乐': ['#ffd166', '#ff4d5e'],
  '天天开心': ['#ffb3c6', '#ffd6a5'],
  '心想事成': ['#ffe08a', '#b388ff'],
};
const textMorph = { current: '圣诞快乐', last: -10 };
function blessColorFn(text) {
  const [a, b] = BLESS_COLORS[text].map((c) => new THREE.Color(c));
  const white = new THREE.Color('#fff6dc');
  const aspect = textInfo ? textInfo.aspect : 4;
  return (t) => {
    if (Math.random() < 0.12) return white;
    const k = 0.5 + 0.5 * Math.sin(t[0] * Math.PI * 2.2 + t[1] * aspect);
    return a.clone().lerp(b, k * 0.75);
  };
}
function morphText(origin) {
  if (!textInfo || clock - textMorph.last < 1.3) return;
  textMorph.last = clock;
  const choices = BLESSINGS.filter((b) => b !== textMorph.current);
  const next = choices[(Math.random() * choices.length) | 0];
  textMorph.current = next;
  textInfo = sampleText(next, TEXT_COUNT);
  const pts = textInfo.pts.map(([x, y]) => [x, y, rand(-0.12, 0.12)]);
  for (let i = pts.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [pts[i], pts[j]] = [pts[j], pts[i]];
  }
  fw.morphText(pts, textLayout(), blessColorFn(next), origin);
  sound.chime(5);
  on(ui.swipeTip, false);
}

async function startFinale() {
  const gen = generation;
  const s0 = treeGroup.scale.x, y0 = treeGroup.position.y;
  tween(1.6, (e) => {
    treeGroup.scale.setScalar(s0 + (FINALE_SCALE - s0) * e);
    treeGroup.position.y = y0 + (FINALE_Y - y0) * e;
  });

  textMorph.current = '圣诞快乐';
  textInfo = sampleText('圣诞快乐', TEXT_COUNT);
  const targets = textInfo.pts.map(([x, y]) => [x, y, rand(-0.12, 0.12)]);
  targets.sort((a, b) => a[0] - b[0]);
  const gold = new THREE.Color('#ffd166');
  const colorFn = blessColorFn('圣诞快乐');
  const groups = 4;
  const per = Math.ceil(targets.length / groups);
  for (let g = 0; g < groups; g++) {
    const part = targets.slice(g * per, (g + 1) * per);
    if (!part.length) continue;
    const nx = part.reduce((s, t) => s + t[0], 0) / part.length;
    after(g * 0.32 + rand(0, 0.1), () => {
      const L = textLayout();
      const ex = nx * L.W;
      fw.rocket(ex * 0.6 + rand(-0.5, 0.5), LOOK.y - view.visH / 2 - 0.5, 0, ex, L.cy + rand(-0.3, 0.3), 1.15, gold, (x, y, z) => {
        fw.textBurst(x, y, z, part, textLayout(), colorFn);
        fw.burst(x, y, z, { count: IS_MOBILE ? 90 : 160, speed: 8, colors: PALETTES[(g * 2 + 1) % PALETTES.length], size: 1, life: 1.6 });
      });
    });
  }
  await sleep(state.mode === 'visit' ? 2.6 : 3.4);
  if (gen !== generation) return;
  finale = { nextLaunch: clock + 0.3 };
  on(ui.dock);
  finaleModal();
  after(0.6, () => { on(ui.swipeTip); after(5, () => on(ui.swipeTip, false)); });
}

function launchRandomFirework() {
  const x1 = rand(-0.45, 0.45) * view.visW;
  const top = LOOK.y + view.visH / 2;
  const y1 = rand(top - view.visH * 0.42, top - view.visH * 0.08);
  const z = rand(-8, -2);
  const pal = PALETTES[(Math.random() * PALETTES.length) | 0];
  fw.rocket(x1 + rand(-1.5, 1.5), LOOK.y - view.visH / 2 - 1, z, x1, y1, rand(1.0, 1.4), pal[0], (x, y, zz) => {
    fw.burst(x, y, zz, { count: IS_MOBILE ? 110 : 200, speed: rand(5.5, 8.5), colors: pal, size: 1, life: rand(1.4, 2.0) });
  });
}

function resetShow() {
  generation++;
  timers = [];
  tweens = [];
  finale = null;
  textInfo = null;
  reveal = { active: false };
  fw.clear();
  U.uReveal.value = 0;
  U.uIntro.value = 0;
  U.uScatter.value = 0;
  star.target = star.v = star.flash = 0;
  treeGroup.scale.setScalar(1);
  treeGroup.position.y = 0;
  [ui.caption, ui.dock, ui.hint, ui.swipeTip, ui.cta, ui.deco].forEach((el) => on(el, false));
  hideFab();
  textMorph.current = '圣诞快乐';
  burst.target = burst.v = burst.vel = burst.kick = burst.hold = 0;
  state.photos.forEach((p) => {
    p.state = 'idle';
    if (p.mesh) p.mesh.visible = false;
  });
}

/* =====================================================================
 * 指针：拖动旋转 / 点照片看大图 / 指尖星光
 * ===================================================================== */
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pickPhoto(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const meshes = state.photos.filter((p) => p.state === 'hang' && p.mesh && p.mesh.visible && p.t > 0.3).map((p) => p.mesh);
  if (!meshes.length) return null;
  const hits = raycaster.intersectObjects(meshes, false);
  if (!hits.length) return null;
  hits.sort((a, b) => (b.object.userData.photo.front || 0) - (a.object.userData.photo.front || 0));
  return hits[0].object.userData.photo;
}
const trailPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -3);
const trailHit = new THREE.Vector3();
let lastTrail = 0;
function sparkleAt(x, y) {
  if (clock - lastTrail < 0.016) return;
  lastTrail = clock;
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  if (!raycaster.ray.intersectPlane(trailPlane, trailHit)) return;
  const c = ICE_SPARK[(Math.random() * ICE_SPARK.length) | 0];
  for (let k = 0; k < 2; k++) {
    fw.add(0, trailHit.x + rand(-0.06, 0.06), trailHit.y + rand(-0.06, 0.06), trailHit.z,
      rand(-0.4, 0.4), rand(-0.2, 0.5), rand(-0.4, 0.4), c, rand(0.5, 0.9), rand(0.5, 0.9), 0.4);
  }
}

let drag = null;
let yawVel = 0;
const burst = { v: 0, vel: 0, target: 0, kick: 0, hold: 0 };
const planeZ0 = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const hitV = new THREE.Vector3();
function worldAt(x, y, plane) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray.intersectPlane(plane, hitV);
}
function overText(x, y) {
  if (!textInfo) return false;
  const w = worldAt(x, y, planeZ0);
  if (!w) return false;
  const L = textLayout();
  const H = L.W / textInfo.aspect;
  return Math.abs(w.x) < L.W * 0.56 && Math.abs(w.y - L.cy) < H * 0.75 + 0.5;
}
function starHit(x, y) {
  if (star.v < 0.5) return false;
  const v = treeGroup.localToWorld(tmpV.set(0, STAR_Y, 0)).project(camera);
  return Math.hypot((v.x * 0.5 + 0.5) * innerWidth - x, (0.5 - v.y * 0.5) * innerHeight - y) < 46;
}
const SHOWER = C(['#fff3c4', '#ffd77a', '#ffffff', '#ffc8dd', '#a0c4ff']);
function starShower() {
  star.flash = 0.9;
  const p = treeGroup.localToWorld(tmpV.set(0, STAR_Y, 0));
  fw.burst(p.x, p.y, p.z, { count: IS_MOBILE ? 130 : 240, speed: 3.6, colors: SHOWER, size: 0.85, life: 2.6, grav: 2.4 });
  sound.chime(7);
}

canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, axis: null, text: overText(e.clientX, e.clientY), path: 0, swiped: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  const x = e.clientX, y = e.clientY;
  sparkleAt(x, y);
  if (!drag) {
    if (!IS_MOBILE) {
      const p = pickPhoto(x, y);
      state.photos.forEach((q) => { q.hover = q === p; });
      canvas.classList.toggle('pointer', !!p || starHit(x, y) || overText(x, y));
    }
    return;
  }
  const dx = x - drag.x, dy = y - drag.y;
  drag.x = x;
  drag.y = y;
  if (Math.abs(x - drag.sx) + Math.abs(y - drag.sy) > 8) drag.moved = true;
  // 在祝福文字上划过：推开粒子，划够一段就换一句祝福
  if (drag.text) {
    drag.path += Math.hypot(dx, dy);
    const w = worldAt(x, y, planeZ0);
    if (w) fw.repel(w.x, w.y, 1.3, 0.35);
    if (!drag.swiped && drag.path > 50 && w) {
      drag.swiped = true;
      morphText(w.clone());
    }
    return;
  }
  if (!drag.axis && drag.moved) drag.axis = Math.abs(x - drag.sx) >= Math.abs(y - drag.sy) ? 'x' : 'y';
  if (drag.axis === 'x') {
    const d = (dx / innerWidth) * Math.PI * 1.6;
    treeGroup.rotation.y += d;
    yawVel = d * 30;
  } else if (drag.axis === 'y') {
    // 上下拖：把粒子打散，越远散得越开
    const d = (drag.sy - y) / (innerHeight * 0.32);
    burst.target = Math.min(1.25, Math.abs(d));
    U.uBurstDir.value = d >= 0 ? 1 : -1;
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (drag && !drag.moved) {
    if (starHit(e.clientX, e.clientY)) starShower();
    else {
      const p = pickPhoto(e.clientX, e.clientY);
      if (p) openLightbox(state.photos.indexOf(p));
    }
  }
  if (drag && drag.axis === 'y') {
    // 松手：先保证完全散开，停留片刻，再慢慢聚回来
    burst.kick = Math.max(burst.v, 1.05);
    burst.hold = 0;
  }
  burst.target = 0;
  drag = null;
});
canvas.addEventListener('pointercancel', () => { burst.target = 0; drag = null; });

/* =====================================================================
 * 渲染循环
 * ===================================================================== */
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

const capV = new THREE.Vector3();
let capTop = -1;
function placeCaption() {
  capV.set(0, treeGroup.position.y + (TREE_BASE - 0.7) * treeGroup.scale.y - 0.1, 0).project(camera);
  const y = Math.round((0.5 - capV.y * 0.5) * innerHeight);
  if (y !== capTop) {
    capTop = y;
    ui.caption.style.top = y + 'px';
  }
}

const centerV = new THREE.Vector3();
let nextMeteor = 3;
let last = performance.now();
let shotHiRes = false;
function frame(now) {
  requestAnimationFrame(frame);
  if (shotRequest && !shotHiRes) {
    // 截图这一帧用更高的分辨率渲染，图片更清晰
    shotHiRes = true;
    // 手机显存有限：截图最长边不超过约 2400 像素
    const cap = (IS_MOBILE ? 2400 : 3600) / Math.max(innerWidth, innerHeight);
    renderer.setPixelRatio(Math.max(perf.pr, Math.min(IS_MOBILE ? 2 : 3, Math.max(2, devicePixelRatio), cap)));
    layout();
  }
  const rawDt = Math.max(0, (now - last) / 1000);
  const dt = Math.min(0.05, rawDt) * TIME_SCALE;
  last = now;
  clock += dt;
  adaptQuality(Math.min(rawDt, 0.25));
  runTimers(dt);
  U.uClock.value = clock;

  treeGroup.rotation.y += (0.16 + yawVel) * dt;
  yawVel *= Math.exp(-dt * 2.5);
  // 打散：跟手时很快；松手后冲到完全散开 → 停一会 → 像文字一样慢慢聚回
  let bt, bk, bd;
  if (burst.target > 0) { bt = burst.target; bk = 60; bd = 10; }
  else if (burst.kick) {
    bt = burst.kick; bk = 45; bd = 9;
    if (burst.v >= burst.kick * 0.96) { burst.kick = 0; burst.hold = clock + 0.3; }
  } else if (clock < burst.hold) { bt = burst.v; bk = 0; bd = 14; }
  else { bt = 0; bk = 10; bd = 6.2; }
  burst.vel += (bt - burst.v) * bk * dt;
  burst.vel *= Math.exp(-dt * bd);
  burst.v += burst.vel * dt;
  U.uBurst.value = Math.max(-0.15, burst.v);
  groundGroup.position.y = treeGroup.position.y + (TREE_BASE - 0.06) * treeGroup.scale.y;
  if (clock > nextMeteor) {
    nextMeteor = clock + rand(5, 11);
    const dir = Math.random() < 0.5 ? -1 : 1;
    const top = LOOK.y + view.visH * 0.62;
    fw.meteor(rand(-0.7, 0.7) * view.visW * 1.4, top - rand(0, view.visH * 0.2), -14, dir * rand(11, 17), -rand(5, 9), rand(0.9, 1.4));
  }
  treeGroup.updateMatrixWorld();
  centerV.set(0, treeGroup.position.y, 0).applyMatrix4(camera.matrixWorldInverse);
  U.uCenterZ.value = centerV.z;
  U.uGS.value = treeGroup.scale.x;

  // 光笔
  const u = U.uReveal.value;
  const drawing = reveal.active && u > 0.001 && u < 0.999;
  heads.forEach((h, k) => {
    const ang = u * TURNS * TAU + STRANDS[k];
    const r = TREE_R * (1 - u);
    h.position.set(Math.cos(ang) * r, TREE_BASE + u * TREE_H, Math.sin(ang) * r);
    h.material.opacity = drawing ? 1 : Math.max(0, h.material.opacity - dt * 3);
    h.scale.setScalar(0.9 + 0.2 * Math.sin(clock * 20 + k));
    if (drawing) {
      const w = treeGroup.localToWorld(tmpV.copy(h.position));
      const c = GOLD_SPARK[(Math.random() * GOLD_SPARK.length) | 0];
      for (let n = 0; n < 2; n++) {
        fw.add(0, w.x, w.y, w.z, rand(-0.6, 0.6), rand(-0.3, 0.6), rand(-0.6, 0.6), c, rand(0.5, 0.9), rand(0.5, 1.1), 0.8);
      }
    }
  });

  // 星星
  star.v += (star.target - star.v) * (1 - Math.exp(-dt * 2.2));
  star.flash = Math.max(0, star.flash - dt * 1.4);
  const pulse = 1 + 0.06 * Math.sin(clock * 3);
  starCore.material.opacity = star.v;
  starFlare.material.opacity = star.v * 0.85;
  starCore.scale.setScalar(Math.max(0.001, 1.6 * easeOutBack(clamp01(star.v)) * pulse));
  starFlare.scale.setScalar(Math.max(0.001, 5 * star.v * (1 + 0.1 * Math.sin(clock * 2.1))));
  starFlare.material.rotation = clock * 0.12;
  starFlash.material.opacity = star.flash;
  starFlash.scale.setScalar(Math.max(0.001, 2 + (1 - star.flash) * 9));

  const scatterWanted = updatePhotos(dt);
  const sc = U.uScatter;
  sc.value += (scatterWanted - sc.value) * (1 - Math.exp(-dt * (scatterWanted > sc.value ? 2.6 : 1.8)));

  if (finale && clock >= finale.nextLaunch) {
    launchRandomFirework();
    finale.nextLaunch = clock + rand(0.7, 1.5) * (IS_MOBILE ? 1.3 : 1);
  }
  fw.update(dt, clock);
  placeCaption();

  renderer.clear();
  composer.render();
  renderer.clearDepth();
  renderer.render(photoScene, camera);
  if (shotRequest) {
    // 绘制完成后立刻拷贝画面（此时画布里只有场景，没有任何按钮）
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d').drawImage(canvas, 0, 0);
    const r = shotRequest;
    shotRequest = null;
    shotHiRes = false;
    renderer.setPixelRatio(perf.pr);
    layout();
    r(copy);
  }
}
requestAnimationFrame(frame);

/* =====================================================================
 * 启动
 * ===================================================================== */
async function boot() {
  const id = params.get('t');
  if (id) {
    ui.landing.classList.add('is-off');
    loading('正在打开圣诞树');
    try {
      const tree = await api.getTree(id);
      if (tree) {
        state.tree = tree;
        state.remote = await api.listPhotos(id);
        state.mode = isMyTree(id) ? 'owner' : 'visit';
        applyTheme(tree.theme);
        loading();
        document.body.classList.remove('booting');
        const owners = state.remote.filter((r) => r.isOwner).map(remoteToPhoto);
        const friends = state.remote.filter((r) => !r.isOwner).map(remoteToPhoto);
        if (state.mode === 'visit') {
          // 朋友打开：树画出来、照片挂上去，很快就能看到按钮
          start({ featured: [], prehung: [...owners, ...friends], seed: tree.id });
        } else {
          // 主人回来：朋友们挂的照片逐张放大
          start(friends.length
            ? { featured: friends, prehung: owners, seed: tree.id }
            : { featured: owners, prehung: [], seed: tree.id });
        }
        return;
      }
      toast('没有找到这棵树，可能链接不完整');
    } catch (e) {
      console.warn(e);
      toast('圣诞树加载失败，请检查网络后刷新');
    }
    loading();
    ui.landing.classList.remove('is-off');
  }
  setLanding();
  if (params.has('demo')) {
    ui.nick.value = ui.nick.value || '小雪';
    setTimeout(() => ui.go.click(), 400);
  }
}
boot();

window.__xmas = { state, view, startFinale, textMorph, burst };
