import type { GoatTask } from "@opencompany/db/goat-schema";

export type GoatTaskStepInput = Pick<
  GoatTask,
  "status" | "stage" | "result" | "error" | "harnessSpec" | "debugTrace" | "sandboxId"
>;

const MAX_STEPS = 6;
const MAX_STEP_LENGTH = 160;
const MAX_QUERY_LENGTH = 72;
const DEEP_SEARCH_TYPES = new Set(["deep", "deep-lite", "deep-reasoning"]);

type ToolEvent = {
  name: string;
  args: Record<string, unknown>;
  error: string | null;
  order: number;
};

type SearchEvent = {
  query: string;
  type: string | null;
  order: number;
  error: string | null;
};

export function deriveGoatTaskSteps(task: GoatTaskStepInput): string[] {
  const steps: string[] = [];
  const toolEvents = readToolEvents(task.debugTrace);
  const searchEvents = readSearchEvents(toolEvents);
  const resultToolCalled = toolEvents.some((event) => event.name === "goat_result");
  const firstToolError = toolEvents.find((event) => event.error)?.error ?? null;

  addStageSteps(steps, task);
  addSearchSteps(steps, searchEvents);

  if (task.result?.trim() || resultToolCalled) {
    pushStep(steps, "Synthesized the findings into the final result.");
  }

  if (task.status === "failed") {
    const error = stripTrailingPeriods(sanitizeText(firstToolError ?? task.error));
    pushStep(steps, error ? `Stopped after an error: ${error}.` : "Stopped after the task failed.");
  } else if (task.status === "canceled") {
    pushStep(steps, "Stopped by user request.");
  }

  if (steps.length === 0) {
    pushStep(steps, fallbackStepForStage(task.stage));
  }

  return steps.slice(0, MAX_STEPS);
}

function addStageSteps(steps: string[], task: GoatTaskStepInput) {
  const hasPlannerTrace = Boolean(readRecord(task.debugTrace)?.planner);
  const hasHarnessSpec = hasObjectKeys(task.harnessSpec);

  if (task.status === "queued") {
    pushStep(steps, "Waiting for the runner to start the task.");
    return;
  }

  if (task.stage === "planning") {
    pushStep(steps, "Planning the task and selecting the research path.");
    return;
  }

  if (hasPlannerTrace) {
    pushStep(steps, "Planned the task and selected the research harness.");
  } else if (hasHarnessSpec) {
    pushStep(steps, "Prepared the task request for the research harness.");
  }

  if (task.stage === "sandboxing") {
    pushStep(steps, "Preparing the task workspace.");
    return;
  }

  if (task.sandboxId || task.stage === "running") {
    pushStep(
      steps,
      task.stage === "running" ? "Preparing the task workspace." : "Prepared the task workspace.",
    );
  }

  if (task.stage === "running") {
    pushStep(steps, "Running the research harness and collecting results.");
  } else if (task.stage === "completed" && steps.length === 0) {
    pushStep(steps, "Ran the research harness.");
  }
}

function addSearchSteps(steps: string[], searchEvents: SearchEvent[]) {
  const uniqueSearches = uniqueSearchesByQuery(searchEvents);
  if (uniqueSearches.length === 0) return;

  const deepSearches = uniqueSearches.filter(
    (event) => event.type && DEEP_SEARCH_TYPES.has(event.type),
  );
  if (deepSearches.length === uniqueSearches.length) {
    pushStep(steps, `Searched deeply for ${formatQueryList(deepSearches)}.`);
    return;
  }

  const useDeepStep = deepSearches.length > 0 && uniqueSearches.length > 1;
  const firstPassSearches = useDeepStep
    ? uniqueSearches.filter((event) => !event.type || !DEEP_SEARCH_TYPES.has(event.type))
    : uniqueSearches;

  if (firstPassSearches.length > 0) {
    pushStep(steps, `Searched the web for ${formatQueryList(firstPassSearches)}.`);
  }

  if (useDeepStep) {
    pushStep(steps, `Went deeper on ${formatQueryList(deepSearches)}.`);
  }
}

function readToolEvents(debugTrace: unknown): ToolEvent[] {
  const harness = readRecord(readRecord(debugTrace)?.harness);
  const turns = Array.isArray(harness?.turns) ? harness.turns : [];
  const events: ToolEvent[] = [];

  for (const turn of turns) {
    const toolResults = readRecord(turn)?.toolResults;
    if (!Array.isArray(toolResults)) continue;

    for (const toolResult of toolResults) {
      const record = readRecord(toolResult);
      const name = readString(record?.name);
      if (!name) continue;
      events.push({
        name,
        args: readRecord(record?.args) ?? {},
        error: sanitizeText(record?.error),
        order: events.length,
      });
    }
  }

  return events;
}

function readSearchEvents(toolEvents: ToolEvent[]): SearchEvent[] {
  return toolEvents.flatMap((event) => {
    if (event.name !== "exa_search") return [];
    const query = sanitizeText(event.args.query);
    if (!query) return [];
    return [
      {
        query,
        type: sanitizeText(event.args.type)?.toLowerCase() ?? null,
        order: event.order,
        error: event.error,
      },
    ];
  });
}

function uniqueSearchesByQuery(searchEvents: SearchEvent[]): SearchEvent[] {
  const seen = new Set<string>();
  const unique: SearchEvent[] = [];

  for (const event of searchEvents.toSorted((a, b) => a.order - b.order)) {
    const key = event.query.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(event);
  }

  return unique;
}

function formatQueryList(searches: SearchEvent[]) {
  const queries = searches.map((event) => `"${formatQuery(event.query)}"`);
  if (queries.length === 1) return queries[0];
  if (queries.length === 2) return `${queries[0]} and ${queries[1]}`;
  const remaining = queries.length - 2;
  return `${queries[0]}, ${queries[1]}, and ${remaining} more ${remaining === 1 ? "topic" : "topics"}`;
}

function formatQuery(query: string) {
  return truncate(query.replaceAll('"', "'"), MAX_QUERY_LENGTH);
}

function pushStep(steps: string[], step: string) {
  const normalized = truncate(sanitizeText(step) ?? "", MAX_STEP_LENGTH);
  if (!normalized) return;
  if (steps.includes(normalized)) return;
  steps.push(normalized);
}

function fallbackStepForStage(stage: GoatTaskStepInput["stage"]) {
  switch (stage) {
    case "queued":
      return "Waiting for the runner to start the task.";
    case "planning":
      return "Planning the task and selecting the research path.";
    case "sandboxing":
      return "Preparing the task workspace.";
    case "running":
      return "Running the research harness and collecting results.";
    case "completed":
      return "Ran the research harness.";
    case "failed":
      return "Stopped after the task failed.";
    case "canceled":
      return "Stopped by user request.";
  }
}

function hasObjectKeys(value: unknown) {
  const record = readRecord(value);
  return Boolean(record && Object.keys(record).length > 0);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sanitizeText(value: unknown): string | null {
  const text = readString(value);
  if (!text) return null;
  return text.replace(/\s+/g, " ").trim();
}

function stripTrailingPeriods(value: string | null) {
  return value?.replace(/\.+$/g, "").trim() ?? null;
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}
