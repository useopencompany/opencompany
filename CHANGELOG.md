# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.12.0] - 2026-08-11

### Changed
- Chat runs on a rebuilt real-time backend: replies stream in faster and pick up right where they left off if your connection drops or you reload the page mid-response (#1167, #1168, #1169, #1170, #1172, #1173, #1175, #1176, #1177, #1178, #1179, #1180, #1181, #1182) — @louis and @opencompany-bot.

### Fixed
- Tool call results now stay in the right order instead of jumping around while a reply is still streaming in (#1183) — @louis.

## [1.11.0] - 2026-08-10

### Added
- Import skills from a public GitHub repo or a skills.sh page by pasting a link, so your workspace can reuse skills other people have published instead of writing your own from scratch (#1140) — @opencompany-bot.
- Qwen 3.8 Max is now available as a chat model (#1153) — @opencompany-bot.

### Changed
- Wiki pages are faster and closer to Notion: edits show up instantly, and a new `/` slash menu lets you insert blocks and links without leaving the keyboard (#1148, #1149) — @opencompany-bot.
- Cmd+K now shows archived chats alongside active ones, sorted by recency, so you can jump back into an old conversation without digging through the archive separately (#1147) — @opencompany-bot.

### Fixed
- Chats that stalled mid-response now recover on their own instead of hanging indefinitely (#1146) — @opencompany-bot.
- Archiving a chat no longer risks crashing the page — you'll see a clear error and can retry if something goes wrong (#1155) — @opencompany-bot.
- A chat's unread status and a task's ability to keep going no longer break right after we ship an update (#1150, #1151, #1154) — @opencompany-bot.
- If a model provider errors out mid-reply, you keep whatever it had already written instead of losing the response (#1152) — @opencompany-bot.
- Shared links to the pricing, use-cases, media, ship, and blog pages now show a preview image on X, WhatsApp, and Slack (#1126) — @opencompany-bot.
- The chat header now lines up correctly with the sidebar above it (#1134) — @opencompany-bot.

## [1.10.0] - 2026-08-07

### Added
- Post to X (Twitter) right from chat — connect one or more accounts in Settings, then ask Goat to post to one account or several at once (#1109, #1121) — @opencompany-bot.
- Goat can now generate real files in chat — spreadsheets, PDFs, slides, docs, and images — that you can preview, download, and share, instead of only markdown replies (#1137) — @opencompany-bot.
- Wiki (preview): a self-building company wiki that lives alongside chat, with linked pages, cited sources, and a Notion-style editor. Turn it on under Preferences > Beta features (#1133, #1136, #1138, #1139, #1143) — @opencompany-bot.
- A new pricing page lays out the Hobby and Pro plans side by side, and the marketing site nav gained a "Book demo" option (#1110) — @opencompany-bot.

### Changed
- Onboarding is shorter — new workspaces get their Brain folders set up automatically instead of asking you to arrange them upfront (#1114) — @opencompany-bot.
- Chats you start now show up in the sidebar the moment you send them, instead of a moment later (#1130, #1135) — @opencompany-bot.
- The changelog moved from the sidebar footer into the account menu (#1115) — @opencompany-bot.
- Popovers, dialogs, and menus now use softer, more natural shadows instead of hard-edged ones (#1124) — @opencompany-bot.

### Fixed
- Chat tables no longer split words letter-by-letter into narrow columns (#1128) — @opencompany-bot.
- A chat open in two browser tabs now shows the same running or finished status in both, instead of disagreeing (#1129) — @opencompany-bot.
- Approving an X post now shows a clear, readable summary of what's about to be posted instead of raw data (#1125) — @opencompany-bot.
- Approving an action no longer briefly flashes a false "could not produce a response" error before the real answer (#1118) — @opencompany-bot.
- Claude Code no longer shows your account as disconnected just because you temporarily hit a usage limit (#1127) — @opencompany-bot.
- Claude Code skills are discovered reliably again, and skills mentioned when starting a workflow are no longer dropped (#1131, #1120) — @opencompany-bot.
- Claude Code sessions that run background subagents now reliably return with an answer instead of stopping silently (#1113) — @opencompany-bot.
- Coding tasks recover automatically after brief sandbox network hiccups instead of failing outright, and archiving a chat now reliably stops any coding work still scheduled for it (#1112, #1111) — @opencompany-bot.
- Codex sessions stay connected instead of periodically asking you to reconnect (#1117) — @opencompany-bot.
- Connecting Infisical is more reliable, including for the EU region and for sandboxes that previously failed to provision secrets (#1116, #1119, #1122) — @opencompany-bot.

## [1.9.0] - 2026-08-06

### Added
- OpenCompany Hobby: a free plan with $5 of included usage refreshed monthly, for single-member workspaces, alongside Pro (#1095) — @opencompany-bot.
- Connect Infisical as a workspace integration in Settings so Codex and Claude Code coding sandboxes can pull your secrets automatically (#1096) — @opencompany-bot.
- Chat and Brain now accept CSV, TSV, Markdown, plain text, and JSON uploads, not just images and PDFs (#1104) — @opencompany-bot.

### Changed
- Cmd+K is now a real command palette: search your chats and jump to actions from one input, with compose as a separate step instead of crowding the search box (#1093) — @opencompany-bot.
- Signing in and signing up now happen on our own pages instead of a WorkOS hosted picker — pick Google or email magic link, and we remember which one you used last (#1099) — @opencompany-bot.

### Fixed
- The Goat home page's chat and task list scrolls properly again instead of getting cut off (#1098) — @opencompany-bot.
- Fixed a bug where interrupting a tool call, like a browser action, could break the next message you sent in that chat (#1103) — @opencompany-bot.

## [1.8.0] - 2026-08-05

### Added
- Goat can now create Attio records — people, companies, and deals — directly from chat, alongside the existing search, update, and comment support (#1068) — @opencompany-bot.
- @claude now starts a Claude Code session from the composer, the same way @codex already does (#1071, #1091) — @opencompany-bot.
- Composer drafts now save per chat — switch away mid-sentence and your unsent text is still there when you come back (#1069) — @opencompany-bot.

### Changed
- Background chats started with `&` can now be launched from any chat, including while another chat or Codex session is still running, and the directive is highlighted as you type it (#1064, #1070, #1081, #1088) — @opencompany-bot.
- Goat usage is now billed at cost with no platform markup, and included monthly usage is tracked separately from top-up funds (#1083) — @opencompany-bot.
- Typing in the coding workspace terminal now feels instant instead of waiting on the remote echo (#1062, #1076) — @opencompany-bot.

### Fixed
- The sidebar no longer shows a background chat as unread before it has actually started running (#1086) — @opencompany-bot.
- The sidebar's working indicator no longer lags behind a chat that keeps generating after you navigate away (#1065) — @opencompany-bot.
- Task sessions no longer show duplicate task cards, and `@skill` mentions work again inside them (#1075, #1092) — @opencompany-bot.
- Starting a Codex task from Kimi, Grok, or Claude in main chat now hands off to the right model instead of misrouting it (#1079) — @opencompany-bot.
- Fixed a race that could mark a Codex coding task as failed even though it was still running (#1072) — @opencompany-bot.
- The coding workspace preview picker correctly detects open ports again (#1090) — @opencompany-bot.
- The chat composer no longer overlaps the latest message when it grows tall (#1085) — @opencompany-bot.
- Opening a chat from the sidebar now focuses the composer automatically (#1078) — @opencompany-bot.
- Automatic model routing is now more reliable, with better diagnostics when something goes wrong (#1084) — @opencompany-bot.

## [1.7.0] - 2026-08-04

### Added
- OpenCompany Pro: a $20/month plan for a single workspace with room for up to 10 members, managed through Stripe billing (#1052) — @opencompany-bot.
- Voice dictation in the composer — tap the mic, watch your words appear live, and edit before sending (#1054) — @opencompany-bot.
- Connect Neon as a read-only integration to ask about your database's projects, branches, schemas, and data (#1056, #1059) — @opencompany-bot.
- Goat can now post comments on Attio records, list entries, and threads (#1055) — @opencompany-bot.
- Start a background chat straight from the composer by beginning your message with `&` (#1060) — @opencompany-bot.

### Changed
- Integrations that lose their connection now show a clear "Needs reconnect" state in Settings instead of failing silently (#1053) — @opencompany-bot.

### Fixed
- The sidebar's working indicator no longer lags behind chats that are actively running (#1051) — @opencompany-bot.
- The coding workspace preview picker no longer lists internal sandbox ports as if they were your app (#1058) — @opencompany-bot.

## [1.6.0] - 2026-08-03

### Added
- Read, update, and append rows in Google Sheets from chat, alongside the existing Google Docs support (#1047) — @opencompany-bot.
- Share links now cover task runs and Codex/Claude Code cloud coding sessions too, not just regular chats (#1043, #1044) — @opencompany-bot.
- Finished tasks that resulted in a GitHub pull request now show a direct link to it in the task's Properties panel (#1015) — @opencompany-bot.

### Changed
- The sidebar and chat list status indicator now shows a distinct spinner for chats actively running, instead of only marking finished ones unread (#1046) — @opencompany-bot.
- Workflow steps now hand off to the next step with a focused brief instead of the whole prior transcript, and each step's activity shows up in the task's timeline (#1036, #1048) — @opencompany-bot.

### Fixed
- Shift+Enter in the composer now inserts a newline instead of sending the message (#1035) — @opencompany-bot.
- Chats no longer show a stale unread indicator after a live reply has already arrived (#1042) — @opencompany-bot.
- Scheduled tasks and workflows now fire reliably instead of occasionally being skipped (#1039) — @opencompany-bot.
- Interrupted chat turns now recover cleanly, without losing the assistant's reply or double-sending an iMessage notification (#1040) — @opencompany-bot.
- Looking up a company's employees now returns clean results, with a clear prompt instead of an error when nothing matches (#1049) — @opencompany-bot.
- Fixed a database migration gap that could silently block iMessage notifications from sending (#1045) — @louis.

## [1.5.0] - 2026-08-01

### Added
- Get notified over iMessage when Goat needs your input or finishes a task, with a secure device-pairing flow (#1025) — @louis.
- Connect an authenticated browser profile so Goat can research pages that need you to be logged in; sensitive sites like banking are blocked by default (#1028) — @opencompany-bot.
- Workflows can now run on a schedule, set with a plain-language frequency builder — every N minutes or hours, daily, weekdays, or weekly — instead of raw cron (#1009, #1020) — @opencompany-bot.
- Start a one-off background task straight from the composer with `#task`, no need to save it as a workflow first (#987) — @opencompany-bot.
- Pick the coding model for each step in a workflow, and use Claude Code as a workflow step engine (#1005, #1022) — @opencompany-bot.
- Workflow tasks started from chat can now carry attachments (#1012) — @opencompany-bot.
- Tasks and workflows are now visible to your whole workspace, not just whoever started them (#1013) — @opencompany-bot.
- The Tasks page can switch to a dense list view alongside the existing board (#992) — @opencompany-bot.
- Claude Code sessions can now read from your connected tools — Slack, Gmail, Linear, and more — matching what Codex sessions could already do (#989, #1008) — @opencompany-bot.
- The sidebar now shows a live status dot on each chat for running, waiting-on-you, and errored states (#1011) — @opencompany-bot.
- Codex chats show their live plan as a running checklist while they work (#1010) — @opencompany-bot.

### Changed
- @mentioning Claude Code or Codex in the composer now applies to that one message only, instead of switching the chat's engine for good (#1016) — @opencompany-bot.
- New workflows are active by default instead of needing a manual toggle, and workflow mentions are now highlighted in the composer (#1002, #1007) — @opencompany-bot.
- Workflow step lists now render in the read-only run detail view (#1030) — @opencompany-bot.

### Fixed
- Long Linear issue descriptions and comments up to Linear's own limit are no longer rejected early (#1032) — @opencompany-bot.
- Stopping a task now reacts immediately across Claude Code, Codex, and OpenCompany chat engines (#1023) — @louis.
- Scheduled task wakeups now reliably fire across all chat engines (#1024) — @louis.
- The sidebar no longer flashes stale data on refresh (#1026) — @opencompany-bot.
- Cloud coding workspace terminals no longer freeze while typing during a slow background operation (#982) — @louis.
- The cloud terminal no longer offers to autofill saved passwords (#986) — @opencompany-bot.
- Fixed a bash syntax bug that could block every cloud coding session from starting (#979) — @louis.
- Tasks and workflow runs now hold up better through runner restarts and deploys, without losing chat history or duplicating messages (#988, #990, #991, #993, #995, #1019, #1031) — @opencompany-bot and @louis.
- Assorted workflow composer fixes: mentions stay available in engine mode, the caret stays aligned, duplicate stop controls are gone, and task titles and sources display correctly (#994, #996, #997, #999, #1000, #1003, #1004, #1006) — @opencompany-bot.

## [1.4.0] - 2026-07-29

### Added
- New Tasks & Workflows board: a Kanban view of every chat and workflow run, with a time-range filter and a Linear-style detail panel where you can reply to a task like a normal chat (#957, #963, #964, #973, #947) — @louis and @opencompany-bot.
- Workflows now run as sequential multi-step tasks with a model and skill per step, and can be started directly from main chat just by asking (#967, #953, #948) — @louis and @opencompany-bot.
- Codex and Claude Code chats get a persistent Preview and Terminal workspace, tucked behind a single toggle in the chat header until you need it (#962, #972, #976) — @louis and @opencompany-bot.
- Configure per-repository environment and setup for Codex and Claude Code sandboxes, stored encrypted (#956) — @louis.
- Codex sessions can now save findings to the Brain, same as main chat (#965) — @opencompany-bot.
- Ask Goat to create a Google Doc, optionally pre-filled with text (#950) — @opencompany-bot.
- Connect PostHog to ask about dashboards, saved insights, and analytics queries from chat (#969) — @opencompany-bot.
- Claude Fable 5 and DeepSeek V4 Pro are now available as chat models (#975, #946) — @opencompany-bot.
- Shared chat links now show the chat's title and a branded preview card when unfurled elsewhere (#961) — @opencompany-bot.
- Automatic model routing (beta): turn it on under Preferences > Beta features to have Goat pick the model for your first message (#966, #968, #970) — @opencompany-bot.

### Changed
- Cmd+K now opens the full composer — attachments, @mentions, and the model picker included — instead of a bare text box, and always starts a new chat in the background (#949) — @opencompany-bot.

### Fixed
- Claude Code sandboxes no longer race two agents on the same chat after a runner restart, which could revert files or duplicate commits (#974) — @louis.
- Scheduled Claude Code wakeups now reliably fire even across restarts (#971) — @louis.
- Removing a Linear issue's project from chat now actually clears it instead of being silently ignored (#958) — @louis.
- The onboarding message that kicks off Brain building now always sends on the first try, and new chats default to Kimi K3 (#955) — @opencompany-bot.

### Removed
- Removed the retired Local Codex bridge, including its beta preference and composer option; leftover Local Codex chat sessions were cleaned up (#959, #960) — @opencompany-bot.

## [1.3.0] - 2026-07-28

### Added
- Claude Code is now a persistent sandbox chat engine in Goat, with subscription authentication, model and effort controls, attachments, resumable sessions, and expandable subagent traces (#928, #930, #935) — @louis and @opencompany-bot.
- Build durable workspace workflows and reusable skills, edit their instructions with rich Markdown, and mention skills from workflow instructions with autocomplete (#927, #934, #937) — @louis and @opencompany-bot.
- Main chat can discover and use relevant workspace skills without requiring an explicit `@skill` mention (#909) — @opencompany-bot.
- Cloud Codex tasks can safely read from connected tools that are enabled for read-only access, without exposing provider credentials to the sandbox (#914) — @opencompany-bot.
- Goat can create Gmail drafts without sending them, controlled by a separate per-account permission (#922) — @opencompany-bot.
- Latitude is now available as a personal integration for chat and background tasks, with per-capability read and write controls (#925) — @opencompany-bot.
- Switch between workspaces or create a new one directly from the workspace picker (#901) — @opencompany-bot.
- Search within timestamped YouTube transcripts or bring a complete transcript into chat (#920, #933) — @louis and @opencompany-bot.
- Look up a known prospect's work email from their name and company or LinkedIn profile, without re-running broad prospect research (#938) — @opencompany-bot.
- Workspace admins can cap paid capability spend per chat, with one-off approval when a request would exceed the budget (#941) — @louis.

### Changed
- Paid research turns can now run up to six long-running capability calls instead of one (#940) — @louis.
- Opening a Brain overview is now instant, even for Brains with many large documents (#919) — @opencompany-bot.
- Claude Sonnet chats now reuse prompt context more efficiently through automatic prompt caching (#899) — @louis.
- Goat analytics now use a minimal PostHog setup with four allowlisted events and no autocapture, session recording, heatmaps, or message content (#923, #931) — @opencompany-bot and @louis.
- Chat headers use tighter spacing so the conversation has more room (#936) — @opencompany-bot.

### Fixed
- Approving or declining a connected-tool action no longer repeats a successful write in the same turn (#917) — @louis.
- Cloud Codex work now survives runner deployments, paused-sandbox resumes, and transient sandbox placement failures more reliably (#918, #921, #924, #926) — @louis.
- Workspace invitations now open the invited workspace directly and keep the active workspace in sync after sign-in (#902) — @opencompany-bot.
- Claude Code setup accepts tokens copied with wrapping whitespace, and its home cards now show the correct engine and status (#929, #932) — @louis.
- Long Claude Code turns can survive repeated runner handoffs without stranding the work (#939) — @louis.

## [1.2.0] - 2026-07-27

### Added
- Share any Goat chat as a live, read-only link, then stop sharing whenever you want; sharing it again creates a fresh URL so old viewers stay locked out (#892, #896) — @opencompany-bot.
- Goat Quick brings chat to the macOS menu bar with an Option-Command-Space shortcut (#876, #877) — @louis.
- Goat can browse full websites in a persistent sandbox and read up to four specific URLs per turn alongside multi-search web research (#866, #868, #881, #906) — @louis and @opencompany-bot.
- Connected tools can now take guarded actions from chat with per-connection On, Ask, and Off controls: create Calendar events; create, update, and comment on Linear issues; send Gmail; read and edit Google Docs; read Slack; and read, update, or configure Attio lists (#842, #843, #851, #859, #870, #873, #891, #894, #895, #897, #905) — @louis and @opencompany-bot.
- New managed research capabilities cover X, LinkedIn, YouTube, Instagram, TikTok, Semrush SEO, and structured prospect search, with a price quote and approval before paid calls (#869, #874, #887, #888) — @louis and @opencompany-bot.
- Connect a workspace Stripe account to ask read-only questions about payments, balances, subscriptions and estimated MRR, or open invoices (#890) — @opencompany-bot.
- Cloud Codex tasks can query their active Brain, with access checked again on every call (#884) — @opencompany-bot.
- Ask main chat to survey Slack, Gmail, and Linear and save focused findings to the Brain with their original source attached (#838) — @louis.
- Attach `.srt` subtitle files in chat, save them to the Brain, or pass the originals into Cloud Codex (#907) — @opencompany-bot.
- New workspace owners now receive a short founder onboarding email series with one-click unsubscribe (#900) — @louis.
- A new shareable [use-cases page](https://www.opencompany.cloud/use-cases) shows what OpenCompany can do (#885) — @louis.

### Changed
- The Slack answer bot now runs through the full Goat agent, understands follow-up threads, can work across multiple Brains, and shows live status while it works (#854) — @louis.
- You can keep drafting your next message while Goat responds, tool rows are less cluttered, and the context-window meter updates throughout multi-step turns (#857, #871, #872, #904) — @opencompany-bot.
- Onboarding now guides connected sources all the way to actively feeding the Brain, and valid company URLs are no longer blocked by temporary reachability checks (#852, #883) — @louis and @opencompany-bot.
- Brain queries now default to curated pages, paginate consistently across chat, MCP, and the CLI, and keep raw evidence available when you explicitly need it (#880) — @louis.
- Basic Brain ingestion is more efficient, groups each GitHub pull request lifecycle into one filing pass, and preserves valid source citations (#846, #847, #848, #849, #850, #853) — @louis and @opencompany-bot.

### Fixed
- Accepted workspace invitations now appear after sign-in even when you already belong to another workspace (#889) — @opencompany-bot.
- Brain sidebar context-menu actions work with the mouse again, and each chat keeps its original model instead of inheriting a choice from another tab (#864, #865) — @louis and @opencompany-bot.
- Cloud Codex handoffs and long, parallel, or paid chat actions recover more reliably instead of timing out or rejecting valid tool calls (#858, #862, #875, #878, #879, #882, #886) — @louis.
- Brain tool results no longer appear twice in the model's chat context (#903) — @louis.

## [1.1.0] - 2026-07-22

### Added
- Four new brain sources file in automatically: Attio, HubSpot, Fathom, and Granola — so your CRM records, meeting notes, and calls land in the brain without you lifting a finger (#776, #757, #767, #758) — @louis.
- Ask Goat right from Slack — mention @opencompany in a channel and it answers from your brain (beta) (#759) — @louis.
- Goat chat can now search across your connected tools — Slack, Gmail, GitHub, Linear, Attio, Google Drive, and Google Calendar — and pull the results straight into the conversation (#830, #828, #832, #831, #807) — @louis.
- Chat answers now cite the brain sources they came from, so you can see where an answer is grounded (#775) — @louis.
- Codex coding sessions run in the cloud and show up as Tasks, with model selection and file attachments (#784, #766, #771) — @louis.
- The changelog now lives in the sidebar, so you can see what's new without leaving the app (#833) — @louis.
- Browse and restore your archived chats from the ⌘K palette (#796) — @louis.
- Goat remembers the model you picked for main chat between sessions (#829) — @louis.
- Kimi K3 is now in the model picker (#777) — @louis.
- A sidebar feedback widget sends your bugs and ideas straight to our team (#764) — @louis.
- Save anything to your brain over MCP from any agent (#748) — @louis.
- Migrated the OpenCompany blog archive into the new marketing site, keeping its existing URLs and search metadata (#765) — @louis.

### Changed
- Billing is now a pure pay-as-you-go wallet — you pay only for what you use and top up yourself, with no seats or plans (#802) — @louis.
- The integrations settings page was redesigned as a clean grid of brand cards, with a scope switcher and the option to connect tools during onboarding (#810, #824, #834) — @louis.
- Brain ingestion is more reliable, resumes cleanly after upgrades, and brain search now returns sharper, better-ranked results (#792, #770, #835) — @louis.
- A context-usage tooltip shows how full the model's context window is, and switching between chats is now instant (#795, #804) — @louis.

### Fixed
- Linear now reconnects cleanly instead of getting stuck showing as disconnected (#814) — @louis.
- Codex chat sessions no longer get stuck when queued, closed, or interrupted by a deploy (#794, #798, #812) — @louis.
- Attio system noise is kept out of the brain, and Attio ingestion is more robust (#819, #781) — @louis.
- Integration setup failures now show a clear error instead of failing silently (#821) — @louis.
- Checkout is more reliable, with fixed promotion-code and idempotency handling (#761, #763) — @louis.

## [1.0.0] - 2026-07-15

Goat is a company brain — it turns your team's tools and conversations into a
shared, structured knowledge base and brings it to any agent over MCP. This is
its first release at [my.opencompany.chat](https://my.opencompany.chat).

### Added
- Goat is here: a company brain that files what matters from your team's tools and conversations, links it to what you already know, and serves it to any agent over MCP (#554) — @louis.
- Goat Brain is a typed, folder-organized knowledge base with an evidence taxonomy, wiki-style links rendered as chips, and first-class binary documents including PDFs (#558, #607, #611, #615, #620, #613) — @louis.
- Brains ingest from your sources automatically — Jamie meeting notes, GitHub (PRs, issues, comments), Gmail, Linear, Google Drive, X, and chat captures — filing and linking what matters (#575, #652, #659, #641, #715, #573, #631) — @louis.
- Ingestion can enrich entries with web search, respects per-brain spend budgets, and imports company context during onboarding (#691, #725, #724, #728) — @louis.
- Goat chat streams live with disconnect-safe, resumable sessions, file attachments that flow end-to-end into the brain, chat pinning, background chats, and Cmd+K to start a new one (#633, #700, #731, #577, #627) — @louis.
- Codex-backed sessions run in Goat across cloud and local sandboxes, with in-chat controls, sandbox status, and per-task engine selection (#555, #649, #624, #662, #661) — @louis.
- Tasks can run on a schedule, notify their originating chat on completion, expose their harness config, and sit behind a background-task preference (#560, #557, #559, #717) — @louis.
- A single user-level MCP endpoint at `/mcp` exposes every brain you can access, with a personal MCP settings tab and member onboarding (#739, #600, #714) — @louis.
- Workspaces gate brain access with member-level permissions, member-contributed sources, multi-account connections, and cross-member deduplication (#596, #656, #740) — @louis.
- Workspace billing ships with pooled monthly allowances, per-seat pricing, USD credits, per-brain intelligence tiers, credit top-up promotion codes, and a spend overview with charts (#718, #732, #742, #745, #648, #651) — @louis.
- A brain overview dashboard, activity feed, and settings overview give each brain a home, alongside a model picker, Fumadocs-powered docs, browser research tools, an onboarding flow, and new app icons (#741, #625, #669, #594, #572, #576, #710, #727) — @louis.
- Codex chats get auto-generated titles, and Goat gained an appearance theme toggle and a quicker new-brain action in the sidebar (#668, #703, #702) — @opencompany-bot.

### Changed
- Brain retrieval was rebuilt on a Postgres-native read plane and unified into a single surface; chat and MCP now read the brain read-only, with all writes flowing through ingestion (#621, #695, #690) — @louis.
- Navigation across the brain and app is now client-first for instant transitions (#591, #635) — @louis.
- The sidebar gained a workspace switcher in its header, recent-chat history, archive-on-hover, and a per-brain context menu (#667, #696, #698, #712) — @louis.
- The ingestion model was updated, the per-event ingestion budget was raised to one dollar, and the browser tab now reads "OpenCompany" (#655, #734, #747) — @louis.

### Fixed
- Brain ingestion no longer suffers retry storms or conflict-page pollution, and retrieval tracking is accurate (#707, #743) — @louis.
- Fixed an infinite render loop that froze brain navigation and a composer freeze when input scrolled past its max height (#736, #730) — @louis.
- Goat chat session continuity and post-completion navigation are reliable, and chat pin transactions are consistent (#590, #706, #737) — @louis.
- Jamie webhook API-key handling and setup were corrected (#580, #654) — @louis.

## [0.18.0] - 2026-06-25

### Added
- Agents can now run Codex-backed sessions with persisted auth, sandbox lifecycle support, runtime event ingestion, and transcript UI support behind the Codex engine flag (#525) — @louis.
- Google Drive is now available as a first-party integration with OAuth, Drive search/read/export tools, and Google Docs create/update tools (#515) — @louis.
- Company workspaces now have a dedicated Integrations tab for first-party and MCP integration controls (#522) — @louis.
- Personal routines now include scheduling with create, edit, delete, toggle, run-now, next-run, and timezone controls (#458, #507) — @louis.
- Billing now supports weekly spending limits and automatic credit refills with saved cards (#505) — @jasper.
- Delegated coding and memory tools now use a runner-hosted LLM token broker, keeping raw provider keys out of sandboxes while metering brokered usage server-side (#439) — @louis.
- Z.ai GLM-5.2 is now available in the model catalog with billing and reasoning-capable model support (#486) — @opencompany-bot.
- Local development can now persist Turbo logs and inspect them through `bun run dev:logs` (#518) — @louis.
- Codex E2B toolbox templates now include Playwright and Playwright-managed Chromium for browser-ready coding sessions (#525) — @louis.

### Changed
- Mobile Memory pages now let users swipe the file tree away for a full-width file view, while guarding iOS edge-back gestures (#510) — @jasper.
- Tool-call cards now show the brand icon for external services like Linear, Slack, Gmail, GitHub, Notion, PostHog, Google Calendar, Google Drive, and Neon (#524) — @jasper.
- After-session memory updates now appear as a compact footer badge with a tooltip and link to the spawned memory-pass session (#526) — @louis.
- The personal and company sidebar space switcher is now a dropdown, and the private beta badge has been removed (#520) — @louis.
- Feedback reports now use a one-tap Bug, Feedback, and Idea segmented selector with Feedback selected by default (#499) — @jasper.
- Company and personal route navigation now uses faster links, debounced prefetching, and loading skeletons for slow routes (#523) — @louis.

### Fixed
- Google Drive OAuth now uses the narrower `drive.file` scope so production connections are not blocked by full-Drive restricted-scope verification (#517) — @louis.
- iOS PWA layouts now respect safe-area insets, avoid keyboard popups in the mobile model picker, use full-width chat messages on phones, and prevent mobile settings clipping (#501, #504) — @jasper.
- MCP reconnect and tool-discovery failures now return recoverable tool outputs instead of failing the whole session (#503) — @louis.
- Durable Stream publishing now retries with a fresh producer when a cached producer has already closed, improving live delivery for lifecycle and memory events (#502) — @louis.
- The automatic-refill Add a card flow now passes the required Stripe Checkout currency (#511) — @jasper.
- Personal session unread dots are visible again and are no longer re-armed by background after-session memory passes (#509, #513) — @jasper.
- Existing personal agents now backfill missing `soul.md` files so the Soul nav opens the editor instead of jumping to a new chat (#514) — @jasper.
- Company sidebars no longer show personal-agent threads in recent or pinned session history (#521) — @louis.
- Reading position is preserved when completed work blocks collapse or expand in long session transcripts (#508) — @jasper.

## [0.17.0] - 2026-06-22

### Fixed
- Completed assistant replies now appear live when the final stream payload is missed, without needing a page reload (#496) — @louis.

## [0.16.0] - 2026-06-19

### Added
- Personal sessions on mobile can now swipe from the opposite edge for session details, while filmstrip gestures respect swipe direction (#492, #495) — @jasper.
- The personal agent sidebar now includes a tabbed session details inspector (#489) — @louis.

### Changed
- Feedback reports now submit optimistically and archive actions show a confirmation toast (#491) — @jasper.
- Personal Brain and after-session memory guidance is stricter, so agents only save persistent files or memories when user intent is clear (#485) — @louis.
- The personal sidebar home entry is now labeled New Session and uses the send icon (#487) — @louis.
- Personal sidebar session lists now hide scrollbars while remaining scrollable (#494) — @jasper.

### Fixed
- Agent replies no longer reorder in the transcript when stream events arrive out of order (#493) — @jasper.
- Mobile drawer swipes now work more reliably in Safari while preserving normal vertical page scrolling (#490) — @jasper.

## [0.15.0] - 2026-06-18

### Added
- Personal Brain now keeps restorable file versions, with restore tooling, caps, and runner guidance for safer durable writes (#483) — @jasper.
- Mobile users can now swipe to open the main navigation drawer (#484) — @jasper.

### Fixed
- The onboarding wizard no longer resets when setting tool policies during the capabilities step (#481) — @jasper.
- The three-dot menu in the brain file view no longer renders behind the file text (#480) — @jasper.
- GitHub work repositories granted after connecting now resolve via a live lookup instead of being missed (#479) — @jasper.
- Various mobile and phone UI fixes (#478) — @jasper.

## [0.14.0] - 2026-06-16

### Added
- OpenRouter Fusion models are now supported (#473) — @louis.
- Messages sent mid-run now offer Steer, Queue, and Interrupt send-modes (#468) — @jasper.
- Chat sessions can now be renamed via double-click or a right-click menu (#467) — @jasper.
- Clarifying questions now always include a free-text "Other" answer (#466) — @jasper.
- Screenshots dropped into chat are now attached to the Linear issue created from that conversation (#464) — @jasper.

### Changed
- Built-in skills now show distinct icons instead of a shared Sparkles placeholder (#475) — @jasper.
- Memory lookup prompting tightened for more relevant recall (#474) — @louis.
- Typed @mentions in the agent editor are no longer auto-converted as you type (#470) — @jasper.

### Fixed
- Near-identical person records in memory are now deduplicated (#477) — @jasper.
- The thinking trace now separates distinct reasoning phases instead of running them together (#476) — @jasper.
- The "Updated memory" card no longer overlaps the message footer (#469) — @jasper.
- Fixed the personal billing redirect (#465) — @louis.

## [0.13.0] - 2026-06-12

### Added
- Agents can now create Linear issues directly from chat, preserving the relevant conversation context in the issue (#462) — @jasper.
- Notion is now available as a first-party MCP integration with OAuth connection flow and tool discovery (#455) — @louis.
- New users can now complete a Leo-led onboarding flow with updated personal onboarding screens and kickoff behavior (#451) — @louis.
- Agents can now use the bundled YC knowledge skill (#456) — @louis.
- Feedback reports can now include screenshots, which are uploaded and embedded inline in the linked Linear issue (#447) — @jasper.
- The personal Memory surface is now URL-addressable, so selected memory paths can be opened and restored from direct links (#446) — @jasper.
- Memory queries now support relative `--since` windows and query-less recent-memory listings (#444) — @louis.
- Preview workspaces now show an early-preview badge in the sidebar (#457) — @louis.

### Changed
- Personal sidebar navigation was refreshed for the updated personal surface structure (#449) — @louis.
- GitHub permission scopes were consolidated and renamed around clearer permission groups (#450) — @louis.
- Signup welcome email delivery and unsubscribe handling were refactored for more reliable account email flows (#452) — @louis.

### Fixed
- Home-space image drag and drop now preserves sent images and shows them in the chat bubble after sending (#454) — @jasper.
- Sessions now recover stale stream state after returning to a tab instead of staying stuck on outdated loading state (#448) — @louis.
- Personal Brain writes are no longer silently dropped when the agent bundle exceeds the 80-file cap (#445) — @louis.
- Chat scrolling now settles at the bottom when expected during active sessions (#431) — @jasper.

## [0.12.0] - 2026-06-11

### Added
- Brain files created or edited by agents now show as clickable attachments under assistant turns, and the company Brain can be opened directly at `/brain/<path>` deep links (#356) — @louis.
- The personal Brain is now URL-addressable too, with nested file links restoring the selected file on reload and keeping the Brain navigation active (#426) — @jasper.
- Personal Brain files created or edited during agent turns now link directly from the session transcript into the matching personal Brain path (#442) — @louis.
- Personal sessions now support split-screen panes, so multiple chats can stay visible and be arranged side by side (#441) — @louis.
- Agents can now start scoped subagents with selected tool grants, with subagent lifecycle events shown in the parent session transcript (#421) — @louis.
- The personal Integrations tab now expands inline with connected account details, permission summaries, degraded-access warnings, disconnect actions, and GitHub repository refresh (#390) — @louis.
- Personal recall can now be constrained by time windows, including query-less recent-session snippets, so agents can ask for memory from a specific lookback period (#416) — @louis.
- Large pasted text is captured through the attachment pipeline, and oversized text attachments are materialized as sandbox file references instead of being inlined into every model call (#410) — @louis.
- Session usage now updates live during streaming, long-running tool calls show an elapsed counter, and the context-window tooltip includes session cost (#395, #376, #399) — @louis.
- Runner observability now records per-tool-call phase timings, Braintrust spans, PostHog rollups, and hidden sandbox hydration timing events for production latency diagnosis (#411, #417) — @louis.

### Changed
- Starting a session from the personal home prompt now switches to an optimistic session view immediately while creation and navigation finish in the background (#420) — @louis.
- Runner sandbox hydration now overlaps bundle, skill, and setup work to reduce startup latency for sessions that need a sandbox (#434) — @louis.
- Personal inbox cards now render markdown in their body and step text, matching the markdown contract used by the inbox tool (#438) — @louis.
- Recall recap guidance is tighter, with cleaner formatting for recalled memories and follow-up summaries (#436) — @louis.
- Preview deployment PR comments now include `?skipOnboarding`, letting reviewers test fresh preview accounts without going through onboarding (#435) — @louis.
- New personal agents now default to Leo on Kimi K2.6, with updated default capabilities, model selection, settings reset, and personal agent source normalization (#409, #425) — @louis.
- Memory tooling now returns richer `memory query` and `memory get` output, clearer invalid-usage help, a tighter keeper kickoff prompt, and canonical guidance that durable facts belong in structured memory while `agent/user.md` is the always-loaded digest (#413, #418, #422, #428) — @louis.
- Memory keeper passes now use Gemini 3.1 Flash Lite, surface what they stored, and appear in the transcript near the turn they followed instead of pinned to the bottom (#401, #397) — @louis.
- Runtime details now stay collapsed by default for new sessions, including sessions with related parent or child metadata (#423) — @louis.
- Slack support channel names now keep the per-workspace suffix at the end, for example `<customer>-x-opencompany-<id8>` (#394) — @jasper.

### Fixed
- Slash command session starts now route to the intended personal or company surface instead of opening the wrong session view (#432) — @louis.
- Session lists now consistently sort by creation time across the company and personal sidebars (#437) — @louis.
- Personal agent skill slash commands are available again in the composer slash menu and insert the right skill mention (#440) — @louis.
- Personal-session inspector links now stay inside the personal surface instead of opening related sessions, session pages, or agent links under `/company` (#391) — @louis.
- Personal runtime tool guidance now advertises the correct `work/`, `personal-brain/`, and `agent/` roots and blocks generic file tools from editing structured memory paths (#414) — @louis.
- OpenCode tool usage is now parsed from current `step_finish` events and charged back to the spawning session instead of silently appearing as zero-cost work (#402) — @jasper.
- Runner shutdown and interruption handling now drains in-flight runs, persists abort/failure state more reliably, and avoids replaying interrupted deploy-time work (#378) — @louis.
- E2B stream callbacks are guarded against detached rejections so stopping an `opencode_coder` command no longer crashes the runner process (#400) — @louis.

## [0.11.0] - 2026-06-10

### Added
- The new `/personal` experiment surface gives each user a private default agent with its own sessions, behavior editor, capability panels, context files, memory, tools, skills, integrations, and settings views (#353) — @louis.
- Claude Fable 5 is now available end to end in the model catalog, with reasoning, image, PDF, long-context, and billing support (#384) — @louis.
- Preview deployments can now complete Gmail and Google Calendar OAuth through a stable callback broker, making Google integration testing work across hosted preview URLs (#382) — @louis.
- Public changelog entries can now include embedded images and short looping videos, with docs for recording, compressing, uploading, and referencing changelog media (#387) — @louis.
- The account menu now shows when the currently running build was last deployed, with release details in the tooltip (#388) — @louis.
- Personal agents now support plain `@github` for all installation repositories and repo-scoped `@github/owner/repo` mentions, with matching sandbox and coding-tool access (#392) — @louis.

### Changed
- Sandbox preparation no longer waits on optional developer-tool installation during the critical setup path (#393) — @louis.

### Fixed
- Personal recall searches no longer fail before running when the runner configures its statement timeout (#389) — @louis.

## [0.10.0] - 2026-06-08

### Added
- Paste, drag, drop, or pick screenshots, PDFs, and text/code files in the session composer; attachments are validated per model, stored in private Vercel Blob, rendered as compact cards, and inlined into runner model calls (#362) — @jasper.
- Attached skills now appear in the composer slash menu as `/<command>` entries, using the skill's declared `command` frontmatter when present and inserting the matching `@skill/<id>` mention when selected (#350) — @louis.
- Brain pages now show when the file was last updated directly in the header, and include a copy button for the page title plus current contents (#355, #358) — @louis, @jasper.

### Changed
- Session pages now use the session title as the browser tab title, making multiple open chats easier to tell apart (#354) — @louis.
- Slack Connect support channels now use safer `<customer>-<id8>-x-opencompany` naming, include recovery sweeps for stuck provisioning, and have expanded setup and operations docs (#335) — @jasper.

### Fixed
- `opencode_coder` timeouts and command failures now preserve partial diffs, persist artifacts, return a resumable opencode session id, and report timeout status instead of dropping the work (#344) — @louis.
- Long-running tool calls no longer trigger runner job replay and double billing after transient lease gaps; job lease TTL and lease-busy retry ceilings are now configurable (#345) — @louis.
- Coding sandboxes now configure GitHub git credentials and best-effort ensure `rg` and `bun` are available, so plain git commands, repo search, and tests work more reliably inside sessions (#346) — @louis.

## [0.9.0] - 2026-06-05

### Added
- Gmail and Google Calendar are now first-party integrations — connect one or more Google accounts to give agents read-only Gmail and read/write Calendar tools, with per-account calendar selection (#319, #320) — @louis.
- Switch the model for a single chat on the fly without changing the agent's saved default, in a redesigned composer with a toolbar tray for the agent and model selectors (#331) — @louis.
- A context-window usage ring in the session top bar shows how full the model's context window is for the current turn (#332) — @louis.
- Slack Connect — completing onboarding now provisions a private shared Slack channel with our team, surfaced as a "Connect on Slack" card on your workspace home (#278) — @jasper.
- Tool calls that touch a Linear issue now show an external-link icon that opens the issue directly (#324) — @jasper.
- Deferred tool discovery — capability tools and coding agents are no longer all preloaded; the model discovers them on demand via `find_tools` and runs them through a `use_tool` dispatcher, improving tool selection and shrinking the cached prompt (#321) — @louis.
- New shared `@opencompany/ui` component package (shadcn / Tailwind v4) and a design-system app to document and showcase it (#323) — @louis.

### Changed
- Deferred-tool arguments now run through a validate → coerce → repair pipeline before dispatch, so smaller models' malformed tool calls are fixed automatically instead of failing (#328) — @louis.
- Brain access scope is now enforced at the tool layer, so out-of-scope Brain writes are rejected up front with a clear error instead of being silently dropped at sync (#327) — @louis.
- The new-session empty state no longer shows default prompt chips (#315) — @louis.
- The `/btw` start toast no longer echoes the prompt; it shows just a confirmation and an Open action (#330) — @louis.
- Faster navigation — removed the route-level session loader that flashed skeletons on fast nav (#303) — @louis.
- Production deploys are faster and now recover gracefully from interrupted runner deploys (#310, #318) — @louis.
- Runner model and tool calls are now traced via Braintrust's `wrapAISDK` defaults for richer, lower-maintenance observability (#304) — @louis.

### Fixed
- Unknown-tool and invalid tool-input calls are now recovered as tool results that steer the model back on track, instead of crashing the turn (#314, #325) — @louis.
- Fixed a startup-status race that briefly showed "Stopped before finishing" on a freshly started session that was actually still running (#306, #312) — @louis.
- Runner completions that contain only reasoning and no answer are now rejected instead of recorded as a successful turn (#300) — @louis.

### Security
- Hardened GitHub permission gating for agent shell commands, closing permission bypasses (#302) — @louis.

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
