/**
 * PetDesk 视频引擎
 * Step 2: 多动作视频切换 + 预加载队列 + Crossfade
 */

// ===== 类型 =====

export interface VideoAction {
  src: string;
  loop: boolean;
  duration?: number;
}

export interface ActionMap {
  [actionName: string]: VideoAction;
}

// ===== VideoController =====

export class VideoController {
  private video: HTMLVideoElement;
  private actions: ActionMap = {};
  private currentAction: string | null = null;
  private isTransitioning = false;
  private switchQueue: string[] = [];
  private onChange: ((action: string) => void) | null = null;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.video.addEventListener("ended", () => this.handleEnded());
    this.video.style.opacity = "1";
    this.video.style.transition = "none";
  }

  registerActions(actions: ActionMap) {
    Object.assign(this.actions, actions);
  }

  /** 预加载所有注册的动作 */
  async preloadAll(): Promise<void> {
    console.log("[VideoEngine] 开始预加载...");
    // idle 优先（用临时元素，不干扰主 video）
    if (this.actions["idle"]) {
      await this.preloadOne("idle");
    }
    // 其余后台串行加载（避免并行切换 src 互相踩踏）
    const rest = Object.keys(this.actions).filter((k) => k !== "idle");
    for (const k of rest) {
      await this.preloadOne(k);
    }
    console.log("[VideoEngine] 预加载全部完成");
  }

  private async preloadOne(name: string): Promise<void> {
    const action = this.actions[name];
    if (!action) return;
    // 用临时 video 元素预加载，不干扰主视频
    const tmp = document.createElement("video");
    tmp.muted = true;
    tmp.preload = "auto";
    tmp.src = action.src;
    tmp.load();
    await new Promise<void>((r) => {
      tmp.addEventListener("loadeddata", () => r(), { once: true });
      tmp.addEventListener("error", () => r(), { once: true }); // 失败也继续
    });
    tmp.remove();
  }

  /** 播放指定动作 */
  async play(actionName: string): Promise<void> {
    if (!this.actions[actionName]) {
      console.warn(`[VideoEngine] 未知动作: ${actionName}`);
      return;
    }

    // 相同动作不重播 (loop 动作)
    const action = this.actions[actionName];
    if (this.currentAction === actionName && action.loop) return;

    // 如果正在过渡中，入队等待
    if (this.isTransitioning) {
      // 只保留最新一个待切换动作
      this.switchQueue = [actionName];
      return;
    }

    await this.executeSwitch(actionName);
  }

  /** 立即切换（打断当前过渡） */
  async playImmediate(actionName: string): Promise<void> {
    if (!this.actions[actionName]) return;
    this.switchQueue = [];
    await this.executeSwitch(actionName);
  }

  setOnChange(callback: (action: string) => void) {
    this.onChange = callback;
  }

  getCurrentAction(): string | null {
    return this.currentAction;
  }

  getStatus(): { action: string | null; transition: boolean; queue: string[] } {
    return {
      action: this.currentAction,
      transition: this.isTransitioning,
      queue: [...this.switchQueue],
    };
  }

  // ---- 内部 ----

  private async executeSwitch(actionName: string): Promise<void> {
    this.isTransitioning = true;
    const action = this.actions[actionName];

    // 淡出
    await this.animateOpacity(1, 0, 120);

    // 切换源
    this.video.loop = action.loop;
    this.video.src = action.src;
    this.currentAction = actionName;
    this.onChange?.(actionName);

    // 播放
    try {
      await this.video.play();
    } catch {
      // 静默
    }

    // 淡入
    await this.animateOpacity(0, 1, 120);

    this.isTransitioning = false;

    // 处理队列
    if (this.switchQueue.length > 0) {
      const next = this.switchQueue.shift()!;
      this.switchQueue = [];
      this.executeSwitch(next);
    }
  }

  private handleEnded() {
    const action = this.currentAction ? this.actions[this.currentAction] : null;
    if (action && !action.loop && this.currentAction !== "idle") {
      this.play("idle");
    }
  }

  private animateOpacity(from: number, to: number, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min((now - start) / ms, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        this.video.style.opacity = String(from + (to - from) * eased);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }
}

// ===== OverlayCanvas =====

