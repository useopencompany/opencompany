# Future concepts

This folder contains product research and implementation plans. A document's status identifies
whether it is still speculative; current implementation and operational contracts live in code,
architecture documentation, or an ADR.

## Current research

- [Agent Skills and Agent Plugins 1.0.0](./agent-skills-plugins.md) — implemented strict portable artifacts,
  immutable runtime snapshots, approved stdio MCP, durable plugin data, and the clean replacement
  of opencompany's legacy skill model.
- [Plugins v2](./integrations-plugins-mcp.md) — standard-first plugins: implement Agent
  Plugins 1.0.0 as a first-class client (we author official plugins as standard packages),
  route every tool through the one action gateway on every engine identically, and layer our
  capability permissions and workspace-vs-personal ownership on top. Ships as one Linear
  vertical slice, then mechanical per-provider migration.
- [Open-source readiness](./oss-readiness.md) — decisions for the public naming boundary, repository
  layout, license and open scope, history safety, contributor model, and independently landable
  release sequence.
- [LinkedIn network in Chat](./linkedin-network-main-chat-research.md) — a user-provided LinkedIn
  connections import and a private relationship-query surface that remains separate from managed
  public LinkedIn research.
