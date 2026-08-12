"use server";

import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { TaskSource } from "@opencompany/core";
import type {
  GoatChatMessageAttachment,
  GoatHarnessEngine,
  GoatHarnessSpec,
} from "@opencompany/db/goat-schema";
import { createGoatTaskForActor } from "@opencompany/goat-agent/application/task-creation";
import { after } from "next/server";
import { triggerGoatCodexChatWake } from "@/lib/task-runner";

// Internal web producers use the same application service as the public /v1 command surface.
// Browser callers must use the typed protocol client instead of importing this server adapter.
export async function createGoatTaskForUser(input: {
  userWorkosId: string;
  workspaceId?: string | null;
  brainRef?: string | null;
  prompt: string;
  model: AgentModelId;
  name?: string;
  engine?: GoatHarnessEngine;
  harnessSpec?: GoatHarnessSpec;
  scheduleId?: string;
  scheduledFor?: Date;
  workflowId?: string;
  workflowBrainRef?: string;
  attachments?: GoatChatMessageAttachment[];
  attachmentTexts?: Record<string, string> | null;
  source?: TaskSource;
  idempotencyKey?: string;
}) {
  const { userWorkosId, ...command } = input;
  return createGoatTaskForActor(
    { ...command, actorId: userWorkosId },
    {
      wakeTaskWorker: triggerGoatCodexChatWake,
      defer: after,
    },
  );
}
