/**
 * PetDesk 渲染进程
 * 双模式: 视频优先 (MP4) → 2D 像素精灵兜底
 */

import {
  VideoController,
  OverlayCanvas,
  ChromaKeyRenderer,
} from "./video-engine";
import { SpriteRenderer, PIXEL_ACTIONS } from "./sprite-engine";

// ===== DOM =====
const videoEl = document.getElementById("pet-video") as HTMLVideoElement;
const chromaCanvas = document.getElementById("chroma-canvas") as HTMLCanvasElement;
const overlayCanvas = document.getElementById("overlay-canvas") as HTMLCanvasElement;

const videoCtrl = new VideoController(videoEl);
const spriteRenderer = new SpriteRenderer(chromaCanvas);
const overlay = new OverlayCanvas(overlayCanvas);
const chromaKey = new ChromaKeyRenderer(videoEl, chromaCanvas);

// ===== 映射 =====
const ACTION_KEYS: Record<string, string> = {
  "1": "idle", "2": "happy", "3": "walk", "4": "surprised", "5": "sleep",
  "6": "run", "7": "attack",
};
const ACTION_LABELS: Record<string, string> = {
  idle: "待机", happy: "开心", walk: "走路", surprised: "受惊", sleep: "睡觉",
  run: "奔跑", attack: "攻击",
};

// ===== 状态 =====
let mood = 50;
let lastScared = 0, lastAttention = 0, lastDouble = 0, lastChase = 0, lastClick = 0;
type RenderMode = "video" | "sprite";
let currentMode: RenderMode = "video";

// ===== 走路步进管理 =====
let isWalkStepping = false;
let walkDir = 1; // 1=右, -1=左

function startWalkStep(dir = 1) {
  if (isWalkStepping) {
    // 已经在走，切换方向
    if (dir !== walkDir) {
      walkDir = dir;
      flipVideo(dir === -1);
      window.petAPI.walkStepStart(dir);
    }
    return;
  }
  isWalkStepping = true;
  walkDir = dir;
  flipVideo(dir === -1);
  window.petAPI.walkStepStart(dir);
}

function stopWalkStep() {
  if (!isWalkStepping) return;
  isWalkStepping = false;
  flipVideo(false);
  window.petAPI.walkStepStop();
}

function flipVideo(flip: boolean) {
  // chroma-key 模式下翻转 canvas（video 是隐藏的，CSS transform 不影响 canvas drawImage）
  if (chromaKey.isRunning()) {
    chromaCanvas.style.transform = flip ? "scaleX(-1)" : "";
  } else {
    videoEl.style.transform = flip ? "scaleX(-1)" : "";
  }
}

// 监听主进程发来的方向翻转（走到边界时自动反转）
window.petAPI.onWalkFlip(() => {
  walkDir = -walkDir;
  flipVideo(walkDir === -1);
});

// 动作切换到非 walk 时自动停止步进
videoCtrl.setOnChange((action) => {
  if (action !== "walk") stopWalkStep();
});

// ===== 统一播放接口 =====

function playAction(action: string) {
  if (currentMode === "video") {
    // 没有对应视频素材的动作 fallback
    if (!REAL_VIDEO_SRCS[action]) {
      const fallback: Record<string, string> = { run: "walk", attack: "happy" };
      const fb = fallback[action] || "idle";
      console.log(`[Video] 无 "${action}" 素材，fallback → ${fb}`);
      videoCtrl.play(fb);
      return;
    }
    videoCtrl.play(action);
  } else {
    spriteRenderer.play(action);
  }
}

function getCurrentAction(): string | null {
  return currentMode === "video" ? videoCtrl.getCurrentAction() : spriteRenderer.getCurrentAction();
}

