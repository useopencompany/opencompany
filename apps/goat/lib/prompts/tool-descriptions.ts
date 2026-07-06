export const GOAT_BRAIN_TOOL_DESCRIPTION =
  "Use the user's personal Goat Brain for durable world knowledge: people, companies, projects, meetings, decisions, insights, research, references, and durable notes. Use ingest when the user asks to remember/save new information, query for recall/search, and get for a known brain id. Do not treat Brain as current chat scratchpad.";

export const GOAT_BRAIN_TOOL_ARGS_DESCRIPTION =
  "Structured brain action. Use { action: 'ingest', text, sourceTitle? }, { action: 'query', text, limit?, hops? }, or { action: 'get', id, section? }. Raw args are internal-only.";

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
