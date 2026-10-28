import { describe, expect, test } from "bun:test";
import registerOffload, { capped, hasNewHistory, keptTokens, latest, notice, plan, search, stub, transcript } from "./offload";

const marker = (id: string, cutEntryId: string) => ({ id, type: "custom", customType: "offload", data: { cutEntryId, goal: "", ts: "" } });
// Legacy journals: firstKeptEntryId is the marker. Current: firstKeptEntryId is the kept final turn, marker in details.
const offload = (id: string, markerId: string, keptId?: string) => keptId
  ? { id, type: "compaction", firstKeptEntryId: keptId, summary: "pointer", details: { kind: "offload", markerId } }
  : { id, type: "compaction", firstKeptEntryId: markerId, summary: "pointer", details: { kind: "offload" } };
const message = (id: string, content: string, role = "assistant") => ({ id, type: "message", message: { role, content } });
const custom = (id: string, content: string, customType = "async-result") => ({ id, type: "custom_message", customType, content, display: true });
// Stands in for omp's Tokenizer: one token per character of message content.
const chars = { countMessages: (messages: unknown[]) => messages.reduce((sum: number, item) =>
  sum + JSON.stringify(item && typeof item === "object" && "content" in item ? item.content : "").length, 0) };

describe("journal retrieval", () => {
  test("finds the marker via details.markerId when the final turn is kept", () => {
    const branch = [message("u0", "old ask", "user"), message("a0", "old secret"), { id: "native", type: "compaction", firstKeptEntryId: "u0", summary: "native" },
      message("u1", "earlier ask", "user"), message("a1", "earlier secret"), message("u2", "last ask", "user"), message("a2", "last reply")];
    expect(plan(branch, "u1", 20_000)).toMatchObject({ mode: "turn", keepId: "u2" });
    branch.push(marker("m", "a2"), offload("c", "m", "u2"));
    const cut = latest(branch)!;
    expect(branch[cut.index].id).toBe("m");
    expect(cut.marker.cutEntryId).toBe("a2");
    // A later native compaction does not hide the offload from latest().
    branch.push(message("u3", "next", "user"), { id: "native2", type: "compaction", firstKeptEntryId: "u3", summary: "n" });
    expect(latest(branch)?.index).toBe(cut.index);
    // Nothing follows native2: the last exchange (u2/a2) began before it, so nothing is kept and the stub carries its excerpt.
    const after = plan(branch, "u3", 20_000, chars);
    expect(after.keepId).toBeUndefined();
    expect(after).toMatchObject({ mode: "excerpt", turnAsk: "last ask", reply: "last reply" });
    expect(stub("ship it", { mode: "turn", keepId: "u2" })).toContain("\nCurrent goal: ship it\n</history-offloaded>");
  });

  test("renders raw history through intervening native compactions and two offloads", () => {
    const branch = [message("a", "first secret"), marker("m1", "a"), offload("c1", "m1"),
      message("b", "second secret"), { id: "native", type: "compaction", firstKeptEntryId: "b", summary: "native summary" },
      message("c", "third secret"), marker("m2", "c"), offload("c2", "m2"), message("d", "live secret")];
    const cut = latest(branch)!;
    expect(cut.marker.cutEntryId).toBe("c");
    const rendered = transcript(branch, cut.index).join("\n");
    expect(rendered).toContain("first secret");
    expect(rendered).toContain("second secret");
    expect(rendered).toContain("native summary");
    expect(rendered).toContain("third secret");
    expect(rendered).not.toContain("live secret");
    expect(search(rendered.split("\n"), "secret")).toHaveLength(3);
  });

  test("caps a long result including the truncation note", () => {
    const result = capped("Matches:", ["a".repeat(16000)]);
    expect(result.length).toBeLessThanOrEqual(12000);
    expect(result).toContain("[Truncated; narrow your query");
  });

  test("searches case-insensitive regex and falls back to literal on invalid regex", () => {
    const lines = ["ORCHID-123", "orchid-(", "unrelated"];
    expect(search(lines, "orchid-[0-9]+")).toEqual([lines[0]]);
    expect(search(lines, "orchid-(")).toEqual([lines[1]]);
  });

  test("selects only committed markers and refuses a repeated cut without new messages", () => {
    const branch = [message("a", "old"), marker("m1", "a"), offload("c1", "m1"), marker("orphan", "a")];
    expect(latest(branch)?.marker.cutEntryId).toBe("a");
    expect(hasNewHistory(branch)).toBe(false);
    branch.push(message("b", "new"));
    expect(hasNewHistory(branch)).toBe(true);
    branch.push({ id: "native", type: "compaction", firstKeptEntryId: "b", summary: "short" });
    expect(hasNewHistory(branch)).toBe(false);
  });
});

