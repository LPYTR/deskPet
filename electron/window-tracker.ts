/**
 * 窗口追踪器
 * 每 500ms 轮询前台窗口坐标，计算宠物应贴边的目标位置
 */

import { screen } from "electron";

// ===== 类型 =====

export interface WindowInfo {
  title: string;
  owner: string;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface PetPosition {
  x: number;
  y: number;
}

export interface WindowChangeEvent {
  type: "move" | "switch" | "minimize" | "desktop";
  activeWindow: WindowInfo | null;
  petPosition: PetPosition;
}

// ===== 配置 =====

const POLL_INTERVAL = 500; // ms (原 150ms，降低以减少 CPU/权限请求)
const IDLE_POLL_INTERVAL = 2000; // 空闲时进一步降频
const PET_SIZE = 150; // 宠物窗口宽高（与 BrowserWindow 一致）
const EDGE_OFFSET = 4; // 宠物与窗口边缘的间距

// ===== 状态 =====

let lastWindowTitle = "";
let isTracking = false;
let isPaused = false;
let timer: ReturnType<typeof setInterval> | null = null;
let onChange: ((event: WindowChangeEvent) => void) | null = null;
let lastWindowChangeTime = 0;
let idleMode = false;

// ===== 公开 API =====

export function startTracking(
  callback: (event: WindowChangeEvent) => void
) {
  onChange = callback;
  if (isTracking) return;
  isTracking = true;
  isPaused = false;

  // 立即执行一次
  poll();

  timer = setInterval(poll, POLL_INTERVAL);
  console.log(`[WindowTracker] 开始追踪 (${POLL_INTERVAL}ms)`);
}

export function stopTracking() {
  isTracking = false;
  isPaused = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  onChange = null;
  console.log("[WindowTracker] 停止追踪");
}

export function pauseTracking() {
  if (!isTracking || isPaused) return;
  isPaused = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  console.log("[WindowTracker] 暂停追踪");
}

export function resumeTracking() {
  if (!isTracking || !isPaused) return;
  isPaused = false;
  // 立即执行一次
  poll();
  const interval = idleMode ? IDLE_POLL_INTERVAL : POLL_INTERVAL;
  timer = setInterval(poll, interval);
  console.log(`[WindowTracker] 恢复追踪 (${interval}ms)`);
}

// ===== 内部 =====

async function poll() {
  if (!onChange || isPaused) return;

  let winInfo: WindowInfo | null = null;

  try {
    const activeWin = await import("active-win");
    const win = await activeWin.default();
    if (win) {
      winInfo = {
        title: win.title,
        owner: win.owner?.name || "",
        bounds: {
          x: win.bounds.x,
          y: win.bounds.y,
          width: win.bounds.width,
          height: win.bounds.height,
        },
      };
    }
  } catch {
    // active-win 偶尔失败，静默跳过
    return;
  }

  const event = buildEvent(winInfo);
  onChange(event);

  // 检测窗口是否变化 (用于空闲检测)
  const currentTitle = winInfo?.title || "";
  if (currentTitle !== lastWindowTitle) {
    lastWindowChangeTime = Date.now();
  }
  lastWindowTitle = currentTitle;

  // 空闲检测：如果超过 5 分钟窗口没有切换，进入空闲模式降频
  const now = Date.now();
  const shouldBeIdle = now - lastWindowChangeTime > 300_000; // 5 分钟
  if (shouldBeIdle !== idleMode) {
    idleMode = shouldBeIdle;
    // 重建定时器以应用新频率
    if (timer && !isPaused) {
      clearInterval(timer);
      const interval = idleMode ? IDLE_POLL_INTERVAL : POLL_INTERVAL;
      timer = setInterval(poll, interval);
      console.log(`[WindowTracker] ${idleMode ? "进入空闲模式" : "退出空闲模式"} (${interval}ms)`);
    }
  }
}

function buildEvent(win: WindowInfo | null): WindowChangeEvent {
  // 没有前台窗口 → 桌面模式
  if (!win) {
    return {
      type: "desktop",
      activeWindow: null,
      petPosition: getDesktopPetPosition(),
    };
  }

  // 窗口标题变了 → 切换窗口
  const type =
    lastWindowTitle && win.title !== lastWindowTitle ? "switch" : "move";

  return {
    type,
    activeWindow: win,
    petPosition: calcSnapPosition(win),
  };
}

// ===== 位置计算 =====

/**
 * 计算宠物贴边位置
 * - 最大化窗口 → 顶部边缘居中
 * - 普通窗口 → 优先右侧，右侧空间不足则左侧，其次上方
 */
function calcSnapPosition(win: WindowInfo): PetPosition {
  const display = screen.getDisplayNearestPoint({
    x: win.bounds.x,
    y: win.bounds.y,
  });
  const { workArea } = display;

  // 判断是否最大化（窗口占满工作区 95% 以上）
  const widthRatio = win.bounds.width / workArea.width;
  const heightRatio = win.bounds.height / workArea.height;
  const isMaximized = widthRatio > 0.95 && heightRatio > 0.95;

  let rawX: number;
  let rawY: number;

  if (isMaximized) {
    // 顶部边缘居中：窗口上方，水平居中
    rawX = win.bounds.x + win.bounds.width / 2 - PET_SIZE / 2;
    rawY = win.bounds.y - PET_SIZE + 30;
  } else {
    // 计算右侧和左侧的可用空间
    const rightSpace = workArea.x + workArea.width - (win.bounds.x + win.bounds.width);
    const leftSpace = win.bounds.x - workArea.x;

    if (rightSpace >= PET_SIZE + EDGE_OFFSET) {
      // 右侧空间充足 → 贴右边缘
      rawX = win.bounds.x + win.bounds.width + EDGE_OFFSET;
    } else if (leftSpace >= PET_SIZE + EDGE_OFFSET) {
      // 右侧不够但左侧充足 → 贴左边缘
      rawX = win.bounds.x - PET_SIZE - EDGE_OFFSET;
    } else {
      // 两侧都不够 → 窗口上方居中
      rawX = win.bounds.x + win.bounds.width / 2 - PET_SIZE / 2;
    }

    // 垂直：优先窗口中间，但限制在屏幕内
    rawY = win.bounds.y + win.bounds.height / 2 - PET_SIZE / 2;
  }

  // 限制在屏幕工作区内（留 4px 边距防止抽搐）
  const margin = 4;
  return {
    x: Math.round(clamp(rawX, workArea.x + margin, workArea.x + workArea.width - PET_SIZE - margin)),
    y: Math.round(clamp(rawY, workArea.y + margin, workArea.y + workArea.height - PET_SIZE - margin)),
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * 桌面自由模式：右下角
 */
function getDesktopPetPosition(): PetPosition {
  const { workArea } = screen.getPrimaryDisplay();
  const margin = 4;
  return {
    x: clamp(workArea.x + workArea.width - PET_SIZE - 50, workArea.x + margin, workArea.x + workArea.width - PET_SIZE - margin),
    y: clamp(workArea.y + workArea.height - PET_SIZE - 50, workArea.y + margin, workArea.y + workArea.height - PET_SIZE - margin),
  };
}
