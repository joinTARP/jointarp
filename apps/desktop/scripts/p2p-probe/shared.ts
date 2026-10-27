import type { BridgePacket } from "../../src/shared/native-bridge";
export type ProbeResult = { checks: string[]; error?: string };
export type ProbeBridge = {
  bun: {
    requests: { report: { params: ProbeResult; response: boolean } };
    messages: { orpc: BridgePacket };
  };
  webview: { requests: {}; messages: { orpc: BridgePacket } };
};