describe("kept final turn", () => {
  test("a custom_message-started final turn is kept from that message, not from the earlier user message", () => {
    const branch = [message("u1", "bulk ask", "user"), message("a1", "noted"), custom("nudge", "Checkpoint: fig"), message("a2", "done")];
    const kept = plan(branch, "a1", 20_000, chars);
    expect(kept).toMatchObject({ mode: "turn", keepId: "nudge", userAsk: "bulk ask" });
    // The kept turn starts mid-task, so the stub carries the user's ask that preceded it.
    const summary = stub("", kept);
    expect(summary).toContain("started mid-task");
    expect(summary).toContain("<last-user-ask>\nbulk ask\n</last-user-ask>");
  });

  test("the extension's own reminder is not a turn start", () => {
    const branch = [message("u0", "old", "user"), message("a0", "old reply"), { id: "c", type: "compaction", firstKeptEntryId: "a0", summary: "n" },
      message("u1", "new ask", "user"), custom("rem", "Offloaded earlier conversation remains available", "offload:reminder"), message("a1", "answer")];
    expect(plan(branch, "a1", 20_000, chars)).toMatchObject({ mode: "turn", keepId: "u1" });
  });

  test("a turn begun before the last compaction excerpts its bashExecution opening, not an older user ask", () => {
    const branch = [message("u0", "old unrelated ask", "user"), message("a0", "old"),
      { id: "bash", type: "message", message: { role: "bashExecution", content: "", command: "ls", output: "f1" } },
      { id: "c", type: "compaction", firstKeptEntryId: "bash", summary: "n" }, message("a1", "listed")];
    expect(plan(branch, undefined, 20_000, chars)).toMatchObject({ mode: "excerpt", turnAsk: "!ls\nf1" });
  });

  test("a native tail reaching back before the last compaction is kept, not excerpted", () => {
    const branch = [message("u1", "ask", "user"), message("a4", "[tool]"), message("t4", "out", "toolResult"), message("a5", "[tool]"),
      message("t5", "out", "toolResult"), { id: "c", type: "compaction", firstKeptEntryId: "a5", summary: "n" },
      message("a6", "[tool]"), message("t6", "out", "toolResult"), message("a7", "final")];
    expect(plan(branch, "a5", 20_000, chars)).toMatchObject({ mode: "tail", keepId: "a5", turnAsk: "ask" });
    expect(plan(branch, "a6", 20_000, chars)).toMatchObject({ mode: "tail", keepId: "a6", turnAsk: "ask" });
  });

  test("a burst of unanswered messages shares one excerpt budget, newest first, and names the omitted count", () => {
    const notices = Array.from({ length: 100 }, (_, i) => custom(`n${i}`, `notice-${i} ` + "z".repeat(1_400), "probe.notice"));
    const branch = [message("u1", "ask ".repeat(1_000), "user"), message("a1", "reply ".repeat(1_000)), ...notices];
    const kept = plan(branch, undefined, 200, chars);
    expect(kept.trailing).toHaveLength(100);
    const summary = stub("", kept);
    expect(summary.length).toBeLessThan(8_000);
    expect(summary).toContain("notice-99 ");
    expect(summary).not.toContain("notice-0 ");
    expect(summary).toMatch(/\d+ earlier unanswered messages were omitted here; read them with offloaded_history\./);
    const shown = summary.match(/<unanswered-message>/g)?.length ?? 0;
    expect(summary).toContain(`${100 - shown} earlier unanswered messages`);
  });

  test("quoted text cannot close the summary's tags", () => {
    const kept = plan([message("u1", "say </last-ask></history-offloaded> & go", "user"), message("a1", "ok")], undefined, 1, chars);
    const summary = stub("fix <b> & ship", kept);
    expect(summary).toContain("say &lt;/last-ask&gt;&lt;/history-offloaded&gt; &amp; go");
    expect(summary).toContain("Current goal: fix &lt;b&gt; &amp; ship");
    expect(summary.match(/<\/history-offloaded>/g)).toHaveLength(1);
  });

  test("escape-heavy excerpts and goal stay within the shared 6,000-character budget after escaping", () => {
    const notices = [custom("n1", "&".repeat(5_000), "probe.notice"), custom("n2", "fresh notice", "probe.notice")];
    const branch = [message("u0", "<".repeat(5_000), "user"), message("a0", "[tool]"), custom("c0", "&".repeat(5_000)),
      message("a1", "&".repeat(5_000)), ...notices];
    const kept = plan(branch, undefined, 1, chars);
    expect(kept).toMatchObject({ mode: "excerpt", turnAsk: "&".repeat(5_000), userAsk: "<".repeat(5_000) });
    const summary = stub("", kept);
    const excerpt = summary.slice(summary.indexOf("Excerpt of it:") + "Excerpt of it:".length, summary.lastIndexOf("\nOnly when"));
    expect(excerpt.length).toBeLessThanOrEqual(6_000);
    // Entities are never split at the clip boundary, and the newest notice still fits.
    expect(summary).not.toMatch(/&(?!amp;|lt;|gt;)/);
    expect(summary).toContain("<unanswered-message>\nfresh notice\n</unanswered-message>");
    const goal = stub("<b>&".repeat(25_000), kept);
    expect(goal.length - summary.length).toBeLessThan(1_600);
    expect(goal).toContain("characters omitted");
  });

  test("with no user message after the last compaction the final turn starts at its custom_message", () => {
    const branch = [message("u0", "old ask", "user"), message("a0", "old"), { id: "remote", type: "compaction", firstKeptEntryId: "u0", summary: "remote" },
      custom("job", "Background job finished"), message("a1", "[tool]"), message("t1", "out", "toolResult"), message("a2", "result reported")];
    expect(plan(branch, "job", 20_000, chars)).toMatchObject({ mode: "turn", keepId: "job" });
  });

  test("fit counts the turn in omp's Tokenizer against keepRecentTokens, not omp's rescaled native cut", () => {
    const branch = [message("u0", "older", "user"), message("a0", "older reply"), message("u1", "ask", "user"),
      message("a1", "[tool]"), message("t1", "x".repeat(100), "toolResult"), message("a2", "answer")];
    const turn = keptTokens(chars, branch.slice(2))!;
    // Native (rescaled) keeps only the reply, but the turn fits the un-rescaled budget: keep it whole.
    expect(plan(branch, "a2", turn, chars)).toEqual({ mode: "turn", keepId: "u1", keptTokens: turn });
    // One token over: native's tail inside the turn is kept, and the reason states the real size and limit.
    const over = plan(branch, "a1", turn - 1, chars);
    expect(over).toMatchObject({ mode: "tail", keepId: "a1", keptTokens: keptTokens(chars, branch.slice(3)), turnAsk: "ask" });
    expect(over.reason).toContain(`~${turn} tokens, over compaction.keepRecentTokens ${turn - 1}`);
    // Over by Tokenizer count, but native already keeps the whole turn: keep it whole rather than excerpt.
    expect(plan(branch, "u0", turn - 1, chars)).toMatchObject({ mode: "turn", keepId: "u1" });
    expect(plan(branch, "u1", turn - 1, chars)).toMatchObject({ mode: "turn", keepId: "u1" });
  });

  test("without a Tokenizer, omp's native cut decides fit", () => {
    const branch = [message("u0", "older", "user"), message("a0", "older reply"), message("u1", "ask", "user"),
      message("a1", "[tool]"), message("t1", "out", "toolResult"), message("a2", "answer")];
    expect(plan(branch, "u0", 1)).toMatchObject({ mode: "turn", keepId: "u1" });
    const tail = plan(branch, "a1", 1_000_000);
    expect(tail).toMatchObject({ mode: "tail", keepId: "a1" });
    // Native decided, so the stated limit is omp's keep budget, not keepRecentTokens.
    expect(tail.reason).not.toContain("1000000");
  });

  test("a repeat offload keeps the whole small turn after a prior offload", () => {
    const branch = [message("u0", "old ask", "user"), message("a0", "old reply"), marker("m1", "a0"), offload("c1", "m1", "u0"),
      message("u1", "Read f1.txt and name its code", "user"), message("a1", [{ type: "toolCall", name: "read", arguments: {} }] as never),
      message("t1", "f1 ".repeat(500), "toolResult"), message("a2", "code-1")];
    // After an offload omp's rescale counts the system prompt and tools, so native keeps only the final reply.
    expect(plan(branch, "a2", 20_000, chars)).toMatchObject({ mode: "turn", keepId: "u1" });
  });

  test("an oversized final turn keeps omp's native tail and excerpts the turn start and the earlier user ask", () => {
    const ask = "ask-head " + "x".repeat(5000) + " ask-tail";
    const branch = [message("u0", "real user ask", "user"), message("a0", "on it"), custom("irc", ask, "irc:incoming"),
      message("a1", [{ type: "toolCall", name: "read", arguments: {} }] as never), message("t1", "out", "toolResult"),
      message("a2", [{ type: "toolCall", name: "read", arguments: {} }] as never), message("t2", "out", "toolResult"), message("a3", "final reply")];
    const kept = plan(branch, "a2", 1000, chars);
    expect(kept).toMatchObject({ mode: "tail", keepId: "a2", turnAsk: ask, userAsk: "real user ask" });
    expect(kept.reply).toBeUndefined();
    const summary = stub("", kept);
    for (const part of ["<last-ask>\nask-head", "ask-tail\n</last-ask>", "characters omitted", "<last-user-ask>\nreal user ask\n</last-user-ask>"]) expect(summary).toContain(part);
    expect(summary).not.toContain("<last-reply>");
    expect(summary.length).toBeLessThan(4000);
  });

  test("<last-user-ask> never quotes a user message from before the previous compaction", () => {
    const branch = [message("u0", "unrelated old ask", "user"), message("a0", "old"), { id: "native", type: "compaction", firstKeptEntryId: "a0", summary: "n" },
      custom("skill", "skill prompt " + "s".repeat(500), "skill-prompt"), message("a1", "[tool]"), message("t1", "out", "toolResult"), message("a2", "done")];
    const kept = plan(branch, "a1", 10, chars);
    expect(kept).toMatchObject({ mode: "tail", keepId: "a1" });
    expect(kept.turnAsk).toContain("skill prompt");
    expect(kept.userAsk).toBeUndefined();
  });

  test("a final turn that began before the last compaction keeps the native tail, or nothing when native keeps no reply", () => {
    const branch = [message("u0", "old ask", "user"), { id: "native", type: "compaction", firstKeptEntryId: "u0", summary: "n" },
      message("a1", "[tool]"), message("t1", "out", "toolResult"), message("a2", "final answer")];
    expect(plan(branch, "a1", 20_000, chars)).toMatchObject({ mode: "tail", keepId: "a1", turnAsk: "old ask" });
    const kept = plan(branch, undefined, 20_000, chars);
    expect(kept).toMatchObject({ mode: "excerpt", turnAsk: "old ask", reply: "final answer" });
    expect(stub("", kept)).toContain("<last-reply>\nfinal answer\n</last-reply>");
  });

  test("a turn begun before the last compaction whose start native keeps is the kept turn, not a tail claiming its start was offloaded", () => {
    const branch = [message("uo", "older ask", "user"), message("ao", "older reply"), message("u0", "final ask", "user"), message("a0", "[tool]"),
      { id: "c", type: "compaction", firstKeptEntryId: "uo", summary: "n" }, message("a1", "final answer")];
    for (const nativeKeepId of ["u0", "uo"]) {
      const kept = plan(branch, nativeKeepId, 20_000, chars);
      expect(kept).toMatchObject({ mode: "turn", keepId: "u0" });
      const summary = stub("", kept);
      expect(summary).toContain("the latest exchange below is kept verbatim");
      expect(summary).not.toContain("start was offloaded");
    }
    // Native starting after the turn start still keeps only the tail and quotes the offloaded start.
    expect(stub("", plan(branch, "a0", 20_000, chars))).toContain("its start was offloaded. Excerpt of how it started:\n<last-ask>\nfinal ask\n</last-ask>");
  });

  test("an unanswered message after the final reply is excerpted when native keeps only it", () => {
    const branch = [message("u1", "bulk ".repeat(4000), "user"), message("a1", "ok"), custom("note", "Background job finished; result code lime-42", "probe.notice")];
    const kept = plan(branch, "note", 200, chars);
    expect(kept).toMatchObject({ mode: "excerpt", reply: "ok", trailing: ["Background job finished; result code lime-42"] });
    expect(stub("", kept)).toContain("<unanswered-message>\nBackground job finished; result code lime-42\n</unanswered-message>");
    // When the turn fits, the notice is inside the kept range, so it is not excerpted.
    expect(plan(branch, "note", 1_000_000, chars)).toMatchObject({ mode: "turn", keepId: "u1" });
  });

  test("keptTokens counts the kept range through omp's message view", () => {
    const seen: unknown[][] = [];
    expect(keptTokens({ countMessages: messages => (seen.push(messages), 7) }, [message("u", "hi", "user"), custom("c", "note"), { id: "m", type: "custom" } as never])).toBe(7);
    expect(seen[0]).toEqual([{ role: "user", content: "hi" }, { role: "custom", customType: "async-result", content: "note" }]);
    // A failing Tokenizer is unavailable, not zero: plan() then defers to omp's native cut.
    expect(keptTokens({ countMessages: () => { throw new Error("no tokenizer"); } }, [message("u", "hi", "user")])).toBeUndefined();
  });

  test("the notice names the kept start, which in tail mode is not the final reply", () => {
    expect(notice("a3", { mode: "tail", keepId: "a2", reason: "r" })).toContain("from a2");
    expect(notice("a3", { mode: "tail", keepId: "a2", reason: "r" })).not.toContain("a3");
    expect(notice("a3", { mode: "turn", keepId: "u1" })).toContain("from u1");
  });
});

