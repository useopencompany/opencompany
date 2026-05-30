# M13 — Cooperatively cancel running sandbox commands on abort

**Severity:** 🟡 Medium — abort doesn't stop in-flight tool work promptly.

> **Refactor, don't duct-tape.** Don't just shorten command timeouts to make
> aborts "feel" faster. Wire the abort signal through to the sandbox command so a
> running command is actually killed.

## Root cause

Abort sets `abort_requested_at` + flips status, and calls process-local
`abortActiveRun` (`apps/runner/src/session-lifecycle.ts:411-434`,
`apps/runner/src/active-runs.ts`). The model stream notices at the next
`checkAbort` between stream parts. But a run blocked **inside** a long-running
`shell`/`amp_coder` command only notices when the command returns or hits its
timeout — the abort signal isn't propagated into the E2B command execution
(`runSandboxTool` in `apps/runner/src/sandbox.ts:290-437` passes no cancellation
to `sandbox.commands.run`). So mid-command, abort latency = up to the command
timeout (see M14).

## The refactor

1. Thread the run's `AbortSignal` into `runSandboxTool` and into the E2B command
   invocation. On abort, actively terminate the running command in the sandbox
   (kill the process / use E2B's cancellation, whichever the SDK supports) rather
   than waiting for it to finish.
2. Ensure the `onOutput` / `command.output` publishing stops promptly and the
   tool resolves to an aborted/failed result that the loop already knows how to
   handle.
3. Verify the existing per-part `checkAbort` in the output callbacks
   (`tool-dispatcher.ts:313,343`) coordinates with the new hard-cancel so there's
   one clear cancellation path, not two competing ones.

## Files in scope

- `apps/runner/src/sandbox.ts` (`runSandboxTool` — accept + honor a signal)
- `apps/runner/src/tool-dispatcher.ts` (pass the signal through; resolve aborted
  tool output)
- `apps/runner/src/amp-tool.ts` (long-running amp commands)

## Acceptance criteria

- Aborting a session during a long `shell` command stops the command within
  seconds (not at the command timeout).
- Output streaming halts promptly; the run transitions to aborted cleanly with
  the lease released/failed as today.
- No orphaned sandbox processes left running after abort.

## Risks / notes

- Depends on what the E2B SDK exposes for command cancellation — confirm the API
  before designing. If only process-kill via a second command is available, do
  that.
- Make abort idempotent and safe if the command already finished.
