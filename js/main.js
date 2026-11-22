import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { HandTracker } from './hands.js';
import { Fireworks, sampleText } from './fx.js';
import { Sound } from './audio.js';
import { api, cloudEnabled, MAX_FRIENDS, TreeFullError, rememberMyTree, isMyTree, compressImage } from './api.js';

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
  const warm = ['#ffcf70', '#ffb36b', '#ff7a6b', '#ffe1a8', '#ff9fb2', '#a8e4ff'].map((c) => new THREE.Color(c));

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
    if (Math.random() < 0.15) col.copy(gold);
    col.multiplyScalar(rand(0.7, 1));
    put(cone(u, rand(0.86, 1.04)), [1, u, 0, 0], [rand(0.6, 1.35), Math.random() * TAU, rand(0.5, 2.2), 0], [col.r, col.g, col.b]);
  }
  for (let n = 0; n < COUNT.glow; n++) {
    const u = 1 - Math.cbrt(Math.random());
    const ang = Math.random() * TAU;
    const r = TREE_R * (1 - u) * Math.sqrt(Math.random()) * 0.75;
    const k = rand(0.5, 1);
    put([Math.cos(ang) * r, TREE_BASE + u * TREE_H, Math.sin(ang) * r], [2, u, 0, 0],
      [rand(9, 18), Math.random() * TAU, 0.5, 0], [0.1 * k, 0.22 * k, 0.42 * k]);
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
      uniform float uClock, uReveal, uIntro, uScatter, uFade, uSize, uScale, uPR, uCenterZ, uGS;
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
          col = mix(vec3(0.55, 0.8, 1.0), vec3(1.0, 0.97, 0.92), smoothstep(0.0, 0.95, u)) * aColor + head * vec3(0.6, 0.5, 0.3);
          tw = 0.78 + 0.22 * sin(uClock * aB.z + aB.y);
        } else {
          p = position;
          u = aA.y;
          float k = type > 3.5 ? uIntro : clamp((uReveal - u) * 5.0, 0.0, 1.0);
          float ke = k * k * (3.0 - 2.0 * k);
          vec3 outw = normalize(vec3(p.x, 0.0, p.z) + vec3(1e-4, 0.0, 1e-4));
          if (type < 3.5) p += (outw * 1.0 + vec3(0.0, 0.9, 0.0)) * (1.0 - ke);
          alpha = ke;
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
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        // 前亮后暗，增强立体感
        float depth = mv.z - uCenterZ;
        float df = smoothstep(-RAD * uGS, RAD * uGS, depth);
        alpha *= mix(0.3, 1.0, mix(df, 1.0, uScatter));
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
 * 烟花 & 声音
 * ===================================================================== */
const fw = new Fireworks(FW_MAX, U);
scene.add(fw.points);
const sound = new Sound();
fw.onExplode = () => sound.boom(0.7);

const C = (list) => list.map((c) => new THREE.Color(c));
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
const FINALE_SCALE = 0.66, FINALE_Y = -1.15;
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
  U.uScale.value = dist * Math.max(0.55, treePx / 620);
  U.uPR.value = renderer.getPixelRatio();
  renderer.setSize(w, h);
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
  return n <= 3 ? 1.7 : n <= 6 ? 1.45 : 1.25;
};

