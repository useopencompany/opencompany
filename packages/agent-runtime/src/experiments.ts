// Workspace experiments are per-workspace beta flags persisted in the `workspace_experiments`
// table, keyed by a freeform `key` text column. Adding a new experiment needs NO database
// migration — only a new entry in EXPERIMENT_DEFINITIONS below. Both the web app (settings UI +
// server actions) and the runner (runtime gating) import from this single registry so the keys,
// titles, and descriptions never drift between layers.

export const EXPERIMENT_KEYS = {
  mcp: "mcp",
  explore: "explore",
} as const;

export type ExperimentKey = (typeof EXPERIMENT_KEYS)[keyof typeof EXPERIMENT_KEYS];

export type ExperimentDefinition = {
  key: ExperimentKey;
  title: string;
  description: string;
};

// Ordered for display in the settings Experiments section. To launch a new workspace test, add a
// definition here and gate the behaviour on isExperimentEnabled(experiments, EXPERIMENT_KEYS.x).
export const EXPERIMENT_DEFINITIONS: readonly ExperimentDefinition[] = [
  {
    key: EXPERIMENT_KEYS.mcp,
    title: "MCP beta",
    description: "Try workspace-scoped MCP servers in agent configs.",
  },
  {
    key: EXPERIMENT_KEYS.explore,
    title: "Explore (beta)",
    description:
      "Let agents launch a read-only explore sub-agent that researches the Brain in a separate context and returns a short summary.",
  },
];

export const EXPERIMENT_DEFINITION_BY_KEY: Record<ExperimentKey, ExperimentDefinition> =
  Object.fromEntries(
    EXPERIMENT_DEFINITIONS.map((definition) => [definition.key, definition]),
  ) as Record<ExperimentKey, ExperimentDefinition>;

const EXPERIMENT_KEY_SET = new Set<string>(Object.values(EXPERIMENT_KEYS));

export function isExperimentKey(value: string): value is ExperimentKey {
  return EXPERIMENT_KEY_SET.has(value);
}

// A workspace's enabled experiment flags, resolved from the DB. A missing key means "off", so a
// brand-new workspace with no rows reads every experiment as disabled.
export type WorkspaceExperiments = Partial<Record<ExperimentKey, boolean>>;

export function isExperimentEnabled(
  experiments: WorkspaceExperiments | undefined,
  key: ExperimentKey,
): boolean {
  return experiments?.[key] === true;
}
