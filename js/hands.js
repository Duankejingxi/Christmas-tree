// 摄像头 + MediaPipe 手部关键点识别：检测「拇指与食指捏合」
// 所有依赖都放在仓库内（lib/、assets/），国内网络也能正常加载。

const WASM_JS = new URL('../lib/mediapipe/wasm/vision_wasm_internal.js', import.meta.url).href;
const WASM_BIN = new URL('../lib/mediapipe/wasm/vision_wasm_internal.wasm', import.meta.url).href;
const MODEL = new URL('../assets/models/hand_landmarker.task', import.meta.url).href;

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

const PINCH_ON = 0.3;   // 捏合阈值（拇指-食指距离 / 手掌大小）
const PINCH_OFF = 0.45; // 松开阈值（迟滞，防止抖动重复触发）

export class HandTracker {
  constructor(video, canvas, statusEl) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.statusEl = statusEl;
    this.running = false;
    this.pinched = false;
    this.lastVideoTime = -1;
    this.onPinch = null;
    this.onPinchChange = null;
  }

  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('当前浏览器不支持摄像头（需要 HTTPS）');
    }
    const modelPromise = this._loadModel();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    try {
      this.landmarker = await modelPromise;
    } catch (e) {
      this.stop();
      throw e;
    }
    const vw = this.video.videoWidth || 640;
    const vh = this.video.videoHeight || 480;
    this.canvas.width = 320;
    this.canvas.height = Math.round(320 * vh / vw);
    this.running = true;
  }

  async _loadModel() {
    const { HandLandmarker } = await import('../lib/mediapipe/vision_bundle.mjs');
    const fileset = { wasmLoaderPath: WASM_JS, wasmBinaryPath: WASM_BIN };
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      return await HandLandmarker.createFromOptions(fileset, opts('GPU'));
    } catch (e) {
      return await HandLandmarker.createFromOptions(fileset, opts('CPU'));
    }
  }

  update() {
    if (!this.running || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    let res;
    try {
      res = this.landmarker.detectForVideo(this.video, performance.now());
    } catch (e) {
      return;
    }
    const lm = res && res.landmarks && res.landmarks[0];
    let ratio = 1;
    if (lm) {
      const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      ratio = d(lm[4], lm[8]) / Math.max(1e-3, d(lm[0], lm[9]));
      if (!this.pinched && ratio < PINCH_ON) {
        this.pinched = true;
        this.onPinchChange && this.onPinchChange(true);
        this.onPinch && this.onPinch();
      } else if (this.pinched && ratio > PINCH_OFF) {
        this.pinched = false;
        this.onPinchChange && this.onPinchChange(false);
      }
    } else if (this.pinched) {
      this.pinched = false;
      this.onPinchChange && this.onPinchChange(false);
    }
    this._draw(lm);
    if (this.statusEl) {
      this.statusEl.textContent = !lm ? '把手放到镜头前' : this.pinched ? '捏住了 ✨' : '捏合拇指和食指 👌';
    }
  }

  _draw(lm) {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(this.video, 0, 0, w, h);
    ctx.restore();
    ctx.fillStyle = 'rgba(2,4,10,0.25)';
    ctx.fillRect(0, 0, w, h);
    if (!lm) return;
    const P = (p) => [(1 - p.x) * w, p.y * h];
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(190,234,255,0.7)';
    ctx.beginPath();
    for (const [a, b] of CONNECTIONS) {
      const [x1, y1] = P(lm[a]);
      const [x2, y2] = P(lm[b]);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
    for (let i = 0; i < lm.length; i++) {
      const [x, y] = P(lm[i]);
      const tip = i === 4 || i === 8;
      ctx.fillStyle = tip ? '#ffd77a' : '#e8f8ff';
      ctx.beginPath();
      ctx.arc(x, y, tip ? 4 : 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.pinched) {
      const [x1, y1] = P(lm[4]);
      const [x2, y2] = P(lm[8]);
      ctx.strokeStyle = '#ffd77a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc((x1 + x2) / 2, (y1 + y2) / 2, 12, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.landmarker) {
      try { this.landmarker.close(); } catch (e) { /* ignore */ }
      this.landmarker = null;
    }
  }
}
