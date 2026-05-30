# L — Lower-priority polish (grouped)

**Severity:** 🟢 Lower — correctness-adjacent hygiene and observability.

> **Refactor, don't duct-tape.** Even for small items, fix the underlying thing
> rather than masking it. These are grouped because they're individually small,
> not because they deserve hacks.

Each item below is independently shippable. Pick them up opportunistically,
ideally alongside a related higher-priority change.

---

## L15 — Stream token in the URL query string

`apps/web/components/useSessionEventStream.ts:89-92` puts the signed stream token
in the `EventSource` URL query (`?token=...`). It's a short-lived HMAC token, so
risk is low, but it lands in browser history and any intermediary access logs.
The runner already redacts it from its own logs (`redactStreamToken` in
`server.ts`).

**Refactor direction:** prefer not to carry the secret in the URL. Options:
cookie-based auth for the SSE endpoint (same-origin via a proxy), or a one-time
exchange that swaps the URL token for a connection bound server-side. If keeping
it in the URL, document the decision and the mitigations explicitly. Don't just
leave it implicit.

**Files:** `apps/web/components/useSessionEventStream.ts`,
`apps/runner/src/server.ts`, `packages/agent-runtime/src/tokens.ts`.

---

## L16 — `setMaxListeners(0)` hides subscription leaks

`apps/runner/src/events.ts:25` disables Node's listener-leak warning entirely.
That warning is a useful signal if an `unsubscribe` is ever missed (e.g. an SSE
handler that doesn't tear down — see H8).

**Refactor direction:** set a sane bound sized to expected concurrent SSE
connections, or (better, once C3 lands) the in-process emitter is no longer the
primary fan-out and this is moot. Don't keep `0` as a way to silence a real leak.

**Files:** `apps/runner/src/events.ts` (revisit as part of C3/H8).

---

## L17 — `/healthz` only reports liveness

`apps/runner/src/server.ts:32-42` returns `ok: true` without probing
dependencies. A runner that can't reach Neon or E2B still reports healthy, so
orchestrators won't pull it from rotation.

**Refactor direction:** add a real readiness check (cheap DB ping; optionally an
E2B reachability check) distinct from liveness. Surface effective config
(concurrency from M11, instance id) for observability. Keep liveness and
readiness as separate endpoints/semantics.

**Files:** `apps/runner/src/server.ts`.

---

## L18 — Inconsistent event/message bounding in detail fetch

`apps/web/lib/agent-sessions/data.ts` loads messages unbounded
(`data.ts:144-148`) but events capped at the **first** 300 (`data.ts:149-154`).
This is the same root defect as H4 and should be resolved there — listed here
only so it isn't forgotten if H4 is descoped. Make bounding consistent and
intentional across both.

**Files:** `apps/web/lib/agent-sessions/data.ts` (resolve with H4).
