import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const MARKER = "offload";
type Marker = { cutEntryId: string; goal: string; ts: string };
type Block = { type: string; text?: string; name?: string; arguments?: unknown };
type Message = { role: string; content: string | Block[]; toolCallId?: string; toolName?: string; command?: string; output?: string };
type Entry = { id: string; type: string; customType?: string; data?: Marker; message?: Message; content?: unknown; summary?: string; firstKeptEntryId?: string; details?: unknown };
const HISTORY_BUDGET = 12_000;
/** omp 18.2.11 `compaction.keepRecentTokens` default; the hook reads the effective value from `preparation.settings`. */
const DEFAULT_KEEP_TOKENS = 20_000;
/** Escaped size of each quoted excerpt (and the goal), excluding the omitted-characters line. */
const EXCERPT_CHARS = 1_500;
/** Shared budget for all excerpt tags in one summary, measured after escaping: four full-size clips. */
const SUMMARY_EXCERPT_CHARS = 4 * EXCERPT_CHARS;
const RETRIEVE = "Only when the current request depends on earlier work, use offloaded_history to search or read the raw journal; otherwise answer without retrieving it.";
/**
 * What the offload keeps of the final turn: the whole turn (`turn`), omp's native tail inside it
 * (`tail`, plus an excerpt of the turn's start), or nothing plus an excerpt (`excerpt`).
 * `keptTokens` is the kept range in omp's Tokenizer; absent when the Tokenizer is unavailable.
 */
export type Plan = { mode: "turn" | "tail" | "excerpt"; keepId?: string; keptTokens?: number; reason?: string; turnAsk?: string; userAsk?: string; reply?: string; trailing?: string[] };
/** Quoted journal text must not open or close the summary's own tags. */
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/**
 * Escaped head-and-tail clip whose escaped text is at most EXCERPT_CHARS. Raw slices are escaped, so an entity is
 * never split, and escape growth (`&` to 5 characters, `<`/`>` to 4) cannot push a tag past its share of the budget.
 */
function quote(value: string): string {
  const escaped = escape(value);
  if (escaped.length <= EXCERPT_CHARS) return escaped;
  // Keeping one more raw character grows the escaped text, so the largest fitting raw count is found by bisection.
  let lo = 0;
  let hi = Math.min(value.length - 1, EXCERPT_CHARS);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const size = escape(value.slice(0, Math.floor(mid / 2))).length + escape(value.slice(value.length - Math.ceil(mid / 2))).length;
    if (size <= EXCERPT_CHARS) lo = mid;
    else hi = mid - 1;
  }
  return `${escape(value.slice(0, Math.floor(lo / 2)))}\n[… ${value.length - lo} characters omitted …]\n${escape(value.slice(value.length - Math.ceil(lo / 2)))}`;
}
const tag = (name: string, value?: string) => value ? `\n<${name}>\n${quote(value)}\n</${name}>` : "";
/** Unanswered notices, newest first, while they fit the summary's remaining excerpt budget; names how many older ones were left out. */
function unanswered(trailing: string[], used: number): string {
  const kept: string[] = [];
  let left = SUMMARY_EXCERPT_CHARS - used;
  for (let i = trailing.length - 1; i >= 0; i--) {
    const body = `\nArrived after the last reply and not yet answered:${tag("unanswered-message", trailing[i])}`;
    if (body.length > left) break;
    kept.unshift(body);
    left -= body.length;
  }
  const omitted = trailing.length - kept.length;
  return (omitted ? `\n${omitted} earlier unanswered message${omitted === 1 ? " was" : "s were"} omitted here; read them with ${TOOL}.` : "") + kept.join("");
}
export function stub(goal: string, plan?: Plan): string {
  let body: string;
  const asks = plan ? tag("last-ask", plan.turnAsk) + tag("last-user-ask", plan.userAsk) : "";
  if (plan?.mode === "turn") {
    body = "Earlier conversation was offloaded; the latest exchange below is kept verbatim."
      + (asks ? ` That turn started mid-task, not with a user message; the user's last ask before it was offloaded:${asks}\n` : " ") + RETRIEVE;
  } else if (plan?.mode === "tail") {
    body = `Earlier conversation was offloaded. The latest turn is only partially kept (${plan.reason}): the messages below are its final steps through the last reply, as far back as omp's keep budget allows, and its start was offloaded.`
      + `${asks ? ` Excerpt of how it started:${asks}` : ""}\n${RETRIEVE}`;
  } else if (plan && (asks || plan.reply || plan.trailing?.length)) {
    // At most three tags of EXCERPT_CHARS escaped each, so the unanswered messages always keep a share of the budget.
    const excerpt = asks + tag("last-reply", plan.reply);
    body = `Earlier conversation was offloaded, including the latest exchange, which is not kept verbatim (${plan.reason}). Excerpt of it:`
      + excerpt + unanswered(plan.trailing ?? [], excerpt.length) + `\n${RETRIEVE}`;
  } else body = `Earlier conversation was offloaded. ${RETRIEVE}`;
  return `<history-offloaded>\n${body}${goal ? `\nCurrent goal: ${quote(goal)}` : ""}\n</history-offloaded>`;
}

