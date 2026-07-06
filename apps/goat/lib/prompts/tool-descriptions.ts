export const GOAT_BRAIN_TOOL_DESCRIPTION =
  "Use the user's personal Goat Brain CLI for durable structured memory stored as Markdown files. Use help when you need command-specific usage, list for inventory, query for recall/search, get for a known brain id, create for explicit new records with type and truth/truthStdin, append-evidence to add sourced timeline evidence, rewrite only for compiled truth, alias for name aliases, link for typed related records, merge for duplicates, delete only with dryRun: true, and doctor for validation. Use includeMerged only when inspecting duplicate/merged history. Do not treat Brain as current chat scratchpad.";

export const GOAT_BRAIN_TOOL_ARGS_DESCRIPTION =
  "CLI-shaped structured invocation. Use { command, flags, stdin? }, where flags are CLI options without leading dashes. Examples: { command: 'help', flags: { topic: 'create' } }, { command: 'create', flags: { id: 'opencompany', title: 'OpenCompany', type: 'company', folder: 'companies', truth: 'OpenCompany is a company building agent infrastructure.', json: true } }, { command: 'query', flags: { text: 'hiring', hops: 2, graphDirection: 'both', limit: 5, json: true } }, { command: 'query', flags: { text: 'Sarah Chen', includeMerged: true, json: true } }, { command: 'get', flags: { id: 'garry-tan', json: true } }, { command: 'append-evidence', flags: { id: 'garry-tan', body: 'Met at YC event.', sourceTitle: 'User chat note', json: true } }, or { command: 'delete', flags: { id: 'old-note', dryRun: true, json: true } }. Delete is preview-only in chat. Use camelCase or kebab-case flag names.";

export const START_TASK_TOOL_DESCRIPTION =
  "Start a task when the user's request should become an asynchronous tracked Result, including work that needs connected-account context, external research, monitoring, or a specialized just-in-time agent.";

export const START_TASK_PROMPT_DESCRIPTION =
  "A self-contained task prompt. Preserve the user's goal, relevant context, success criteria, and any constraints needed by the just-in-time agent.";

export const START_TASK_NAME_DESCRIPTION = "A short 2-7 word task name for the Results list.";

export const START_TASK_REASON_DESCRIPTION =
  "Short reason this should run as a task instead of a chat answer.";

export const WEB_SEARCH_TOOL_DESCRIPTION =
  "Search the public web once for simple freshness-sensitive questions. Use this for one-shot current facts, recent updates, or latest docs. Do not use it for deep research, monitoring, multi-source reports, connected-account work, or anything that should become a tracked Result.";

export const WEB_SEARCH_QUERY_DESCRIPTION =
  "A concise public-web search query. Prefer entity names plus the user's requested current fact or update.";

export const WEB_SEARCH_RECENCY_DAYS_DESCRIPTION =
  "Optional freshness window for latest/recent requests. Use 7 for very recent news, 30 for recent updates, and 90 for broader current context.";
