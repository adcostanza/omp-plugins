# /offload for omp

`/offload [goal]` drops earlier conversation from the model's active context without starting a new session. The last exchange stays in context; everything before it stays in the session file, and the model can search it with the `offloaded_history` tool when it needs it.

## Install

```sh
omp plugin marketplace add adcostanza/omp-plugins
omp plugin install offload@adcostanza
```

Or in the TUI: `/marketplace add adcostanza/omp-plugins`, then `/marketplace install offload@adcostanza`.

## Use

After the assistant finishes a turn, run `/offload`, or `/offload <goal>` to note what you're doing next. The notice says what was kept.

- The session ID stays the same and the session file is only appended to.
- The last exchange stays live, including its tool calls, when it fits in `compaction.keepRecentTokens` (20K tokens by default). A larger final turn keeps its last steps, or a quoted excerpt.
- Earlier conversation is searchable with `offloaded_history`, across repeated offloads and later compactions.

## Limits

- Sessions under `compaction.keepRecentTokens` can't be offloaded; omp has nothing to cut and `/offload` says so.
- The divider reads "compacted"; omp doesn't let extensions name it.
- About 82 extra system-prompt tokens per session for the tool.
- External memory integrations can still recall offloaded content.

Built against omp 18.2.11; the smoke check passes on omp 18.3.0. How the keep is chosen, the designs that failed, and every limit: [DESIGN.md](DESIGN.md).

## Development

From the repository root (the smoke check needs live model auth; set `OFFLOAD_MODEL` to pick the model):

```sh
bun test plugins/offload/offload.test.ts
python3 -u plugins/offload/scripts/smoke.py   # prints PASS SC1-SC5
```