const TRUNCATED = "\n[Truncated; narrow your query with a pattern or smaller line range.]";
const REMINDER_TYPE = `${MARKER}:reminder`;
const TOOL = "offloaded_history";
const isOffloadDetails = (details: unknown) => !!details && typeof details === "object" && "kind" in details && details.kind === MARKER;
const isReminder = (entry: Entry) => entry.type === "custom_message" && entry.customType === REMINDER_TYPE;
const markerIdOf = (details: unknown) => isOffloadDetails(details) && typeof (details as { markerId?: unknown }).markerId === "string" ? (details as { markerId: string }).markerId : undefined;
export function capped(header: string, lines: string[]): string {
  let result = header.slice(0, HISTORY_BUDGET - TRUNCATED.length);
  for (const line of lines) {
    if (result.length + line.length + 1 > HISTORY_BUDGET) {
      return result + `\n${line.slice(0, Math.max(0, HISTORY_BUDGET - result.length - TRUNCATED.length - 1))}` + TRUNCATED;
    }
    result += `\n${line}`;
  }
  return result;
}

export function latest(branch: Entry[]) {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "compaction" || !isOffloadDetails(entry.details)) continue;
    // Older journals used the marker itself as firstKeptEntryId.
    const markerIndex = branch.findIndex(candidate => candidate.id === (markerIdOf(entry.details) ?? entry.firstKeptEntryId));
    const markerEntry = branch[markerIndex];
    if (markerEntry?.type === "custom" && markerEntry.customType === MARKER && markerEntry.data?.cutEntryId) return { marker: markerEntry.data, index: markerIndex };
  }
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((block: Block) => block.text ?? (block.type === "toolCall" ? `[tool call ${block.name} ${JSON.stringify(block.arguments)}]` : `[${block.type}]`)).join("\n");
  return JSON.stringify(value ?? "");
}

function messageText(message?: Message): string {
  if (!message) return "";
  const body = text(message.content);
  return message.role === "toolResult" ? `[${message.toolName} call ${message.toolCallId}] ${body}` : body;
}

export function transcript(branch: Entry[], markerIndex: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < markerIndex; i++) {
    const entry = branch[i];
    const role = entry.type === "message" ? entry.message?.role : entry.type;
    const content = entry.type === "message" ? messageText(entry.message) : entry.type === "compaction" || entry.type === "branch_summary" ? entry.summary ?? "" : JSON.stringify(entry);
    for (const line of content.split("\n")) lines.push(`${String(lines.length + 1).padStart(4)} [${entry.id} ${role}] ${line}`);
  }
  return lines;
}
export function search(lines: string[], pattern: string): string[] {
  let match: (line: string) => boolean;
  try {
    const regex = new RegExp(pattern, "i");
    match = line => regex.test(line);
  } catch {
    const literal = pattern.toLowerCase();
    match = line => line.toLowerCase().includes(literal);
  }
  return lines.filter(match);
}

export function hasNewHistory(branch: Entry[]): boolean {
  const lastCompaction = branch.findLastIndex(entry => entry.type === "compaction");
  return branch.slice(lastCompaction + 1).some(entry => entry.type === "message");
}

const isNotice = (entry: Entry) => entry.type === "custom_message" && entry.customType !== REMINDER_TYPE;
/**
 * omp 18.2.11 turn start (bundle `wX`): user/bashExecution messages, custom_message and branch_summary entries;
 * minus this extension's own hidden reminder, which omp writes right after the user message it rides on.
 */
const isTurnStart = (entry: Entry) => entry.type === "branch_summary" || isNotice(entry)
  || (entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "bashExecution"));
const replyText = (entry: Entry) => Array.isArray(entry.message?.content)
  ? entry.message.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n") : text(entry.message?.content);
