export type OnlineStage =
  | "service"
  | "coordinator"
  | "ice"
  | "waiting"
  | "signaling"
  | "connecting"
  | "channels"
  | "authenticating"
  | "approval"
  | "connected";

export type OnlineProgress = { stage: OnlineStage; startedAt: number; detail?: string };
