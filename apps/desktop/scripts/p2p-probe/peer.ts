import { noise, pureJsCrypto } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { tcp } from "@libp2p/tcp";
import { multiaddr } from "@multiformats/multiaddr";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { RouterClient } from "@orpc/server";
import { createLibp2p } from "libp2p";

import type { ProbeRouter } from "./router";
import { StreamPort } from "./stream-port";

export const protocol = "/tarp-probe/rpc/1";
export function createPeer(listen: string[] = [], expectedPeer?: string) {
  return createLibp2p({
    addresses: { listen },
    transports: [tcp()],
    // Bun 的默认原生 ChaCha20 大帧路径不可用，使用 Noise 提供的纯 JS 实现。
    connectionEncrypters: [noise({ crypto: pureJsCrypto })],
    streamMuxers: [yamux()],
    services: { identify: identify() },
    connectionGater: {
      denyInboundEncryptedConnection: (peer) =>
        expectedPeer !== undefined && peer.toString() !== expectedPeer,
    },
  });
}
export async function connect(peer: Awaited<ReturnType<typeof createPeer>>, address: string) {
  const stream = await peer.dialProtocol(multiaddr(address), protocol, {
    signal: AbortSignal.timeout(10_000),
  });
  const port = new StreamPort(stream);
  const link = new RPCLink({ port });
  return { port, link, client: createORPCClient<RouterClient<ProbeRouter>>(link) };
}