function switchToSpriteMode(reason: string) {
  if (currentMode === "sprite") return;
  console.warn(`[Mode] 切换到精灵模式: ${reason}`);
  currentMode = "sprite";

  // 停止走路步进
  stopWalkStep();

  // 隐藏视频，显示精灵画布
  videoEl.style.display = "none";
  if (chromaKey.isRunning()) chromaKey.stop();
  chromaCanvas.style.display = "block";

  // 注册精灵动作并播放当前动作
  spriteRenderer.registerActions(PIXEL_ACTIONS);
  spriteRenderer.preloadAll().then(() => {
    spriteRenderer.play("idle");
    updateBadge();
  });
}

function updateBadge() {
  const action = getCurrentAction() || "idle";
  if (currentMode === "sprite") {
    const f = spriteRenderer.getCurrentFrame();
    const t = spriteRenderer.getTotalFrames();
    overlay.showBadge(`${ACTION_LABELS[action]} | 心情 ${mood} | 2D精灵 [${f}/${t}]`);
  } else {
    overlay.showBadge(`${ACTION_LABELS[action]} | 心情 ${mood} | 视频`);
  }
}

// ===== 真实视频列表 =====
const ASSET_BASE = "/assets/default-cat";
const REAL_VIDEO_SRCS: Record<string, string> = {
  idle:      `${ASSET_BASE}/idle.webm`,
  happy:     `${ASSET_BASE}/happy.webm`,
  walk:      `${ASSET_BASE}/walk.webm`,
};

// ===== 启动 =====

async function init() {
  console.log("🐾 PetDesk — 视频模式");

  // 0. 确保所有画布尺寸正确
  const canvasSize = 150;
  overlayCanvas.width = overlayCanvas.clientWidth || canvasSize;
  overlayCanvas.height = overlayCanvas.clientHeight || canvasSize;
  chromaCanvas.width = chromaCanvas.clientWidth || canvasSize;
  chromaCanvas.height = chromaCanvas.clientHeight || canvasSize;

  // 1. 默认使用视频模式
  currentMode = "video";
  videoEl.style.display = "block";
  chromaCanvas.style.display = "none";

  // 注册真实视频动作
  const videoActions = Object.entries(REAL_VIDEO_SRCS).map(([name, src]) => ({
    [name]: { src, loop: ["idle", "walk"].includes(name) },
  })).reduce((acc, cur) => ({ ...acc, ...cur }), {});
  videoCtrl.registerActions(videoActions);

  console.log("[Init] 视频动作已注册:", Object.keys(videoActions).join(", "));

  // 预加载视频
  await videoCtrl.preloadAll();
  videoCtrl.play("idle");

  // 2. 清除调试标记
  updateBadge();
  const debugBg = document.getElementById("debug-bg");
  if (debugBg) debugBg.style.display = "none";

  // 3. 等待视频首帧渲染后，自动检测背景色并启用 chroma-key
  await waitForVideoFrame(videoEl);
  const bgColor = detectVideoBackground(videoEl);
  if (bgColor) {
    console.log(`[Init] 检测到视频背景色: rgb(${bgColor.join(",")})`);
    videoEl.style.display = "none";
    chromaCanvas.style.display = "block";
    chromaKey.setColor(bgColor[0], bgColor[1], bgColor[2]);
    // 根据背景亮度自适应阈值：深色背景用低阈值（保护猫咪暗色细节），亮色用高阈值
    const brightness = (bgColor[0] + bgColor[1] + bgColor[2]) / 3;
    const threshold = brightness < 60 ? 50 : brightness < 150 ? 70 : 90;
    chromaKey.setThreshold(threshold);
    chromaKey.start();
    console.log(`[Init] Chroma-Key 已自动启用, 阈值: ${threshold}`);
  } else {
    console.log("[Init] 未检测到纯色背景，使用视频原始渲染");
  }

  console.log("✅ 就绪");

  setupKeyboard();
  setupChromaKeyControls();
  setupAllMouse();
  setupWindowTracking();
  setupTransitionListener();
  setupMouseStateListener();
}

