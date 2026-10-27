import { setTimeout } from "node:timers/promises";

import { os } from "@orpc/server";
import { z } from "zod";

export function createProbeRouter() {
  let active = 0;
  let cancelled = 0;
  return {
    echo: os.input(z.string().max(256 * 1024)).handler(({ input }) => input),
    events: os.input(z.number().int().min(1).max(100)).handler(async function* ({ input, signal }) {
      active++;
      let sent = 0;
      try {
        for (; sent < input; sent++) {
          yield sent;
          await setTimeout(20, undefined, { signal });
        }
      } finally {
        active--;
        if (sent < input) cancelled++;
      }
    }),
    stats: os.handler(() => ({ active, cancelled })),
  };
}
export type ProbeRouter = ReturnType<typeof createProbeRouter>;
