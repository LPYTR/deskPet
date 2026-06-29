/**
 * PetDesk 2D 像素精灵渲染引擎
 * 基于 Canvas 的精灵表动画系统，作为视频渲染的兜底方案
 */

// ===== 类型 =====

export interface SpriteAction {
  src: string;        // 精灵表图片路径
  frameW: number;     // 单帧宽度
  frameH: number;     // 单帧高度
  columns: number;    // 精灵表列数（网格布局）
  startFrame: number; // 起始帧索引（0-based，网格中从左到右从上到下）
  endFrame: number;   // 结束帧索引（不含）
  fps: number;        // 播放帧率
  loop: boolean;      // 是否循环
}

export interface SpriteActionMap {
  [actionName: string]: SpriteAction;
}

// ===== SpriteRenderer =====

export class SpriteRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private actions: SpriteActionMap = {};
  private currentAction: string | null = null;
  private currentFrame = 0;
  private totalFrames = 0;
  private frameTimer = 0;
  private lastTime = 0;
  private spriteImg: HTMLImageElement | null = null;
  private running = false;
  private rid = 0;
  private onChange: ((action: string) => void) | null = null;

  // 缓存已加载的图片
  private imageCache: Map<string, HTMLImageElement> = new Map();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false; // 像素风：关闭平滑
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  private resize() {
    this.canvas.width = this.canvas.clientWidth;
    this.canvas.height = this.canvas.clientHeight;
  }

  registerActions(actions: SpriteActionMap) {
    Object.assign(this.actions, actions);
  }

  /** 预加载所有精灵图 */
  async preloadAll(): Promise<void> {
    console.log("[SpriteEngine] 开始预加载精灵图...");
    const loads: Promise<void>[] = [];
    for (const [name, action] of Object.entries(this.actions)) {
      if (!this.imageCache.has(action.src)) {
        loads.push(this.loadImage(action.src));
      }
    }
    await Promise.all(loads);
    console.log("[SpriteEngine] 精灵图预加载完成");
  }

  private loadImage(src: string): Promise<void> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.imageCache.set(src, img);
        console.log(`[SpriteEngine] 加载: ${src} (${img.width}x${img.height})`);
        resolve();
      };
      img.onerror = () => {
        console.warn(`[SpriteEngine] 加载失败: ${src}`);
        resolve(); // 失败不阻塞
      };
      img.src = src;
    });
  }

  /** 播放指定动作 */
  play(actionName: string): void {
    const action = this.actions[actionName];
    if (!action) {
      console.warn(`[SpriteEngine] 未知动作: ${actionName}`);
      return;
    }

    // 相同循环动作不重播
    if (this.currentAction === actionName && action.loop) return;

    this.currentAction = actionName;
    this.currentFrame = 0;
    this.frameTimer = 0;

    const img = this.imageCache.get(action.src);
    if (!img) {
      console.warn(`[SpriteEngine] 图片未缓存: ${action.src}`);
      return;
    }
    this.spriteImg = img;
    this.totalFrames = action.endFrame - action.startFrame;
    console.log(`[SpriteEngine] ${actionName}: 帧 ${action.startFrame}-${action.endFrame-1} (共${this.totalFrames}帧) ${action.columns}列`);
    this.onChange?.(actionName);

    if (!this.running) {
      this.running = true;
      this.lastTime = performance.now();
      this.loop();
    }
  }

  setOnChange(callback: (action: string) => void) {
    this.onChange = callback;
  }

  getCurrentAction(): string | null {
    return this.currentAction;
  }

  getCurrentFrame(): number {
    return this.currentFrame;
  }

  getTotalFrames(): number {
    return this.totalFrames;
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rid);
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 切换到另一个渲染器时清理 */
  destroy() {
    this.stop();
    this.imageCache.clear();
    this.spriteImg = null;
  }

  // ---- 内部 ----

  private loop() {
    if (!this.running) return;
    this.rid = requestAnimationFrame(() => this.loop());

    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    const action = this.currentAction ? this.actions[this.currentAction] : null;
    if (!action || !this.spriteImg) return;

    // 更新帧
    this.frameTimer += dt;
    const frameInterval = 1 / action.fps;
    if (this.frameTimer >= frameInterval) {
      this.frameTimer -= frameInterval;
      this.currentFrame++;
      if (this.currentFrame >= this.totalFrames) {
        if (action.loop) {
          this.currentFrame = 0;
        } else {
          // 不循环：停在最后一帧，切回 idle
          this.currentFrame = this.totalFrames - 1;
          if (this.currentAction !== "idle") {
            this.play("idle");
            return;
          }
        }
      }
    }

    // 绘制当前帧
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.ctx.clearRect(0, 0, w, h);

    // 计算网格中的源位置
    const actualFrameIndex = action.startFrame + this.currentFrame;
    const sx = (actualFrameIndex % action.columns) * action.frameW;
    const sy = Math.floor(actualFrameIndex / action.columns) * action.frameH;
    const sw = action.frameW;
    const sh = action.frameH;

    // 居中绘制，缩放到画布大小
    const scale = Math.min(w / sw, h / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2;

    this.ctx.drawImage(this.spriteImg, sx, sy, sw, sh, dx, dy, dw, dh);

    // 调试：帧号和网格坐标
    this.ctx.fillStyle = "rgba(0,0,0,0.6)";
    this.ctx.font = "11px monospace";
    this.ctx.fillText(`${this.currentAction || "?"} #${this.currentFrame}/${this.totalFrames}`, 4, h - 4);
  }
}

// ===== 精灵动作映射 =====

const ASSET_BASE = "/assets/pixel-cat";
const COLS = 22; // 22列 x 106行, 每帧16x16

/**
 * 网格精灵表: 352x1696, 16x16px/帧, 22列 x 106行
 * 你需要告诉我每个动作对应哪些帧 (行号 x 22列)
 * 当前按行分配，每行22帧。调整 startFrame/endFrame 即可精确定位。
 */
export const PIXEL_ACTIONS: SpriteActionMap = {
  idle:      { src: `${ASSET_BASE}/cat 1.png`, frameW: 16, frameH: 16, columns: COLS, startFrame: 0,   endFrame: 22,  fps: 8,  loop: true },
  walk:      { src: `${ASSET_BASE}/cat 1.png`, frameW: 16, frameH: 16, columns: COLS, startFrame: 22,  endFrame: 44,  fps: 10, loop: true },
  run:       { src: `${ASSET_BASE}/cat 1.png`, frameW: 16, frameH: 16, columns: COLS, startFrame: 44,  endFrame: 66,  fps: 12, loop: true },
  happy:     { src: `${ASSET_BASE}/cat 1.png`, frameW: 16, frameH: 16, columns: COLS, startFrame: 66,  endFrame: 88,  fps: 10, loop: false },
  surprised: { src: `${ASSET_BASE}/cat 1.png`, frameW: 16, frameH: 16, columns: COLS, startFrame: 88,  endFrame: 110, fps: 10, loop: false },
  sleep:     { src: `${ASSET_BASE}/cat 1.png`, frameW: 16, frameH: 16, columns: COLS, startFrame: 110, endFrame: 132, fps: 4,  loop: true },
  attack:    { src: `${ASSET_BASE}/cat 1.png`, frameW: 16, frameH: 16, columns: COLS, startFrame: 132, endFrame: 154, fps: 12, loop: false },
  jump:      { src: `${ASSET_BASE}/cat 1.png`, frameW: 16, frameH: 16, columns: COLS, startFrame: 154, endFrame: 176, fps: 10, loop: false },
};
