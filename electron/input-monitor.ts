/**
 * 全局输入监控
 * 每 100ms 采样鼠标坐标 → 计算速度/状态 → IPC 推送渲染进程
 */

import { screen, BrowserWindow } from "electron";

// ===== 类型 =====

export type MouseState = "idle" | "hover" | "dragging" | "idle_long";

export interface MouseEvent {
  x: number;
  y: number;
  velocity: number; // px/s
  state: MouseState;
  stateChanged: boolean; // 状态刚切换时为 true
}

// ===== 配置 =====

const SAMPLE_INTERVAL = 100; // ms (原 50ms，降低以减少 CPU)
const IDLE_SAMPLE_INTERVAL = 500; // 空闲时进一步降频
const HOVER_TIMEOUT = 1000; // 悬停 ≥1s 触发 hover
const IDLE_LONG_TIMEOUT = 180_000; // 3min 无移动
const DRAG_SPEED_THRESHOLD = 2000; // px/s, 超过为快速拖拽
const HOVER_HISTORY_SIZE = 3; // 连续 N 次在宠物区域内才判定 hover

// ===== 状态 =====

let prevX = 0;
let prevY = 0;
let prevTime = 0;
let idleTimer = 0; // 上次移动的时间戳
let hoverStart = 0; // 开始悬停的时间戳
let hoverCount = 0;
let currentState: MouseState = "idle";
let callback: ((e: MouseEvent) => void) | null = null;
let running = false;
let isPaused = false;
let timer: ReturnType<typeof setInterval> | null = null;
let idleMode = false;
let petWindow: BrowserWindow | null = null;

// ===== 公开 API =====

export function startInputMonitor(
  win: BrowserWindow,
  cb: (e: MouseEvent) => void
) {
  if (running) return;
  callback = cb;
  running = true;
  isPaused = false;
  petWindow = win;
  prevTime = performance.now();
  idleTimer = prevTime;

  // 初始位置
  const initPos = screen.getCursorScreenPoint();
  prevX = initPos.x;
  prevY = initPos.y;

  timer = setInterval(() => tick(), SAMPLE_INTERVAL);
  console.log(`[InputMonitor] 开始监控 (${SAMPLE_INTERVAL}ms)`);
}

export function stopInputMonitor() {
  running = false;
  isPaused = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  callback = null;
  petWindow = null;
  console.log("[InputMonitor] 停止监控");
}

export function pauseInputMonitor() {
  if (!running || isPaused) return;
  isPaused = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  console.log("[InputMonitor] 暂停监控");
}

export function resumeInputMonitor() {
  if (!running || !isPaused) return;
  isPaused = false;
  const interval = idleMode ? IDLE_SAMPLE_INTERVAL : SAMPLE_INTERVAL;
  timer = setInterval(() => tick(), interval);
  console.log(`[InputMonitor] 恢复监控 (${interval}ms)`);
}

// ===== 内部 =====

function tick() {
  if (!callback || isPaused || !petWindow) return;

  const pos = screen.getCursorScreenPoint();
  const now = performance.now();
  const dt = (now - prevTime) / 1000; // 秒

  // 速度
  const dx = pos.x - prevX;
  const dy = pos.y - prevY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const velocity = dt > 0 ? dist / dt : 0;

  // 是否在宠物窗口范围内
  const petBounds = petWindow.getBounds();
  const overPet =
    pos.x >= petBounds.x &&
    pos.x <= petBounds.x + petBounds.width &&
    pos.y >= petBounds.y &&
    pos.y <= petBounds.y + petBounds.height;

  // 状态判定
  let newState: MouseState = "idle";

  // 1. 快速拖拽 (即使不在宠物上方也触发)
  if (velocity > DRAG_SPEED_THRESHOLD && overPet) {
    newState = "dragging";
  }
  // 2. 长时间不动
  else if (now - idleTimer > IDLE_LONG_TIMEOUT) {
    newState = "idle_long";
  }
  // 3. 悬停在宠物上
  else if (overPet) {
    hoverCount++;
    if (hoverCount >= HOVER_HISTORY_SIZE) {
      if (hoverStart === 0) hoverStart = now;
      if (now - hoverStart >= HOVER_TIMEOUT) {
        newState = "hover";
      }
    }
  }
  // 4. 普通移动
  else {
    hoverCount = 0;
    hoverStart = 0;
    newState = "idle";
  }

  // 鼠标移动了 → 重置空闲计时器
  if (dist > 2) {
    idleTimer = now;
    // 如果之前是 idle_long，移动后恢复正常
    if (currentState === "idle_long") {
      newState = "idle";
    }
  }

  // 空闲检测：鼠标超过 2 分钟不动，进入空闲模式降频
  const shouldBeIdle = now - idleTimer > 120_000; // 2 分钟
  if (shouldBeIdle !== idleMode) {
    idleMode = shouldBeIdle;
    if (timer && !isPaused) {
      clearInterval(timer);
      const interval = idleMode ? IDLE_SAMPLE_INTERVAL : SAMPLE_INTERVAL;
      timer = setInterval(() => tick(), interval);
      console.log(`[InputMonitor] ${idleMode ? "进入空闲模式" : "退出空闲模式"} (${interval}ms)`);
    }
  }

  const stateChanged = newState !== currentState;
  currentState = newState;

  // 只在状态变化时推送，减少 IPC 噪音
  if (stateChanged) {
    callback({
      x: pos.x,
      y: pos.y,
      velocity: Math.round(velocity),
      state: currentState,
      stateChanged,
    });
  }

  // 更新上一帧
  prevX = pos.x;
  prevY = pos.y;
  prevTime = now;
}
