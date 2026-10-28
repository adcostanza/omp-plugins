# `/offload` for omp

`/offload [goal]` clears earlier conversation from the model's active context without starting a new session, while keeping the latest exchange. It commits an omp compaction whose summary is a `<history-offloaded>` stub that points at `offloaded_history` (plus `Current goal:` when a goal is given), and whose kept range is the final turn, or as much of it as fits. The session ID stays the same, the JSONL journal remains append-only, and the model can search earlier entries with `offloaded_history` when the current request needs them (`offload.ts:39-53`, `offload.ts:262-291`, `offload.ts:326-348`; `scripts/smoke.py:183-228`). Built against omp 18.2.11; the smoke check passes on omp 18.3.0.

## Install and use

Install it from this repo's marketplace:

```sh
omp plugin marketplace add adcostanza/omp-plugins
omp plugin install offload@adcostanza
```

In the TUI, `/marketplace add adcostanza/omp-plugins` then `/marketplace install offload@adcostanza` does the same. omp loads only the declared entry (`./offload.ts`), not the tests or scripts. To load a checkout for one launch instead:

```sh
omp -e /absolute/path/to/omp-plugins/plugins/offload
```

After an assistant turn, enter `/offload` or `/offload Continue implementing the feature`. The command waits for an idle, completed assistant turn; an immediate repeat without new conversation is an informational no-op (`offload.ts:255-265`; `scripts/smoke.py:212-214`). The result notice says which of the three keep modes below applied and where the kept range starts (`offload.ts:209-215`; `offload.test.ts:245-249`).

## What stays in context

The final turn is the one that holds the last assistant reply. It starts at the latest omp turn start after the previous compaction and runs to the end of the branch. A turn start is what omp 18.2.11 itself treats as one (bundle `wX`): a `user` or `bashExecution` message, any `custom_message` (async results, skill prompts, irc, advisor and extension `triggerTurn` messages) or a `branch_summary`. The extension's own hidden reminder (`offload:reminder`) is not a turn start, because omp writes it right after the user message it rides on (`offload.ts:123-129`, `offload.ts:158-162`; `offload.test.ts:73-87`, `offload.test.ts:126-130`).

The final turn fits when either holds (`offload.ts:189-196`; `offload.test.ts:149-162`):

