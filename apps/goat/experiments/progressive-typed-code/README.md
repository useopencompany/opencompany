# Progressive typed programmatic tool calling

See [RESULTS.md](./RESULTS.md) for the repeated benchmark, fault injection, cross-model probe, and production decision.

This experiment implements the safer pattern recommended by Anthropic, OpenAI, and Cloudflare:

1. The discovery model initially sees only a compact `load_tools` schema.
2. Server-side discovery indexes names, descriptions, and input schemas, then reranks with action/effect and rare-term signals. It returns two candidates for reads to absorb safe synonyms, but only one exact action-matched candidate for writes.
3. Those selected tools become real, directly callable typed tools. A separate `execute` tool can orchestrate loaded read operations when code is the right execution mode.
4. Writes and approval-sensitive actions must use direct typed tools. They are blocked inside `execute`, preserving a clear authorization and retry boundary.
5. The sandbox can invoke only paths loaded during discovery. Inputs remain catalog-validated, credentials and implementations stay host-side, and intermediate read results do not enter model context.
6. Discovery classifies intent from explicit action verbs and treats every catalog operation as a write unless its verb is on a conservative read allowlist. Read intents cannot retrieve write tools, and a write candidate must match all requested action terms. A production catalog should replace name inference with signed effect metadata.
7. The host tracks each discovery query as an operation obligation. If the model stops before attempting a read, it receives one bounded completion continuation that names only the already-selected group—not a benchmark answer. Missing writes fail closed and are never auto-repaired.
8. Tool evidence returns to the model for a final user-facing response.

The runtime permits one repair only after an actual sandbox failure and before any direct write. It blocks duplicate writes and disables writes in generated code. The benchmark permits direct writes because every integration is a deterministic mock and the task prompt is treated as the explicit authorization scope.

This deliberately does **not** expose runtime `tools.search` or `tools.describe`. Schema discovery after code generation was the central reliability flaw in the earlier execute-only spike.

## Run

From the repository root with a development Vercel AI Gateway key:

```bash
bun run apps/goat/experiments/progressive-typed-code/run.ts \
  --model anthropic/claude-sonnet-5 \
  --repeats 1
```

Focused run:

```bash
bun run apps/goat/experiments/progressive-typed-code/run.ts \
  --tasks slack-to-linear,five-source-digest \
  --out .context/progressive-typed-code/smoke.json
```

Tests:

```bash
bun run --filter @opencompany/goat test -- experiments/progressive-typed-code/progressive-typed-code.test.ts
```

## Safety boundary

The capability and mutation policy is production-shaped, but the isolation implementation is not production-safe. It reuses a constrained Node child process and `node:vm`; a real multi-tenant deployment needs a fresh V8 isolate or microVM, no ambient filesystem/network, host-side secret brokering, tenant-scoped capabilities, approvals, quotas, cancellation, and durable audit events.
