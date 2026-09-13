# Future concepts

This folder contains active proposals only. Current implementation and operational contracts live
in code, architecture documentation, or an ADR. Remove a proposal when it is rejected; graduate its
enduring decisions into an ADR when it is implemented.

## Current research

- [Coding-session preview browser](./codex-preview-browser.md) — repository-owned preview profiles,
  stable sandbox ingress, browser control, artifacts, and human authentication takeover.
- [Product and agent evaluations](./evaluations.md) — a native regression harness for Chat,
  Workflow planning, and durable Task execution.
- [Harness bench](./harness-bench.md) — the scoped v1 of agent evaluations: a `bun run bench`
  runner that drives the real chat harness against fixture-backed scenarios for regression,
  model-matrix, cost/speed, and tool-contract experiments (PRO-271).
- [Benchmark reference](./benchmark-reference.md) — how recognized benchmarks (GDPval,
  TheAgentCompany, τ-bench, Toolathlon, SWE-bench, HAL…) define realistic tasks and verify
  completion, mapped against our production workloads to shape the first real-work bench cases.
- [Open-source release readiness](./oss-readiness.md) — remaining safety and contributor-experience
  gates before any explicit repository visibility change.
- [LinkedIn network in Chat](./linkedin-network-main-chat-research.md) — a user-provided LinkedIn
  connections import and a private relationship-query surface that remains separate from managed
  public LinkedIn research.
- [Draft posts on a connected X account](./x-drafts-api-research.md) — why no public X API can save
  a draft post to a user's account, what the Ads API and Articles draft endpoints actually do, and
  why the draft stays in opencompany.