/** 等待视频首帧就绪 */
function waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    if (video.readyState >= 2 && video.videoWidth > 0) {
      resolve();
      return;
    }
    const onReady = () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      // 给浏览器一帧时间来渲染
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    };
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("canplay", onReady);
    // 超时兜底
    setTimeout(() => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      resolve();
    }, 3000);
  });
}

/** 从视频四角采样，检测纯色背景 */
function detectVideoBackground(video: HTMLVideoElement): [number, number, number] | null {
  try {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;

    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);

    // 采样四个角落 5x5 区域
    const corners = [
      [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1],
      [5, 5], [w - 6, 5], [5, h - 6], [w - 6, h - 6],
    ];

    const colors: [number, number, number][] = [];
    for (const [cx, cy] of corners) {
      const x = Math.max(0, Math.min(w - 1, cx));
      const y = Math.max(0, Math.min(h - 1, cy));
      const pixel = ctx.getImageData(x, y, 1, 1).data;
      colors.push([pixel[0], pixel[1], pixel[2]]);
    }

    // 检查这些采样点颜色是否一致（纯色背景的标志）
    const avg = colors.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0])
      .map(v => Math.round(v / colors.length)) as [number, number, number];

    // 计算各采样点与均值的最大偏差
    const maxDev = Math.max(...colors.map(c =>
      Math.max(Math.abs(c[0] - avg[0]), Math.abs(c[1] - avg[1]), Math.abs(c[2] - avg[2]))
    ));

    // 偏差小于 25 说明是纯色背景
    if (maxDev < 25) {
      return avg;
    }
    return null;
  } catch {
    return null;
  }
}

// ===== 视频探测 =====

function probeVideo(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(`[Probe] 开始探测: ${path}`);
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.src = path;
    let resolved = false;
    v.addEventListener("loadeddata", () => {
      console.log(`[Probe] loadeddata 触发: ${path}, 尺寸: ${v.videoWidth}x${v.videoHeight}, 时长: ${v.duration}s`);
      // loadeddata 成功 → 尝试播放一小段验证解码器
      v.play().then(() => {
        console.log(`[Probe] ✅ play() 成功: ${path}`);
        if (!resolved) { resolved = true; resolve(true); }
      }).catch((err) => {
        console.warn(`[Probe] ❌ play() 失败: ${path} — ${err.name}: ${err.message}`);
        if (!resolved) { resolved = true; resolve(false); }
      });
    }, { once: true });
    v.addEventListener("error", () => {
      const err = v.error;
      console.warn(`[Probe] ❌ error 事件: ${path} — code=${err?.code}, message=${err?.message}`);
      if (!resolved) { resolved = true; resolve(false); }
    }, { once: true });
    // 超时 5s
    setTimeout(() => {
      if (!resolved) { resolved = true; console.warn(`[Probe] ⏰ 超时: ${path}`); resolve(false); }
    }, 5000);
    v.load();
  });
}

// ===== 快捷键 =====

function setupKeyboard() {
  window.petAPI.onShortcut((key) => {
    const action = ACTION_KEYS[key];
    if (!action) return;

    // walk → 向右走, run → 向左走
    if (action === "walk") {
      playAction("walk");
      startWalkStep(1);   // 向右
    } else if (action === "run") {
      playAction("walk");  // 复用 walk 动画
      startWalkStep(-1);  // 向左（视频翻转）
    } else {
      stopWalkStep();
      playAction(action);
    }
  });
}

// ===== Chroma-Key 调试控制 =====