function showPhoto(p) {
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

const SHOW_IN = 0.8, SHOW_HOLD = 2.0, SHOW_OUT = 1.0;
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
    const world = treeGroup.localToWorld(tmpV.copy(p.local));
    let rotZ = 0;
    if (p.state === 'show') {
      p.t += dt;
      const t = p.t;
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
['landing', 'eyebrow', 'lead', 'form', 'nickField', 'nick', 'slots', 'addSlot', 'file', 'note', 'go', 'goText', 'alt',
  'caption', 'ask', 'camYes', 'camNo', 'hint', 'cam', 'camCanvas', 'video', 'dock', 'inviteLabel', 'newLabel',
  'sheet', 'sheetTitle', 'sheetSub', 'qr', 'shareLink', 'copyBtn', 'nativeShare', 'openMine', 'demoNote',
  'album', 'albumTitle', 'albumGrid', 'zipBtn', 'lightbox', 'lbPrev', 'lbNext', 'lbImg', 'lbWho', 'lbWhen', 'lbDownload',
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

function countdownText() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let xmas = new Date(now.getFullYear(), 11, 25);
  if (today > xmas) xmas = new Date(now.getFullYear() + 1, 11, 25);
  const days = Math.round((xmas - today) / 86400000);
  return days <= 0 ? '今天就是圣诞节' : `距离圣诞还有 ${days} 天`;
}

/* ---------- 首页 ---------- */
const rot = () => `${(Math.random() * 10 - 5).toFixed(1)}deg`;

function renderSlots() {
  ui.slots.querySelectorAll('.slot:not(.add)').forEach((n) => n.remove());
  const single = state.mode === 'visit';
  ui.slots.classList.toggle('single', single);
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
  const max = single ? 1 : MAX_LOCAL;
  ui.addSlot.classList.toggle('full', state.pending.length >= max);
  ui.file.multiple = !single;
  if (state.mode === 'local') {
    ui.note.innerHTML = state.pending.length
      ? `已放入 <b>${state.pending.length}</b> 张 · 最多 ${MAX_LOCAL} 张`
      : '放几张照片进去 · 可选';
  }
}

ui.file.addEventListener('change', () => {
  const files = [...ui.file.files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(f.name));
  const single = state.mode === 'visit';
  if (single) {
    state.pending.forEach((p) => URL.revokeObjectURL(p.url));
    state.pending = [];
  }
  const max = single ? 1 : MAX_LOCAL;
  const room = max - state.pending.length;
  if (files.length > room && !single) toast(`最多 ${max} 张，已保留前 ${room} 张`);
  files.slice(0, room).forEach((file) => state.pending.push({ file, url: URL.createObjectURL(file) }));
  ui.file.value = '';
  renderSlots();
});

function setLanding() {
  ui.eyebrow.textContent = countdownText();
  const n = state.remote.length;
  const left = MAX_FRIENDS - n;
  ui.nickField.hidden = false;
  ui.slots.hidden = false;
  ui.nick.placeholder = '你的名字';
  if (state.mode === 'local') {
    ui.lead.textContent = '点亮一棵属于你的圣诞树';
    ui.goText.textContent = '点亮';
    ui.alt.textContent = '邀请朋友一起装饰 →';
  } else if (state.mode === 'visit') {
    ui.lead.innerHTML = `<b>${esc(state.tree.ownerName)}</b> 的圣诞树`;
    if (left > 0) {
      ui.nick.placeholder = '你的名字 · 会写在照片上';
      ui.note.innerHTML = n ? `已有 <b>${n}</b> 位朋友挂上了照片 · 还能挂 ${left} 张` : '挂上一张照片，做第一个来装饰的朋友';
      ui.goText.textContent = '挂上去';
      ui.alt.textContent = n ? '先看看这棵树 →' : '';
    } else {
      ui.nickField.hidden = true;
      ui.slots.hidden = true;
      ui.note.innerHTML = `这棵树已经挂满 ${MAX_FRIENDS} 张照片啦`;
      ui.goText.textContent = '去看看';
      ui.alt.textContent = '我也要一棵 →';
    }
  } else {
    ui.lead.textContent = '你的共享圣诞树';
    ui.nickField.hidden = true;
    ui.slots.hidden = true;
    ui.note.innerHTML = n ? `已有 <b>${n}</b> 位朋友来装饰 · 还能挂 ${left} 张` : '还没有朋友来装饰，把链接发给他们吧';
    ui.goText.textContent = '打开';
    ui.alt.textContent = '邀请朋友 →';
  }
  renderSlots();
  try { if (!ui.nick.value) ui.nick.value = localStorage.getItem('xmas.nick') || ''; } catch (e) { /* ignore */ }
  document.body.classList.remove('booting');
}

function requireNick() {
  const v = ui.nick.value.trim();
  if (!v) {
    ui.nickField.classList.remove('shake');
    void ui.nickField.offsetWidth;
    ui.nickField.classList.add('shake');
    ui.nick.focus();
    toast('先写下你的名字吧');
    return null;
  }
  try { localStorage.setItem('xmas.nick', v); } catch (e) { /* ignore */ }
  return v;
}

ui.go.addEventListener('click', () => {
  if (state.mode === 'local') {
    const nick = requireNick();
    if (!nick) return;
    state.nickname = nick;
    const photos = state.pending.map((p) => ({ nickname: nick, src: p.url, blob: p.file, createdAt: new Date().toISOString() }));
    start({ featured: photos, prehung: [], seed: 'local-' + Math.random() });
  } else if (state.mode === 'visit' && state.remote.length < MAX_FRIENDS) {
    const nick = requireNick();
    if (!nick) return;
    if (!state.pending.length) {
      toast('选一张照片挂到树上吧');
      return;
    }
    state.nickname = nick;
    const f = state.pending[0];
    const mine = { nickname: nick, src: f.url, blob: f.file, createdAt: new Date().toISOString(), mine: true };
    state.uploading = uploadMine(mine, f.file);
    start({ featured: [mine], prehung: state.remote.map(remoteToPhoto), seed: state.tree.id });
  } else {
    viewShared();
  }
});
ui.nick.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.go.click(); });

