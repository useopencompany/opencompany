# Runner / Session Refactor Handoff

These specs come out of a deep review of the runner data plane, the shared
`agent-runtime` lease layer, the DB schema/client, the billing ledger, and the
web control plane + SSE client.

## Ground rule for every spec in this folder

**Fix the root cause with a real refactor. Do not duct-tape around the symptom.**

Several of these issues are connected — they share a single upstream cause (the
DB driver choice and the in-process event bus). When you pick one up:

- Read the "Root cause" section before the "Symptoms" section. If you find
  yourself adding a flag, a retry, a sleep, a cache, or a special-case branch to
  make a symptom go away, stop — you are duct-taping. Go fix the thing the
  symptom points at.
- Prefer deleting/replacing a mechanism over wrapping it.
- Land the change with tests that would have caught the original defect.
- Update `docs/runner.md` and `docs/database.md` to match the new reality. The
  docs are already drifting from the code (e.g. they claim "no distributed lease
  enforcement yet" but Postgres leases exist) — don't add to the drift.

## Pickup order

The order matters. Earlier items unblock later ones.

| # | File | Severity | Theme |
|---|------|----------|-------|
| C1 | [C1-pooled-db-driver.md](./C1-pooled-db-driver.md) | 🔴 Critical | Runner uses Neon HTTP driver; needs pooled connection + transactions |
| C2 | [C2-throttle-lease-abort-read.md](./C2-throttle-lease-abort-read.md) | 🔴 Critical | DB read on every stream token |
| C3 | [C3-shared-event-transport.md](./C3-shared-event-transport.md) | 🔴 Critical | In-process event bus blocks horizontal scale |
| H4 | [H4-durable-stream-replay.md](./H4-durable-stream-replay.md) | 🟠 High | Reconnect loses durable state on long sessions |
| H5 | [H5-idempotent-billing.md](./H5-idempotent-billing.md) | 🟠 High | Retries double-charge the credit ledger |
| H6 | [H6-atomic-lease-writes.md](./H6-atomic-lease-writes.md) | 🟠 High | Non-atomic check-then-write lease guard (TOCTOU) |
| H7 | [H7-notify-worker-wakeup.md](./H7-notify-worker-wakeup.md) | 🟠 High | ~1s poll latency before a turn starts |
| H8 | [H8-sse-busy-wait.md](./H8-sse-busy-wait.md) | 🟠 High | SSE handler held open by a 250ms spin loop |
| M9 | [M9-bigint-event-ids.md](./M9-bigint-event-ids.md) | 🟡 Medium | int4 PKs on append-only high-volume tables |
| M10 | [M10-client-reducer-perf.md](./M10-client-reducer-perf.md) | 🟡 Medium | O(n) client reducer per event |
| M11 | [M11-configurable-concurrency.md](./M11-configurable-concurrency.md) | 🟡 Medium | Worker concurrency hardcoded to 2 |
| M12 | [M12-turn-context-windowing.md](./M12-turn-context-windowing.md) | 🟡 Medium | Every turn re-loads full message history |
| M13 | [M13-cooperative-abort.md](./M13-cooperative-abort.md) | 🟡 Medium | Abort can't cancel a running sandbox command |
| M14 | [M14-sandbox-command-timeout.md](./M14-sandbox-command-timeout.md) | 🟡 Medium | Fixed 120s shell timeout, no override |
| L | [L-polish.md](./L-polish.md) | 🟢 Lower | Token-in-URL, listener cap, healthz depth, bounding |

## Recommended batching

- **Batch 1 (foundation):** C1 → C2 → H5. Tight, high-impact, mostly independent of UI.
- **Batch 2 (scale + latency):** C3 → H7 (share the Postgres LISTEN/NOTIFY work).
- **Batch 3 (correctness + integrity):** H4 → H6 → M9.
- **Batch 4 (polish):** H8, M10–M14, L.