export class OverlayCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bubble: { text: string; until: number } | null = null;
  private badge: string | null = null;
  private progress: number | null = null;
  private particles: Particle[] = [];
  private rid = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.loop();
  }

  resize() {
    this.canvas.width = this.canvas.clientWidth;
    this.canvas.height = this.canvas.clientHeight;
  }

  showBubble(text: string, duration = 3000) {
    this.bubble = { text, until: performance.now() + duration };
  }

  showBadge(text: string) {
    this.badge = text;
    // 3 秒后自动消失
    setTimeout(() => {
      if (this.badge === text) this.badge = null;
    }, 3000);
  }

  setProgress(pct: number) {
    this.progress = Math.max(0, Math.min(100, pct));
  }
  hideProgress() {
    this.progress = null;
  }

  startParticles(type: ParticleType) {
    this.stopParticles();
    const n = type === "confetti" ? 50 : 30;
    for (let i = 0; i < n; i++) this.particles.push(makeParticle(type, this.canvas.width));
  }
  stopParticles() {
    this.particles = [];
  }

  // ----

  private frameCount = 0;

  private loop() {
    this.frameCount++;

    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    // 粒子每 2 帧更新一次 (~30fps)
    if (this.frameCount % 2 === 0) {
      this.renderParticles(w, h);
    } else if (this.particles.length === 0) {
      // 没有粒子时进一步降频：每 4 帧 (~15fps) 只检查 bubble/badge
      if (this.frameCount % 4 !== 0) {
        // 仍然需要绘制已有内容（防止闪烁）
        this.renderStaticContent(w, h);
        this.rid = requestAnimationFrame(() => this.loop());
        return;
      }
    }

    if (this.progress !== null) this.renderBar(w, h);
    if (this.bubble) {
      if (performance.now() > this.bubble.until) this.bubble = null;
      else this.renderBubble(w, h);
    }
    if (this.badge) this.renderBadge(w);

    this.rid = requestAnimationFrame(() => this.loop());
  }

  /** 无粒子时的静态内容重绘（防止清屏闪烁） */
  private renderStaticContent(w: number, h: number) {
    if (this.progress !== null) this.renderBar(w, h);
    if (this.bubble && performance.now() <= this.bubble.until) this.renderBubble(w, h);
    if (this.badge) this.renderBadge(w);
  }

  private renderBubble(w: number, h: number) {
    const ctx = this.ctx;
    const text = this.bubble!.text;
    const fs = 14;
    ctx.font = `${fs}px "PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(text).width;
    const bw = tw + 24;
    const bh = fs + 16;
    const bx = w / 2 - bw / 2;
    const by = 10;

    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.beginPath();
    roundRect(ctx, bx, by, bw, bh, 10);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.lineWidth = 1;
    ctx.stroke();
    // tail
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.beginPath();
    ctx.moveTo(w / 2 - 6, by + bh);
    ctx.lineTo(w / 2, by + bh + 8);
    ctx.lineTo(w / 2 + 6, by + bh);
    ctx.fill();
    ctx.fillStyle = "#333";
    ctx.fillText(text, w / 2, by + bh / 2);
  }

  private renderBar(w: number, h: number) {
    const ctx = this.ctx;
    const bw = 100;
    const bh = 6;
    const bx = w / 2 - bw / 2;
    const by = h - 30;
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.beginPath();
    roundRect(ctx, bx, by, bw, bh, 3);
    ctx.fill();
    const fw = (bw * (this.progress ?? 0)) / 100;
    ctx.fillStyle = (this.progress ?? 0) >= 100 ? "#4CAF50" : "#FF9800";
    ctx.beginPath();
    roundRect(ctx, bx, by, fw, bh, 3);
    ctx.fill();
  }

  private renderBadge(w: number) {
    const ctx = this.ctx;
    const text = this.badge!;
    ctx.font = '11px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    roundRect(ctx, w - tw - 18, 4, tw + 14, 22, 6);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(text, w - 10, 9);
  }

  private renderParticles(w: number, h: number) {
    const ctx = this.ctx;
    for (const p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.g;
      if (p.y > h + 20 || p.x < -20 || p.x > w + 20) {
        p.y = -20;
        p.x = Math.random() * w;
        p.vy = p.ivy;
      }
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  destroy() {
    cancelAnimationFrame(this.rid);
  }
}

// ===== Particle =====

type ParticleType = "rain" | "snow" | "confetti" | "dust";

interface Particle {
  x: number; y: number; vx: number; vy: number; ivy: number; g: number;
  r: number; color: string;
}

function makeParticle(type: ParticleType, cw: number): Particle {
  const p: Particle = {
    x: Math.random() * cw, y: -20 - Math.random() * 100,
    vx: 0, vy: 0, ivy: 0, g: 0, r: 0, color: "",
  };
  switch (type) {
    case "rain":
      p.vy = 6 + Math.random() * 4; p.ivy = p.vy; p.vx = -1; p.g = 0;
      p.r = 1.5; p.color = "rgba(120,180,255,0.55)"; break;
    case "snow":
      p.vy = 1 + Math.random() * 2; p.ivy = p.vy; p.vx = Math.random() - 0.5; p.g = 0;
      p.r = 3 + Math.random() * 4; p.color = "rgba(255,255,255,0.8)"; break;
    case "confetti":
      p.vy = 1 + Math.random() * 3; p.ivy = p.vy; p.vx = Math.random() * 2 - 1; p.g = 0.1;
      p.r = 3 + Math.random() * 3; p.color = `hsl(${Math.random() * 360},80%,60%)`; break;
    case "dust":
      // 跑动扬尘：小颗粒从底部弹出，向两侧飘散
      p.x = cw / 2 + (Math.random() - 0.5) * 60;
      p.y = cw * 0.7 + Math.random() * 20;
      p.vy = -(2 + Math.random() * 3); p.ivy = p.vy;
      p.vx = (Math.random() - 0.5) * 3;
      p.g = 0.08;
      p.r = 2 + Math.random() * 3;
      p.color = `rgba(160,140,120,${0.4 + Math.random() * 0.4})`; break;
  }
  return p;
}

// ===== Chroma-Key =====

export function chromaKeyFrame(
  video: HTMLVideoElement,
  target: [number, number, number] = [0, 255, 0],
  threshold = 80
): ImageData | null {
  const c = document.createElement("canvas");
  c.width = video.videoWidth || 320;
  c.height = video.videoHeight || 320;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const [tr, tg, tb] = target;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.sqrt((d[i] - tr) ** 2 + (d[i + 1] - tg) ** 2 + (d[i + 2] - tb) ** 2);
    if (dist < threshold) d[i + 3] = 0;
  }
  return img;
}

// ===== ChromaKeyRenderer（实时抠色）=====

export class ChromaKeyRenderer {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private targetColor: [number, number, number] = [0, 0, 0]; // 默认黑底（抠像导出常见）
  private threshold = 80;
  private running = false;
  private rid = 0;
  private tempCanvas: HTMLCanvasElement;
  private tempCtx: CanvasRenderingContext2D;
  private frameCount = 0;
  private lastFrameTime = 0;

  // 降分辨率处理：在 1/2 分辨率下做像素处理，减少 75% 计算量
  private static readonly SCALE_DOWN = 2; // 处理分辨率 = 原始 / 2

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    this.tempCanvas = document.createElement("canvas");
    this.tempCtx = this.tempCanvas.getContext("2d")!;
  }

  setColor(r: number, g: number, b: number) { this.targetColor = [r, g, b]; }
  setThreshold(t: number) { this.threshold = t; }
  getThreshold() { return this.threshold; }
  getColor() { return this.targetColor; }

  start() {
    if (this.running) return;
    this.running = true;
    this.canvas.style.display = "block";
    this.resize();
    this.frameCount = 0;
    this.lastFrameTime = performance.now();
    this.loop();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rid);
    this.canvas.style.display = "none";
  }

  isRunning() { return this.running; }

  private resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  private loop() {
    if (!this.running) return;
    this.rid = requestAnimationFrame(() => this.loop());

    // 帧跳过：每 3 帧处理一次 (~20fps 像素操作)
    this.frameCount++;
    if (this.frameCount % 3 !== 0) return;

    const vw = this.video.videoWidth || 320;
    const vh = this.video.videoHeight || 320;
    const scale = ChromaKeyRenderer.SCALE_DOWN;
    const tw = Math.floor(vw / scale);
    const th = Math.floor(vh / scale);

    if (this.tempCanvas.width !== tw || this.tempCanvas.height !== th) {
      this.tempCanvas.width = tw;
      this.tempCanvas.height = th;
    }

    // 缩小绘制到临时画布（1/2 分辨率 → 像素量减少 75%）
    this.tempCtx.drawImage(this.video, 0, 0, vw, vh, 0, 0, tw, th);
    const frame = this.tempCtx.getImageData(0, 0, tw, th);
    const d = frame.data;
    const [tr, tg, tb] = this.targetColor;

    for (let i = 0; i < d.length; i += 4) {
      const dist = Math.sqrt(
        (d[i] - tr) ** 2 + (d[i + 1] - tg) ** 2 + (d[i + 2] - tb) ** 2
      );
      if (dist < this.threshold) d[i + 3] = 0;
    }

    // 放回临时画布
    this.tempCtx.putImageData(frame, 0, 0);

    // 缩放到显示画布（浏览器自动放大到原始尺寸）
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.ctx.clearRect(0, 0, cw, ch);
    this.ctx.drawImage(this.tempCanvas, 0, 0, tw, th, 0, 0, cw, ch);
  }
}

// ===== 测试视频生成（5 种不同动画）=====

type TestAction = "idle" | "happy" | "walk" | "surprised" | "sleep";

const ACTION_PARAMS: Record<TestAction, {
  color: string;    // 身体颜色
  duration: number; // 秒
  bounceAmp: number; // 弹跳幅度
  bounceSpeed: number; // 弹跳速度
  xOscAmp: number;  // 横向摆动幅度
  xOscSpeed: number;
  eyeScale: number;  // 眼睛大小
  extra?: string;    // 额外绘制: "zzz" | "sparkle" | "exclaim"
}> = {
  idle:      { color: "#FF8C42", duration: 2, bounceAmp: 8,  bounceSpeed: 1.0, xOscAmp: 0,   xOscSpeed: 0,   eyeScale: 1.0 },
  happy:     { color: "#FF9F43", duration: 1.5, bounceAmp: 40, bounceSpeed: 3.0, xOscAmp: 10, xOscSpeed: 5,  eyeScale: 1.4, extra: "sparkle" },
  walk:      { color: "#FF8C42", duration: 2,   bounceAmp: 15, bounceSpeed: 2.0, xOscAmp: 45, xOscSpeed: 1.5, eyeScale: 1.0 },
  surprised: { color: "#FFB347", duration: 1.2, bounceAmp: 0,  bounceSpeed: 0,   xOscAmp: 0,   xOscSpeed: 0,   eyeScale: 2.2, extra: "exclaim" },
  sleep:     { color: "#E8A87C", duration: 2.5, bounceAmp: 6,  bounceSpeed: 0.4, xOscAmp: 0,   xOscSpeed: 0,   eyeScale: 0.25, extra: "zzz" },
};

function generateOneTestVideo(action: TestAction): Promise<string> {
  return new Promise((resolve) => {
    const p = ACTION_PARAMS[action];
    const size = 256;
    const fps = 30;
    const totalFrames = p.duration * fps;

    const c = document.createElement("canvas");
    c.width = size; c.height = size;
    const ctx = c.getContext("2d")!;

    const stream = c.captureStream(fps);
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp9",
      videoBitsPerSecond: 800_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.start();

    let frame = 0;
    function drawFrame() {
      if (frame >= totalFrames) {
        recorder.stop();
        return;
      }
      const t = frame / fps;
      const bounceY = Math.abs(Math.sin(t * Math.PI * p.bounceSpeed)) * p.bounceAmp;
      const xOff = Math.sin(t * Math.PI * p.xOscSpeed) * p.xOscAmp;
      const cx = size / 2 + xOff;
      const cy = size / 2 + bounceY;

      ctx.clearRect(0, 0, size, size);
      // 透明背景 (chroma-key 用)
      ctx.fillStyle = "#00FF00";
      ctx.fillRect(0, 0, size, size);

      // --- 身体 ---
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.ellipse(cx, cy + 20, 40, 50, 0, 0, Math.PI * 2);
      ctx.fill();

      // --- 头 ---
      ctx.beginPath();
      ctx.arc(cx, cy - 25, 35, 0, Math.PI * 2);
      ctx.fill();

      // --- 耳朵 ---
      ctx.beginPath(); ctx.moveTo(cx - 30, cy - 40); ctx.lineTo(cx - 15, cy - 62); ctx.lineTo(cx - 5, cy - 40); ctx.fill();
      ctx.beginPath(); ctx.moveTo(cx + 30, cy - 40); ctx.lineTo(cx + 15, cy - 62); ctx.lineTo(cx + 5, cy - 40); ctx.fill();

      // --- 眼睛 ---
      const eyeR = 5 * p.eyeScale;
      if (p.eyeScale < 0.5) {
        // 睡觉：眯眼线
        ctx.strokeStyle = "#333"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(cx - 17, cy - 28); ctx.lineTo(cx - 7, cy - 28); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx + 7, cy - 28); ctx.lineTo(cx + 17, cy - 28); ctx.stroke();
      } else if (p.eyeScale > 1.8) {
        // 惊讶：大圆眼 + 小瞳孔
        ctx.fillStyle = "#fff";
        ctx.beginPath(); ctx.arc(cx - 12, cy - 28, eyeR + 2, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx + 12, cy - 28, eyeR + 2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#333";
        ctx.beginPath(); ctx.arc(cx - 12, cy - 28, 3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx + 12, cy - 28, 3, 0, Math.PI * 2); ctx.fill();
      } else {
        // 普通圆眼
        ctx.fillStyle = "#333";
        ctx.beginPath(); ctx.arc(cx - 12, cy - 28, eyeR, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx + 12, cy - 28, eyeR, 0, Math.PI * 2); ctx.fill();
        // 高光
        ctx.fillStyle = "#fff";
        ctx.beginPath(); ctx.arc(cx - 10, cy - 30, 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx + 14, cy - 30, 1.5, 0, Math.PI * 2); ctx.fill();
      }

      // --- 嘴巴 ---
      ctx.strokeStyle = "#333"; ctx.lineWidth = 1.5;
      if (p.extra === "exclaim") {
        // 惊讶 O 嘴
        ctx.beginPath(); ctx.arc(cx, cy - 12, 8, 0, Math.PI * 2); ctx.stroke();
      } else if (p.extra === "zzz") {
        // 打呼噜微张嘴
        ctx.beginPath(); ctx.ellipse(cx, cy - 12, 5, 3, 0, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(cx, cy - 15, 10, 0.1 * Math.PI, 0.9 * Math.PI); ctx.stroke();
      }

      // --- 前爪 ---
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.ellipse(cx - 20, cy + 55, 18, 12, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx + 20, cy + 55, 18, 12, 0, 0, Math.PI * 2); ctx.fill();

      // --- 特效 ---
      if (p.extra === "sparkle" && frame % 8 < 4) {
        // 闪烁星星
        ctx.fillStyle = "#FFD700";
        const sx = cx + 40, sy = cy - 50;
        drawStar(ctx, sx, sy, 6, 8, 4);
      }
      if (p.extra === "exclaim") {
        // 感叹号
        ctx.fillStyle = "#FF4444"; ctx.font = "bold 36px sans-serif"; ctx.textAlign = "center";
        ctx.fillText("!", cx + 40, cy - 50);
      }
      if (p.extra === "zzz") {
        ctx.fillStyle = "#666"; ctx.font = "18px sans-serif"; ctx.textAlign = "left";
        const zAlpha = 0.4 + 0.3 * Math.sin(t * 3);
        ctx.globalAlpha = zAlpha;
        ctx.fillText("z", cx + 30, cy - 50);
        ctx.fillText("z", cx + 40, cy - 60);
        ctx.fillText("Z", cx + 50, cy - 72);
        ctx.globalAlpha = 1;
      }

      frame++;
      setTimeout(drawFrame, 1000 / fps);
    }
    drawFrame();

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      resolve(URL.createObjectURL(blob));
    };
  });
}

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, outerR: number, innerR: number, points: number) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = (i * Math.PI) / points - Math.PI / 2;
    const px = x + Math.cos(angle) * r;
    const py = y + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

/** 批量生成所有测试视频，返回 ActionMap */
export async function generateTestVideoSet(): Promise<ActionMap> {
  console.log("[VideoEngine] 正在生成 5 段测试视频...");
  const actions: TestAction[] = ["idle", "happy", "walk", "surprised", "sleep"];
  const map: ActionMap = {};
  let i = 0;
  for (const a of actions) {
    console.log(`[VideoEngine]   [${i + 1}/5] ${a}...`);
    const url = await generateOneTestVideo(a);
    // 清理旧 blob URL（同一个 action 名）
    map[a] = {
      src: url,
      loop: ["idle", "walk", "sleep"].includes(a),
      duration: ACTION_PARAMS[a].duration,
    };
    i++;
  }
  console.log("[VideoEngine] 测试视频全部生成完毕");
  return map;
}

// ===== 辅助 =====

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
