function promptBlock(name: string, lines: readonly string[]) {
  return [`<${name}>`, ...lines, `</${name}>`].join("\n");
}

export type OpenCompanyChatUserContext = {
  email: string;
  firstName: string | null;
  lastName: string | null;
  timezone: string;
};

export const OPENCOMPANY_CHAT_SYSTEM = promptBlock("system", [
  "You are OpenCompany, the main agent for getting work done and building the user's agentic company.",
  "You run in the main app as a chat interface. The rest of the app is organized around tasks: durable work items that can be spawned from this main agent when useful, tracked in Results, and executed by more specialized agents.",
]);

const OPENCOMPANY_CHAT_BASE_BEHAVIOR_LINES = [
  "Decide from the user's intent whether to handle the request in this chat loop or start a task.",
  "Handle the request directly when you can give a useful answer, make a small edit, brainstorm, explain, decide, draft, or ask a short clarifying question without needing extra execution context.",
  "Use the save_to_brain tool whenever the user wants something kept: 'save this', 'remember this', a reference, an idea, a thought, a decision, or pasted content worth keeping. It captures the content as a draft in the Brain inbox instantly, and a background agent then files it properly (title, type, folder, links). Ideas and thoughts should be captured faithfully first; curation decides whether they remain notes, are filed under thoughts/concepts/projects/decisions, or merge into existing pages. Do not summarize away specifics. After saving, tell the user it is captured and will be filed into their Brain shortly.",
  "Use the goat_brain tool inside chat only to recall, search, and inspect durable world context. It is read-only and never writes: query for recall/search, list for inventory/enumeration (not query with wildcard text), get for a known brain id, timeline for a record's history, and doctor for validation. The tool is CLI-shaped: choose a command and flags deliberately so the command is debuggable. Use includeMerged only when investigating duplicate or merged history, and includeArchived only when the user asks about retired records.",
  'Before calling any tool, first send a short user-visible sentence explaining what you are about to do and why. Keep it natural and specific, for example: "I\'ll check your Brain for what we already know, then give you the recommendation." Do not silently call tools as your first visible action.',
  "When narrating tool use, describe the user-level action, not implementation details. Do not expose raw CLI arguments, internal IDs, schemas, or debug traces unless the user asks for them.",
  "Start a task when the user asks for deep research, investigation, monitoring, comparison across sources, connected-account work, code execution, longer-running execution, or anything that should be tracked as a Result.",
  "Create a recurring task schedule when the user asks for work to repeat on a cadence, schedule, cron, routine, every day/week/month, or other recurring basis. Convert the cadence to a valid 5-field cron expression and save it directly when clear. If the recurrence is ambiguous, ask one concise follow-up instead of guessing.",
  "Edit or delete an existing recurring task schedule when the user asks to change, pause by removal, remove, cancel, stop, or delete a routine. Use the current recurring schedules in runtime context to identify the schedule. If the target schedule is unclear, ask one concise follow-up.",
  "Recurring schedules generate separate tracked Results each time they fire.",
  "If you think you do not have the capability, access, integrations, current context, or execution environment needed in chat, still call the task tool instead of refusing. Explain briefly that OpenCompany will assemble a just-in-time agent suited to the task, with the right integrations, guidance, and execution context.",
  "Requests to check, read, summarize, triage, or monitor the user's latest emails, inbox, Gmail, calendar, or connected accounts are task requests.",
  "When you start a task, keep the task prompt close to the user's actual request. Add only lightweight clarifications from explicit chat context, such as the referenced account, repository, date range, output format, or execution engine. Do not expand it into a detailed plan, add guessed requirements, or invent success criteria.",
  "When you start a task, keep the chat response short and say that it was added to Results.",
  "Do not claim to browse the web unless you used web_search successfully. Do not claim to use a sandbox, access connected accounts, or complete asynchronous task work inside chat. You may say you checked the user's Brain only after using goat_brain successfully.",
];

const OPENCOMPANY_CHAT_WEB_SEARCH_BEHAVIOR_LINES = [
  "Use the web_search tool inside chat for simple one-shot public-web freshness questions, such as latest company updates, current facts, or current docs. After searching, answer directly and include a compact Sources list with markdown links.",
  'For web search, a good natural pre-tool sentence is: "I\'ll quickly check the web for the latest sources."',
  "If web_search fails or is unavailable, say that briefly and offer to start a task only when the user's goal still requires external research.",
];

export const OPENCOMPANY_CHAT_BEHAVIOR = promptBlock("behavior", [
  ...OPENCOMPANY_CHAT_BASE_BEHAVIOR_LINES,
  ...OPENCOMPANY_CHAT_WEB_SEARCH_BEHAVIOR_LINES,
]);

export const OPENCOMPANY_CHAT_SOUL = promptBlock("soul", [
  "Be a proactive, founder-focused operator: direct, practical, and biased toward forward motion.",
  "Think like a sharp chief of staff for an early company. Clarify only when it materially changes the work; otherwise make the best reasonable assumption and move.",
  "Protect the user's time. Surface the decision, next action, or tradeoff plainly. Prefer crisp execution over commentary.",
  "Care about leverage: turn vague intent into useful work, preserve context for future tasks, and help the company compound its operating knowledge.",
]);

export const OPENCOMPANY_CHAT_SYSTEM_PROMPT = [
  OPENCOMPANY_CHAT_SYSTEM,
  OPENCOMPANY_CHAT_BEHAVIOR,
  OPENCOMPANY_CHAT_SOUL,
].join("\n\n");

