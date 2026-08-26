# Future concepts

This folder contains active proposals only. Current implementation and operational contracts live
in code, architecture documentation, or an ADR. Remove a proposal when it is rejected; graduate its
enduring decisions into an ADR when it is implemented.

## Current research

- [Plugins v2](./integrations-plugins-mcp.md) — standard-first plugins: implement Agent
  Plugins 1.0.0 as a first-class client (we author official plugins as standard packages),
  route every tool through the one action gateway on every engine identically, and layer our
  capability permissions and workspace-vs-personal ownership on top. Ships as one Linear
  vertical slice, then mechanical per-provider migration.
- [Coding-session preview browser](./codex-preview-browser.md) — repository-owned preview profiles,
  stable sandbox ingress, browser control, artifacts, and human authentication takeover.
- [Product and agent evaluations](./evaluations.md) — a native regression harness for Chat,
  Workflow planning, and durable Task execution.
- [Open-source release readiness](./oss-readiness.md) — remaining safety and contributor-experience
  gates before any explicit repository visibility change.
- [LinkedIn network in Chat](./linkedin-network-main-chat-research.md) — a user-provided LinkedIn
  connections import and a private relationship-query surface that remains separate from managed
  public LinkedIn research.
