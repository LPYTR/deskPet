/**
 * 窗口追踪器
 * 每 500ms 轮询前台窗口坐标，计算宠物应贴边的目标位置
 * macOS: 通过子进程运行 active-win（绕过 Electron 沙箱限制）
 */

import { screen } from "electron";
import { execFile } from "child_process";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
  isMaximized: boolean;
}

// ===== 配置 =====

const POLL_INTERVAL = 500; // ms
const IDLE_POLL_INTERVAL = 2000; // 空闲时进一步降频
const PET_SIZE = 150;
const EDGE_OFFSET = 4;

// ===== 状态 =====

let lastWindowTitle = "";
let isTracking = false;
let isPaused = false;
let timer: ReturnType<typeof setInterval> | null = null;
let onChange: ((event: WindowChangeEvent) => void) | null = null;
let lastWindowChangeTime = 0;
let idleMode = false;

// macOS: 缓存的 node 路径（用于子进程 active-win）
let nodeBin = "";
let windowTrackLogged = false;
let windowTrackErrLogged = false;

function findNodeBin(): string {
  try {
    const { execSync } = require("child_process");
    const result = execSync("which node 2>/dev/null || echo ''", { encoding: "utf8", timeout: 3000 }).trim();
    if (result) return result;
  } catch {}
  const fs = require("fs");
  const common = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  for (const p of common) {
    if (fs.existsSync(p)) return p;
  }
  return "node";
}

function getNodeBin(): string {
  if (!nodeBin) {
    nodeBin = findNodeBin();
    console.log(`[WindowTracker] node binary: ${nodeBin}`);
  }
  return nodeBin;
}

// ===== 公开 API =====

export function startTracking(
  callback: (event: WindowChangeEvent) => void
) {
  onChange = callback;
  if (isTracking) return;
  isTracking = true;
  isPaused = false;

  // 预热 node 路径
  getNodeBin();

  // 立即执行一次
  pollViaChild();

  timer = setInterval(pollViaChild, POLL_INTERVAL);
  console.log(`[WindowTracker] 开始追踪 (${POLL_INTERVAL}ms, 子进程模式)`);
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
  pollViaChild();
  const interval = idleMode ? IDLE_POLL_INTERVAL : POLL_INTERVAL;
  timer = setInterval(pollViaChild, interval);
  console.log(`[WindowTracker] 恢复追踪 (${interval}ms)`);
}

// ===== 内部: 通过子进程运行 active-win =====

let scriptPath = "";

function getScriptPath(): string {
  if (!scriptPath) {
    const dir = join(tmpdir(), "petdesk");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    scriptPath = join(dir, "active-win-poll.js");
    // 使用 require.resolve 获取 active-win 的绝对路径，避免子进程找不到模块
    const activeWinPath = require.resolve("active-win");
    writeFileSync(scriptPath,
      'var activeWin = require(' + JSON.stringify(activeWinPath) + ');\n' +
      'activeWin().then(function(w) {\n' +
      '  if (w && w.bounds) {\n' +
      '    process.stdout.write(JSON.stringify({\n' +
      '      title: w.title || "",\n' +
      '      owner: w.owner && w.owner.name ? w.owner.name : "",\n' +
      '      bounds: w.bounds\n' +
      '    }));\n' +
      '  } else {\n' +
      '    process.stdout.write("null");\n' +
      '  }\n' +
      '}).catch(function(e) {\n' +
      '  process.stdout.write("null");\n' +
      '});\n'
    );
  }
  return scriptPath;
}

