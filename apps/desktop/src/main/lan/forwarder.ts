import { ORPCError } from "@orpc/server";
import type { RPCHandlerOptions } from "@orpc/server/message-port";

import type { DesktopRpcContext } from "../desktop-rpc-context";
import { assertLanAccess } from "./service";

export const lanForwarder: NonNullable<
  RPCHandlerOptions<DesktopRpcContext>["clientInterceptors"]
>[number] = ({ context, path, input, signal, lastEventId, next }) => {
  if (path[0] === "lan" || path[0] === "windows") return next();
  const roomId =
    input && typeof input === "object"
      ? "roomId" in input
        ? input.roomId
        : "id" in input
          ? input.id
          : undefined
      : undefined;
  const remote = typeof roomId === "string" ? context.lan?.remote(roomId) : undefined;
  if (!remote || typeof roomId !== "string") return next();
  if (remote.closed)
    throw new ORPCError("PRECONDITION_FAILED", { message: "房间连接已断开，请重新加入" });
  try {
    assertLanAccess(path, input, roomId);
  } catch {
    throw new ORPCError("FORBIDDEN", { message: "此操作仅限房主使用" });
  }
  if (path.join(".") === "sessions.module.resources")
    return context.lan!.moduleResources(roomId, signal);
  return remote.link.call(path, input, { context: {}, signal, lastEventId });
};
