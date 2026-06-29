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

type Unsubscriber = () => void;

interface PetAPI {
  getActiveWindow(): Promise<ActiveWindowInfo | null>;
  hidePet(): Promise<void>;
  showPet(): Promise<void>;
  isPetVisible(): Promise<boolean>;
  onShortcut(callback: (key: string) => void): Unsubscriber;
  onWindowInfo(callback: (info: WindowChangeInfo) => void): Unsubscriber;
  onTransition(callback: (phase: string) => void): Unsubscriber;
  onMouseState(callback: (e: MouseStateEvent) => void): Unsubscriber;
  setManualPosition(manual: boolean): Promise<void>;
  moveToCorner(): Promise<void>;
  walkStepStart(dir: number): Promise<void>;
  walkStepStop(): Promise<void>;
  onWalkFlip(callback: () => void): Unsubscriber;
  moveWindowBy(dx: number, dy: number): Promise<void>;
  endDrag(): Promise<void>;
}

interface Window {
  petAPI: PetAPI;
}
