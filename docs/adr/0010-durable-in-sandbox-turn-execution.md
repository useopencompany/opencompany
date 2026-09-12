# ADR 0010: Durable in-sandbox execution for coding-engine turns

- Status: Proposed
- Date: 2026-09-12
- Owners: runner maintainers
- Informs: `docs/acp-support.md`, `docs/runner.md`, ADR 0001/0002 execution vocabulary
- Related groundwork: #1782 (attempt-scoped fallback item ids), #1783 (acquisition telemetry),
  #1785 (batch-oriented event projection)

## Context

A Codex or Claude Code turn runs as an ACP adapter process inside a persistent E2B sandbox. The
runner holds the adapter's stdin/stdout as a live JSON-RPC channel tunneled through E2B's command
stream, and the durable Run's lifetime is coupled to that channel: if the runner process or the
channel dies, the turn cannot be reattached. Recovery kills any leftover adapter, starts a fresh
one, `session/load`s the persisted engine session, and re-prompts the model with recovery
instructions whose side effects are, as `claude-code-chat.ts` documents, "not intrinsically
idempotent."

The runner deploys several times a day (eight deploys on 2026-09-12 alone) with a 230-second drain
inside Render's 300-second SIGTERM window. Coding turns run a median of ~6 minutes and a p90 of
~21 minutes, so most in-flight turns cannot finish inside a drain and are handed off.

Fourteen days of production (measured 2026-09-12):

- 12.5% of completed Claude Code turns and 16.7% of completed Codex turns required at least one
  retry; nearly all of those went through lease-reclaim or cross-deploy recovery.
- Retried turns completed in a median of ~32 minutes versus ~6 minutes for clean turns.
- One week of runner logs shows 80 turn reclaims and 25 shutdown handoffs against roughly 430
  coding turns.
- ~4.6% of coding turns ended in terminal failure; the most common terminal error is literally
  "This chat run could not continue after repeated infrastructure failures. Send your message
  again to retry."
- TASK-733, a routine task, spread 8 turns across 6 runner pods spanning 5 deploys in 36 hours.

Eight distinct retry layers exist to compensate for the coupling: command-stream reconnect,
empty-result repair, stale-session fallback, guest reboot-from-disk, bounded infrastructure
retries, lease-reclaim recovery (10 attempts), task-level re-turns, and the self-heal sweeper.
Each is individually well built and incident-tested (TASK-411's 53-attempt loop, the #1371
session brick, the 2026-09-08/09 restore wedge, the 2026-06-10 stream-callback crash), but they
all exist because a durable Run rides on a connection-oriented protocol held by the least durable
process in the system.

## Decision

Move turn execution into the sandbox and make the runner a supervisor-and-projector rather than
the execution host. The unit of execution becomes an **attempt journal on the sandbox disk**; the
JSON-RPC channel between runner and adapter disappears.

### Components

**Turn supervisor (new, runs in the sandbox).** A small pinned Node program installed like the
ACP adapters. Per durable attempt it:

- spawns the ACP adapter, performs `initialize`/`session/load`-or-`new`/`session/prompt` exactly
  as `acp-harness.ts` does today, and owns that stdio channel entirely inside the sandbox;
- appends every ACP notification, request, response, and its own lifecycle markers to
  `~/.opencompany/turns/<turnId>/journal.jsonl` as `{seq, kind, payload}` records, fsynced in
  batches, with a sidecar `state.json` (`running | awaiting_permission | completed | failed`,
  terminal summary, last seq);
- surfaces agent-to-client requests (permissions, elicitations) as journal records plus a pending
  file, and polls their resolutions through the existing lease-authenticated gateway HTTP
  endpoint the sandbox already uses for host tools;
- enforces the turn wall clock locally and finalizes the journal on adapter exit, cancellation,
  or timeout.

**Runner (changed).** The claim/lease/heartbeat state machine, `run_events` projection, Electric
read models, approvals, billing, and settlement all remain. The engine adapters change from
"drive the ACP channel" to:

1. ensure sandbox + supervisor (versioned install check, as `ensureClaudeAcpAdapterInstalled`
   today), stage the same bootstrap the turn gets now;
2. start the supervisor with the prepared prompt if `state.json` shows no attempt for this turn;
3. tail the journal from the last projected `seq` (persisted per turn) and feed batches into the
   existing projector — #1785 already made projection batch-oriented for exactly this shape;
4. settle the Run from `state.json` when the journal reaches a terminal record.

