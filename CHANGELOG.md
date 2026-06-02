# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Guided first-run setup — after signing up you land in a live setup conversation that helps configure your workspace, instead of an empty editor (#241).
- New `/btw` command to start a new session without leaving your current view (#243).
- New `/clear` command in the chat composer (#231).
- "Run now" button to trigger a scheduled agent immediately (#236).
- Agents can now pull content from TikTok and Instagram (#239) and YouTube (#233).
- Pin sessions to the top of the sidebar (#213).
- Live product status indicator in the sidebar, linking to the public status page (#224).
- Agents can now adjust their own schedules (#217).
- Workspace tool permissions — allow, ask, or deny which tools and integrations an agent can use, with approval prompts that are remembered between runs (#229).
- Live reasoning support for Kimi models (#226).
- Provider logos for xAI and MiniMax in the model picker (#232).

### Changed
- Agent runs no longer break when an integration like Linear or Slack is turned on but not yet connected — the agent now asks you to connect it instead (#238).
- When you send a message, it scrolls to the top of the chat, matching the ChatGPT/Claude experience (#219).
- The copy button now stays visible on assistant replies and appears on hover for your own messages (#222).
- The onboarding call step now has a clear "Skip for now" button (#220).

### Fixed
- Linear no longer shows as disconnected after you reconnect with valid credentials (#234).
- Agent turns that quietly stop mid-task are now flagged instead of being recorded as a silent success — important for scheduled and unattended runs (#225).
- Sessions now recover when a response stream gets interrupted (#223).
- Rapidly toggling a session's pin no longer causes glitches (#218).
- Restored the after-session hook menu when typing at the start of a line (#227).
- The hook suggestion popup now stays beneath the model dropdown (#230).

## [0.5.0] - 2026-06-01

### Added
- Cron-based agent schedules — agents can now be scheduled to run on a recurring basis (#208).
- Read-only X (Twitter) hosted tool for agents (#212).
- Agent self-update skill, allowing agents to evolve their own `.agent` definition (#210).
- Dark mode support (#186).
- Grok model support via the AI gateway (#206).
- MiniMax and Kimi gateway models (#193).
- Client-side felt time-to-first-token measurement (#192).

### Changed
- GitHub repositories are now decoupled from the amp tool, making repository bindings more flexible (#204).
- Lazy GitHub sandbox initialization is more solid and reliable (#207).
- Vercel Skew Protection is enabled via custom `deploymentId` for safer deploys (#205).
- Onboarding call booking step is now skippable (#191).
- Assistant turn duration is now shown next to the copy button (#187).

### Fixed
- Agents no longer disappear from the list after creating or editing a new agent (#203).
- Renaming an agent no longer resets it to "Untitled agent" (#194).
- Vercel deployment ID length is correctly handled (#211).
- Session archiving is now optimistic and instant instead of waiting on the server (#200).
- Feedback dialog auto-closes after a successful submit (#190).
- Page no longer rubber-bands at the fold due to `overscroll-behavior` fix (#189).

## [0.4.1] - 2026-05-30

### Changed
- Runner job worker now wakes immediately on enqueue instead of waiting for the next poll interval, reducing time-to-first-token for agent sessions.
- Web dispatch no longer blocks on analytics flush; PostHog capture and runner dispatch now run concurrently.
- Workspace context loading collapses user, workspace, and role into a single joined query, and session submission runs the balance check and auth lookup concurrently, cutting pre-dispatch database round-trips.

### Fixed
- Runner event serialization no longer crashes when `created_at` arrives as a string from the raw lease-write path; the value is now coerced to a `Date` at the source.

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
