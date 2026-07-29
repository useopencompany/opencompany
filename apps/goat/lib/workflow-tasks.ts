import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import type { GoatWorkflowHarnessSpec } from "@opencompany/db/goat-harness";
import type {
  GoatHarnessEngine,
  GoatTask,
  GoatTaskToolName,
  GoatWorkflowStep,
} from "@opencompany/db/goat-schema";
import { goatTasks } from "@opencompany/db/goat-schema";
import { serializeGoatBrainSkillMarkdown } from "@opencompany/goat-brain";
import { and, eq } from "drizzle-orm";
import { generateGoatChatTitle } from "@/lib/chat-title";
import { isGoatCodexConnectedForUser } from "@/lib/codex-auth";
import { getGoatAvailableHarnessTools } from "@/lib/integrations/google-data";
import {
  type GoatSkillMentionRef,
  type GoatWorkspaceSkill,
  resolveGoatSkillMentions,
} from "@/lib/skills";
import { createGoatTaskForUser } from "@/lib/tasks";
import {
  DEFAULT_GOAT_WORKFLOW_MODEL_TOKEN,
  type GoatWorkflowModelToken,
  isGoatWorkflowModelToken,
} from "@/lib/workflow-model-options";
import {
  GoatWorkflowMentionError,
  type GoatWorkflowMentionRef,
  type GoatWorkspaceWorkflow,
  resolveGoatWorkflowMention,
} from "@/lib/workflows";

export type GoatWorkflowEngineSelection = {
  engine: GoatHarnessEngine;
  model: AgentModelId;
};

// The token → engine/model mapping for the shared option list in
// workflow-model-options.ts (kept there so the client editor can render it).
const GOAT_WORKFLOW_MODEL_MENTIONS: Record<GoatWorkflowModelToken, GoatWorkflowEngineSelection> = {
  codex: { engine: "codex", model: "openai/gpt-5.5" },
  "kimi-k2.6": { engine: "opencompany", model: "moonshotai/kimi-k2.6" },
  "kimi-k3": { engine: "opencompany", model: "moonshotai/kimi-k3" },
  "glm-5.2": { engine: "opencompany", model: "zai/glm-5.2" },
  "sonnet-5": { engine: "opencompany", model: "anthropic/claude-sonnet-5" },
  "gpt-5.5": { engine: "opencompany", model: "openai/gpt-5.5" },
};

const DEFAULT_GOAT_WORKFLOW_SELECTION: GoatWorkflowEngineSelection =
  GOAT_WORKFLOW_MODEL_MENTIONS[DEFAULT_GOAT_WORKFLOW_MODEL_TOKEN];

// The token must end alphanumeric so trailing punctuation ("run @sonnet-5.")
// stays out of the capture while inner dots ("@kimi-k2.6") still match.
const WORKFLOW_MENTION_TOKEN_PATTERN = /(^|\s)@([a-z0-9](?:[a-z0-9./-]*[a-z0-9])?)/gi;
const WORKFLOW_SKILL_MENTION_PATTERN = /(^|\s)@skill\/([a-z0-9][a-z0-9-]{0,79})(?![a-z0-9-])/gi;

export function resolveGoatWorkflowStepSelection(
  step: Pick<GoatWorkflowStep, "model" | "instructions">,
): GoatWorkflowEngineSelection {
  const selectedToken = step.model.trim().toLowerCase();
  if (selectedToken) {
    if (!isGoatWorkflowModelToken(selectedToken)) {
      throw new GoatWorkflowMentionError(
        `This workflow step's model "${selectedToken}" is not available. Pick a model in the workflow editor.`,
      );
    }
    return GOAT_WORKFLOW_MODEL_MENTIONS[selectedToken];
  }

  const selected = new Map<string, GoatWorkflowEngineSelection>();
  for (const match of step.instructions.matchAll(WORKFLOW_MENTION_TOKEN_PATTERN)) {
    const token = (match[2] ?? "").toLowerCase();
    if (!isGoatWorkflowModelToken(token)) continue;
    selected.set(token, GOAT_WORKFLOW_MODEL_MENTIONS[token]);
  }
  if (selected.size > 1) {
    throw new GoatWorkflowMentionError(
      `This workflow step mentions more than one model (${[...selected.keys()]
        .map((token) => `@${token}`)
        .join(", ")}). Pick one model for the step.`,
    );
  }
  return [...selected.values()][0] ?? DEFAULT_GOAT_WORKFLOW_SELECTION;
}

// Retained as a compatibility name for callers that parse one legacy step.
export function parseGoatWorkflowEngineSelection(step: {
  model?: string;
  instructions: string;
}): GoatWorkflowEngineSelection {
  return resolveGoatWorkflowStepSelection({
    model: step.model ?? "",
    instructions: step.instructions,
  });
}

export function extractGoatWorkflowSkillMentionRefs(instructions: string): GoatSkillMentionRef[] {
  const ids = new Set<string>();
  for (const match of instructions.matchAll(WORKFLOW_SKILL_MENTION_PATTERN)) {
    const id = match[2]?.toLowerCase();
    if (id) ids.add(id);
  }
  return [...ids].map((id) => ({ id }));
}