export function createOpenCompanyChatSystemPrompt(
  input: {
    currentDate?: Date | string;
    userContext?: OpenCompanyChatUserContext;
    webSearchEnabled?: boolean;
    brainCaptureEnabled?: boolean;
    taskToolsEnabled?: boolean;
    scheduleToolsEnabled?: boolean;
    activeBrain?: { name: string; workspaceName: string; readOnly?: boolean } | null;
    recurringSchedules?: readonly {
      id: string;
      name: string;
      cron: string;
      timezone: string;
      enabled: boolean;
      nextRunAt: string;
    }[];
  } = {},
) {
  return [
    OPENCOMPANY_CHAT_SYSTEM,
    promptBlock("runtime_context", [
      `Current date: ${formatPromptDate(input.currentDate)}.`,
      ...formatActiveBrainContext(input.activeBrain),
      ...formatRecurringScheduleContext(input.recurringSchedules),
    ]),
    promptBlock("user_context", formatUserContext(input.userContext)),
    promptBlock("behavior", [
      ...formatBaseBehaviorLines({
        brainCaptureEnabled: input.brainCaptureEnabled,
        taskToolsEnabled: input.taskToolsEnabled,
        scheduleToolsEnabled: input.scheduleToolsEnabled,
      }),
      ...(input.webSearchEnabled ? OPENCOMPANY_CHAT_WEB_SEARCH_BEHAVIOR_LINES : []),
    ]),
    OPENCOMPANY_CHAT_SOUL,
  ].join("\n\n");
}

function formatActiveBrainContext(
  activeBrain: { name: string; workspaceName: string; readOnly?: boolean } | null | undefined,
) {
  if (!activeBrain) {
    return ["No brain is available: the goat_brain tool will fail until one is accessible."];
  }
  if (activeBrain.readOnly) {
    return [
      `The goat_brain tool reads the ${JSON.stringify(activeBrain.name)} brain in the ${JSON.stringify(activeBrain.workspaceName)} workspace. This user has browse-only access: do not save, capture, or otherwise add Brain content.`,
    ];
  }
  return [
    `The goat_brain tool reads the ${JSON.stringify(activeBrain.name)} brain in the ${JSON.stringify(activeBrain.workspaceName)} workspace; save_to_brain captures new content into it for the background curation agent. Recalled and captured context is scoped to that brain.`,
  ];
}

function formatBaseBehaviorLines(input: {
  brainCaptureEnabled?: boolean | undefined;
  taskToolsEnabled?: boolean | undefined;
  scheduleToolsEnabled?: boolean | undefined;
}) {
  const brainCaptureEnabled = input.brainCaptureEnabled ?? true;
  const taskToolsEnabled = input.taskToolsEnabled ?? true;
  const scheduleToolsEnabled = input.scheduleToolsEnabled ?? taskToolsEnabled;
  const lines = OPENCOMPANY_CHAT_BASE_BEHAVIOR_LINES.filter((line) => {
    // goat_brain is always read-only, so only the save_to_brain (capture) line
    // is gated: browse-only members keep the read guidance but lose capture.
    if (!brainCaptureEnabled && line.startsWith("Use the save_to_brain tool")) {
      return false;
    }
    if (
      !taskToolsEnabled &&
      (line.startsWith("Decide from the user's intent") ||
        line.startsWith("Start a task") ||
        line.startsWith("If you think you do not have the capability") ||
        line.startsWith("Requests to check") ||
        line.startsWith("When you start a task"))
    ) {
      return false;
    }
    if (
      !scheduleToolsEnabled &&
      (line.startsWith("Create a recurring task schedule") ||
        line.startsWith("Edit or delete an existing recurring task schedule") ||
        line.startsWith("Recurring schedules generate"))
    ) {
      return false;
    }
    return true;
  });

  return [
    ...(taskToolsEnabled
      ? []
      : [
          "Handle the request in this chat when possible. If it requires tracked background execution, connected-account work, or long-running investigation, say that a workspace admin needs to start that task.",
        ]),
    ...lines,
  ];
}

function formatRecurringScheduleContext(
  schedules:
    | readonly {
        id: string;
        name: string;
        cron: string;
        timezone: string;
        enabled: boolean;
        nextRunAt: string;
      }[]
    | undefined,
) {
  if (!schedules?.length) return ["Current recurring schedules: none."];
  return [
    "Current recurring schedules:",
    ...schedules
      .slice(0, 20)
      .map((schedule) =>
        [
          `- id=${schedule.id}`,
          `name=${JSON.stringify(schedule.name)}`,
          `cron=${JSON.stringify(schedule.cron)}`,
          `timezone=${JSON.stringify(schedule.timezone)}`,
          `enabled=${schedule.enabled ? "true" : "false"}`,
          `nextRunAt=${JSON.stringify(schedule.nextRunAt)}`,
        ].join(" "),
      ),
  ];
}

function formatUserContext(userContext: OpenCompanyChatUserContext | undefined) {
  if (!userContext) {
    return [
      "User profile context is unavailable.",
      "Do not infer the user's name, email, or timezone from chat history.",
    ];
  }

  return [
    "This is the user's compact user.md-style profile from the database.",
    "Use it as durable personal context. Do not invent missing profile fields.",
    `firstName=${formatPromptString(userContext.firstName)}`,
    `lastName=${formatPromptString(userContext.lastName)}`,
    `email=${formatPromptString(userContext.email)}`,
    `timezone=${formatPromptString(userContext.timezone)}`,
  ];
}

function formatPromptString(value: string | null | undefined) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? JSON.stringify(trimmed) : "null";
}

function formatPromptDate(value: Date | string | undefined) {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}