const entryText = (entry: Entry) => entry.type === "branch_summary" ? entry.summary ?? ""
  : entry.type === "custom_message" ? text(entry.content)
  : entry.message?.role === "bashExecution" ? `!${entry.message.command ?? ""}\n${entry.message.output ?? ""}` : text(entry.message?.content);

type Counter = { countMessages(messages: unknown[]): number };
/** Size of `entries` in omp's Tokenizer, mapped to messages as omp 18.2.11 does (bundle `VXt`); undefined without a Tokenizer. */
export function keptTokens(counter: Counter | undefined, entries: Entry[]): number | undefined {
  if (!counter) return undefined;
  const messages = entries.map(entry => entry.type === "message" ? entry.message
    : entry.type === "custom_message" ? { role: "custom", customType: entry.customType, content: entry.content }
    : entry.type === "branch_summary" ? { role: "branchSummary", summary: entry.summary } : undefined).filter(Boolean);
  // A Tokenizer that throws is treated as unavailable: plan() falls back to omp's native fit rule.
  try { return counter.countMessages(messages); } catch { return undefined; }
}

/**
 * Keep-start is the latest omp turn start after the last compaction that opens the turn of the final
 * assistant reply; the final turn runs from it to the end of the branch. The turn fits iff its size in
 * omp's Tokenizer is at most `compaction.keepRecentTokens` (`budget`, un-rescaled), or omp's own preparation
 * already keeps it whole (`nativeKeepId` = `preparation.firstKeptEntryId` at or before the turn's start, which for a
 * turn begun before the last compaction is that earlier turn start); without a Tokenizer only the latter applies.
 * A kept turn that starts mid-task (not at a user message) carries the user's last ask after the last compaction.
 * A turn that does not fit keeps omp's native tail when that tail starts inside the turn and still includes the
 * final reply, with an excerpt of the turn's start; failing that, nothing is kept and
 * the stub carries an excerpt of the ask, the reply and any unanswered message after the reply.
 */
export function plan(branch: Entry[], nativeKeepId: string | undefined, budget: number, counter?: Counter): Plan {
  const lastCompaction = branch.findLastIndex(entry => entry.type === "compaction");
  const lastReply = branch.findLastIndex(entry => entry.type === "message" && entry.message?.role === "assistant");
  let start = -1;
  for (let i = lastReply; i > lastCompaction && start < 0; i--) if (isTurnStart(branch[i])) start = i;
  const native = nativeKeepId === undefined ? -1 : branch.findIndex(entry => entry.id === nativeKeepId);
  // With no turn start after the last compaction, the excerpt reaches back to whatever started the turn.
  const turnIndex = start >= 0 ? start : branch.findLastIndex((entry, i) => i <= lastReply && isTurnStart(entry));
  const userIndex = branch.findLastIndex((entry, i) => i > lastCompaction && i <= lastReply && entry.type === "message" && entry.message?.role === "user");
  const excerpt = (keptFrom: number) => ({
    turnAsk: turnIndex >= 0 && turnIndex < keptFrom ? entryText(branch[turnIndex]) : undefined,
    userAsk: userIndex >= 0 && userIndex !== turnIndex && userIndex < keptFrom ? entryText(branch[userIndex]) : undefined,
  });
  const turnTokens = start >= 0 ? keptTokens(counter, branch.slice(start)) : undefined;
  // Native keeping the whole turn also counts as fitting: an excerpt would keep strictly less than native would.
  // Token fit applies only after the last compaction; before it, only omp's own cut shows where a cut is valid.
  if ((turnIndex >= 0 && native >= 0 && native <= turnIndex) || (turnTokens !== undefined && turnTokens <= budget)) {
    const { userAsk } = excerpt(turnIndex);
    return { mode: "turn", keepId: branch[turnIndex].id, keptTokens: start >= 0 ? turnTokens : keptTokens(counter, branch.slice(turnIndex)),
      ...(userAsk !== undefined && { userAsk }) };
  }
  const reason = start < 0 ? "the turn began before the previous compaction"
    : turnTokens === undefined ? "the turn is over omp's keep budget" : `the turn is ~${turnTokens} tokens, over compaction.keepRecentTokens ${budget}`;
  // Reaching here means native starts after the turn's start (or is absent).
  if (native >= 0 && native <= lastReply) {
    return { mode: "tail", keepId: nativeKeepId, keptTokens: keptTokens(counter, branch.slice(native)), reason, ...excerpt(native) };
  }
  const reply = branch.findLast(entry => entry.type === "message" && entry.message?.role === "assistant" && replyText(entry).trim() !== "");
  return { mode: "excerpt", reason, ...excerpt(branch.length), reply: reply && replyText(reply),
    trailing: branch.slice(lastReply + 1).filter(isNotice).map(entryText) };
}

