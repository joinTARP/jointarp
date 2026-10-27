export type DesktopAction =
  | "minimize"
  | "maximize"
  | "close"
  | "quit"
  | "settings"
  | "reset-zoom"
  | "zoom-in"
  | "zoom-out"
  | "full-screen"
  | "reload"
  | "devtools"
  | "window-state";

export interface DesktopEvents {
  windowAction(action: DesktopAction): Promise<boolean>;
  claimStartupAnimation(): Promise<boolean>;
  setGamePage(active: boolean): void;
  onRequestLeaveRoom(listener: () => void): () => void;
  onOpenSettings(listener: () => void): () => void;
}
