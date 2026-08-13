import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { GoatWorkflowHarnessSpec } from "@opencompany/db/goat-harness";
import type {
  GoatChatMessageAttachment,
  GoatHarnessEngine,
  GoatTask,
  GoatTaskToolName,
  GoatWorkflowStep,
} from "@opencompany/db/goat-schema";
import { serializeGoatBrainSkillMarkdown } from "@opencompany/goat-brain";
import {
  isGoatClaudeCodeConnectedForUser,
  isGoatCodexConnectedForUser,
} from "./application/engine-auth-status";
import { getGoatAvailableHarnessTools } from "./integrations/google-data";
import {
  type GoatSkillMentionRef,
  type GoatWorkspaceSkill,
  resolveGoatSkillMentions,
} from "./skills";
import {
  DEFAULT_GOAT_WORKFLOW_MODEL_TOKEN,
  goatWorkflowModelSelection,
  isGoatWorkflowModelToken,
} from "./workflow-model-options";
import {
  GoatWorkflowMentionError,
  type GoatWorkflowMentionRef,
  type GoatWorkspaceWorkflow,
  resolveGoatWorkflowMention,
} from "./workflows";

export type GoatWorkflowEngineSelection = {
  engine: GoatHarnessEngine;
  model: AgentModelId;
  reasoningEffort?: GoatWorkflowStep["reasoningEffort"];
};

const DEFAULT_GOAT_WORKFLOW_SELECTION: GoatWorkflowEngineSelection = goatWorkflowModelSelection({
  model: DEFAULT_GOAT_WORKFLOW_MODEL_TOKEN,
});

// The token must end alphanumeric so trailing punctuation ("run @sonnet-5.")
// stays out of the capture while inner dots ("@kimi-k2.6") still match.
const WORKFLOW_MENTION_TOKEN_PATTERN = /(^|\s)@([a-z0-9](?:[a-z0-9./-]*[a-z0-9])?)/gi;
const WORKFLOW_SKILL_MENTION_PATTERN = /(^|\s)@skill\/([a-z0-9][a-z0-9-]{0,79})(?![a-z0-9-])/gi;

