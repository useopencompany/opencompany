# Code execution as the tool interface

This isolated Goat spike compares three ways to expose the same deterministic mock integration catalog to a real model:

1. `execute`: the model sees one `execute({ code })` schema. Generated JavaScript lazily calls `tools.search`, `tools.describe`, and `tools[path]` inside a worker.
2. `flat`: the model sees all 90 integration tool schemas on every provider request.
3. `tiered`: the model sees three meta-tools (`catalog_search`, `catalog_describe`, `catalog_invoke`) and pays an LLM step for each dependent catalog operation. This is a lazy-catalog comparator, not a complete LCM implementation.

The catalog directly reuses the parallel spike's registry: 20 tools each for Linear, Attio, Slack, GitHub, and Notion (100 total). [`tasks.ts`](./tasks.ts) imports and adapts that spike's exact 15-task corpus, preserving ids and prompts.

## Run

From the repository root, with a development Vercel AI Gateway key in the environment:

```bash
bun run apps/goat/experiments/code-tool-interface/run.ts \
  --model anthropic/claude-sonnet-5 \
  --strategies execute,flat,tiered \
  --repeats 1
```

Useful narrower runs:

```bash
bun run apps/goat/experiments/code-tool-interface/run.ts \
  --strategies execute \
  --tasks slack-to-linear,github-compare-tags \
  --out .context/code-tool-interface/smoke.json
```

The default remains the exact 15-task shared corpus. Run the separate deterministic tool-error probe with `--tasks fault-recover-tool-error`.

Raw JSON includes every model turn's token usage, generated code, sandbox result, searched queries, described and invoked tool paths, tool inputs/outputs, and errors. A Markdown report is written beside it. `.context` is gitignored so traces do not become repository artifacts accidentally.

See [`RESULTS.md`](./RESULTS.md) for the measured July 2026 run and recommendation.

Run the focused tests with:

```bash
bun run --filter @opencompany/goat test -- experiments/code-tool-interface/code-tool-interface.test.ts
```

## Metric definitions

- `modelRoundTrips`: provider requests, represented by AI SDK steps. The execute strategy stops after the one forced execute call, treating the returned program value as the task result.
- `toolRoundTrips`: model-visible tool calls. An execute run has one even when its code performs many catalog calls.
- `invokedTools`: actual mock integration calls, including a rejected call. This remains comparable across strategies.
- `overfetchCount`: unique described paths that were never invoked.
- `usagePerTurn`: provider-reported input/output/total tokens for every model request. Aggregate token cost is the sum across the task.
- `success`: deterministic task oracle based on required paths, call counts, mutation evidence, and error recovery—not the model's self-report.

## Sandbox boundary

The spike runs generated JavaScript in a dedicated Node child process and a `node:vm` context. The child inherits only `PATH`, exposes only a frozen `tools` proxy and captured `console`, disables string/wasm code generation, limits V8 heap/stack, caps code/log/result sizes and pending calls, validates tool inputs, and is killed on a hard deadline. Tool implementations and credentials remain in the parent behind an IPC bridge.

This is **not production-safe isolation**. Node explicitly does not treat `node:vm` as a security mechanism, and the child shares the host's OS identity and network/filesystem authority if the VM is escaped. A multi-tenant version needs a hardened isolate or microVM/container boundary, no ambient network/filesystem, per-tenant capability tokens, catalog allowlists and approval policies, syscall/resource quotas, egress controls, immutable images, secret brokering outside the sandbox, durable audit logs, cancellation, and abuse testing.

## Out of scope

- Real integration wiring and auth/credential handling
- Production sandbox hardening or multi-tenant execution
- Streaming partial results mid-execution
- Human approval/resume semantics
- A full engine-managed LCM summary DAG

The interface follows Executor's public code-mode convention—intent discovery, lazy schema description, then typed path invocation—while keeping the implementation local and mock-only for this comparison.
