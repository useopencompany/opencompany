export type AgentSessionStatus =
  | "created"
  | "provisioning"
  | "ready"
  | "running"
  | "aborting"
  | "archiving"
  | "archived"
  | "completed"
  | "failed";

export type AgentRuntimeEvent =
  | {
      type: "session.status";
      payload: { status: AgentSessionStatus; message?: string };
    }
  | {
      type: "message.created";
      payload: {
        messageId: string;
        role: "user" | "assistant" | "tool";
        content?: string;
        status?: "running" | "completed";
        internal?: boolean;
      };
    }
  | {
      type: "message.delta";
      payload: { messageId: string; delta: string };
    }
  | {
      type: "message.reasoning_delta";
      payload: { messageId: string; delta: string };
    }
  | {
      type: "message.completed";
      payload: {
        messageId: string;
        content?: string;
        modelMessage?: Record<string, unknown>;
        internal?: boolean;
      };
    }
  | {
      type: "message.reasoning_summary";
      payload: { messageId: string; summary: string };
    }
  | {
      type: "tool.started";
      payload: { messageId: string; toolCallId: string; name: string; input?: unknown };
    }
  | {
      type: "tool.completed";
      payload: {
        messageId: string;
        toolCallId: string;
        name: string;
        outputPreview?: string;
        output?: unknown;
      };
    }
  | {
      type: "tool.failed";
      payload: {
        messageId: string;
        toolCallId: string;
        name: string;
        outputPreview?: string;
        output?: unknown;
        error: { message: string; code: string; recoverable: boolean };
      };
    }
  | {
      type: "file.changed";
      payload: { path: string; operation: "write" };
    }
  | {
      type: "brain.file_changed";
      payload: { path: string; savedPath?: string; operation: "write" | "delete" };
    }
  | {
      type: "brain.conflict";
      payload: {
        path: string;
        savedPath?: string;
        operation: "conflict_copy" | "delete_conflict";
      };
    }
  | {
      type: "command.output";
      payload: {
        command: string;
        toolCallId?: string;
        stream: "stdout" | "stderr";
        delta: string;
      };
    }
  | {
      type: "session.error";
      payload: { message: string };
    }
  | {
      type: "session.title_updated";
      payload: { title: string };
    }
  | {
      type: "session.usage";
      payload: {
        messageId: string;
        runLeaseId: string;
        stepIndex: number;
        modelProvider: string;
        modelName: string;
        responseModelId?: string;
        inputTokens: number;
        inputNoCacheTokens: number;
        inputCacheReadTokens: number;
        inputCacheWriteTokens: number;
        outputTokens: number;
        outputTextTokens: number;
        outputReasoningTokens: number;
        totalTokens: number;
        providerCostUsdMicros?: number;
        platformFeeUsdMicros?: number;
        chargedCostUsdMicros?: number;
        finishReason?: string;
        rawFinishReason?: string;
      };
    }
  | {
      type: "session.tool_usage";
      payload: {
        messageId: string;
        runLeaseId: string;
        toolCallId: string;
        toolName: string;
        provider: string;
        operation: string;
        providerRequestId?: string;
        costUsdMicros: number;
        providerCostUsdMicros?: number;
        platformFeeUsdMicros?: number;
        chargedCostUsdMicros?: number;
      };
    }
  | {
      type: "session.delegated_usage";
      payload: {
        childSessionId: string;
        parentToolCallId: string;
        usage: {
          inputTokens: number;
          inputNoCacheTokens: number;
          inputCacheReadTokens: number;
          inputCacheWriteTokens: number;
          outputTokens: number;
          outputTextTokens: number;
          outputReasoningTokens: number;
          totalTokens: number;
        };
        toolUsage: {
          totalCostUsdMicros: number;
          byProviderOperation: Array<{
            provider: string;
            operation: string;
            costUsdMicros: number;
            calls: number;
          }>;
        };
        cost: {
          providerCostUsdMicros: number;
          platformFeeUsdMicros: number;
          totalCostUsdMicros: number;
          modelCostUsdMicros: number;
          toolCostUsdMicros: number;
        };
      };
    }
  | {
      type: "session.archived";
      payload: {
        sandboxId: string | null;
        sandboxKilled: boolean;
        sandboxAlreadyStopped: boolean;
      };
    }
  | {
      type: "after_session.started";
      payload: { runId?: number; messageId: string; idleDelaySeconds: number };
    }
  | {
      type: "after_session.completed";
      payload: { runId?: number; messageId: string };
    }
  | {
      type: "after_session.skipped";
      payload: { messageId: string; reason: string };
    }
  | {
      type: "after_session.failed";
      payload: { runId?: number; messageId: string; message: string };
    };

export type AgentRuntimeEventType = AgentRuntimeEvent["type"];
export type AgentRuntimeEventPayload = AgentRuntimeEvent["payload"];
