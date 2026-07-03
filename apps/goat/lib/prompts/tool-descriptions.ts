export const GOAT_BRAIN_TOOL_DESCRIPTION =
  'Run the user\'s personal Goat brain CLI for durable notes and recall. Use this when the user asks to remember, save, recall, inspect, edit, link, or search personal/company context that should stay available later. Default folders are inbox, decisions, insights, meetings, companies, people, projects, research, references, docs, ideas, and concepts. Pass only CLI arguments, for example: query --text "pricing" --hops 1 --limit 5, create --folder inbox --title "Hiring note" --truth "...", append-timeline note-id --body "...", or doctor.';

export const GOAT_BRAIN_TOOL_ARGS_DESCRIPTION =
  "Arguments for the goat-brain CLI, excluding the executable name. Do not include shell operators. Prefer query/get before editing unless the user clearly asked to remember or update something.";

export const START_TASK_TOOL_DESCRIPTION =
  "Start a task when the user's request should become an asynchronous tracked Result, including work that needs connected-account context, external research, monitoring, or a specialized just-in-time agent.";

export const START_TASK_PROMPT_DESCRIPTION =
  "A self-contained task prompt. Preserve the user's goal, relevant context, success criteria, and any constraints needed by the just-in-time agent.";

export const START_TASK_NAME_DESCRIPTION = "A short 2-7 word task name for the Results list.";

export const START_TASK_REASON_DESCRIPTION =
  "Short reason this should run as a task instead of a chat answer.";
