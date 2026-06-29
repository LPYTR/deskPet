import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("petAPI", {
  // 前台窗口
  getActiveWindow: (): Promise<ActiveWindowInfo | null> =>
    ipcRenderer.invoke("get-active-window"),

  // 显示/隐藏
  hidePet: (): Promise<void> => ipcRenderer.invoke("hide-pet"),
  showPet: (): Promise<void> => ipcRenderer.invoke("show-pet"),
  isPetVisible: (): Promise<boolean> => ipcRenderer.invoke("is-pet-visible"),

  // 全局快捷键
  onShortcut: (callback: (key: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, key: string) =>
      callback(key);
    ipcRenderer.on("shortcut", handler);
    return () => ipcRenderer.removeListener("shortcut", handler);
  },

  // 窗口信息推送
  onWindowInfo: (callback: (info: WindowChangeInfo) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      info: WindowChangeInfo
    ) => callback(info);
    ipcRenderer.on("window-info", handler);
    return () => ipcRenderer.removeListener("window-info", handler);
  },

  // 过渡事件
  onTransition: (callback: (phase: string) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      phase: string
    ) => callback(phase);
    ipcRenderer.on("transition", handler);
    return () => ipcRenderer.removeListener("transition", handler);
  },

  // 鼠标状态推送（仅状态变化时）
  onMouseState: (callback: (e: MouseStateEvent) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      e: MouseStateEvent
    ) => callback(e);
    ipcRenderer.on("mouse-state", handler);
    return () => ipcRenderer.removeListener("mouse-state", handler);
  },

  // 手动位置
  setManualPosition: (manual: boolean): Promise<void> =>
    ipcRenderer.invoke("set-manual-position", manual),

  // 窗口拖动
  moveWindowBy: (dx: number, dy: number): Promise<void> =>
    ipcRenderer.invoke("move-window-by", dx, dy),
  endDrag: (): Promise<void> =>
    ipcRenderer.invoke("end-drag"),

  // 受惊躲角落
  moveToCorner: (): Promise<void> =>
    ipcRenderer.invoke("move-to-corner"),

  // 走路步进：dir=1 向右, dir=-1 向左
  walkStepStart: (dir: number): Promise<void> =>
    ipcRenderer.invoke("walk-step-start", dir),
  walkStepStop: (): Promise<void> =>
    ipcRenderer.invoke("walk-step-stop"),

  // 走到屏幕边界时主进程通知渲染进程翻转
  onWalkFlip: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("walk-flip", handler);
    return () => ipcRenderer.removeListener("walk-flip", handler);
  },
});

// ===== 类型 =====

interface ActiveWindowInfo {
  title: string;
  owner: string;
  bounds: { x: number; y: number; width: number; height: number };
}

interface WindowChangeInfo {
  type: "move" | "switch" | "minimize" | "desktop";
  title: string;
  owner: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
}

interface MouseStateEvent {
  x: number;
  y: number;
  velocity: number;
  state: "idle" | "hover" | "dragging" | "idle_long";
}
