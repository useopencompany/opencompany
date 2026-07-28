import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import type {
  GoatHarnessEngine,
  GoatHarnessSpec,
  GoatTask,
  GoatTaskToolName,
} from "@opencompany/db/goat-schema";
import { goatTasks, goatUsers } from "@opencompany/db/goat-schema";
import {
  type GoatBrainSkill,
  type GoatBrainWorkflow,
  serializeGoatBrainSkillMarkdown,
} from "@opencompany/goat-brain";
import { and, eq } from "drizzle-orm";
import { type GoatBrainSkillMentionRef, resolveGoatBrainSkillMentions } from "@/lib/brain-skills";
import {
  GoatBrainWorkflowMentionError,
  type GoatBrainWorkflowMentionRef,
  resolveGoatBrainWorkflowMention,
} from "@/lib/brain-workflows";
import { generateGoatChatTitle } from "@/lib/chat-title";
import { isGoatCodexConnectedForUser } from "@/lib/codex-auth";
import { getGoatAvailableHarnessTools } from "@/lib/integrations/google-data";
import { createGoatTaskForUser } from "@/lib/tasks";
import {
  DEFAULT_GOAT_WORKFLOW_MODEL_TOKEN,
  type GoatWorkflowModelToken,
  isGoatWorkflowModelToken,
} from "@/lib/workflow-model-options";

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
const WORKFLOW_SKILL_MENTION_PATTERN = /(^|\s)@skill\/([a-z0-9][a-z0-9-]{0,79})(?=\s|$)/gi;

// The editor's Model dropdown (frontmatter `model:`) is the primary selection;
// an inline @mention in the instructions still works when no frontmatter model
// is set. Exactly one model either way.
export function parseGoatWorkflowEngineSelection(workflow: {
  model?: string;
  instructions: string;
}): GoatWorkflowEngineSelection {
  const frontmatterToken = workflow.model?.trim().toLowerCase() ?? "";
  if (frontmatterToken) {
    if (!isGoatWorkflowModelToken(frontmatterToken)) {
      throw new GoatBrainWorkflowMentionError(
        `This workflow's model "${frontmatterToken}" is not available. Pick a model in the workflow editor.`,
      );
    }
    return GOAT_WORKFLOW_MODEL_MENTIONS[frontmatterToken];
  }

  const selected = new Map<string, GoatWorkflowEngineSelection>();
  for (const match of workflow.instructions.matchAll(WORKFLOW_MENTION_TOKEN_PATTERN)) {
    const token = (match[2] ?? "").toLowerCase();
    if (!isGoatWorkflowModelToken(token)) continue;
    selected.set(token, GOAT_WORKFLOW_MODEL_MENTIONS[token]);
  }
  if (selected.size > 1) {
    throw new GoatBrainWorkflowMentionError(
      `This workflow mentions more than one model (${[...selected.keys()]
        .map((token) => `@${token}`)
        .join(", ")}). Keep exactly one model mention in the workflow instructions.`,
    );
  }
  return [...selected.values()][0] ?? DEFAULT_GOAT_WORKFLOW_SELECTION;
}

export function extractGoatWorkflowSkillMentionRefs(
  instructions: string,
  brainRef: string,
): GoatBrainSkillMentionRef[] {
  const ids = new Set<string>();
  for (const match of instructions.matchAll(WORKFLOW_SKILL_MENTION_PATTERN)) {
    const id = match[2]?.toLowerCase();
    if (id) ids.add(id);
  }
  return [...ids].map((id) => ({ brainRef, id }));
}

export function compileGoatWorkflowHarnessSpec(input: {
  workflow: GoatBrainWorkflow;
  brainRef: string;
  skills: GoatBrainSkill[];
  tools: GoatTaskToolName[];
  selection: GoatWorkflowEngineSelection;
  description: string;
}): GoatHarnessSpec {
  const skillBlocks = input.skills.map((skill) => serializeGoatBrainSkillMarkdown(skill));
  const systemPrompt = [
    `You are executing the user-authored workflow "${input.workflow.name}" as a background task.`,
    ...(input.workflow.description ? [`Workflow description: ${input.workflow.description}`] : []),
    "Follow the workflow instructions below to complete the user's request. Work autonomously to completion; there is no interactive user in this run.",
    "",
    "<workflow_instructions>",
    input.workflow.instructions,
    "</workflow_instructions>",
    ...(skillBlocks.length > 0
      ? [
          "",
          "The workflow references these user-authored skills. Apply them where relevant:",
          "",
          "<workflow_skills>",
          skillBlocks.join("\n\n"),
          "</workflow_skills>",
        ]
      : []),
  ].join("\n");

  return {
    schemaVersion: "goat.harness.v1",
    engine: input.selection.engine,
    model: input.selection.model,
    systemPrompt,
    // The opencompany-engine chat loop composes the shared main-chat system
    // prompt and appends these blocks; the workflow instructions + skills ride
    // here. (systemPrompt above is still used by the Codex engine path.)
    systemBlocks: [systemPrompt],
    initialUserMessage: [`Task: ${input.workflow.name}`, "", input.description].join("\n"),
    tools: input.tools,
    skills: [],
    maxModelSteps: 16,
    resultMode: "assistant_final",
    workflow: {
      id: input.workflow.id,
      brainRef: input.brainRef,
      skillIds: input.skills.map((skill) => skill.id),
    },
  };
}

export async function createGoatTaskFromWorkflow(input: {
  userWorkosId: string;
  activeBrainRef: string | null;
  mention: GoatBrainWorkflowMentionRef;
  description: string;
}): Promise<GoatTask> {
  const workflow = await resolveGoatBrainWorkflowMention({
    activeBrainRef: input.activeBrainRef,
    mention: input.mention,
  });
  const selection = parseGoatWorkflowEngineSelection(workflow);
  if (selection.engine === "codex" && !(await isGoatCodexConnectedForUser(input.userWorkosId))) {
    throw new GoatBrainWorkflowMentionError(
      `Workflow "#${workflow.id}" runs on Codex, but Codex is not connected. Connect Codex in Settings first.`,
    );
  }

  const skillRefs = extractGoatWorkflowSkillMentionRefs(
    workflow.instructions,
    input.mention.brainRef,
  );
  const skills = await resolveGoatBrainSkillMentions({
    activeBrainRef: input.activeBrainRef,
    mentions: skillRefs,
  });
  const tools = await getGoatAvailableHarnessTools(input.userWorkosId);
  const description = input.description.trim() || workflow.name;

  const harnessSpec = compileGoatWorkflowHarnessSpec({
    workflow,
    brainRef: input.mention.brainRef,
    skills,
    tools,
    selection,
    description,
  });

  // Workflow tasks run on the background-task pipeline, which is gated on the
  // per-user task-spawning setting (task creation AND the runner claim query
  // both require it). Explicitly firing a workflow is opting in, so flip the
  // setting on instead of dead-ending behind a hidden toggle.
  await getDb()
    .update(goatUsers)
    .set({ taskSpawningEnabled: true, updatedAt: new Date() })
    .where(
      and(eq(goatUsers.workosUserId, input.userWorkosId), eq(goatUsers.taskSpawningEnabled, false)),
    );

  return createGoatTaskForUser({
    userWorkosId: input.userWorkosId,
    prompt: description,
    model: selection.model,
    name: workflow.name,
    harnessSpec,
    workflowId: workflow.id,
    workflowBrainRef: input.mention.brainRef,
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
