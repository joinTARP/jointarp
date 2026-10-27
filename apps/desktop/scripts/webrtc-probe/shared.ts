import type { BridgePacket } from "../../src/shared/native-bridge";
export type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
export type ProbeResult = {
  scope: string;
  origin: string;
  secure: boolean;
  peer: string;
  checks: string[];
  error?: string;
  stage?: string;
  binaryMs?: number;
  state?: string;
  pairs?: { state: string; nominated: boolean; localType?: string; remoteType?: string }[];
};
export type ProbeBridge = {
  bun: {
    requests: {
      config: { params: undefined; response: { iceServers: { urls: string }[]; mode: string } };
      ready: { params: undefined; response: number };
      report: { params: ProbeResult; response: boolean };
    };
    messages: { signal: Signal; orpc: BridgePacket; log: Record<string, string> };
  };
  webview: { requests: {}; messages: { start: {}; signal: Signal; orpc: BridgePacket } };
};
