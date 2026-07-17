# Adaptive Tool Exposure Lab

Local Goat experiment for inspecting a deterministic, lossless tool-exposure loop with simulated
integrations.

Open `/experiments/adaptive-tool-exposure` while running `bun run dev:goat`. The page and API route
return 404 outside development; the API also accepts `NODE_ENV=test` for focused route tests.

## What is simulated

- Six integrations: Slack, Gmail, Linear, GitHub, Notion, and Calendar.
- Eight realistic tools per integration, for 48 total full definitions.
- Every execution result is a local fixture. Write-looking calls are recorded but never sent to an
  external service.

## Model loop

1. The engine always renders Level 0: one capability sentence and a stable `integration://`
   pointer per integration.
2. `analyzeAdaptiveToolQuery` splits the request into operation clauses and deterministically
   activates integrations from explicit aliases, keywords, and typed patterns.
3. It scores tools against each clause and renders at most four compact Level-1 cards per activated
   integration.
4. The model receives those two views plus only three engine tools:
   `expand_integration`, `inspect_tool`, and `call_tool`.
5. `call_tool` resolves the `tool://` pointer, loads the full Level-2 schema, validates arguments,
   records the expansion, and returns a mock result.
6. If the curated cards miss a tool, the model can recover through the always-visible integration
   pointer. Explicit Level-1 and Level-2 expansions are shown in the UI trace.

`Analyze exposure` runs only the deterministic engine and does not require AI Gateway. `Run
simulated agent` makes a real model call through Vercel AI Gateway, but all integration execution
remains local and simulated.

## Broad evaluation

The evaluation harness compares three approaches over the same registry and mock executor:

- `flat`: all 48 full schemas are directly callable.
- `search`: Level 0 plus a model-initiated catalog-search step.
- `adaptive`: deterministic request-specific candidates with lossless expansion.

The suite contains 26 common, multi-integration, long-tail, implicit-provider, and no-tool tasks.
Static analysis also measures deterministic routing over 5,200 samples and estimates context growth
through 96 integrations / 768 tools.

```sh
bun run --filter @opencompany/goat experiment:adaptive-tool-exposure -- analyze

infisical run --env=dev --path=/runner -- \
  bun run --filter @opencompany/goat experiment:adaptive-tool-exposure -- live \
  --model anthropic/claude-sonnet-5 \
  --tasks all \
  --repetitions 1 \
  --output .context/adaptive-tool-exposure-eval.json \
  --report experiments/adaptive-tool-exposure/RESULTS-2026-07-17.md
```

See [`RESULTS-2026-07-17.md`](./RESULTS-2026-07-17.md) for the measured comparison and decision.

## Verification

```sh
bun run --filter @opencompany/goat test -- \
  components/AdaptiveToolExposureLab.test.tsx \
  experiments/adaptive-tool-exposure/activation.test.ts \
  experiments/adaptive-tool-exposure/eval.test.ts \
  experiments/adaptive-tool-exposure/runtime.test.ts \
  app/api/experiments/adaptive-tool-exposure/route.test.ts
bun run --filter @opencompany/goat typecheck
```
