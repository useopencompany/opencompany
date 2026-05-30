# M14 — Make sandbox command timeouts fit real workloads

**Severity:** 🟡 Medium — long builds/tests hard-fail at a fixed 120s.

> **Refactor, don't duct-tape.** Don't scatter ad-hoc larger numbers at
> individual call sites. Make command timeouts a coherent, configurable policy.

## Root cause

`runSandboxTool` hardcodes a 120s timeout on `shell` and `amp_coder` command
execution (`apps/runner/src/sandbox.ts:312` and related), with shorter fixed
timeouts on file/list/git operations. There is no per-agent or per-command
override. Real builds, installs, and test suites routinely exceed 120s and will
hard-fail with no recourse.

## The refactor

1. Introduce a coherent timeout policy: sensible defaults per operation class
   (quick fs ops vs. long shell/amp), an env-level ceiling
   (`RUNNER_SANDBOX_COMMAND_TIMEOUT_MS` or similar), and optionally a per-agent
   override surfaced through the agent config.
2. Make the long-running tool paths (`shell`, `amp_coder`) use the configurable
   value, while keeping fs/git ops on tight defaults.
3. Coordinate with M13: a long command must be cancellable on abort regardless of
   its timeout, so a generous timeout doesn't make abort feel broken.
4. Document the interaction with the E2B sandbox-level timeout
   (`ACTIVE_SANDBOX_TIMEOUT_MS` = 60 min, `RUNNER_E2B_IDLE_TIMEOUT_MS`) so the
   per-command and per-sandbox timeouts are clearly distinct.

## Files in scope

- `apps/runner/src/sandbox.ts` (timeout values in `runSandboxTool`)
- `apps/runner/src/env.ts` (new env if added)
- `apps/runner/src/amp-tool.ts` (long amp commands)
- agent config plumbing if a per-agent override is added
- `docs/runner.md`, `.env.example`

## Acceptance criteria

- A long shell command (e.g. > 2 min) completes successfully under the new
  default/ceiling.
- Timeout is configurable and documented; fs/git ops keep tight timeouts.
- Abort still cancels promptly (M13) even with a long timeout configured.

## Risks / notes

- Don't set the per-command timeout above the sandbox-level active timeout, or
  the sandbox pauses out from under a running command. Keep them consistent.