/** The `/offload` result line; names where the kept range starts, which in tail mode is not the final reply. */
export function notice(cutEntryId: string, plan: Plan): string {
  const size = plan.keptTokens ? ` (~${plan.keptTokens} tokens)` : "";
  const kept = plan.mode === "turn" ? `kept the latest turn verbatim from ${plan.keepId}${size}`
    : plan.mode === "tail" ? `kept the end of the latest turn from ${plan.keepId}${size} (${plan.reason}); the summary carries an excerpt of its start`
    : `offloaded through ${cutEntryId}; the latest turn is not kept (${plan.reason}); the summary carries an excerpt`;
  return `Offload committed: ${kept}. Earlier messages remain in the session journal.`;
}

function hasLiveReminder(branch: Entry[]): boolean {
  const end = branch.findLastIndex(entry => entry.type === "compaction");
  if (end < 0) return false;
  const lastCompaction = branch[end];
  if (lastCompaction.summary?.includes(TOOL)) return true;
  const kept = branch.findIndex(entry => entry.id === lastCompaction.firstKeptEntryId);
  return branch.slice(kept < 0 ? end + 1 : kept).some(isReminder);
}
const REMINDER = `Offloaded earlier conversation remains available through ${TOOL}. Retrieve it only if the current request depends on earlier work.`;
export default function offload(pi: ExtensionAPI) {
  let reminderRegistered = false;
  let reminderQueued = false;
  type Attempt = { goal: string; cutEntryId: string; counter?: Counter; markerId?: string; plan?: Plan };
  const pending = new Map<string, Attempt>();
  let compactHandlerRegistered = false;
  const registerReminder = () => {
    if (reminderRegistered) return;
    reminderRegistered = true;
    pi.on("session_compact", (event, ctx) => {
      if (event.fromExtension && isOffloadDetails(event.compactionEntry.details)) return;
      const branch = ctx.sessionManager.getBranch() as Entry[];
      if (!latest(branch)) return;
      // A queued reminder has not necessarily been written to the journal yet.
      if (reminderQueued && branch.some(isReminder)) reminderQueued = false;
      if (reminderQueued || hasLiveReminder(branch)) return;
      pi.sendMessage({ customType: REMINDER_TYPE, content: REMINDER, display: false }, { deliverAs: "nextTurn" });
      reminderQueued = true;
    });
  };
  const syncReminder = (_event: unknown, ctx: { sessionManager: { getBranch(): unknown[] } }) => {
    reminderQueued = false;
    if (latest(ctx.sessionManager.getBranch() as Entry[])) registerReminder();
  };
  pi.on("session_start", syncReminder);
  pi.on("session_switch", syncReminder);
  pi.registerCommand("offload", {
    description: "Offload earlier conversation; keep it searchable in this session",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const branch = ctx.sessionManager.getBranch() as Entry[];
      const lastMessage = branch.findLast(entry => entry.type === "message");
      if (!lastMessage || lastMessage.message?.role !== "assistant") {
        ctx.ui.notify("Offload requires a completed assistant turn", "warning");
        return;
      }
      if (!hasNewHistory(branch)) {
        ctx.ui.notify("Nothing new to offload since the last compaction.", "info");
        return;
      }
      const cutEntryId = lastMessage.id;
      const goal = args.trim();
      // omp's own Tokenizer for ctx.model (the class omp's compaction counts with) decides whether the final turn fits.
      // omp's extension module map provides this package at runtime; it is not installed for `bun test`. If the import
      // or construction fails, counter stays undefined and plan() falls back to omp's native preparation.
      let counter: Counter | undefined;
      try {
        const { Tokenizer } = await import("@oh-my-pi/pi-agent-core");
        counter = new Tokenizer("model" in ctx ? ctx.model : undefined);
      } catch {}
      const leafId = ctx.sessionManager.getLeafId();
      if (!leafId) throw new Error("Offload has no journal leaf");
      // No global hook: sessions which never offload retain native speculative compaction.
      // omp 18.2.11 has pi.on but no public off; this handler becomes inert after the commit.
      if (!compactHandlerRegistered) {
        compactHandlerRegistered = true;
        pi.on("session_before_compact", event => {
          // Public focus text belongs to a user /compact, not this options-only pass.
          // Keep pending until a compaction actually commits: an automatic pass
          // can be aborted after the marker is appended but before its commit.
          if (event.signal.aborted || event.customInstructions !== undefined) return;
          let selected: Attempt | undefined;
          for (const [id, attempt] of pending) {
            if (!event.branchEntries.some(entry => entry.id === id)) continue;
            if (!attempt.markerId || !event.branchEntries.some(entry => entry.id === attempt.markerId)) {
              pi.appendEntry(MARKER, { cutEntryId: attempt.cutEntryId, goal: attempt.goal, ts: new Date().toISOString() });
              const markerId = ctx.sessionManager.getLeafId();
              if (!markerId || markerId === id) throw new Error("Offload marker was not appended");
              attempt.markerId = markerId;
            }
            selected = attempt;
          }
          if (!selected?.markerId) return;
          const preparation = event.preparation as { settings?: { keepRecentTokens?: unknown }; firstKeptEntryId?: unknown };
          const budget = typeof preparation.settings?.keepRecentTokens === "number" ? preparation.settings.keepRecentTokens : DEFAULT_KEEP_TOKENS;
          const nativeKeepId = typeof preparation.firstKeptEntryId === "string" ? preparation.firstKeptEntryId : undefined;
          selected.plan = plan(event.branchEntries as Entry[], nativeKeepId, budget, selected.counter);
          return { compaction: {
            summary: stub(selected.goal, selected.plan),
            // The kept range starts at keepId (turn start, or omp's native tail cut); the marker (a custom entry)
            // sits inside it and is not rendered. Without keepId the marker is the cut and nothing of the branch is kept.
            firstKeptEntryId: selected.plan.keepId ?? selected.markerId,
            tokensBefore: event.preparation.tokensBefore,
            details: { kind: MARKER, markerId: selected.markerId, keep: selected.plan.mode, nativeKeepId, keptTokens: selected.plan.keptTokens, keepRecentTokens: budget },
          } };
        });
        pi.on("session_compact", event => {
          if (!event.fromExtension || !isOffloadDetails(event.compactionEntry.details)) return;
          for (const [id, attempt] of pending) {
            if (attempt.markerId === markerIdOf(event.compactionEntry.details)) pending.delete(id);
          }
        });
      }
      const attempt: Attempt = { goal, cutEntryId, counter };
      pending.set(leafId, attempt);
      let failure: unknown;
      try {
        await ctx.compact({ mode: "soft", suppressContinuation: true });
      } catch (error) {
        failure = error;
      } finally {
        pending.delete(leafId);
      }
      const committedBranch = ctx.sessionManager.getBranch() as Entry[];
      const foundCut = latest(committedBranch);
      const committed = attempt.markerId !== undefined && foundCut !== undefined && committedBranch[foundCut.index].id === attempt.markerId;
      if (!committed) {
        if (!attempt.markerId && failure && /^(Already compacted|Nothing to compact)/.test(String(failure instanceof Error ? failure.message : failure))) {
          ctx.ui.notify("Context is still within omp's compaction.keepRecentTokens window (20K tokens by default); nothing to offload yet. Active context is unchanged.", "info");
          return;
        }
        if (attempt.markerId) pi.appendEntry(`${MARKER}:cancelled`, { markerId: attempt.markerId });
        throw failure ?? new Error("Offload compaction did not commit; the active context is unchanged");
      }
      registerReminder();
      // The hook that wrote this marker's compaction also set its plan.
      ctx.ui.notify(notice(cutEntryId, attempt.plan!), "info");
    },
  });

  pi.registerTool({
    name: TOOL,
    label: "Offloaded history",
    description: "Only when the current request depends on earlier offloaded work: search raw history with a case-insensitive regex {pattern}, or read lines {from,to}. Invalid regex falls back to literal matching.",
    parameters: pi.zod.object({
      pattern: pi.zod.string().optional(),
      from: pi.zod.number().optional(),
      to: pi.zod.number().optional(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const branch = ctx.sessionManager.getBranch() as Entry[];
      const found = latest(branch);
      if (!found) return { content: [{ type: "text", text: "This branch has no offloaded history." }] };
      const lines = transcript(branch, found.index);
      if (params.pattern !== undefined) {
        const matches = search(lines, params.pattern);
        return { content: [{ type: "text", text: capped(`Matches (${matches.length}) of ${lines.length} lines:`, matches.length ? matches : ["(none)"]) }] };
      }
      const from = Math.max(1, Math.floor(params.from ?? 1));
      const to = Math.min(lines.length, Math.floor(params.to ?? from + 59));
      return { content: [{ type: "text", text: capped(`Lines ${from}-${to} of ${lines.length}:`, lines.slice(from - 1, to)) }] };
    },
  });
}