A runner deploy now interrupts only *tailing*. The replacement pod reads the persisted cursor,
resumes tailing the same journal, and the model never notices. Journal `seq` becomes the event
dedup key, which retires the synthetic-item-id collision class (#1782) structurally.

**Cancellation.** Stop requests flow as today (DB flag), but the supervisor observes them through
the gateway poll and issues `session/cancel` locally. The heartbeat self-revocation dance remains
only as the recovery path for a dead supervisor.

### What this deletes

- Cross-deploy handoff and the model-level recovery prompt (`buildClaudeChatRecoveryTask`,
  `claimCodexChatRecovery`'s 10-attempt budget, `CLAUDE_CHAT_HANDOFF_TIMEOUT_MS` parking rules).
- The fence-versus-detached-adapter race as a correctness concern: a reclaimed turn attaches to
  the same supervisor instead of racing a leftover process. `pkill` fencing remains only for
  supervisor-crash cleanup.
- The in-runner ACP client (`AcpJsonRpcClient`) with its stream reconnects and guest probes; the
  probe moves into the tail loop, where a silent journal plus an unreachable guest triggers the
  existing reboot-from-disk rescue.
- The empty-result repair as a cross-process concern (the supervisor applies it locally, same
  prompt).

### What this deliberately keeps

- E2B, ACP, and the pinned adapters. This is a topology change, not a protocol or vendor change.
- The lease state machine. A lease now means "I am the projector for this turn," and expiry means
  another pod resumes tailing — cheap, safe, idempotent.
- `run_events`/Electric delivery to the browser, approvals as durable rows, sandbox billing,
  orphan reconciliation, and self-heal as the backstop for poisoned runtime state.
- The infrastructure-retry budget for pre-engine setup failures (sandbox acquisition, bootstrap),
  which are unchanged.

## Rollout

This is the most critical path in the product; nothing ships dark or big-bang.

1. **Phase 0 (landed):** batch projection (#1785), acquisition telemetry (#1783), attempt-scoped
   ids (#1782). These are prerequisites and stand alone.
2. **Phase 1 — supervisor in shadow.** The supervisor ships in the template and journals a real
   turn while the existing runner-attached path still executes it (supervisor runs the journal
   only, not the adapter). A comparison job diffs journal contents against projected events per
   turn. Exit criteria: ≥99.9% event parity across two weeks of production traffic, zero
   supervisor crashes without a journal terminal record.
3. **Phase 2 — Codex chat behind `RUNNER_CODING_TURN_SUPERVISOR_ENABLED`,** workspace-allowlisted,
   starting with internal workspaces. Deploy-time behavior is the first thing validated: ship a
   deliberate mid-turn deploy in staging and verify zero recovery prompts, transcript continuity,
   and correct settlement. Claude Code follows one release later (its `--resume` store is already
   sandbox-local, so it inherits the same shape).
4. **Phase 3 — cutover and deletion.** Remove the recovery-prompt machinery and handoff paths;
   drop `CODEX_CHAT_MAX_TOTAL_ATTEMPTS` to a small number now that reclaims no longer re-execute
   engines; update `docs/acp-support.md` and `docs/runner.md`.

Rollback at any phase is the env flag; the journal is additive sandbox state and the old path
never learns about it.

### Testing strategy

- Supervisor: unit tests over a scripted fake adapter (crash mid-notification, oversized
  payloads, permission round-trips, cancellation, wall-clock expiry), plus a journal fuzz test
  (truncated tail record must be ignored, never mis-parsed).
- Runner tail: unit tests for cursor resume, duplicate suppression by `seq`, lease loss mid-tail,
  and guest-unresponsive escalation into the reboot rescue.
- End-to-end in CI against a real E2B sandbox: one scripted turn with a forced runner restart
  mid-turn asserting no re-prompt and continuous event sequence.
- Chaos pass in staging before each phase gate: kill -9 the runner during turns, pause the
  sandbox mid-turn, kill the supervisor, and expire leases manually.

## Alternatives considered

**Longer drains / slower deploy cadence for the worker.** Render caps `maxShutdownDelaySeconds`
at 300s; p50 turns alone exceed it. Splitting the coding worker into its own service deployed
less often shrinks exposure and is worth doing operationally, but converts "turns break on every
deploy" into "turns break on every worker deploy" — a schedule, not a fix.

**Reattach the live adapter across runners without a journal.** E2B can reconnect a background
command's stream, but output emitted between disconnect and reattach is gone, in-flight JSON-RPC
ids are ambiguous, and pending permission requests dangle. Every hole in that design is plugged
by an on-disk journal — at which point the journal is the design.

**A message broker between runner and sandbox.** Solves the same decoupling with new
infrastructure, new credentials in the sandbox, and a second durability domain to reconcile with
Postgres. The sandbox disk is already the crash domain that survives every failure we observed
(it is what `session/load` recovery depends on today), and tailing it needs no new services.

**Replace ACP / build a bespoke engine protocol.** Rejected: the compatibility surface in
`docs/acp-support.md` is an asset, both engines are pinned upstream packages, and nothing in the
incident history implicates the protocol — only where its connection terminates.

## Consequences

- Deploys stop being the dominant source of turn retries; the recovery-prompt path and its
  duplicated-side-effect risk are deleted rather than further hardened.
- The runner sheds its most stateful responsibility; worker loss becomes boring by construction,
  and `CODEX_CHAT_MAX_TOTAL_ATTEMPTS`-class caps stop guarding LLM re-execution.
- A paused-then-wedged sandbox still loses the in-memory adapter, but now leaves a journal of
  everything up to the wedge: recovery becomes "resume from the journal's last record" instead of
  "ask the model what it already did."
- New failure surface: supervisor bugs. Bounded by pinning, the shadow phase, and the fact that a
  dead supervisor degrades to today's behavior (reclaim, fence, fresh attempt).
- Journals add sandbox disk usage (bounded per turn, cleaned with the turn directory) and one new
  version pin to manage.
- The 90-second lease stops bounding user-visible interruption; it only bounds projection lag.

## Open questions for review

1. Should the supervisor push journal batches to the runner over the existing gateway (lower
   latency, reuses ticket auth) with tailing as the fallback, or is poll-based tailing alone
   acceptable for v1? Proposal: tail-only v1; push is an optimization once parity is proven.
2. Where does the per-turn projected cursor live — a column on `codex_chat_turns` (additive
   migration) or inside `run_attempts`? Proposal: `codex_chat_turns.journal_cursor` (additive).
3. Does Workflow/Task approval parking change at all? Proposal: no — the pause path already
   persists the exact invocation and stops the engine; the supervisor simply finalizes the
   attempt as paused.