ui.alt.addEventListener('click', () => {
  if (state.mode === 'local') {
    const nick = requireNick();
    if (nick) createShare(nick);
  } else if (state.mode === 'visit' && state.remote.length < MAX_FRIENDS) {
    viewShared();
  } else if (state.mode === 'visit') {
    location.href = BASE_URL;
  } else {
    openSheet(shareLinkFor(state.tree.id), true);
  }
});

const remoteToPhoto = (r) => ({ nickname: r.nickname, src: r.url, createdAt: r.createdAt, id: r.id });
function viewShared() {
  start({ featured: state.remote.map(remoteToPhoto), prehung: [], seed: state.tree.id });
}

/* ---------- 上传 ---------- */
async function uploadMine(photo, file) {
  try {
    const blob = await compressImage(file);
    const row = await api.addPhoto(state.tree.id, photo.nickname, blob);
    photo.id = row.id;
    photo.remoteUrl = row.url;
    state.remote.push(row);
    return { ok: true };
  } catch (e) {
    console.warn(e);
    return { ok: false, full: e instanceof TreeFullError, error: e };
  }
}

/* ---------- 分享 ---------- */
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

async function createShare(name) {
  loading('正在创建你的共享树');
  try {
    const tree = await api.createTree(name);
    rememberMyTree(tree);
    loading();
    openSheet(shareLinkFor(tree.id), true, tree.id);
  } catch (e) {
    loading();
    toast('创建失败：' + (e.message || '请检查网络'));
  }
}

async function openSheet(link, mine, openId) {
  ui.shareLink.value = link;
  ui.sheetTitle.textContent = mine ? '邀请朋友来装饰你的树' : '把这棵树分享给朋友';
  ui.sheetSub.textContent = mine
    ? `每位朋友可以挂上一张照片 · 最多 ${MAX_FRIENDS} 位`
    : `还能挂 ${Math.max(0, MAX_FRIENDS - state.remote.length)} 张照片`;
  ui.demoNote.hidden = cloudEnabled;
  ui.nativeShare.hidden = !navigator.share;
  ui.openMine.hidden = !openId;
  ui.openMine.onclick = () => { location.href = shareLinkFor(openId); };
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
  const v = ui.shareLink.value;
  try {
    await navigator.clipboard.writeText(v);
  } catch (e) {
    ui.shareLink.select();
    document.execCommand('copy');
  }
  ui.copyBtn.textContent = '已复制';
  setTimeout(() => { ui.copyBtn.textContent = '复制'; }, 1600);
});
ui.nativeShare.addEventListener('click', () => {
  navigator.share({ title: 'Merry Christmas', text: '来帮我装饰圣诞树吧', url: ui.shareLink.value }).catch(() => {});
});

document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => on(b.closest('.overlay'), false)));
document.querySelectorAll('.overlay').forEach((o) => o.addEventListener('click', (e) => { if (e.target === o) on(o, false); }));
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.overlay.is-on').forEach((o) => on(o, false));
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
  const owner = state.tree ? `${state.tree.ownerName} 的圣诞树` : `${state.nickname} 的圣诞树`;
  ui.albumTitle.textContent = `${owner} · ${list.length} 张照片`;
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

