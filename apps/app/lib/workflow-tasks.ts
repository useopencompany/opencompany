import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { serializeBrainSkillMarkdown } from "@opencompany/brain";
import { getDb } from "@opencompany/db/client";
import type { WorkflowHarnessSpec } from "@opencompany/db/harness";
import type {
  ChatMessageAttachment,
  HarnessEngine,
  Task,
  TaskToolName,
  WorkflowStep,
} from "@opencompany/db/schema";
import { chatSessions, tasks } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { generateChatTitle } from "@/lib/chat-title";
import { isClaudeCodeConnectedForUser } from "@/lib/claude-code-auth";
import { isCodexConnectedForUser } from "@/lib/codex-auth";
import { getAvailableHarnessTools } from "@/lib/integrations/google-data";
import { resolveSkillMentions, type SkillMentionRef, type WorkspaceSkill } from "@/lib/skills";
import { createTaskForUser } from "@/lib/tasks";
import {
  DEFAULT_WORKFLOW_MODEL_TOKEN,
  isWorkflowModelToken,
  workflowModelSelection,
} from "@/lib/workflow-model-options";
import {
  resolveWorkflowMention,
  WorkflowMentionError,
  type WorkflowMentionRef,
  type WorkspaceWorkflow,
} from "@/lib/workflows";

export type WorkflowEngineSelection = {
  engine: HarnessEngine;
  model: AgentModelId;
  reasoningEffort?: WorkflowStep["reasoningEffort"];
};

const DEFAULT_WORKFLOW_SELECTION: WorkflowEngineSelection = workflowModelSelection({
  model: DEFAULT_WORKFLOW_MODEL_TOKEN,
});

// The token must end alphanumeric so trailing punctuation ("run @sonnet-5.")
// stays out of the capture while inner dots ("@kimi-k2.6") still match.
const WORKFLOW_MENTION_TOKEN_PATTERN = /(^|\s)@([a-z0-9](?:[a-z0-9./-]*[a-z0-9])?)/gi;
const WORKFLOW_SKILL_MENTION_PATTERN = /(^|\s)@skill\/([a-z0-9][a-z0-9-]{0,79})(?![a-z0-9-])/gi;

export function resolveWorkflowStepSelection(step: {
  model: string;
  runtimeModel?: unknown;
  reasoningEffort?: unknown;
  instructions: string;
}): WorkflowEngineSelection {
  const selectedToken = step.model.trim().toLowerCase();
  if (selectedToken) {
    if (!isWorkflowModelToken(selectedToken)) {
      throw new WorkflowMentionError(
        `This workflow step's model "${selectedToken}" is not available. Pick a model in the workflow editor.`,
      );
    }
    return workflowModelSelection({
      model: selectedToken,
      runtimeModel: step.runtimeModel,
      reasoningEffort: step.reasoningEffort,
    });
  }

  const selected = new Map<string, WorkflowEngineSelection>();
  for (const match of step.instructions.matchAll(WORKFLOW_MENTION_TOKEN_PATTERN)) {
    const token = (match[2] ?? "").toLowerCase();
    if (!isWorkflowModelToken(token)) continue;
    selected.set(token, workflowModelSelection({ model: token }));
  }
  if (selected.size > 1) {
    throw new WorkflowMentionError(
      `This workflow step mentions more than one model (${[...selected.keys()]
        .map((token) => `@${token}`)
        .join(", ")}). Pick one model for the step.`,
    );
  }
  return [...selected.values()][0] ?? DEFAULT_WORKFLOW_SELECTION;
}

// Retained as a compatibility name for callers that parse one legacy step.
export function parseWorkflowEngineSelection(step: {
  model?: string;
  runtimeModel?: unknown;
  reasoningEffort?: unknown;
  instructions: string;
}): WorkflowEngineSelection {
  return resolveWorkflowStepSelection({
    model: step.model ?? "",
    runtimeModel: step.runtimeModel,
    reasoningEffort: step.reasoningEffort,
    instructions: step.instructions,
  });
}

export function extractWorkflowSkillMentionRefs(instructions: string): SkillMentionRef[] {
  const ids = new Set<string>();
  for (const match of instructions.matchAll(WORKFLOW_SKILL_MENTION_PATTERN)) {
    const id = match[2]?.toLowerCase();
    if (id) ids.add(id);
  }
  return [...ids].map((id) => ({ id }));
}

