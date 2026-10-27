import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { RouterClient } from "@orpc/server";
import { Electroview } from "electrobun/view";

import { NativeMessagePort } from "../../src/shared/native-bridge";
import type { ProbeRouter } from "./router";
import type { ProbeBridge } from "./shared";
import { verify } from "./verify";

const port = new NativeMessagePort((packet) => rpc.send.orpc(packet));
const rpc = Electroview.defineRPC<ProbeBridge>({
  handlers: { requests: {}, messages: { orpc: (packet) => port.receive(packet) } },
});
new Electroview({ rpc });
const client = createORPCClient<RouterClient<ProbeRouter>>(new RPCLink({ port }));
document.body.textContent = "正在验证 Bun P2P RPC…";
try {
  const checks = await verify(client);
  document.body.textContent = checks.join("\n");
  await rpc.request.report({ checks });
} catch (error) {
  document.body.textContent = String(error);
  await rpc.request.report({ checks: [], error: String(error) });
}