/* ---------- 结束 dock ---------- */
ui.dock.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'replay') replay();
  else if (act === 'album') openAlbum();
  else if (act === 'invite') {
    if (state.mode === 'local') createShare(state.nickname);
    else openSheet(shareLinkFor(state.tree.id), state.mode === 'owner');
  } else if (act === 'new') {
    location.href = BASE_URL;
  }
});
function setupDock() {
  ui.inviteLabel.textContent = state.mode === 'visit' ? '分享' : '邀请朋友';
  ui.newLabel.textContent = state.mode === 'visit' ? '我也要一棵' : state.mode === 'owner' ? '新的树' : '重新制作';
}

/* ---------- 声音按钮 ---------- */
ui.soundBtn.addEventListener('click', () => {
  sound.unlock();
  const en = sound.toggle();
  if (en) sound.startMusic();
  ui.soundBtn.classList.toggle('muted', !en);
});

/* =====================================================================
 * 手势
 * ===================================================================== */
let hands = null;
let mode = 'none'; // 'cam' | 'auto'
let camQueue = null;
function onTriggerNext() {
  if (mode !== 'cam' || !camQueue || camQueue.busy) return false;
  const q = camQueue;
  if (q.next >= q.list.length) return false;
  const p = q.list[q.next++];
  q.busy = true;
  on(ui.hint, false);
  showPhoto(p).then(() => {
    q.busy = false;
    if (q.next >= q.list.length) q.resolveAll();
    else updateHint();
  });
  return true;
}
function updateHint() {
  if (mode !== 'cam' || !camQueue) return;
  const n = camQueue.list.length;
  ui.hint.innerHTML = n > 1 ? `捏合手指 · <b>${camQueue.next + 1} / ${n}</b>` : '捏合手指，把照片挂上去';
  on(ui.hint);
}
async function startHands() {
  loading('正在打开摄像头');
  try {
    hands = new HandTracker(ui.video, ui.camCanvas, null);
    hands.onPinch = onTriggerNext;
    hands.onPinchChange = (v) => ui.cam.classList.toggle('pinch', v);
    await hands.start();
    loading();
    on(ui.cam);
    return true;
  } catch (e) {
    console.warn(e);
    loading();
    if (hands) hands.stop();
    hands = null;
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    toast(denied ? '没有摄像头权限，改为自动播放' : '摄像头没能打开，改为自动播放');
    return false;
  }
}
function stopHands() {
  if (hands) hands.stop();
  hands = null;
  on(ui.cam, false);
  ui.cam.classList.remove('pinch');
}
function askCamera(single) {
  ui.ask.querySelector('p').firstChild.textContent = single ? '用手势把照片挂上去？' : '用手势翻看照片？';
  return new Promise((resolve) => {
    on(ui.ask);
    const done = (v) => { on(ui.ask, false); resolve(v); };
    ui.camYes.onclick = () => done(true);
    ui.camNo.onclick = () => done(false);
  });
}

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
  // 按上传时间顺序放置，保证每个人看到的位置一致
  const ordered = [...state.photos].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  placePhotos(ordered, args.seed);
  setupDock();
  resetShow();
  runShow(args);
}

function replay() {
  resetShow();
  runShow(showArgs);
}

