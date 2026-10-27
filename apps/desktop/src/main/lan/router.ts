import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { desktopProcedure } from "../desktop-rpc-context";
import type { DesktopRpcContext } from "../desktop-rpc-context";

const procedure = desktopProcedure.use(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    throw new ORPCError("PRECONDITION_FAILED", {
      message: error instanceof Error ? error.message : "内网操作失败",
    });
  }
});
const room = z.object({ roomId: z.string().uuid() });
function service(context: DesktopRpcContext) {
  if (!context.lan) throw new Error("内网联机尚未初始化");
  return context.lan;
}
export const lanRouter = {
  onlineHost: procedure
    .input(room)
    .handler(({ context, input }) => service(context).online.host(input.roomId)),
  onlineJoin: procedure
    .input(z.object({ code: z.string().regex(/^\d{6}$/) }))
    .handler(({ context, input, signal }) => service(context).online.join(input.code, signal)),
  cancelOnlineJoin: procedure
    .input(z.object({ code: z.string().regex(/^\d{6}$/) }))
    .handler(({ context, input }) => service(context).online.cancelJoin(input.code)),
  status: procedure
    .input(room)
    .handler(({ context, input }) => service(context).status(input.roomId)),
  host: procedure.input(room).handler(({ context, input }) => service(context).host(input.roomId)),
  stop: procedure.input(room).handler(({ context, input }) => service(context).stop(input.roomId)),
  join: procedure
    .input(z.object({ address: z.string().max(80) }))
    .handler(({ context, input, signal }) => service(context).join(input.address, signal)),
  decide: procedure
    .input(room.extend({ id: z.string(), approve: z.boolean() }))
    .handler(({ context, input }) =>
      service(context).decide(input.roomId, input.id, input.approve),
    ),
};
