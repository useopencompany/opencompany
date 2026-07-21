export const GOAT_BRAIN_TOOL_DESCRIPTION =
  "Read-only access to the user's durable Goat Brain (structured memory stored as Markdown files). Use it to recall and inspect existing knowledge, never to write. Use query for recall/search, list for inventory, get for a known brain id, timeline for a record's history, help for command-specific usage, and doctor for validation. Use query with since windows like 6h, 2d, 1w, or an ISO timestamp to search or browse recent Brain entries; omit text when the user only wants recent entries. Use includeMerged only when inspecting duplicate/merged history and includeArchived only for retired records. To add or edit Brain content — new pages, evidence, corrections, links, or merges — use save_to_brain instead; the background curation agent files it. Do not treat Brain as a chat scratchpad.";

export const SAVE_TO_BRAIN_TOOL_DESCRIPTION =
  "Save something the user wants remembered - a reference, idea, thought, note, decision, pasted content, or an attached file - into their Brain. This captures the content as a draft page in the inbox immediately and queues a background curation agent that files it properly (title, type, folder, links to related pages). Use this whenever the user says things like 'save this', 'remember this', 'note this down', or shares a reference, idea, or thought worth keeping. Do not rewrite or summarize the content; capture what the user gave you. To save files attached in this conversation, pass their attachment ids via attachmentIds instead of copying the content field.";

export const SAVE_TO_BRAIN_CONTENT_DESCRIPTION =
  "The content to save, verbatim or lightly cleaned. Preserve the user's wording, links, and details; do not summarize away specifics. Omit when saving attached files via attachmentIds.";

export const SAVE_TO_BRAIN_ATTACHMENT_IDS_DESCRIPTION =
  "Ids of files attached in this conversation to save into the Brain as assets (each attachment's id is shown next to it in the conversation). The file itself is copied into the Brain and ingested in the background; do not also paste its content into the content field.";

export const SAVE_TO_BRAIN_TITLE_DESCRIPTION =
  "Optional short title for the capture. Omit it to derive one from the content.";

export const SAVE_TO_BRAIN_INTENT_DESCRIPTION =
  "Optional one-line note on what the user wants this for, e.g. 'reference for the pricing page rework'. Helps the background curation agent file it.";

export const START_TASK_TOOL_DESCRIPTION =
  "Start a task when the user's request should become an asynchronous tracked task, including work that needs connected-account context, external research, monitoring, or a specialized just-in-time agent. If the user explicitly asks for Codex, a Codex task, repository edits, tests, debugging, code review, or pull-request work, preserve that execution intent by setting engine to codex.";

export const START_TASK_PROMPT_DESCRIPTION =
  "A brief task prompt for the just-in-time agent. Use the user's own request as the backbone and keep it close to what they said. Add only light clarifications from explicit chat context, such as referenced accounts, repositories, date ranges, output format, or execution engine. Do not expand into a detailed plan, invent requirements, or add guessed success criteria. Preserve explicit execution-engine requests such as Codex verbatim instead of paraphrasing them away.";

export const START_TASK_ENGINE_DESCRIPTION =
  "Optional execution engine hint. Set to codex when the user explicitly asks for Codex or a Codex task, or for repository edits, tests, debugging, code review, or pull-request work where Codex is the requested executor. Omit for ordinary research, writing, connected-account lookup, or analysis tasks.";

export const START_TASK_NAME_DESCRIPTION = "A short 2-7 word task name for the Tasks list.";

export const START_TASK_REASON_DESCRIPTION =
  "Short reason this should run as a task instead of a chat answer.";

export const SCHEDULE_TASK_TOOL_DESCRIPTION =
  "Create a recurring Goat task schedule from the user's request. Use only when the user clearly asks for repeated, recurring, scheduled, or cron-like work. Convert the recurrence to a valid 5-field cron expression and save directly; if the recurrence is ambiguous or not cron-expressible, ask a short follow-up instead of calling this tool.";

export const SCHEDULE_TASK_PROMPT_DESCRIPTION =
  "A brief prompt for every generated task run. Use the user's recurring request as the backbone and add only light clarifications from explicit chat context, such as cadence, referenced accounts, date ranges, output format, or execution engine. Do not expand into a detailed plan, invent requirements, or add guessed success criteria.";

export const SCHEDULE_TASK_NAME_DESCRIPTION =
  "A short 2-7 word recurring task name for the Routines list and generated Tasks.";

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
  "Search the public web once for simple freshness-sensitive questions. Use this for one-shot current facts, recent updates, or latest docs. Do not use it for deep research, monitoring, multi-source reports, connected-account work, or anything that should become a tracked task.";

export const WEB_SEARCH_QUERY_DESCRIPTION =
  "A concise public-web search query. Prefer entity names plus the user's requested current fact or update.";

export const WEB_SEARCH_RECENCY_DAYS_DESCRIPTION =
  "Optional freshness window for latest/recent requests. Use 7 for very recent news, 30 for recent updates, and 90 for broader current context.";

export const USE_CAPABILITY_TOOL_DESCRIPTION =
  "Use one of the user's connected capabilities listed in <capabilities>. A fresh worker handles each call with only the tools permitted for the selected operation and returns a compact summary plus entity references. Use read for retrieval. Use create or write only when the latest user message explicitly requests a supported change and the capability advertises that exact operation. A create call permits at most one successful creation; write calls remain limited to the capability's stated mutation tools.";

export const USE_CAPABILITY_OPERATION_DESCRIPTION =
  'Select "read" for lookup or retrieval. Select "create" or "write" only when the user explicitly and unambiguously asked for a supported external change and the chosen capability advertises that exact operation.';

export const USE_CAPABILITY_REQUEST_DESCRIPTION =
  "A fully self-contained natural-language request for the worker, which sees none of this conversation. Resolve pronouns and references into concrete names, emails, channel names, issue keys, or URLs from chat context, and convert relative dates like 'yesterday' or 'last week' into absolute dates. For creates or writes, include the exact requested changes and targets without inventing missing values. State the desired detail, e.g. 'the 5 most recent'. Do not include instructions about which tools to use or how to format output.";