function captionText() {
  if (state.tree) return `${state.tree.ownerName} 的圣诞树`;
  return state.nickname ? `致 ${state.nickname}` : '';
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
  await sleep(1.0);
  if (!alive()) return;

  // 3. 已有的朋友照片直接挂上
  if (prehung.length) {
    prehung.forEach((p, i) => hangPhoto(p, i * 0.16));
    await sleep(prehung.length * 0.16 + 1.0);
    if (!alive()) return;
  }

  // 4. 主角照片逐张展示（手势 / 自动）
  if (featured.length) {
    on(ui.caption, false);
    let useCam = await askCamera(featured.length === 1);
    if (!alive()) return;
    if (useCam) useCam = await startHands();
    if (!alive()) { stopHands(); return; }
    mode = useCam ? 'cam' : 'auto';
    on(ui.caption, false);
    if (mode === 'cam') {
      await new Promise((resolveAll) => {
        camQueue = { list: featured, next: 0, busy: false, resolveAll };
        updateHint();
      });
      camQueue = null;
      on(ui.hint, false);
      await sleep(0.4);
      stopHands();
    } else {
      await sleep(0.3);
      for (let i = 0; i < featured.length; i++) {
        if (!alive()) return;
        if (featured.length > 1) {
          ui.hint.innerHTML = `<b>${i + 1} / ${featured.length}</b>`;
          on(ui.hint);
        }
        await showPhoto(featured[i]);
        await sleep(0.3);
      }
      on(ui.hint, false);
    }
    mode = 'none';
    if (!alive()) return;
    await sleep(0.3);
    featured.forEach((p, i) => hangPhoto(p, i * 0.18));
    await sleep(featured.length * 0.18 + 1.4);
    on(ui.caption, !!ui.caption.textContent);
    if (!alive()) return;
  } else {
    await sleep(0.6);
  }

  // 5. 上传结果（访客）
  if (state.uploading) {
    const r = await state.uploading;
    state.uploading = null;
    if (!alive()) return;
    if (r.ok) toast(`你的照片已经挂在 ${state.tree.ownerName} 的树上了`, 3600);
    else if (r.full) toast('这棵树刚刚被挂满了，照片没能保存', 4000);
    else toast('照片没能上传成功：' + (r.error && r.error.message ? r.error.message : '请检查网络'), 4500);
  }

  startFinale();
}

async function startFinale() {
  const gen = generation;
  const s0 = treeGroup.scale.x, y0 = treeGroup.position.y;
  tween(1.6, (e) => {
    treeGroup.scale.setScalar(s0 + (FINALE_SCALE - s0) * e);
    treeGroup.position.y = y0 + (FINALE_Y - y0) * e;
  });

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
  await sleep(3.4);
  if (gen !== generation) return;
  finale = { nextLaunch: clock + 0.3 };
  on(ui.dock);
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
  stopHands();
  mode = 'none';
  camQueue = null;
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
  [ui.caption, ui.dock, ui.hint, ui.ask].forEach((el) => on(el, false));
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
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, sx: e.clientX, sy: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  sparkleAt(e.clientX, e.clientY);
  if (!drag) {
    if (!IS_MOBILE) {
      const p = pickPhoto(e.clientX, e.clientY);
      state.photos.forEach((q) => { q.hover = q === p; });
      canvas.classList.toggle('pointer', !!p);
    }
    return;
  }
  const dx = e.clientX - drag.x;
  drag.x = e.clientX;
  if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 8) drag.moved = true;
  const d = (dx / innerWidth) * Math.PI * 1.6;
  treeGroup.rotation.y += d;
  yawVel = d * 30;
});
canvas.addEventListener('pointerup', (e) => {
  if (drag && !drag.moved) {
    if (!onTriggerNext()) {
      const p = pickPhoto(e.clientX, e.clientY);
      if (p) openLightbox(state.photos.indexOf(p));
    }
  }
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
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = Math.max(0, (now - last) / 1000);
  const dt = Math.min(0.05, rawDt) * TIME_SCALE;
  last = now;
  clock += dt;
  adaptQuality(Math.min(rawDt, 0.25));
  runTimers(dt);
  U.uClock.value = clock;

  treeGroup.rotation.y += (0.16 + yawVel) * dt;
  yawVel *= Math.exp(-dt * 2.5);
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

  if (hands) hands.update();
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
}
requestAnimationFrame(frame);

/* =====================================================================
 * 启动
 * ===================================================================== */
async function boot() {
  const id = params.get('t');
  if (id) {
    loading('正在打开圣诞树');
    try {
      const tree = await api.getTree(id);
      if (!tree) {
        toast('没有找到这棵树，可能链接不完整');
      } else {
        state.tree = tree;
        state.remote = await api.listPhotos(id);
        state.mode = isMyTree(id) ? 'owner' : 'visit';
      }
    } catch (e) {
      console.warn(e);
      toast('圣诞树加载失败，请检查网络后刷新');
    }
    loading();
  }
  setLanding();
  if (params.has('demo') && state.mode === 'local') {
    ui.nick.value = ui.nick.value || '小雪';
    setTimeout(() => ui.go.click(), 400);
  }
}
boot();

window.__xmas = { state, view, startFinale };
