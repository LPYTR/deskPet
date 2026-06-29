import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  screen,
} from "electron";
import { join } from "path";
import {
  startTracking,
  stopTracking,
  pauseTracking,
  resumeTracking,
} from "./window-tracker";
import {
  startInputMonitor,
  stopInputMonitor,
  pauseInputMonitor,
  resumeInputMonitor,
} from "./input-monitor";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let manualPosition = false;

// ===== 连续平滑跟随 =====
let targetX: number | null = null;
let targetY: number | null = null;
let followTimer: ReturnType<typeof setInterval> | null = null;
let isWindowSwitch = false;
let switchTargetX: number | null = null; // 窗口切换时的原始目标（不被步进覆盖）

function updatePetTarget(x: number, y: number, isSwitch: boolean) {
  targetX = x;
  targetY = y;
  if (isSwitch) {
    isWindowSwitch = true;
    switchTargetX = x; // 保存原始目标
  }

  // 窗口切换时：用 walk-step 走向目标（有可见步进）
  if (isSwitch && mainWindow && !walkStepping) {
    const [cx] = mainWindow.getPosition();
    const dir = x > cx ? 1 : -1;
    walkStepping = true;
    walkDirection = dir;
    lastBounceTime = 0;
    if (dir === -1) mainWindow.webContents.send("walk-flip");
  } else if (!followTimer && mainWindow && !walkStepping) {
    startFollowLoop();
  }
}

function startFollowLoop() {
  if (followTimer || walkStepping) return;  // 走路时不启动跟随
  followTimer = setInterval(() => {
    if (!mainWindow || targetX === null || targetY === null || walkStepping) {
      stopFollowLoop();
      return;
    }

    const [cx, cy] = mainWindow.getPosition();
    const dx = targetX - cx;
    const dy = targetY - cy;
    const dist = Math.hypot(dx, dy);

    // 已到达目标
    if (dist < 2) {
      if (isWindowSwitch) {
        mainWindow.webContents.send("transition", "arrive");
        isWindowSwitch = false;
      }
      mainWindow.setPosition(targetX, targetY);
      stopFollowLoop();
      return;
    }

    const speed = isWindowSwitch ? 0.10 : 0.13;
    let nx = Math.round(cx + dx * speed);
    let ny = Math.round(cy + dy * speed);

    // 用当前位置所在屏幕实时 clamp（不用缓存，防止跨屏 stale 导致震荡）
    const display = screen.getDisplayNearestPoint({ x: cx, y: cy });
    const { workArea } = display;
    const margin = 4;
    nx = clamp(nx, workArea.x + margin, workArea.x + workArea.width - PET_SIZE - margin);
    ny = clamp(ny, workArea.y + margin, workArea.y + workArea.height - PET_SIZE - margin);

    mainWindow.setPosition(nx, ny);
  }, 16);
}