function setupChromaKeyControls() {
  // Chroma-Key 仅视频模式有效
  if (currentMode !== "video") return;

  const presets: [number, number, number][] = [
    [0, 255, 0],    // G: 绿幕 (推荐，猫咪橙色无冲突)
    [0, 0, 0],      // K: 黑底 (会抠掉猫眼/黑线，不推荐)
    [0, 0, 255],    // B: 蓝幕
    [255, 0, 255],  // M: 品红
    [255, 255, 255],// W: 白底
  ];
  let presetIdx = 0;

  window.addEventListener("keydown", (e) => {
    if (currentMode !== "video") return;

    if (e.key === "g" || e.key === "G") {
      if (chromaKey.isRunning()) {
        chromaKey.stop();
        videoEl.style.display = "block";
        updateBadge();
        console.log("[ChromaKey] 已关闭");
      } else {
        videoEl.style.display = "none";
        chromaKey.start();
        overlay.showBadge(`${ACTION_LABELS[getCurrentAction() || "idle"]} | 心情 ${mood} | 🟢CK`);
        console.log("[ChromaKey] 已开启");
      }
    }

    if (!chromaKey.isRunning()) return;

    if (e.key === "ArrowRight") {
      chromaKey.setThreshold(chromaKey.getThreshold() + 10);
      console.log(`[ChromaKey] 阈值: ${chromaKey.getThreshold()}`);
    }
    if (e.key === "ArrowLeft") {
      chromaKey.setThreshold(Math.max(10, chromaKey.getThreshold() - 10));
      console.log(`[ChromaKey] 阈值: ${chromaKey.getThreshold()}`);
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      presetIdx = (presetIdx + 1) % presets.length;
      const [r, g, b] = presets[presetIdx];
      chromaKey.setColor(r, g, b);
      const names = ["黑底", "绿幕", "蓝幕", "品红", "白底"];
      console.log(`[ChromaKey] 颜色: ${names[presetIdx]} (${r},${g},${b})`);
    }
  });
}

// ===== 鼠标交互 (含窗口拖动) =====

function setupAllMouse() {
  // 根据当前模式选择点击目标
  function getClickTarget(): HTMLElement {
    if (currentMode === "sprite") return chromaCanvas;
    if (chromaKey.isRunning()) return chromaCanvas;
    return videoEl;
  }

  // ---- 窗口拖动状态 ----
  let dragInfo: { startX: number; startY: number; lastX: number; lastY: number; dragging: boolean } | null = null;

  const ct = getClickTarget();
  ct.addEventListener("mousedown", (e) => {
    if (e.button === 2) return;
    dragInfo = {
      startX: e.screenX,
      startY: e.screenY,
      lastX: e.screenX,
      lastY: e.screenY,
      dragging: false,
    };
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragInfo) return;
    const dx = e.screenX - dragInfo.lastX;
    const dy = e.screenY - dragInfo.lastY;
    const totalDist = Math.hypot(e.screenX - dragInfo.startX, e.screenY - dragInfo.startY);

    if (!dragInfo.dragging && totalDist > 15) {
      dragInfo.dragging = true;
    }

    if (dragInfo.dragging && (dx !== 0 || dy !== 0)) {
      window.petAPI.moveWindowBy(dx, dy);
      dragInfo.lastX = e.screenX;
      dragInfo.lastY = e.screenY;
    }
  });

  window.addEventListener("mouseup", () => {
    if (!dragInfo) return;

    if (dragInfo.dragging) {
      window.petAPI.endDrag();
    } else {
      const now = Date.now();
      if (now - lastClick < 500) { dragInfo = null; return; }
      lastClick = now;
      playAction("happy");
      mood = Math.min(100, mood + 2);
      const msgs = ["汪~今天也喜欢我!", "喵~你终于理我了", "嘿嘿，别摸头~", "嗷呜~好开心"];
      overlay.showBubble(msgs[Math.floor(Math.random() * msgs.length)], 2500);
    }

    dragInfo = null;
  });

  // 双击
  ct.addEventListener("dblclick", () => {
    const now = Date.now();
    if (now - lastDouble < 2000) return;
    lastDouble = now;
    const s = ["surprised", "happy"];
    playAction(s[Math.floor(Math.random() * s.length)]);
    mood = Math.min(100, mood + 3);
    overlay.showBubble("哎呀!", 1500);
  });

  // 右键菜单
  ct.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY);
  });

  // 文件拖放追逐
  ct.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = "none";
    const now = Date.now();
    if (now - lastChase > 3000) {
      lastChase = now;
      playAction("walk");
      overlay.showBubble("别跑!", 1500);
      setTimeout(() => { if (getCurrentAction() === "walk") playAction("idle"); }, 1500);
    }
  });

  ct.addEventListener("drop", (e) => e.preventDefault());
}