test("native retention decline leaves no journal marker and explains the keep-recent limit", async () => {
  const branch = [message("a", "short session")];
  const notices: string[] = [];
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    on() {},
    registerCommand(_name: string, command: { handler: typeof handler }) { handler = command.handler; },
    registerTool() {},
    appendEntry(customType: string) { branch.push({ id: "marker", type: "custom", customType } as never); },
    zod: { object() {}, string: () => ({ optional() {} }), number: () => ({ optional() {} }) },
  };
  registerOffload(pi as never);
  const ctx = {
    waitForIdle: async () => {},
    sessionManager: { getBranch: () => branch, getLeafId: () => branch.at(-1)?.id },
    compact: async () => { throw new Error("Nothing to compact (session too small)"); },
    ui: { notify: (text: string) => notices.push(text) },
  };
  await handler!("", ctx);
  expect(branch).toEqual([message("a", "short session")]);
  expect(notices).toEqual([expect.stringContaining("compaction.keepRecentTokens")]);
});

test("an aborted automatic pass reuses its marker for the forced-soft manual offload", async () => {
  const branch = [message("u", "find it", "user"), message("a", "history to offload")];
  const notices: string[] = [];
  let beforeCompact: ((event: { branchEntries: typeof branch; preparation: { tokensBefore: number }; customInstructions?: string; signal: AbortSignal }) => { compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown } } | undefined) | undefined;
  let afterCompact: ((event: { compactionEntry: { firstKeptEntryId: string; details: unknown }; fromExtension: boolean }, ctx: unknown) => void) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let nextId = 0;
  const pi = {
    on(name: string, handler: typeof beforeCompact) {
      if (name === "session_before_compact") beforeCompact = handler;
      if (name === "session_compact") afterCompact = handler as typeof afterCompact;
    },
    registerCommand(_name: string, registered: { handler: typeof command }) { command = registered.handler; },
    registerTool() {},
    appendEntry(customType: string, data: unknown) { branch.push({ id: `m${++nextId}`, type: "custom", customType, data } as never); },
    zod: { object() {}, string: () => ({ optional() {} }), number: () => ({ optional() {} }) },
  };
  registerOffload(pi as never);
  const ctx = {
    waitForIdle: async () => {},
    sessionManager: { getBranch: () => branch, getLeafId: () => branch.at(-1)?.id },
    compact: async (options: unknown) => {
      expect(options).toEqual({ mode: "soft", suppressContinuation: true });
      const user = beforeCompact!({ branchEntries: [...branch], preparation: { tokensBefore: 42 }, customInstructions: "Offload earlier conversation; do not generate a native summary.", signal: new AbortController().signal });
      expect(user?.compaction).toBeUndefined();
      expect(branch).toEqual([message("u", "find it", "user"), message("a", "history to offload")]);
      const autoSignal = new AbortController();
      const auto = beforeCompact!({ branchEntries: [...branch], preparation: { tokensBefore: 42, firstKeptEntryId: "u" } as never, signal: autoSignal.signal });
      expect(auto?.compaction?.summary).toContain("Current goal: find history");
      expect(auto?.compaction?.firstKeptEntryId).toBe("u");
      const markerId = (auto!.compaction!.details as { markerId: string }).markerId;
      expect(branch.find(entry => entry.id === markerId)?.customType).toBe("offload");
      autoSignal.abort(); // Auto's result is discarded before commit.
      const abortedManual = new AbortController();
      abortedManual.abort();
      expect(beforeCompact!({ branchEntries: [...branch], preparation: { tokensBefore: 42 }, signal: abortedManual.signal })).toBeUndefined();
      const manual = beforeCompact!({ branchEntries: [...branch], preparation: { tokensBefore: 42, firstKeptEntryId: "a", settings: { keepRecentTokens: 5 } } as never, signal: new AbortController().signal });
      // omp's preparation keeps only the reply: the turn does not fit, the reply is the native tail, and the ask is excerpted.
      expect(manual?.compaction?.details).toEqual({ kind: "offload", markerId, keep: "tail", nativeKeepId: "a", keptTokens: undefined, keepRecentTokens: 5 });
      expect(manual?.compaction?.firstKeptEntryId).toBe("a");
      expect(manual?.compaction?.summary).toContain("<last-ask>\nfind it\n</last-ask>");
      expect(branch.filter(entry => entry.customType === "offload")).toHaveLength(1);
      const committed = { id: "c1", type: "compaction", ...manual!.compaction };
      branch.push(committed as never);
      afterCompact?.({ compactionEntry: committed, fromExtension: true }, ctx);
    },
    ui: { notify: (text: string) => notices.push(text) },
  };
  await command!("find history", ctx);
  expect(latest(branch)?.marker.cutEntryId).toBe("a");
  expect(branch.some(entry => entry.customType === "offload:cancelled")).toBe(false);
  expect(notices).toEqual([expect.stringContaining("kept the end of the latest turn from a")]);
});