function stopFollowLoop() {
  if (followTimer) {
    clearInterval(followTimer);
    followTimer = null;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

const isDev = !app.isPackaged;
const PET_SIZE = 150;

function createWindow() {
  const { width: screenWidth, height: screenHeight } =
    screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: PET_SIZE,
    height: PET_SIZE,
    x: screenWidth - PET_SIZE - 50,
    y: screenHeight - PET_SIZE - 50,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    type: "toolbar",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (isDev) {
    mainWindow.setIgnoreMouseEvents(false);
  } else {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }

  // 渲染进程日志转发到终端（方便调试）
  mainWindow.webContents.on("console-message", (_ev, _level, message, line, sourceId) => {
    console.log(`[Renderer:${line}] ${message}`);
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    // 开发模式不自动打开 DevTools（按 F12 手动打开）
    // mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "显示/隐藏宠物",
      click: () => {
        if (mainWindow) {
          if (mainWindow.isVisible()) {
            mainWindow.hide();
            pauseTracking();
            pauseInputMonitor();
          } else {
            mainWindow.show();
            resumeTracking();
            resumeInputMonitor();
          }
        }
      },
    },
    { type: "separator" },
    {
      label: "退出 PetDesk",
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setToolTip("PetDesk 桌面搭子");
  tray.setContextMenu(contextMenu);

  tray.on("double-click", () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
        pauseTracking();
        pauseInputMonitor();
      } else {
        mainWindow.show();
        resumeTracking();
        resumeInputMonitor();
      }
    }
  });
}

// ===== 窗口追踪 =====

function startWindowTracking() {
  let lastTitle = "";

  startTracking((event) => {
    if (!mainWindow || manualPosition) return;

    const { x, y } = event.petPosition;
    const isSwitch =
      event.type === "switch" &&
      !!event.activeWindow?.title &&
      event.activeWindow.title !== lastTitle;

    // 更新目标位置（连续平滑跟随，不会瞬移）
    updatePetTarget(x, y, isSwitch);

    // 推送窗口信息给渲染进程（含目标位置用于计算走路方向）
    mainWindow.webContents.send("window-info", {
      type: event.type,
      title: event.activeWindow?.title || "",
      owner: event.activeWindow?.owner || "",
      bounds: event.activeWindow?.bounds || null,
      petX: x,
      petY: y,
    });

    if (event.activeWindow?.title) {
      lastTitle = event.activeWindow.title;
    }
  });
}

// ===== 全局快捷键 =====

function registerShortcuts() {
  for (let i = 1; i <= 7; i++) {
    // 使用 Control+Shift（macOS 上 Command+Shift+3/4/5 被截图占用）
    const registered = globalShortcut.register(
      `Control+Shift+${i}`,
      () => {
        mainWindow?.webContents.send("shortcut", `${i}`);
      }
    );
    if (!registered) {
      console.warn(`[Shortcut] 注册失败: Control+Shift+${i}`);
    }
  }
  console.log("[Shortcut] 全局快捷键已注册: Ctrl+Shift+1~7");
}

// ===== 鼠标监控 =====

function startMouseMonitor() {
  if (!mainWindow) return;
  startInputMonitor(mainWindow, (e) => {
    if (!mainWindow) return;
    // 只在状态变化时推送，减少 IPC 噪音
    if (e.stateChanged) {
      mainWindow.webContents.send("mouse-state", {
        x: e.x,
        y: e.y,
        velocity: e.velocity,
        state: e.state,
      });
    }
  });
}

// ===== IPC =====

ipcMain.handle("get-active-window", async () => {
  try {
    const activeWin = await import("active-win");
    const win = await activeWin.default();
    if (!win) return null;
    return {
      title: win.title,
      owner: win.owner?.name || "",
      bounds: {
        x: win.bounds.x,
        y: win.bounds.y,
        width: win.bounds.width,
        height: win.bounds.height,
      },
    };
  } catch {
    return null;
  }
});

// 窗口拖动（带边界限制，防止跑出屏幕）
ipcMain.handle("move-window-by", (_event, dx: number, dy: number) => {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  let newX = x + Math.round(dx);
  let newY = y + Math.round(dy);

  // 拖动时停止自动跟随
  stopFollowLoop();
  targetX = null;
  targetY = null;

  // 限制在当前显示器的工作区内
  const display = screen.getDisplayNearestPoint({ x: newX, y: newY });
  const { workArea } = display;
  // 允许宠物至少露出 60px（不能完全拖出屏幕）
  newX = Math.max(workArea.x - PET_SIZE + 60, Math.min(newX, workArea.x + workArea.width - 60));
  newY = Math.max(workArea.y - PET_SIZE + 60, Math.min(newY, workArea.y + workArea.height - 60));

  mainWindow.setPosition(newX, newY);
  manualPosition = true; // 手动拖动 = 暂停追踪
});

// 拖动结束，延迟恢复追踪
ipcMain.handle("end-drag", () => {
  // 3s 后恢复窗口跟踪
  setTimeout(() => {
    manualPosition = false;
  }, 3_000);
});

ipcMain.handle("hide-pet", () => {
  mainWindow?.hide();
  pauseTracking();
  pauseInputMonitor();
});

ipcMain.handle("show-pet", () => {
  mainWindow?.show();
  resumeTracking();
  resumeInputMonitor();
});

ipcMain.handle("is-pet-visible", () => {
  return mainWindow?.isVisible() ?? false;
});

ipcMain.handle("set-manual-position", (_event, manual: boolean) => {
  manualPosition = manual;
});

// 走路步进：每 50ms 向指定方向移动（配合 walk 动画）
let walkStepping = false;
let walkDirection = 1; // 1=右, -1=左
let lastBounceTime = 0;  // 上次反弹时间戳，防连触发
const WALK_STEP = 3;
const BOUNCE_COOLDOWN = 800; // 反弹冷却 ms

ipcMain.handle("walk-step-start", (_event, dir: number) => {
  walkStepping = true;
  walkDirection = dir || 1;
  lastBounceTime = 0;
  stopFollowLoop();
});

ipcMain.handle("walk-step-stop", () => {
  walkStepping = false;
});

// 走路步进循环
setInterval(() => {
  if (!mainWindow || !walkStepping) return;
  const STEP = WALK_STEP * walkDirection;
  const [x, y] = mainWindow.getPosition();
  const display = screen.getDisplayNearestPoint({ x, y });
  const wa = display.workArea;
  const margin = 4;
  const rightEdge = wa.x + wa.width - PET_SIZE - margin;
  const leftEdge = wa.x + margin;

  // 窗口切换模式下：向 switchTargetX 走，到达附近时停止
  if (isWindowSwitch && switchTargetX !== null) {
    const toTarget = switchTargetX - x;
    if (Math.abs(toTarget) < 15) {
      walkStepping = false;
      isWindowSwitch = false;
      switchTargetX = null;
      targetX = x; targetY = y;
      mainWindow.webContents.send("transition", "arrive");
      return;
    }
    // 继续向目标走
    walkDirection = toTarget > 0 ? 1 : -1;
  }

  let nx = x + STEP;
  nx = clamp(nx, leftEdge, rightEdge);

  // 碰到边界 → 反向（带冷却防止边缘连触发）
  const atBoundary = (walkDirection > 0 && nx === rightEdge && x >= rightEdge) ||
                     (walkDirection < 0 && nx === leftEdge && x <= leftEdge);
  const now = Date.now();
  if (atBoundary && now - lastBounceTime > BOUNCE_COOLDOWN) {
    walkDirection = -walkDirection;
    lastBounceTime = now;
    mainWindow.webContents.send("walk-flip");
    nx = clamp(x + WALK_STEP * walkDirection, leftEdge, rightEdge);
  }

  if (nx !== x) {
    mainWindow.setPosition(nx, y);
    targetX = nx;
    targetY = y;
  }
}, 50);

// 受惊躲角落
ipcMain.handle("move-to-corner", async () => {
  if (!mainWindow) return;
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;

  // 找到离宠物最近的角落
  const [px, py] = mainWindow.getPosition();
  const corners = [
    { x: workArea.x + 10, y: workArea.y + 10 },                           // 左上
    { x: workArea.x + workArea.width - PET_SIZE - 10, y: workArea.y + 10 }, // 右上
    { x: workArea.x + 10, y: workArea.y + workArea.height - PET_SIZE - 10 }, // 左下
    { x: workArea.x + workArea.width - PET_SIZE - 10, y: workArea.y + workArea.height - PET_SIZE - 10 }, // 右下
  ];

  let nearest = corners[0];
  let minDist = Infinity;
  for (const c of corners) {
    const d = Math.hypot(c.x - px, c.y - py);
    if (d < minDist) { minDist = d; nearest = c; }
  }

  manualPosition = true;
  stopFollowLoop();
  updatePetTarget(nearest.x, nearest.y, false);

  // 5 秒后恢复追踪
  setTimeout(() => {
    manualPosition = false;
  }, 5000);
});

// ===== 生命周期 =====

app.whenReady().then(() => {
  createWindow();
  createTray();
  registerShortcuts();
  startWindowTracking();
  startMouseMonitor();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  stopTracking();
  stopInputMonitor();
  globalShortcut.unregisterAll();
});

app.on("before-quit", () => {
  tray?.destroy();
});
