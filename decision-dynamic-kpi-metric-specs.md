# Decision: Dynamic KPI Metric Specs

**Status:** Accepted
**Date:** 2026-06-16
**Deciders:** Louis, Codex

## Context

The KPI dashboard currently scales by adding explicit catalog metrics in TypeScript. That is safe, but it does not cover long-tail questions such as "PRs merged by a given person" without product/code work. AI can help author those long-tail metrics, but executing arbitrary AI-generated code would create a new trust boundary around provider credentials, network access, CPU, rate limits, and data leakage.

## Options

### Option 1: Execute generated code

Let an AI write JavaScript/TypeScript against an OpenCompany KPI SDK, then execute that code during refresh.

**Pros:**
- Maximum expressiveness.
- Can support novel provider logic without app deploys.
- Feels aligned with agent-native product positioning.

**Cons:**
- Requires real sandboxing, not `node:vm`.
- Provider credentials become exposed to generated code unless the SDK is heavily mediated.
- Hard to bound API calls, CPU, memory, network, and result shape.
- Harder to review, version, migrate, debug, and roll back.

### Option 2: Generate validated metric specs

Expose deterministic provider capabilities and let humans or AI produce JSON configs that are validated and executed by provider code we own.

**Pros:**
- Captures most near-term flexibility without arbitrary code execution.
- Keeps secrets and provider calls inside trusted server code.
- Fits the existing `kpi_metrics.config` and refresh pipeline.
- Gives AI a stable target contract later through structured output.

**Cons:**
- Less expressive than code.
- Each provider still needs capability executors.
- Some advanced requests will need new capability types.

## Decision

Choose Option 2 for this branch. Build a typed metric-spec layer first, starting with a configurable GitHub pull-request search-count metric. Revisit generated code only if validated specs cannot cover important customer use cases, and only with a real isolated runtime.

## Consequences

### Positive

- The current KPI implementation remains stable.
- Users get a practical custom metric path now.
- Future AI authoring can target a safe JSON contract.
- Provider credentials are not handed to generated code.

### Negative

- We still need to design provider capability specs over time.
- The first custom metric is GitHub-focused rather than a universal metric language.
- Very custom calculations remain out of scope until a later calculated-metric layer.