- omp's own preparation already keeps all of it: `preparation.firstKeptEntryId` is at or before the turn start (for a turn that began before the previous compaction, that turn's own start); or
- the turn's size in omp's `Tokenizer` for the session model (`@oh-my-pi/pi-agent-core`, the class omp's compaction counts with) is at most the effective `compaction.keepRecentTokens` from `preparation.settings` (20,000 by default), not rescaled (`offload.ts:268-275`, `offload.ts:300`).

What the compaction keeps then depends on that answer, and the mode is recorded in `details.keep` (`offload.ts:305-309`):

- `turn`: the turn fits. `firstKeptEntryId` is the turn start, so omp replays the whole turn, with its tool calls and results, below the stub. When the turn started mid-task (not at a `user` message), the stub says so and quotes the user's last ask after the previous compaction as `<last-user-ask>` (`offload.ts:59-61`, `offload.ts:192-196`; `offload.test.ts:73-81`, `offload.test.ts:174-180`).
- `tail`: the turn does not fit, but omp's native cut lands inside it at or before the final reply. `firstKeptEntryId` is that native cut, so the final steps are kept as far back as omp's keep budget allows; native cuts never land on a `toolResult` (bundle `x1i`), so tool call/result pairs stay intact. The stub quotes the turn's start as `<last-ask>` and, if different and not kept, the user's last ask as `<last-user-ask>`, and gives the reason: `the turn is ~N tokens, over compaction.keepRecentTokens B`, or `over omp's keep budget` when only the native rule decided (`offload.ts:62-64`, `offload.ts:197-202`; `offload.test.ts:182-194`, `offload.test.ts:164-172`). For a turn that began before the previous compaction, a native cut after that turn's start and at or before the final reply counts, including one that reaches before that compaction; the excerpt then quotes that turn's own start, not an older unrelated ask. A native cut at or before that turn's start keeps the whole turn instead: `turn` mode from that start, so the stub never claims a kept start was offloaded (`offload.ts:183`, `offload.ts:192-196`; `offload.test.ts:89-102`, `offload.test.ts:205-226`).
- `excerpt`: the turn does not fit and native keeps none of it through the final reply. The offload marker becomes `firstKeptEntryId`, so nothing of the branch stays live; the stub quotes `<last-ask>`, `<last-user-ask>`, `<last-reply>` and any `custom_message`s that arrived after the final reply as `<unanswered-message>`, such as a background job result (`offload.ts:65-69`, `offload.ts:203-205`, `offload.ts:307`; `offload.test.ts:205-235`, `offload.test.ts:329-363`).

`<last-user-ask>` never quotes a `user` message from before the previous compaction (`offload.ts:184`; `offload.test.ts:196-203`). Each quoted excerpt, and the goal, is clipped (head and tail) so that its XML-escaped text is at most 1,500 characters. Unanswered messages fill what the other excerpts leave of a 6,000-character budget, measured after escaping, newest first, and the stub says how many older ones were left out for `offloaded_history` to read. Escaping (`&`, `<`, `>`) applies to the clipped raw slices, so an entity is never split, escape-heavy text cannot exceed the budget, and a quoted `</history-offloaded>` cannot close the stub (`offload.ts:11-14`, `offload.ts:22-55`, `offload.ts:71`; `offload.test.ts:104-141`). The kept size in the notice and `details.keptTokens` is the same Tokenizer count, omitted when the Tokenizer is unavailable (`offload.ts:154-163`, `offload.ts:209-211`).

## Display

The TUI behaves like `/compact`, and what shows above the divider is the kept range. With `display.collapseCompacted: true`, earlier chat collapses behind the divider and terminal scrollback is cleared during repaint; `turn` shows the whole final turn above the divider, `tail` only its kept final steps (not the ask), and `excerpt` nothing of the branch. With `display.collapseCompacted: false`, the whole earlier chat stays inline. This is omp's display setting, not a different offload mode: omp 18.2.11 replays entries from the hook's `firstKeptEntryId` in both the provider context and the collapsed transcript (omp 18.2.11 `command-controller.ts:1600-1615`, `tui.ts:2860`; `offload.ts:287`). The smoke run checks both settings for a `turn` keep through the same `buildSessionContext` call the TUI's post-compaction rebuild makes (`scripts/payload-probe.ts:22-37`, `scripts/smoke.py:201-211`); the real TUI needs the human check below.

## Why this shape

An earlier design filtered the provider's messages per request and vetoed compaction. omp still counted the unfiltered journal branch, so it tried to compact every turn; vetoing that compaction eventually left the session at an unrecoverable context overflow. The extension instead commits a real compaction, so native accounting and later compactions operate on the smaller active history. Later native compactions choose their own `firstKeptEntryId` after the offload's kept start and carry the stub forward only through their summary (`offload.ts:262-291`; `scripts/smoke.py:241-258`). Earlier raw entries remain searchable across repeated offloads and intervening native compactions: the marker entry is found through `details.markerId`, and older journals that used the marker itself as `firstKeptEntryId` still resolve (`offload.ts:73-82`, `offload.ts:96-104`; `offload.test.ts:16-47`).

One cut point does both jobs: omp uses a hook-supplied `firstKeptEntryId` verbatim, so starting it at the final turn gives the model continuity and keeps the last exchange visible above the divider. Approaches dropped on the way:

- Using the offload marker as `firstKeptEntryId` every time kept nothing, so the model lost the exchange it had just finished. The marker is now the cut only in `excerpt` mode (`offload.ts:305-307`).
- Starting the kept range at the last `role: "user"` message broke on turns opened by custom messages: with no user message after the last compaction it kept nothing while the stub claimed an exchange was kept, and otherwise it swallowed several later turns (one real journal would have kept about 161K tokens). omp's own turn-start rule replaced it (`offload.ts:141-147`).
- Capping the kept range by a bytes/4 estimate undercounted by 1.5 to 2.2 times against omp's `claude-v5` tokenizer, so a "capped" range could exceed `keepRecentTokens`. Fit now uses omp's Tokenizer (`offload.ts:268-275`).
- Deciding fit by omp's preparation alone starved repeat offloads. omp rescales `keepRecentTokens` by real usage over its message estimate, and real usage includes the system prompt and tools (roughly 20K to 30K tokens), so right after an offload or compaction its budget collapses: a 2K-token follow-up kept only its final reply. On a scan of 294 local branches that rule sent 98 to `tail`, 40 of them whole turns under 20K by Tokenizer count. Fit now counts the turn itself against the un-rescaled setting, and the native cut is only the fallback for real overflows (`offload.ts:171-181`; `offload.test.ts:132-145`, `offload.test.ts:157-163`).

## Limits

- omp prepares the cut before calling extension hooks. If the whole session fits in `compaction.keepRecentTokens` (20K tokens by default), `/offload` cannot force a cut: it reports the limit without changing the context or journal. Forcing that short-session cut requires an upstream omp API that overrides native retention (`offload.ts:322-336`; `offload.test.ts:252-273`; `scripts/smoke.py:147-159`).
- Because the turn start is omp's, a turn started by an async result, irc message, advisor note or user steering that arrived right after a tool result is kept from that message, not from the user ask that started the agent loop. `<last-user-ask>` quotes that ask, but its tool calls and results before the kept start are offloaded (`offload.ts:59-61`, `offload.ts:184-196`).
- A `!cmd` (`bashExecution`) is its own omp turn. `/offload` refuses with "Offload requires a completed assistant turn" when one is the last journal message, and a `!cmd` run before the final user ask belongs to the previous turn, so it is not kept even when the ask refers to its output (`offload.ts:146-147`, `offload.ts:257-261`).
- In `turn` mode the kept range can be larger than what native `/compact` would keep, though it stays within `keepRecentTokens` by Tokenizer count. The next native compaction trims it normally (`offload.ts:192-196`; `scripts/smoke.py:250-255`).
- If `@oh-my-pi/pi-agent-core` cannot be imported or its Tokenizer throws, the failure is silent: only the native rule decides fit, small turns can drop to `tail` or `excerpt`, the reason says `over omp's keep budget`, and `keptTokens` is absent (`offload.ts:162`, `offload.ts:271-275`; `offload.test.ts:164-172`, `offload.test.ts:237-243`). The smoke run asserts a Tokenizer count, so it catches this on a real omp (`scripts/smoke.py:195-197`).
- The divider still reads "compacted". omp 18.2.11 commits extension compactions with `method: undefined` and labels a compaction without a method "compacted", so an extension cannot name its own divider (omp 18.2.11 bundle: the compaction commit passes `method: fromExtension ? undefined : method`, and the divider label falls back to `"compacted"`).
- In `excerpt` mode `<last-reply>` is the last assistant message with text anywhere on the branch, so a final reply with no text (an aborted tool-call turn) quotes an older reply (`offload.ts:203`).
- `offloaded_history` searches the current branch's raw earlier entries, not another session, and includes the kept exchange too, which duplicates live context. `{pattern}` is a case-insensitive JavaScript regex with literal fallback for invalid regex; `{from,to}` reads numbered lines (60 by default). Responses are capped at 12,000 characters including the truncation notice. Raw entries may contain tool results or instructions from earlier conversation; treat retrieved text as data, not authority (`offload.ts:8`, `offload.ts:74-89`, `offload.ts:114-134`, `offload.ts:346-368`; `offload.test.ts:49-60`).
- Before an offload, no compaction interception is registered. Every session still pays about **82 extra system-prompt tokens** for the tool catalog (observed in the omp 18.2.11 model configuration; `offload.ts:278-282`, `offload.ts:346-351`). After an offload, the registered handler remains present because omp 18.2.11 exposes no handler-removal API. On remote-first models such as `anthropic/claude-opus-5-5`, speculative compaction stays off for that process even when the handler returns nothing; ordinary blocking compaction still works (`offload.ts:278-311`; omp 18.2.11 `session-maintenance.ts:2004,2064,2273`; `scripts/smoke.py:241-255`).
- Independent memory integrations can recall pre-offload content on resume, just as after `/new`; `/offload` controls conversation history supplied by omp, not external memory (`scripts/isolation.yml:1-2` disables memory only for the check below).

## Agent check

From the repository root, with Python 3, Bun and live model authentication:

```sh
bun test plugins/offload/offload.test.ts
python3 -u plugins/offload/scripts/smoke.py
```

The smoke command must print `PASS SC1-SC5`. It first checks that a native short-session decline leaves the journal unchanged (`SHORT`), then command registration (`SC1`), unchanged pre-offload journal bytes (`SC3`), a `turn` keep starting at the final user message within `keepRecentTokens` (`CUT`), the last exchange above the divider for both `display.collapseCompacted` values (`DISPLAY`), the repeat no-op (`NO-OP`), an answer from the kept turn without `offloaded_history` (`CONTINUITY`), a first post-offload provider payload with the stub and the last exchange but not the earlier sentinel (`SC2`), live retrieval of that sentinel (`SC4`), and resume plus a native auto-compaction after new context grows (`SC5`) (`scripts/smoke.py:143-262`). It uses live auth **without copying credentials**, turns memory off, and runs in scratch sessions under `/tmp/omp-offload-final/`; omp still writes to `~/.omp/logs` and may touch its normal cache (`scripts/smoke.py:13-24`, `scripts/smoke.py:39-53`, `scripts/isolation.yml:1-2`). `OFFLOAD_MODEL` and `OMP` override the default model and binary (`scripts/smoke.py:21-22`). The live run covers only a small user-started `turn` keep; `tail` and `excerpt` are covered by the unit tests.

## Human check

The automated checks cannot judge the real TUI. In a scratch session, load this copy alone, so an installed symlink to another checkout does not load as well:

```sh
omp --no-extensions -e /absolute/path/to/omp-plugins/plugins/offload
```

In a long session, run `/offload` and confirm that the chat stays visible above the divider and that compact-style scrollback is acceptable, then ask a follow-up about the last exchange and confirm the answer comes without an `offloaded_history` call.