// ===== 右键菜单 =====

function showContextMenu(mx: number, my: number) {
  const existing = document.getElementById("ctx-menu");
  if (existing) existing.remove();
  const menu = document.createElement("div");
  menu.id = "ctx-menu";
  Object.assign(menu.style, {
    position: "fixed", left: `${mx}px`, top: `${my}px`,
    background: "rgba(255,255,255,0.95)", borderRadius: "10px",
    boxShadow: "0 4px 20px rgba(0,0,0,0.2)", padding: "6px 0", zIndex: "9999",
    fontFamily: '"PingFang SC","Microsoft YaHei",sans-serif', fontSize: "13px", minWidth: "150px",
  });
  const items = [
    { label: "😊 生成表情包", action: () => overlay.showBubble("即将上线!", 2000) },
    { label: "⚙️ 设置", action: () => overlay.showBubble("即将上线!", 2000) },
    { type: "sep" as const },
    { label: "👋 隐藏宠物", action: () => window.petAPI.hidePet() },
  ];
  for (const item of items) {
    if ("type" in item) {
      const s = document.createElement("div");
      s.style.cssText = "height:1px;background:rgba(0,0,0,0.08);margin:4px 8px;";
      menu.appendChild(s);
    } else {
      const row = document.createElement("div");
      row.textContent = item.label;
      Object.assign(row.style, { padding: "8px 16px", cursor: "pointer" });
      row.addEventListener("mouseenter", () => row.style.background = "rgba(0,0,0,0.06)");
      row.addEventListener("mouseleave", () => row.style.background = "");
      row.addEventListener("click", () => { item.action(); menu.remove(); });
      menu.appendChild(row);
    }
  }
  document.body.appendChild(menu);
  const close = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener("click", close); }
  };
  setTimeout(() => document.addEventListener("click", close), 0);
}

// ===== 窗口追踪 / 过渡 / 鼠标状态（不变）=====

function setupWindowTracking() {
  let lastTitle = "";
  window.petAPI.onWindowInfo((info) => {
    if (info.type === "switch" && info.title && info.title !== lastTitle) {
      playAction("walk");
    }
    if (info.title) lastTitle = info.title;
  });
}

function setupTransitionListener() {
  window.petAPI.onTransition((phase) => {
    if (phase === "run") overlay.startParticles("dust");
    else if (phase === "arrive") {
      overlay.stopParticles();
      playAction("idle");
      overlay.showBubble("到了!", 1500);
    }
  });
}

function setupMouseStateListener() {
  window.petAPI.onMouseState((e) => {
    const now = Date.now();
    if (e.state === "hover" && getCurrentAction() === "idle") {
      overlay.showBubble("嗯?", 1500);
    } else if (e.state === "dragging" && now - lastScared > 10_000) {
      lastScared = now;
      playAction("surprised");
      overlay.startParticles("confetti");
      window.petAPI.moveToCorner();
      setTimeout(() => overlay.stopParticles(), 1500);
    } else if (e.state === "idle_long" && now - lastAttention > 300_000) {
      lastAttention = now;
      playAction("walk");
      startWalkStep();
      overlay.showBubble("理我一下嘛~", 3000);
      setTimeout(() => { if (getCurrentAction() === "walk") { playAction("idle"); stopWalkStep(); } }, 2000);
    }
  });
}

init();
