# Implementation notes

## 2026-09-02

### Decisions

- Measure replay in the existing wildcard trace hook.
- Store `retireAfterTurn` only in `data/run-status.d`.
- Let the Bridge use the existing `performScopedReset` path after settlement.

### Deviations

- The spec named the Telegram channel as the measurement point.
- Eve 0.47.3 does not expose `message.received` to channel handlers.
- The hook sees both cut points without copying Eve internals.
- Upstream issue: https://github.com/vercel/eve/issues/627
- Remove the hook observer when channel events expose `message.received`.
- Move the same measurement into `agent/channels/telegram.ts` at that time.

### Tradeoffs

- The Bridge clears the marker before sending the notice.
- This prevents duplicate notices if the process restarts.
- A failed reset leaves the marker for the next Bridge pass.
- Queued messages remain intact because retirement uses `clearQueue: false`.