export function resolveGoatWorkflowStepSelection(step: {
  model: string;
  runtimeModel?: unknown;
  reasoningEffort?: unknown;
  instructions: string;
}): GoatWorkflowEngineSelection {
  const selectedToken = step.model.trim().toLowerCase();
  if (selectedToken) {
    if (!isGoatWorkflowModelToken(selectedToken)) {
      throw new GoatWorkflowMentionError(
        `This workflow step's model "${selectedToken}" is not available. Pick a model in the workflow editor.`,
      );
    }
    return goatWorkflowModelSelection({
      model: selectedToken,
      runtimeModel: step.runtimeModel,
      reasoningEffort: step.reasoningEffort,
    });
  }

  const selected = new Map<string, GoatWorkflowEngineSelection>();
  for (const match of step.instructions.matchAll(WORKFLOW_MENTION_TOKEN_PATTERN)) {
    const token = (match[2] ?? "").toLowerCase();
    if (!isGoatWorkflowModelToken(token)) continue;
    selected.set(token, goatWorkflowModelSelection({ model: token }));
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
  runtimeModel?: unknown;
  reasoningEffort?: unknown;
  instructions: string;
}): GoatWorkflowEngineSelection {
  return resolveGoatWorkflowStepSelection({
    model: step.model ?? "",
    runtimeModel: step.runtimeModel,
    reasoningEffort: step.reasoningEffort,
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
  invokedSkillIds?: readonly string[];
  tools: GoatTaskToolName[];
  description: string;
}): GoatWorkflowHarnessSpec {
  const skillById = new Map(input.skills.map((skill) => [skill.id, skill]));
  const invokedSkillIds = new Set(input.invokedSkillIds ?? []);
  const steps = input.workflow.steps.map((step, index) => {
    const selection = resolveGoatWorkflowStepSelection(step);
    const stepSkillIds = new Set(
      extractGoatWorkflowSkillMentionRefs(step.instructions).map((mention) => mention.id),
    );
    // Composer-invoked skills belong to the workflow's first user turn. Later steps stay in the
    // same Conversation and use only the skills authored into those steps.
    if (index === 0) {
      for (const skillId of invokedSkillIds) stepSkillIds.add(skillId);
    }
    const stepSkills = [...stepSkillIds]
      .map((skillId) => skillById.get(skillId))
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
      "Complete this step using the task request plus explicit handoff artifacts from prior steps. Work autonomously; there is no interactive user in this run.",
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
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      systemPrompt,
      systemBlocks: [systemPrompt],
      skillIds: stepSkills.map((skill) => skill.id),
    };
  });
  const firstStep = steps[0];
  if (!firstStep) {
    throw new GoatWorkflowMentionError("This workflow has no steps to run.");
  }
  const hasSandboxStep = steps.some(
    (step) => step.engine === "codex" || step.engine === "claude_code",
  );

  return {
    schemaVersion: "goat.harness.v1",
    // Mirror step 0 so an older runner degrades to executing the first step.
    engine: firstStep.engine,
    model: firstStep.model,
    ...(firstStep.reasoningEffort ? { codex: { reasoningEffort: firstStep.reasoningEffort } } : {}),
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
      completedStepCount: 0,
      ...(hasSandboxStep
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

export async function createGoatTaskFromWorkflow(
  input: {
    userWorkosId: string;
    workspaceId: string | null;
    mention: GoatWorkflowMentionRef;
    skillMentions?: GoatSkillMentionRef[];
    description: string;
    attachments?: GoatChatMessageAttachment[];
    attachmentTexts?: Record<string, string> | null;
  },
  dependencies: {
    createTask: (input: {
      actorId: string;
      workspaceId: string;
      prompt: string;
      model: AgentModelId;
      name: string;
      harnessSpec: GoatWorkflowHarnessSpec;
      attachments?: GoatChatMessageAttachment[];
      attachmentTexts?: Record<string, string> | null;
      workflowId: string;
    }) => Promise<GoatTask>;
    resolveWorkflow?: typeof resolveGoatWorkflowMention;
    preparation?: Partial<GoatWorkflowPreparationDependencies>;
  },
): Promise<GoatTask> {
  const workflow = await (dependencies.resolveWorkflow ?? resolveGoatWorkflowMention)({
    workspaceId: input.workspaceId,
    mention: input.mention,
  });
  // resolveGoatWorkflowMention throws when workspaceId is null, so it is set here.
  const workspaceId = input.workspaceId as string;
  const prepared = await prepareGoatWorkflowRunForUser(
    {
      userWorkosId: input.userWorkosId,
      workspaceId,
      workflow,
      description: input.description,
      ...(input.skillMentions ? { skillMentions: input.skillMentions } : {}),
    },
    dependencies.preparation,
  );

  return dependencies.createTask({
    actorId: input.userWorkosId,
    workspaceId,
    prompt: prepared.description,
    model: prepared.stepSelections[0]!.model,
    name: workflow.name,
    harnessSpec: prepared.harnessSpec,
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.attachmentTexts !== undefined ? { attachmentTexts: input.attachmentTexts } : {}),
    // `workflowId` holds the workspace-scoped workflow slug.
    workflowId: workflow.id,
  });
}

export type GoatWorkflowPreparationDependencies = {
  isCodexConnected: (actorId: string) => Promise<boolean>;
  isClaudeCodeConnected: (actorId: string) => Promise<boolean>;
  resolveSkills: typeof resolveGoatSkillMentions;
  getAvailableTools: typeof getGoatAvailableHarnessTools;
};

const defaultPreparationDependencies: GoatWorkflowPreparationDependencies = {
  isCodexConnected: isGoatCodexConnectedForUser,
  isClaudeCodeConnected: isGoatClaudeCodeConnectedForUser,
  resolveSkills: resolveGoatSkillMentions,
  getAvailableTools: getGoatAvailableHarnessTools,
};

export async function prepareGoatWorkflowRunForUser(
  input: {
    userWorkosId: string;
    workspaceId: string;
    workflow: GoatWorkspaceWorkflow;
    skillMentions?: GoatSkillMentionRef[];
    description: string;
  },
  dependencyOverrides: Partial<GoatWorkflowPreparationDependencies> = {},
): Promise<{
  description: string;
  stepSelections: GoatWorkflowEngineSelection[];
  harnessSpec: GoatWorkflowHarnessSpec;
}> {
  const dependencies = { ...defaultPreparationDependencies, ...dependencyOverrides };
  const { workflow } = input;
  const stepSelections = workflow.steps.map(resolveGoatWorkflowStepSelection);
  const hasCodexStep = stepSelections.some((selection) => selection.engine === "codex");
  const hasClaudeCodeStep = stepSelections.some((selection) => selection.engine === "claude_code");
  if (hasCodexStep && !(await dependencies.isCodexConnected(input.userWorkosId))) {
    throw new GoatWorkflowMentionError(
      `Workflow "#${workflow.id}" uses Codex, but Codex is not connected. Connect Codex in Settings first.`,
    );
  }
  if (hasClaudeCodeStep && !(await dependencies.isClaudeCodeConnected(input.userWorkosId))) {
    throw new GoatWorkflowMentionError(
      `Workflow "#${workflow.id}" uses Claude Code, but Claude Code is not connected. Connect Claude Code in Settings first.`,
    );
  }

  const workflowSkillRefs = [
    ...new Map(
      workflow.steps
        .flatMap((step) => extractGoatWorkflowSkillMentionRefs(step.instructions))
        .map((mention) => [mention.id, mention]),
    ).values(),
  ];
  const invokedSkillRefs = input.skillMentions ?? [];
  const skillRefs = [
    ...new Map(
      [...workflowSkillRefs, ...invokedSkillRefs].map((mention) => [mention.id, mention]),
    ).values(),
  ];
  const skills = await dependencies.resolveSkills({
    workspaceId: input.workspaceId,
    mentions: skillRefs,
  });
  const tools = await dependencies.getAvailableTools(input.userWorkosId);
  const description = input.description.trim() || workflow.name;

  const harnessSpec = compileGoatWorkflowHarnessSpec({
    workflow,
    workspaceId: input.workspaceId,
    skills,
    invokedSkillIds: invokedSkillRefs.map((mention) => mention.id),
    tools,
    description,
  });

  return { description, stepSelections, harnessSpec };
}