export function compileGoatWorkflowHarnessSpec(input: {
  workflow: GoatWorkspaceWorkflow;
  workspaceId: string;
  skills: GoatWorkspaceSkill[];
  tools: GoatTaskToolName[];
  description: string;
}): GoatWorkflowHarnessSpec {
  const skillById = new Map(input.skills.map((skill) => [skill.id, skill]));
  const steps = input.workflow.steps.map((step, index) => {
    const selection = resolveGoatWorkflowStepSelection(step);
    const stepSkills = extractGoatWorkflowSkillMentionRefs(step.instructions)
      .map((mention) => skillById.get(mention.id))
      .filter((skill): skill is GoatWorkspaceSkill => Boolean(skill));
    const skillBlocks =
      selection.engine === "opencompany"
        ? stepSkills.map((skill) => serializeGoatBrainSkillMarkdown(skill))
        : [];
    const title = step.title.trim() || `Step ${index + 1}`;
    const systemPrompt = [
      `You are executing step ${index + 1} of ${input.workflow.steps.length} ("${title}") of the user-authored workflow "${input.workflow.name}" as a background task.`,
      ...(input.workflow.description
        ? [`Workflow description: ${input.workflow.description}`]
        : []),
      "Complete this step using the prior workflow transcript as context. Work autonomously; there is no interactive user in this run.",
      "",
      "<workflow_step_instructions>",
      step.instructions,
      "</workflow_step_instructions>",
      ...(skillBlocks.length > 0
        ? [
            "",
            "This step references these user-authored skills. Apply them where relevant:",
            "",
            "<workflow_skills>",
            skillBlocks.join("\n\n"),
            "</workflow_skills>",
          ]
        : []),
    ].join("\n");

    return {
      index,
      title: step.title,
      engine: selection.engine,
      model: selection.model,
      systemPrompt,
      systemBlocks: [systemPrompt],
      skillIds: stepSkills.map((skill) => skill.id),
    };
  });
  const firstStep = steps[0];
  if (!firstStep) {
    throw new GoatWorkflowMentionError("This workflow has no steps to run.");
  }
  const hasCodexStep = steps.some((step) => step.engine === "codex");

  return {
    schemaVersion: "goat.harness.v1",
    // Mirror step 0 so an older runner degrades to executing the first step.
    engine: firstStep.engine,
    model: firstStep.model,
    systemPrompt: firstStep.systemPrompt,
    systemBlocks: firstStep.systemBlocks,
    initialUserMessage: [`Task: ${input.workflow.name}`, "", input.description].join("\n"),
    tools: input.tools,
    skills: [],
    maxModelSteps: 16,
    resultMode: "assistant_final",
    workflow: {
      id: input.workflow.id,
      workspaceId: input.workspaceId,
      skillIds: input.skills.map((skill) => skill.id),
      steps,
      currentStepIndex: 0,
      ...(hasCodexStep
        ? {
            skillSnapshots: input.skills.map((skill) => ({
              id: skill.id,
              name: skill.name,
              description: skill.description,
              instructions: skill.instructions,
            })),
          }
        : {}),
    },
  };
}

export async function createGoatTaskFromWorkflow(input: {
  userWorkosId: string;
  workspaceId: string | null;
  mention: GoatWorkflowMentionRef;
  description: string;
}): Promise<GoatTask> {
  const workflow = await resolveGoatWorkflowMention({
    workspaceId: input.workspaceId,
    mention: input.mention,
  });
  // resolveGoatWorkflowMention throws when workspaceId is null, so it is set here.
  const workspaceId = input.workspaceId as string;
  const stepSelections = workflow.steps.map(resolveGoatWorkflowStepSelection);
  if (
    stepSelections.some((selection) => selection.engine === "codex") &&
    !(await isGoatCodexConnectedForUser(input.userWorkosId))
  ) {
    throw new GoatWorkflowMentionError(
      `Workflow "#${workflow.id}" uses Codex, but Codex is not connected. Connect Codex in Settings first.`,
    );
  }

  const skillRefs = [
    ...new Map(
      workflow.steps
        .flatMap((step) => extractGoatWorkflowSkillMentionRefs(step.instructions))
        .map((mention) => [mention.id, mention]),
    ).values(),
  ];
  const skills = await resolveGoatSkillMentions({
    workspaceId,
    mentions: skillRefs,
  });
  const tools = await getGoatAvailableHarnessTools(input.userWorkosId);
  const description = input.description.trim() || workflow.name;

  const harnessSpec = compileGoatWorkflowHarnessSpec({
    workflow,
    workspaceId,
    skills,
    tools,
    description,
  });

  return createGoatTaskForUser({
    userWorkosId: input.userWorkosId,
    prompt: description,
    model: stepSelections[0]!.model,
    name: workflow.name,
    harnessSpec,
    // `workflowId` holds the workspace-scoped workflow slug.
    workflowId: workflow.id,
  });
}

// Chat- and trigger-created workflow tasks share this: the task is created instantly with the
// workflow name, then renamed to a cheap one-line summary of the request once generation lands.
export async function generateGoatWorkflowTaskTitle(input: {
  taskId: string;
  userWorkosId: string;
  workflowName: string;
  description: string;
  apiKey?: string | null;
}): Promise<void> {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) return;
  try {
    const title = await generateGoatChatTitle({
      content: input.description,
      fallbackTitle: input.workflowName,
      apiKey,
      userWorkosId: input.userWorkosId,
    });
    if (!title || title === input.workflowName) return;
    await getDb()
      .update(goatTasks)
      .set({ name: title, updatedAt: new Date() })
      .where(and(eq(goatTasks.id, input.taskId), eq(goatTasks.userWorkosId, input.userWorkosId)));
  } catch {
    // Keep the workflow-name fallback; a missing pretty title is not worth failing anything.
  }
}
