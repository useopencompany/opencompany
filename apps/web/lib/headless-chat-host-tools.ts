import type {
  GoatChatHostToolGatewayRequest,
  GoatChatHostToolGatewayResponse,
} from "@opencompany/agent-runtime";
import type { GoatChatHostToolServiceDependencies } from "@opencompany/goat-agent/application/host-tools";
import { executePersistedGoatChatHostTool } from "@opencompany/goat-agent/application/persisted-host-tools";
import { after } from "next/server";
import { planGoatTaskHarness, triggerGoatCodexChatWake } from "@/lib/task-runner";

// Rollback adapter for the legacy internal route. The runner calls the same
// persisted application service directly during normal execution.
export function executeHeadlessChatHostToolGateway(input: {
  request: GoatChatHostToolGatewayRequest;
  signal?: AbortSignal;
  dependencies?: Partial<GoatChatHostToolServiceDependencies>;
}): Promise<GoatChatHostToolGatewayResponse> {
  return executePersistedGoatChatHostTool({
    request: input.request,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.dependencies ? { dependencies: input.dependencies } : {}),
    runtime: {
      wakeTaskWorker: triggerGoatCodexChatWake,
      defer: (work) => after(work),
      planHarness: ({ actorId, prompt }) => planGoatTaskHarness({ userWorkosId: actorId, prompt }),
    },
  });
}
