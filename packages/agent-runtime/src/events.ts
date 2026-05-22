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
      payload: { messageId: string; role: "user" | "assistant" | "tool" };
    }
  | {
      type: "message.delta";
      payload: { messageId: string; delta: string };
    }
  | {
      type: "message.completed";
      payload: { messageId: string; content?: string };
    }
  | {
      type: "tool.started";
      payload: { messageId: string; toolCallId: string; name: string; input?: unknown };
    }
  | {
      type: "tool.delta";
      payload: {
        messageId: string;
        toolCallId: string;
        delta: string;
        stream?: "stdout" | "stderr";
      };
    }
  | {
      type: "tool.completed";
      payload: { messageId: string; toolCallId: string; name: string; output: unknown };
    }
  | {
      type: "file.changed";
      payload: { path: string; operation: "write" };
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
        finishReason?: string;
        rawFinishReason?: string;
      };
    }
  | {
      type: "session.archived";
      payload: {
        sandboxId: string | null;
        sandboxKilled: boolean;
        sandboxAlreadyStopped: boolean;
      };
    };

export type AgentRuntimeEventType = AgentRuntimeEvent["type"];
export type AgentRuntimeEventPayload = AgentRuntimeEvent["payload"];