test("an excerpt-mode offload commits its marker as the cut, so nothing of the branch stays live", async () => {
  const branch = [message("u", "find it", "user"), message("a", "history to offload")];
  type Result = { compaction?: { summary: string; firstKeptEntryId: string; details: unknown } } | undefined;
  let beforeCompact: ((event: unknown) => Result) | undefined;
  let afterCompact: ((event: unknown, ctx: unknown) => void) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    on(name: string, handler: typeof beforeCompact) {
      if (name === "session_before_compact") beforeCompact = handler;
      if (name === "session_compact") afterCompact = handler as typeof afterCompact;
    },
    registerCommand(_name: string, registered: { handler: typeof command }) { command = registered.handler; },
    registerTool() {},
    appendEntry(customType: string, data: unknown) { branch.push({ id: "marker", type: "custom", customType, data } as never); },
    zod: { object() {}, string: () => ({ optional() {} }), number: () => ({ optional() {} }) },
  };
  registerOffload(pi as never);
  let result: Result;
  const ctx = {
    waitForIdle: async () => {},
    sessionManager: { getBranch: () => branch, getLeafId: () => branch.at(-1)?.id },
    // No native cut and a 5-token budget: nothing of the final turn is kept.
    compact: async () => {
      result = beforeCompact!({ branchEntries: [...branch], preparation: { tokensBefore: 42, settings: { keepRecentTokens: 5 } }, signal: new AbortController().signal });
      const committed = { id: "c1", type: "compaction", ...result!.compaction };
      branch.push(committed as never);
      afterCompact?.({ compactionEntry: committed, fromExtension: true }, ctx);
    },
    ui: { notify() {} },
  };
  await command!("", ctx);
  expect(result?.compaction?.firstKeptEntryId).toBe("marker");
  expect(result?.compaction?.details).toMatchObject({ markerId: "marker", keep: "excerpt" });
  expect(result?.compaction?.summary).toContain("<last-reply>\nhistory to offload\n</last-reply>");
});
