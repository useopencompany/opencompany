# Future Concepts

This folder stores speculative product and architecture notes that we want future
agents and teammates to find before designing related work.

Future concepts are not implementation contracts. Treat them as directional
thinking: useful context for planning, discovery, research, and proposal work.
When a concept becomes active product behavior, move the relevant decisions into
the owning spec, architecture doc, migration plan, or code comments.

## Concepts

- [Open-source Readiness](./oss-readiness.md) - decision document for opencompany's
  public naming boundary, monorepo layout, license and open scope, history safety,
  contributor model, and independently landable release sequence.
- [opencompany Headless Core Architecture](./headless-core-architecture.md) -
  reference architecture for the foundation refactor: product vocabulary,
  universal Runs, versioned API and stream contracts, Postgres durability,
  Electric read sync, and the minimal web/mobile monorepo shape.
- [Folder State Architecture](./folder-state-architecture.md) - future model for
  workspace file materialization across Postgres, object storage, GitHub, and
  runtime sandboxes.
- [Generated Artifacts in Main Chat](./main-chat-generated-artifacts-research.md) -
  competitor and open-protocol research plus a recommended contract for promoting
  requested sandbox files into durable, previewable, versioned chat outputs.
- [External Skills Support Research](./external-skills-support-research.md) -
  research and implementation direction for user-configurable external skills.
- [Revolut Business Agent Access](./revolut-business-agent-access-research.md) -
  research and product direction for a read-only Revolut Business finance
  assistant.
- [QM Scope-Centric Agent Architecture](./qm-scope-centric-agent-architecture-research.md) -
  source-backed research on QM's scope model, memory isolation, credential
  grants, channels, tasks, and lack of a persistent agent entity.
- [Goat Plugins — Aligning Skills & Integrations with the Agent Plugins Standard](./goat-plugins-alignment-proposal.md) -
  proposal for bringing Goat's skills and integrations in line with the
  agent-plugins.org packaging standard, with a consent/UX model ahead of what
  the spec itself defines.