function pollViaChild(): void {
  if (!onChange || isPaused) return;

  execFile(getNodeBin(), [getScriptPath()], {
    timeout: 5000,
    maxBuffer: 1024 * 10,
    cwd: process.cwd(),
  }, (err, stdout, stderr) => {
    if (!onChange || isPaused) return;

    let winInfo: WindowInfo | null = null;

    if (!err && stdout) {
      try {
        const trimmed = stdout.trim();
        if (trimmed && trimmed !== "null") {
          const result = JSON.parse(trimmed);
          if (result && result.bounds && result.bounds.width > 0) {
            winInfo = result as WindowInfo;
          }
        }
      } catch {
        // parse error, treat as null
      }
    } else if (err && !windowTrackErrLogged) {
      console.warn(`[WindowTracker] 子进程异常 (将重试): ${err.message}`);
      windowTrackErrLogged = true;
    }

    const event = buildEvent(winInfo);
    onChange(event);

    // 空闲检测
    const currentTitle = winInfo?.title || "";
    if (currentTitle !== lastWindowTitle) {
      lastWindowChangeTime = Date.now();
    }
    lastWindowTitle = currentTitle;

    const now = Date.now();
    const shouldBeIdle = now - lastWindowChangeTime > 300_000;
    if (shouldBeIdle !== idleMode) {
      idleMode = shouldBeIdle;
      if (timer && !isPaused) {
        clearInterval(timer);
        const interval = idleMode ? IDLE_POLL_INTERVAL : POLL_INTERVAL;
        timer = setInterval(pollViaChild, interval);
        console.log(`[WindowTracker] ${idleMode ? "进入空闲模式" : "退出空闲模式"} (${interval}ms)`);
      }
    }
  });
}

// ===== 位置计算 =====

function buildEvent(win: WindowInfo | null): WindowChangeEvent {
  if (!win) {
    return {
      type: "desktop",
      activeWindow: null,
      petPosition: getDesktopPetPosition(),
      isMaximized: false,
    };
  }

  const type =
    lastWindowTitle && win.title !== lastWindowTitle ? "switch" : "move";

  return {
    type,
    activeWindow: win,
    petPosition: calcSnapPosition(win),
    isMaximized: calcIsMaximized(win),
  };
}

function calcIsMaximized(win: WindowInfo): boolean {
  const display = screen.getDisplayNearestPoint({
    x: win.bounds.x,
    y: win.bounds.y,
  });
  const { workArea } = display;
  const widthRatio = win.bounds.width / workArea.width;
  const heightRatio = win.bounds.height / workArea.height;
  return widthRatio > 0.95 && heightRatio > 0.95;
}

function calcSnapPosition(win: WindowInfo): PetPosition {
  const display = screen.getDisplayNearestPoint({
    x: win.bounds.x,
    y: win.bounds.y,
  });
  const { workArea } = display;

  const isMaximized = calcIsMaximized(win);

  let rawX: number;
  let rawY: number;

  if (isMaximized) {
    rawX = win.bounds.x + win.bounds.width / 2 - PET_SIZE / 2;
    rawY = win.bounds.y - PET_SIZE + 30;
  } else {
    const rightSpace = workArea.x + workArea.width - (win.bounds.x + win.bounds.width);
    const leftSpace = win.bounds.x - workArea.x;

    if (rightSpace >= PET_SIZE + EDGE_OFFSET) {
      rawX = win.bounds.x + win.bounds.width + EDGE_OFFSET;
    } else if (leftSpace >= PET_SIZE + EDGE_OFFSET) {
      rawX = win.bounds.x - PET_SIZE - EDGE_OFFSET;
    } else {
      rawX = win.bounds.x + win.bounds.width / 2 - PET_SIZE / 2;
    }

    rawY = win.bounds.y + win.bounds.height / 2 - PET_SIZE / 2;
  }

  const margin = 4;
  return {
    x: Math.round(clamp(rawX, workArea.x + margin, workArea.x + workArea.width - PET_SIZE - margin)),
    y: Math.round(clamp(rawY, workArea.y + margin, workArea.y + workArea.height - PET_SIZE - margin)),
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function getDesktopPetPosition(): PetPosition {
  const { workArea } = screen.getPrimaryDisplay();
  const margin = 4;
  return {
    x: clamp(workArea.x + workArea.width - PET_SIZE - 50, workArea.x + margin, workArea.x + workArea.width - PET_SIZE - margin),
    y: clamp(workArea.y + workArea.height - PET_SIZE - 50, workArea.y + margin, workArea.y + workArea.height - PET_SIZE - margin),
  };
}
