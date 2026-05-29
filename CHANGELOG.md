# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

No unreleased changes yet.

## [0.4.0] - 2026-05-28

### Added
- Workspace integration resource bindings with encrypted credential storage, multi-connection GitHub repository binding, and runtime validation for bound resources.
- Linear and Slack MCP support, including workspace setup flows, agent editor tool gating, runner-side MCP execution, and `.agent` file configuration.
- Delegated agent sessions through `@agent/<slug>` mentions and a `delegate_to_agent` tool, with child-session tracking and parent usage rollups.
- Repo-scoped GitHub auth for agent shell commands and AMP runs, with ephemeral credentials and output redaction.
- GPT 5.2 Codex support and configurable AMP execution modes.
- Agent editor support for markdown headings, ordered and unordered lists, and automatic conversion of typed or pasted `@`/`#` mentions into pills.
- A richer chat composer with quick-start chips, auto-resize, stop controls, copy-message actions, drag-and-drop and paste handling shells, and improved keyboard hints.

### Changed
- Local setup now keeps WorkOS authentication redirects on `localhost:3000` while continuing to use ngrok for GitHub and other public integration callbacks.
- Production web deploys now rely on the GitHub Actions release workflow instead of Vercel Git-triggered deployments.
- AMP command handling now avoids rejected stream-JSON mode combinations and falls back to sanitized plain output when structured results are unavailable.

### Fixed
- GitHub integration sync in production now avoids unsupported Neon HTTP transactions and normalizes legacy agent configs.
- Sandbox repository clones, AMP publishing, and authenticated shell commands now handle GitHub App credentials more reliably.
- Session chat no longer allows duplicate submissions while an assistant is responding and no longer leaves failed sessions stuck in a thinking state.
- The New agent button now shows immediate pending feedback, blocks double-click creation, and surfaces creation failures.
- Linear MCP credential setup now reports missing encryption-key configuration with clearer diagnostics.

## [0.3.0] - 2026-05-27

### Added
- Deterministic `edit_file` support for hosted agents, giving runner sessions a safer and more reviewable way to modify files.
- Expanded hosted Exa tools and clearer search schema guidance for agent research workflows.
- Common Vercel AI Gateway model presets across the editor, runtime configuration, and billing calculations.
- Model and turn-cost analytics for better visibility into session usage and credit spend.
- Signup welcome emails, session-aware feedback reports, and an onboarding call booking step.
- A pulsing sidebar indicator for active sessions.

### Changed
- Runner internals now separate session lifecycle, job leasing, tool dispatch, model streaming, and usage recording for more reliable hosted runs.
- Agent file parsing, mention handling, runtime types, and after-session behavior now live in the shared agent runtime package used by both web and runner.
- GitHub sync jobs now have retry and sweeper support to recover pending workspace file updates more reliably.
- Development and review tooling now includes CodeRabbit configuration and more consistent local script environment loading.

### Fixed
- Blank user messages now survive session payload handling and runtime event rendering.
- Agent detail mention caches no longer leak across agent boundaries.
- Hosted tool fan-out is capped to avoid runaway parallel tool execution.
- GitHub integration callback diagnostics now expose enough detail to troubleshoot failed setup flows.

## [0.2.0] - 2026-05-26

### Added
- Git-backed agent editing, including file-backed `.agent` sync, rename propagation, and visible GitHub sync state.
- Hosted agent sessions with root-route session start, run controls, archive lifecycle, automatic sandbox pausing, and first-message session titles.
- Agent tools for hosted Exa search and lightweight web fetching.
- WorkOS organization workspace support, signup onboarding, default workspace credits, and personal environment setup.
- Brain context files for agents, plus a more complete workspace file experience.
- Session usage, billing, analytics, and cached-token tracking so teams can understand credit spend.
- Public docs, public changelog, and in-app feedback intake.

### Changed
- Workspace sessions now load from cache first and route transitions respond faster.
- Session UI now better explains reasoning model choice, token usage, tool replay, and follow-up state.
- Workspace loading and agent navigation states are more predictable.
- Release automation now coalesces CI, syncs Inngest production functions, records GitHub deployments, and runs on Blacksmith.
- Observability now covers agent sync, launch events, runner logs, and Better Stack error context.

### Fixed
- AuthKit sign-in and sign-up redirects now use full document navigation when required.
- Runner sandboxes recover more reliably from E2B lifecycle and tool failures.
- Brain new file and new folder actions no longer throw on click.
- Direct session title generation and tool replay behave consistently.
- Production release smoke checks and Render release waiting are more reliable.

### Removed
- Persisted tool delta events and the sidebar running badge to reduce noisy state.

## [0.1.0] - 2026-05-20

### Added
- Initial Next.js app prototype with sidebar navigation, Agents, Brain, Inbox, Settings, and session surfaces.
- Early WorkOS authentication, branchable Neon database setup, and persistent agents.
- Turborepo workspace structure with Bun, shared database package, CI, formatting, tests, and secret scanning.
