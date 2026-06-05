# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.0] - 2026-06-04

### Added
- Real-time session sync and durable token streaming powered by Electric and Durable Streams, so chat updates propagate live and survive interrupted connections (#283) — @louis.
- New opencode coding agent tool, letting agents run coding tasks through opencode (#266) — @louis.
- Official PostHog MCP support with OAuth / Dynamic Client Registration, so agents can connect to PostHog without manual token wiring (#269) — @louis.
- E2B sandbox compute is now metered and billed as agent usage (#264) — @louis.
- Upload a custom profile picture for your account (#257) — @jasper.
- Credit top-up analytics to track balance refills (#279) — @louis.
- OpenCompany icon assets (#284) — @louis.
- External skills support (V1) — attach a public GitHub repo or skills.sh page to an agent via an `@skill` mention; the skill is snapshotted workspace-side and materialized read-only into the runner sandbox at session start alongside built-in skills (#296) — @louis.

### Changed
- Session detail now paints instantly from local TanStack DB collections instead of waiting on the server (#290) — @louis.
- Improved AI SDK prompt caching for lower latency and cost on repeated context (#275, #285) — @louis.
- The agent self-edit skill now asks before making changes, stays lightweight, and better equips coding agents (#281) — @louis.
- Onboarding call step reworked so its actions fit on a single screen (#263) — @jasper.
- Web functions now run in the Frankfurt region for lower latency to European users (#286) — @louis.
- MCP server tools are now lazy-loaded via per-server `search_tools` / `use_tool` meta-tools, so raw tool schemas are only sent to the model on demand instead of being injected on every turn — eliminating the per-turn token cost of large MCP catalogs like Slack (#298) — @louis.
- Starting a new session from the root-route prompt now navigates instantly; session detail is assembled in-memory from the just-inserted rows instead of waiting on seven follow-up database reads (#295) — @louis.
- E2B sandbox warm-up now begins at the start of a turn so the ~10 s cold-start overlaps the model's initial token stream rather than blocking the first tool call (#297) — @louis.
- Runner parallel-session concurrency is now configurable via `RUNNER_WORKER_CONCURRENCY` (default 8); production limit raised to 40 (#294) — @louis.

### Fixed
- Coalesced durable-stream token appends to fix streaming lag in production (#288) — @louis.
- Electric and Durable Streams now work in local development (#291), with producer linger and in-flight limits tuned for throughput (#292) — @louis.
- Tool output previews are now redacted of secrets before being persisted to the database (#273) — @louis.
- Approval stream state no longer gets stuck out of sync (#272) — @louis.
- opencode now resolves the correct attached repository (#271) — @louis.
- Linear `save_*` MCP tools are no longer misclassified as Admin-only (#267) — @louis.
- @mention pills no longer break after an agent edits itself (#268) — @louis.
- A run is never replayed after its lease expires, and onboarding dedup is hardened against duplicate runs (#262) — @louis.
- The Render deploy trigger is now resilient to empty API responses (#287) — @louis.
- Session status and error no longer flicker blank at the start of a session; the live stream only takes authority over the Postgres snapshot once it has received a status-bearing event (#299) — @louis.

## [0.7.0] - 2026-06-03

### Added
- Agents can now pause mid-run to ask structured questions with single-select, multi-select, and "Other" answers, then continue from the user's response (#255) — @louis.
- Onboarding agents now use structured questions and receive signup names in their starting context, making first-run setup more personal and less brittle (#259, #260) — @louis.
- Apify-backed Instagram and TikTok tools for public profiles, posts, reels, videos, comments, search, and async social scraping jobs (#253) — @louis.
- Searchable, provider-grouped model picker with Capability, Speed, and Cost ratings so models are easier to compare at a glance (#254) — @louis.
- Day-one Brain wiki and private agent `agent/soul.md` scaffolding, giving new workspaces a cleaner shared knowledge structure and better self-configuration defaults (#251) — @louis.

### Changed
- Onboarding call booking now uses one booking-aware button, the official Cal.com embed bootstrap, and clearer new-tab labeling (#249, #250, #258) — @jasper.
- Public changelog entries now include author attributions (#256) — @louis.

### Fixed
- Chat scroll-to-top behavior after sending a message is now stable during streaming and viewport resizing, with less jitter and less fighting user scrolls (#248) — @jasper.
- Paused sessions now refresh stream tokens correctly, and settings hydrate consistently after reloads (#252) — @louis.
- Editing a markdown title or header no longer flickers while typing (#201) — @jasper.
- Naming a new Brain file from its tab now updates the sidebar tree immediately (#198) — @jasper.

## [0.6.0] - 2026-06-02

### Added
- Guided first-run setup — after signing up you land in a live setup conversation that helps configure your workspace, instead of an empty editor (#241) — @louis.
- New `/btw` command to start a new session without leaving your current view (#243) — @louis.
- New `/clear` command in the chat composer (#231) — @louis.
- "Run now" button to trigger a scheduled agent immediately (#236) — @louis.
- Agents can now pull content from TikTok and Instagram (#239) and YouTube (#233) — @louis.
- Pin sessions to the top of the sidebar (#213) — @jasper.
- Live product status indicator in the sidebar, linking to the public status page (#224) — @louis.
- Agents can now adjust their own schedules (#217) — @louis.
- Workspace tool permissions — allow, ask, or deny which tools and integrations an agent can use, with approval prompts that are remembered between runs (#229) — @louis.
- Live reasoning support for Kimi models (#226) — @louis.
- Provider logos for xAI and MiniMax in the model picker (#232) — @jasper.

### Changed
- Agent runs no longer break when an integration like Linear or Slack is turned on but not yet connected — the agent now asks you to connect it instead (#238) — @louis.
- When you send a message, it scrolls to the top of the chat, matching the ChatGPT/Claude experience (#219) — @jasper.
- The copy button now stays visible on assistant replies and appears on hover for your own messages (#222) — @jasper.
- The onboarding call step now has a clear "Skip for now" button (#220) — @jasper.
- The "reconnecting" banner no longer appears in chat during normal streaming; connection status now lives in the inspector instead (#242) — @louis.

### Fixed
- Linear no longer shows as disconnected after you reconnect with valid credentials (#234) — @louis.
- Agent turns that quietly stop mid-task are now flagged instead of being recorded as a silent success — important for scheduled and unattended runs (#225) — @louis.
- Sessions now recover when a response stream gets interrupted (#223) — @louis.
- Rapidly toggling a session's pin no longer causes glitches (#218) — @jasper.
- Restored the after-session hook menu when typing at the start of a line (#227) — @jasper.
- The hook suggestion popup now stays beneath the model dropdown (#230) — @jasper.

## [0.5.0] - 2026-06-01

### Added
- Cron-based agent schedules — agents can now be scheduled to run on a recurring basis (#208) — @louis.
- Read-only X (Twitter) hosted tool for agents (#212) — @louis.
- Agent self-update skill, allowing agents to evolve their own `.agent` definition (#210) — @louis.
- Dark mode support (#186) — @louis.
- Grok model support via the AI gateway (#206) — @louis.
- MiniMax and Kimi gateway models (#193) — @louis.
- Client-side felt time-to-first-token measurement (#192) — @louis.

### Changed
- GitHub repositories are now decoupled from the amp tool, making repository bindings more flexible (#204) — @louis.
- Lazy GitHub sandbox initialization is more solid and reliable (#207) — @louis.
- Vercel Skew Protection is enabled via custom `deploymentId` for safer deploys (#205) — @louis.
- Onboarding call booking step is now skippable (#191) — @jasper.
- Assistant turn duration is now shown next to the copy button (#187) — @jasper.

### Fixed
- Agents no longer disappear from the list after creating or editing a new agent (#203) — @jasper.
- Renaming an agent no longer resets it to "Untitled agent" (#194) — @jasper.
- Vercel deployment ID length is correctly handled (#211) — @louis.
- Session archiving is now optimistic and instant instead of waiting on the server (#200) — @jasper.
- Feedback dialog auto-closes after a successful submit (#190) — @jasper.
- Page no longer rubber-bands at the fold due to `overscroll-behavior` fix (#189) — @jasper.

## [0.4.1] - 2026-05-30

### Changed
- Runner job worker now wakes immediately on enqueue instead of waiting for the next poll interval, reducing time-to-first-token for agent sessions — @louis.
- Web dispatch no longer blocks on analytics flush; PostHog capture and runner dispatch now run concurrently — @louis.
- Workspace context loading collapses user, workspace, and role into a single joined query, and session submission runs the balance check and auth lookup concurrently, cutting pre-dispatch database round-trips — @louis.

### Fixed
- Runner event serialization no longer crashes when `created_at` arrives as a string from the raw lease-write path; the value is now coerced to a `Date` at the source — @louis.

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