export function compileWorkflowHarnessSpec(input: {
  workflow: WorkspaceWorkflow;
  workspaceId: string;
  skills: WorkspaceSkill[];
  invokedSkillIds?: readonly string[];
  tools: TaskToolName[];
  description: string;
}): WorkflowHarnessSpec {
  const skillById = new Map(input.skills.map((skill) => [skill.id, skill]));
  const invokedSkillIds = new Set(input.invokedSkillIds ?? []);
  const steps = input.workflow.steps.map((step, index) => {
    const selection = resolveWorkflowStepSelection(step);
    const stepSkillIds = new Set(
      extractWorkflowSkillMentionRefs(step.instructions).map((mention) => mention.id),
    );
    // Composer-invoked skills belong to the workflow's first user turn. Later steps run in
    // isolated sessions and keep only the skills authored into those steps.
    if (index === 0) {
      for (const skillId of invokedSkillIds) stepSkillIds.add(skillId);
    }
    const stepSkills = [...stepSkillIds]
      .map((skillId) => skillById.get(skillId))
      .filter((skill): skill is WorkspaceSkill => Boolean(skill));
    const skillBlocks =
      selection.engine === "opencompany"
        ? stepSkills.map((skill) => serializeBrainSkillMarkdown(skill))
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
    throw new WorkflowMentionError("This workflow has no steps to run.");
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

export async function createTaskFromWorkflow(input: {
  userWorkosId: string;
  workspaceId: string | null;
  mention: WorkflowMentionRef;
  skillMentions?: SkillMentionRef[];
  description: string;
  attachments?: ChatMessageAttachment[];
  attachmentTexts?: Record<string, string> | null;
}): Promise<Task> {
  const workflow = await resolveWorkflowMention({
    workspaceId: input.workspaceId,
    mention: input.mention,
  });
  // resolveWorkflowMention throws when workspaceId is null, so it is set here.
  const workspaceId = input.workspaceId as string;
  const prepared = await prepareWorkflowRunForUser({
    userWorkosId: input.userWorkosId,
    workspaceId,
    workflow,
    description: input.description,
    ...(input.skillMentions ? { skillMentions: input.skillMentions } : {}),
  });

  return createTaskForUser({
    userWorkosId: input.userWorkosId,
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

export async function prepareWorkflowRunForUser(input: {
  userWorkosId: string;
  workspaceId: string;
  workflow: WorkspaceWorkflow;
  skillMentions?: SkillMentionRef[];
  description: string;
}): Promise<{
  description: string;
  stepSelections: WorkflowEngineSelection[];
  harnessSpec: WorkflowHarnessSpec;
}> {
  const { workflow } = input;
  const stepSelections = workflow.steps.map(resolveWorkflowStepSelection);
  const hasCodexStep = stepSelections.some((selection) => selection.engine === "codex");
  const hasClaudeCodeStep = stepSelections.some((selection) => selection.engine === "claude_code");
  if (hasCodexStep && !(await isCodexConnectedForUser(input.userWorkosId))) {
    throw new WorkflowMentionError(
      `Workflow "#${workflow.id}" uses Codex, but Codex is not connected. Connect Codex in Settings first.`,
    );
  }
  if (hasClaudeCodeStep && !(await isClaudeCodeConnectedForUser(input.userWorkosId))) {
    throw new WorkflowMentionError(
      `Workflow "#${workflow.id}" uses Claude Code, but Claude Code is not connected. Connect Claude Code in Settings first.`,
    );
  }

  const workflowSkillRefs = [
    ...new Map(
      workflow.steps
        .flatMap((step) => extractWorkflowSkillMentionRefs(step.instructions))
        .map((mention) => [mention.id, mention]),
    ).values(),
  ];
  const invokedSkillRefs = input.skillMentions ?? [];
  const skillRefs = [
    ...new Map(
      [...workflowSkillRefs, ...invokedSkillRefs].map((mention) => [mention.id, mention]),
    ).values(),
  ];
  const skills = await resolveSkillMentions({
    workspaceId: input.workspaceId,
    mentions: skillRefs,
  });
  const tools = await getAvailableHarnessTools(input.userWorkosId);
  const description = input.description.trim() || workflow.name;

  const harnessSpec = compileWorkflowHarnessSpec({
    workflow,
    workspaceId: input.workspaceId,
    skills,
    invokedSkillIds: invokedSkillRefs.map((mention) => mention.id),
    tools,
    description,
  });

  return { description, stepSelections, harnessSpec };
}

// Chat- and trigger-created workflow tasks share this: the task is created instantly with the
// workflow name, then renamed to a cheap one-line summary of the request once generation lands.
export async function generateWorkflowTaskTitle(input: {
  taskId: string;
  userWorkosId: string;
  workflowName: string;
  description: string;
  apiKey?: string | null;
}): Promise<void> {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) return;
  try {
    const title = await generateChatTitle({
      content: input.description,
      fallbackTitle: input.workflowName,
      apiKey,
      userWorkosId: input.userWorkosId,
    });
    if (!title || title === input.workflowName) return;
    const now = new Date();
    const db = getDb();
    const [task] = await db
      .update(tasks)
      .set({ name: title, updatedAt: now })
      .where(and(eq(tasks.id, input.taskId), eq(tasks.userWorkosId, input.userWorkosId)))
      .returning({ sessionId: tasks.sessionId });
    if (!task?.sessionId) return;
    await db
      .update(chatSessions)
      .set({ title, updatedAt: now })
      .where(
        and(
          eq(chatSessions.id, task.sessionId),
          eq(chatSessions.userWorkosId, input.userWorkosId),
          eq(chatSessions.kind, "task"),
        ),
      );
  } catch {
    // Keep the workflow-name fallback; a missing pretty title is not worth failing anything.
  }
}
