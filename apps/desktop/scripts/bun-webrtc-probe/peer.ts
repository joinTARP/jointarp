import { RTCPeerConnection, type RTCDataChannel } from "werift";

export function createPeer(stun = false) {
  return new RTCPeerConnection({
    iceServers: stun ? [{ urls: process.env.TARP_WEBRTC_STUN ?? "stun:stun.miwifi.com:3478" }] : [],
    iceUseIpv6: false,
    iceUseTcp: false,
    iceStunGatherTimeout: 4,
  });
}
export async function waitOpen(channel: RTCDataChannel) {
  const until = Date.now() + 15_000;
  while (channel.readyState !== "open") {
    if (channel.readyState === "closed" || Date.now() > until) throw Error("数据通道未能打开");
    await Bun.sleep(20);
  }
}
export function summary(peer: RTCPeerConnection) {
  const pairs = peer.iceTransports.map((transport) => {
    const pair = transport.getSelectedCandidatePair();
    return pair
      ? {
          localType: candidateType(pair.local.candidate),
          remoteType: candidateType(pair.remote.candidate),
          protocol: pair.local.candidate
            .replace(/^candidate:/, "")
            .trim()
            .split(/\s+/)[2]
            .toLowerCase(),
        }
      : null;
  });
  return {
    state: peer.connectionState,
    ice: peer.iceConnectionState,
    candidates: peer.iceTransports.flatMap((transport) =>
      transport.localCandidates.map((c) => c.type),
    ),
    pairs,
  };
}

function candidateType(candidate: string) {
  const fields = candidate.trim().split(/\s+/);
  const index = fields.indexOf("typ");
  if (index < 0 || !["host", "srflx", "prflx", "relay"].includes(fields[index + 1]))
    throw Error("不能识别选中的 ICE 候选类型");
  return fields[index + 1];
}
