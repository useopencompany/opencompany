// Client-safe catalog of the models a workflow can run on. The token is what
// gets stored in the workflow doc's frontmatter (`model:`) and what an inline
// `@<token>` mention in the instructions resolves against.

export type GoatWorkflowModelToken =
  | "kimi-k2.6"
  | "kimi-k3"
  | "glm-5.2"
  | "sonnet-5"
  | "gpt-5.5"
  | "codex";

export type GoatWorkflowModelOption = {
  token: GoatWorkflowModelToken;
  label: string;
  hint: string;
};

export const GOAT_WORKFLOW_MODEL_OPTIONS: readonly GoatWorkflowModelOption[] = [
  { token: "kimi-k2.6", label: "Kimi K2.6", hint: "Default — fast and cost-conscious" },
  { token: "kimi-k3", label: "Kimi K3", hint: "Premium Kimi reasoning" },
  { token: "glm-5.2", label: "GLM 5.2", hint: "Large-context research" },
  { token: "sonnet-5", label: "Claude Sonnet 5", hint: "Premium writing and judgment" },
  { token: "gpt-5.5", label: "GPT 5.5", hint: "Coding and sharp analysis" },
  { token: "codex", label: "Codex", hint: "Cloud coding agent (needs Codex connected)" },
];

export const DEFAULT_GOAT_WORKFLOW_MODEL_TOKEN: GoatWorkflowModelToken = "kimi-k2.6";

export function isGoatWorkflowModelToken(value: unknown): value is GoatWorkflowModelToken {
  return (
    typeof value === "string" &&
    GOAT_WORKFLOW_MODEL_OPTIONS.some((option) => option.token === value)
  );
}
