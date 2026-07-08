export const GOAT_BRAIN_TOOL_DESCRIPTION =
  "Use the user's personal Goat Brain CLI for durable structured memory stored as Markdown files. Use help when you need command-specific usage, list for inventory, query for recall/search, get for a known brain id, create for explicit new records with type and truth/truthStdin, append-evidence to create sourced evidence records linked to a subject, timeline-add only for local timeline notes, rewrite only for compiled truth, alias for name aliases, link for typed related records, merge for duplicates, delete only with dryRun: true, and doctor for validation. Use includeMerged only when inspecting duplicate/merged history. Do not treat Brain as current chat scratchpad.";

export const GOAT_BRAIN_TOOL_ARGS_DESCRIPTION =
  "CLI-shaped structured invocation. Use { command, flags, stdin? }, where flags are CLI options without leading dashes. Examples: { command: 'help', flags: { topic: 'create' } }, { command: 'create', flags: { id: 'opencompany', title: 'OpenCompany', type: 'company', folder: 'companies', truth: 'OpenCompany is a company building agent infrastructure.', json: true } }, { command: 'append-evidence', flags: { id: 'garry-tan', kind: 'chat', body: 'Met at YC event.', sourceTitle: 'User chat note', json: true } }, { command: 'query', flags: { text: 'hiring', hops: 2, graphDirection: 'both', limit: 5, json: true } }, { command: 'query', flags: { text: 'Sarah Chen', includeMerged: true, json: true } }, { command: 'get', flags: { id: 'garry-tan', json: true } }, or { command: 'delete', flags: { id: 'old-note', dryRun: true, json: true } }. Delete is preview-only in chat. Use camelCase or kebab-case flag names.";

export const START_TASK_TOOL_DESCRIPTION =
  "Start a task when the user's request should become an asynchronous tracked Result, including work that needs connected-account context, external research, monitoring, or a specialized just-in-time agent. If the user explicitly asks for Codex, a Codex task, repository edits, tests, debugging, code review, or pull-request work, preserve that execution intent by setting engine to codex.";

export const START_TASK_PROMPT_DESCRIPTION =
  "A self-contained task prompt. Preserve the user's goal, relevant context, success criteria, and any constraints needed by the just-in-time agent. Preserve explicit execution-engine requests such as Codex verbatim instead of paraphrasing them away.";

export const START_TASK_ENGINE_DESCRIPTION =
  "Optional execution engine hint. Set to codex when the user explicitly asks for Codex or a Codex task, or for repository edits, tests, debugging, code review, or pull-request work where Codex is the requested executor. Omit for ordinary research, writing, connected-account lookup, or analysis tasks.";

export const START_TASK_NAME_DESCRIPTION = "A short 2-7 word task name for the Results list.";

export const START_TASK_REASON_DESCRIPTION =
  "Short reason this should run as a task instead of a chat answer.";

export const SCHEDULE_TASK_TOOL_DESCRIPTION =
  "Create a recurring Goat task schedule from the user's request. Use only when the user clearly asks for repeated, recurring, scheduled, or cron-like work. Convert the recurrence to a valid 5-field cron expression and save directly; if the recurrence is ambiguous or not cron-expressible, ask a short follow-up instead of calling this tool.";

export const SCHEDULE_TASK_PROMPT_DESCRIPTION =
  "A self-contained prompt for every generated task run. Preserve the recurring goal, relevant context, success criteria, and constraints.";

export const SCHEDULE_TASK_NAME_DESCRIPTION =
  "A short 2-7 word recurring task name for the Routines list and generated Results.";

export const SCHEDULE_TASK_CRON_DESCRIPTION =
  "A valid 5-field cron expression: minute hour day-of-month month day-of-week. Do not include seconds.";

export const SCHEDULE_TASK_TIMEZONE_DESCRIPTION =
  "Optional IANA timezone for the cron expression. Omit when the user did not specify a timezone so Goat uses the user's saved timezone.";

export const SCHEDULE_TASK_SOURCE_DESCRIPTION =
  "Short natural-language description of the recurrence, for example 'every weekday at 9 AM'.";

export const EDIT_TASK_SCHEDULE_TOOL_DESCRIPTION =
  "Edit an existing recurring Goat task schedule. Use this when the user asks to change a recurrence name, cadence, cron, timezone, or repeated task prompt. Identify the schedule by id when known, otherwise by its unique visible name from runtime context. If the target is unclear, ask a short follow-up instead of calling this tool.";

export const TASK_SCHEDULE_IDENTIFIER_DESCRIPTION =
  "The existing recurring task schedule id. Prefer this when it is available in runtime context.";

export const TASK_SCHEDULE_NAME_LOOKUP_DESCRIPTION =
  "The existing visible recurring task name to find. Use only when the schedule id is unavailable, and only when the name is unique.";

export const DELETE_TASK_SCHEDULE_TOOL_DESCRIPTION =
  "Delete an existing recurring Goat task schedule so it no longer creates future task runs. Already-created queued or running task runs continue.";

export const WEB_SEARCH_TOOL_DESCRIPTION =
  "Search the public web once for simple freshness-sensitive questions. Use this for one-shot current facts, recent updates, or latest docs. Do not use it for deep research, monitoring, multi-source reports, connected-account work, or anything that should become a tracked Result.";

export const WEB_SEARCH_QUERY_DESCRIPTION =
  "A concise public-web search query. Prefer entity names plus the user's requested current fact or update.";

export const WEB_SEARCH_RECENCY_DAYS_DESCRIPTION =
  "Optional freshness window for latest/recent requests. Use 7 for very recent news, 30 for recent updates, and 90 for broader current context.";
