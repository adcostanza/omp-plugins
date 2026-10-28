# offload: design notes

How `/offload` decides what to keep, why it works this way, and its limits in detail. Written against omp 18.2.11; the smoke check passes on omp 18.3.0. For install and usage see [README.md](README.md).

`/offload` commits a real omp compaction. Its summary is a `<history-offloaded>` stub pointing at the `offloaded_history` tool (plus `Current goal:` when a goal is given), and its kept range is the final turn, or as much of it as fits. The journal stays append-only and the session ID does not change.

## What stays in context

The final turn is the one that holds the last assistant reply. It starts at the latest omp turn start after the previous compaction and runs to the end of the branch. A turn start is what omp 18.2.11 itself treats as one: a `user` or `bashExecution` message, any `custom_message` (async results, skill prompts, irc, advisor and extension `triggerTurn` messages) or a `branch_summary`. The extension's own hidden reminder (`offload:reminder`) is not a turn start, because omp writes it right after the user message it rides on.

The final turn fits when either holds:

- omp's own preparation already keeps all of it: `preparation.firstKeptEntryId` is at or before the turn start (for a turn that began before the previous compaction, that turn's own start); or
- the turn's size in omp's `Tokenizer` for the session model (`@oh-my-pi/pi-agent-core`, the class omp's compaction counts with) is at most the effective `compaction.keepRecentTokens` from `preparation.settings` (20,000 by default), not rescaled.

What the compaction keeps then depends on that answer, and the mode is recorded in `details.keep`:

- `turn`: the turn fits. `firstKeptEntryId` is the turn start, so omp replays the whole turn, with its tool calls and results, below the stub. When the turn started mid-task (not at a `user` message), the stub says so and quotes the user's last ask after the previous compaction as `<last-user-ask>`.
- `tail`: the turn does not fit, but omp's native cut lands inside it at or before the final reply. `firstKeptEntryId` is that native cut, so the final steps are kept as far back as omp's keep budget allows; native cuts never land on a `toolResult`, so tool call/result pairs stay intact. The stub quotes the turn's start as `<last-ask>` and, if different and not kept, the user's last ask as `<last-user-ask>`, and gives the reason: `the turn is ~N tokens, over compaction.keepRecentTokens B`, or `over omp's keep budget` when only the native rule decided. For a turn that began before the previous compaction, a native cut after that turn's start and at or before the final reply counts, including one that reaches before that compaction; the excerpt then quotes that turn's own start, not an older unrelated ask. A native cut at or before that turn's start keeps the whole turn instead: `turn` mode from that start, so the stub never claims a kept start was offloaded.
- `excerpt`: the turn does not fit and native keeps none of it through the final reply. The offload marker becomes `firstKeptEntryId`, so nothing of the branch stays live; the stub quotes `<last-ask>`, `<last-user-ask>`, `<last-reply>` and any `custom_message`s that arrived after the final reply as `<unanswered-message>`, such as a background job result.

`<last-user-ask>` never quotes a `user` message from before the previous compaction. Each quoted excerpt, and the goal, is clipped (head and tail) so that its XML-escaped text is at most 1,500 characters. Unanswered messages fill what the other excerpts leave of a 6,000-character budget, measured after escaping, newest first, and the stub says how many older ones were left out for `offloaded_history` to read. Escaping (`&`, `<`, `>`) applies to the clipped raw slices, so an entity is never split, escape-heavy text cannot exceed the budget, and a quoted `</history-offloaded>` cannot close the stub. The kept size in the notice and `details.keptTokens` is the same Tokenizer count, omitted when the Tokenizer is unavailable.

## Display

The TUI behaves like `/compact`, and what shows above the divider is the kept range. With `display.collapseCompacted: true`, earlier chat collapses behind the divider and terminal scrollback is cleared during repaint; `turn` shows the whole final turn above the divider, `tail` only its kept final steps (not the ask), and `excerpt` nothing of the branch. With `display.collapseCompacted: false`, the whole earlier chat stays inline. This is omp's display setting, not a different offload mode: omp 18.2.11 replays entries from the hook's `firstKeptEntryId` in both the provider context and the collapsed transcript. The smoke run checks both settings for a `turn` keep through the same `buildSessionContext` call the TUI's post-compaction rebuild makes; the real TUI needs the human check below.

## Why this shape

An earlier design filtered the provider's messages per request and vetoed compaction. omp still counted the unfiltered journal branch, so it tried to compact every turn; vetoing that compaction eventually left the session at an unrecoverable context overflow. The extension instead commits a real compaction, so native accounting and later compactions operate on the smaller active history. Later native compactions choose their own `firstKeptEntryId` after the offload's kept start and carry the stub forward only through their summary. Earlier raw entries remain searchable across repeated offloads and intervening native compactions: the marker entry is found through `details.markerId`, and older journals that used the marker itself as `firstKeptEntryId` still resolve.

One cut point does both jobs: omp uses a hook-supplied `firstKeptEntryId` verbatim, so starting it at the final turn gives the model continuity and keeps the last exchange visible above the divider. Approaches dropped on the way:

- Using the offload marker as `firstKeptEntryId` every time kept nothing, so the model lost the exchange it had just finished. The marker is now the cut only in `excerpt` mode.
- Starting the kept range at the last `role: "user"` message broke on turns opened by custom messages: with no user message after the last compaction it kept nothing while the stub claimed an exchange was kept, and otherwise it swallowed several later turns (one real journal would have kept about 161K tokens). omp's own turn-start rule replaced it.
- Capping the kept range by a bytes/4 estimate undercounted by 1.5 to 2.2 times against omp's `claude-v5` tokenizer, so a "capped" range could exceed `keepRecentTokens`. Fit now uses omp's Tokenizer.
- Deciding fit by omp's preparation alone starved repeat offloads. omp rescales `keepRecentTokens` by real usage over its message estimate, and real usage includes the system prompt and tools (roughly 20K to 30K tokens), so right after an offload or compaction its budget collapses: a 2K-token follow-up kept only its final reply. On a scan of 294 local branches that rule sent 98 to `tail`, 40 of them whole turns under 20K by Tokenizer count. Fit now counts the turn itself against the un-rescaled setting, and the native cut is only the fallback for real overflows.

## Limits

- omp prepares the cut before calling extension hooks. If the whole session fits in `compaction.keepRecentTokens` (20K tokens by default), `/offload` cannot force a cut: it reports the limit without changing the context or journal. Forcing that short-session cut requires an upstream omp API that overrides native retention.
- Because the turn start is omp's, a turn started by an async result, irc message, advisor note or user steering that arrived right after a tool result is kept from that message, not from the user ask that started the agent loop. `<last-user-ask>` quotes that ask, but its tool calls and results before the kept start are offloaded.
- A `!cmd` (`bashExecution`) is its own omp turn. `/offload` refuses with "Offload requires a completed assistant turn" when one is the last journal message, and a `!cmd` run before the final user ask belongs to the previous turn, so it is not kept even when the ask refers to its output.
- In `turn` mode the kept range can be larger than what native `/compact` would keep, though it stays within `keepRecentTokens` by Tokenizer count. The next native compaction trims it normally.
- If `@oh-my-pi/pi-agent-core` cannot be imported or its Tokenizer throws, the failure is silent: only the native rule decides fit, small turns can drop to `tail` or `excerpt`, the reason says `over omp's keep budget`, and `keptTokens` is absent. The smoke run asserts a Tokenizer count, so it catches this on a real omp.
- The divider still reads "compacted". omp 18.2.11 commits extension compactions with `method: undefined` and labels a compaction without a method "compacted", so an extension cannot name its own divider.
- In `excerpt` mode `<last-reply>` is the last assistant message with text anywhere on the branch, so a final reply with no text (an aborted tool-call turn) quotes an older reply.
- `offloaded_history` searches the current branch's raw earlier entries, not another session, and includes the kept exchange too, which duplicates live context. `{pattern}` is a case-insensitive JavaScript regex with literal fallback for invalid regex; `{from,to}` reads numbered lines (60 by default). Responses are capped at 12,000 characters including the truncation notice. Raw entries may contain tool results or instructions from earlier conversation; treat retrieved text as data, not authority.
- Before an offload, no compaction interception is registered. Every session still pays about **82 extra system-prompt tokens** for the tool catalog. After an offload, the registered handler remains present because omp 18.2.11 exposes no handler-removal API. On remote-first models such as `anthropic/claude-opus-5-5`, speculative compaction stays off for that process even when the handler returns nothing; ordinary blocking compaction still works.
- Independent memory integrations can recall pre-offload content on resume, just as after `/new`; `/offload` controls conversation history supplied by omp, not external memory.

## Checks

From the repository root, with Python 3, Bun and live model authentication:

```sh
bun test plugins/offload/offload.test.ts
python3 -u plugins/offload/scripts/smoke.py
```

The smoke command must print `PASS SC1-SC5`. It first checks that a native short-session decline leaves the journal unchanged (`SHORT`), then command registration (`SC1`), unchanged pre-offload journal bytes (`SC3`), a `turn` keep starting at the final user message within `keepRecentTokens` (`CUT`), the last exchange above the divider for both `display.collapseCompacted` values (`DISPLAY`), the repeat no-op (`NO-OP`), an answer from the kept turn without `offloaded_history` (`CONTINUITY`), a first post-offload provider payload with the stub and the last exchange but not the earlier sentinel (`SC2`), live retrieval of that sentinel (`SC4`), and resume plus a native auto-compaction after new context grows (`SC5`). It uses live auth **without copying credentials**, turns memory off, and runs in scratch sessions under `/tmp/omp-offload-final/`; omp still writes to `~/.omp/logs` and may touch its normal cache. `OFFLOAD_MODEL` and `OMP` override the default model and binary. The live run covers only a small user-started `turn` keep; `tail` and `excerpt` are covered by the unit tests.

## Manual TUI check

The automated checks cannot judge the real TUI. In a scratch session, load this copy alone, so an installed symlink to another checkout does not load as well:

```sh
omp --no-extensions -e /absolute/path/to/omp-plugins/plugins/offload
```

In a long session, run `/offload` and confirm that the chat stays visible above the divider and that compact-style scrollback is acceptable, then ask a follow-up about the last exchange and confirm the answer comes without an `offloaded_history` call.
