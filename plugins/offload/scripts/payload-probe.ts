import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

let payloadIndex = 0;

export default function payloadProbe(pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload;
    const messages = payload && typeof payload === "object" && "messages" in payload && Array.isArray(payload.messages)
      ? payload.messages : payload && typeof payload === "object" && "input" in payload && Array.isArray(payload.input)
      ? payload.input : [];
    const serialized = JSON.stringify(messages);
    // Full messages go to a scratch file so the smoke can check roles and verbatim text.
    const dump = process.env.OFFLOAD_PROBE_DIR ? `${process.env.OFFLOAD_PROBE_DIR}/payload-${process.pid}-${++payloadIndex}.json` : undefined;
    if (dump) writeFileSync(dump, serialized);
    const probe = { count: messages.length, bytes: Buffer.byteLength(serialized), dump,
      containsSentinel: !!process.env.OFFLOAD_SENTINEL && serialized.includes(process.env.OFFLOAD_SENTINEL),
      containsPointer: serialized.includes("Earlier conversation was offloaded") };
    if (ctx.mode === "rpc") ctx.ui.notify(`offload payload ${JSON.stringify(probe)}`, "info");
  });

  // Smoke-only: renders the transcript context the TUI builds in renderInitialMessages (omp 18.2.11) for both
  // display.collapseCompacted values, so the smoke can check what shows above the compaction divider.
  pi.registerCommand("display-probe", {
    description: "Smoke-only: dump the display transcript for both collapseCompacted values",
    handler: async (_args, ctx) => {
      if (!process.env.OFFLOAD_PROBE_DIR) throw new Error("display-probe needs OFFLOAD_PROBE_DIR");
      const manager = ctx.sessionManager as unknown as { buildSessionContext(options: object): { messages: unknown[] } };
      const result: Record<string, unknown[]> = {};
      for (const collapse of [true, false]) {
        result[String(collapse)] = manager.buildSessionContext({ transcript: true, collapseCompactedHistory: collapse }).messages;
      }
      const dump = `${process.env.OFFLOAD_PROBE_DIR}/display-${process.pid}.json`;
      writeFileSync(dump, JSON.stringify(result));
      ctx.ui.notify(`offload display ${dump}`, "info");
    },
  });
}
