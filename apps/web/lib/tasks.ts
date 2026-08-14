"use server";

import { createTaskForActor } from "@opencompany/agent/application/task-creation";
import type { ChatMessageAttachment } from "@opencompany/agent/chat-attachment-formats";
import type { HarnessEngine, HarnessSpec } from "@opencompany/agent/task-runtime-types";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { TaskSource } from "@opencompany/core";
import { after } from "next/server";
import { triggerCodexChatWake } from "@/lib/task-runner";

// Internal web producers use the same application service as the public /v1 command surface.
// Browser callers must use the typed protocol client instead of importing this server adapter.
export async function createTaskForUser(input: {
  userWorkosId: string;
  workspaceId?: string | null;
  brainRef?: string | null;
  prompt: string;
  model: AgentModelId;
  name?: string;
  engine?: HarnessEngine;
  harnessSpec?: HarnessSpec;
  scheduleId?: string;
  scheduledFor?: Date;
  workflowId?: string;
  workflowBrainRef?: string;
  attachments?: ChatMessageAttachment[];
  attachmentTexts?: Record<string, string> | null;
  source?: TaskSource;
  idempotencyKey?: string;
}) {
  const { userWorkosId, ...command } = input;
  return createTaskForActor(
    { ...command, actorId: userWorkosId },
    {
      wakeTaskWorker: triggerCodexChatWake,
      defer: after,
    },
  );
}
