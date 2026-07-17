# Tiered Tool Exposure Spike

This standalone Goat experiment compares two ways of exposing a large integration-tool catalog to
an LLM agent:

- `flat`: every tool description and full JSON input schema is sent on every model step.
- `tiered`: Level-0 integration summaries are always visible, keyword/regex matches
  deterministically add four curated Level-1 tools, and three generic meta-tools let the model
  expand or call anything through stable pointers. The engine resolves the full Level-2 definition
  and validates arguments at call time.

The design adapts the lossless-pointer and deterministic-engine ideas from Ehrlich and Blackman's
[LCM paper](https://arxiv.org/abs/2605.04050). It is not an implementation of LCM's conversation
compaction or task-partitioning systems.

Nothing here is wired into Goat's production chat path. All integrations and executions are mocks.

## Contents

- `registry.ts`: 100 realistic definitions across Linear, Attio, Slack, GitHub, and Notion.
- `trigger.ts`: deterministic integration selection and microbenchmarking.
- `exposure.ts`: Level 0/1/2 rendering, flat and tiered AI SDK tools, validation, and traces.
- `agent.ts`: the live Vercel AI Gateway agent loop and per-step instrumentation.
- `tasks.ts`: 15 main tasks and three scaling probes.
- `benchmark.ts`: paired execution, synthetic scale registries, and aggregation.
- `tool-exposure.test.ts`: pointer, trigger, context, validation, and scoring invariants.
- `RESULTS-2026-07-17.md`: measured Sonnet 5 results and recommendation.
- `CONCEPT.md`: proposed adaptive production architecture based on the measured failure modes.

## Run it

Static analysis is deterministic and does not call a model:

```bash
bun run --filter @opencompany/goat experiment:tool-exposure -- analyze \
  --scales 1,3,5,8,12,20,40
```

The live benchmark needs `VERCEL_AI_GATEWAY_API_KEY`:

```bash
infisical run --env=dev --path=/runner -- \
  bun run --filter @opencompany/goat experiment:tool-exposure -- live \
  --model anthropic/claude-sonnet-5 \
  --tasks all \
  --repetitions 1 \
  --scales 1,3,5,8,12 \
  --output .context/tool-exposure-full.json
```

Relative output paths resolve from `apps/goat` when run through the workspace filter. Raw result
files belong in its gitignored `.context` directory because model traces are comparatively large.

Run the focused tests with:

```bash
bun run --filter @opencompany/goat test -- \
  experiments/tool-exposure/tool-exposure.test.ts
```

## Measurement definitions

- Provider input tokens come from each AI SDK step's `usage.inputTokens`. First-step input and the
  cumulative sum across the user turn are both retained.
- Static context tokens use a documented four UTF-8 bytes-per-token estimate. They are useful for
  relative schema scaling, not billing.
- Required-tool recall asks whether every requested operation's tool was called with valid input.
- Precision penalizes extra valid tools. Exact success requires full recall and no extra tools.
- Trigger recall is scored independently from agent recovery so a lossless-pointer recovery does
  not hide a routing miss.
- Latency covers the entire agent turn. Trigger latency is also microbenchmarked separately so
  extra model steps are not attributed to regex matching.

Synthetic scale nodes clone the five realistic integration catalogs under unique IDs. They are a
distractor/context stress test, not a substitute for testing many genuinely different MCP servers.
