import type {
  AgentSessionQuestionAnswer,
  AgentSessionQuestionPrompt,
  AgentSessionQuestionResolutionSource,
} from "./types";

export type AgentSessionStatus =
  | "created"
  | "provisioning"
  | "ready"
  | "running"
  | "awaiting_approval"
  | "awaiting_input"
  | "aborting"
  | "archiving"
  | "archived"
  | "completed"
  | "failed";

export type AgentRuntimeIncompleteReason = "announced_unexecuted_next_action";

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
      type: "message.reasoning_started";
      payload: { messageId: string };
    }
  | {
      type: "message.reasoning_completed";
      payload: { messageId: string };
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
      // Debug-only snapshot of the inputs sent to the model for a turn (the assembled system
      // prompt + the tool catalog). Not rendered in the UI — captured purely so the session's
      // "Copy JSON" export can include the otherwise-ephemeral request inputs. See
      // isInspectableRuntimeEvent (web) which hides it from the inspector event list.
      type: "debug.model_request";
      payload: {
        messageId: string;
        systemPrompt: string;
        tools: Array<{ name: string; description: string; parameters: unknown }>;
      };
    }
  | {
      type: "message.reasoning_summary";
      payload: { messageId: string; summary: string };
    }
  | {
      type: "message.reasoning_content";
      payload: { messageId: string; text: string; format: "raw" };
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
      type: "tool.approval_required";
      payload: {
        messageId: string;
        toolCallId: string;
        name: string;
        providerKey: string;
        permissionGroup: "read" | "post" | "modify" | "admin";
        inputPreview?: string;
        requestedAt: string;
      };
    }
  | {
      type: "tool.approval_resolved";
      payload: {
        messageId: string;
        toolCallId: string;
        name: string;
        decision: "approved" | "denied";
        decisionSource: "user" | "timeout" | "abort";
      };
    }
  | {
      type: "question.requested";
      payload: {
        messageId: string;
        toolCallId: string;
        questions: AgentSessionQuestionPrompt[];
        requestedAt: string;
      };
    }
  | {
      type: "question.answered";
      payload: {
        messageId: string;
        toolCallId: string;
        // Whether the user actually answered (vs. skipped / timed out / aborted). The web client
        // renders the "Question skipped" summary off this rather than inferring from resolutionSource.
        answered: boolean;
        answers: AgentSessionQuestionAnswer[];
        resolutionSource: AgentSessionQuestionResolutionSource;
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
      type: "agent_bundle.file_changed";
      payload: { path: string; savedPath?: string; operation: "write" | "delete" };
    }
  | {
      type: "agent_bundle.conflict";
      payload: {
        path: string;
        savedPath?: string;
        operation: "conflict_copy" | "delete_conflict";
      };
    }
  | {
      type: "agent.self_updated";
      payload: {
        version: number;
        changedFields: string[];
        summary?: string;
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
      // The model ended its turn under the step limit and with no pending tool
      // calls, but it looks like it stopped mid-task rather than genuinely
      // finishing (e.g. it announced a next action and never took it). The turn
      // still completes, but this distinct event keeps unattended runs from
      // looking cleanly green when the work was actually abandoned.
      type: "session.incomplete";
      payload: { messageId: string; reason: AgentRuntimeIncompleteReason };
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
      type: "session.sandbox_usage";
      payload: {
        messageId: string;
        runLeaseId: string;
        sandboxId: string;
        template: string | null;
        vcpu: number | null;
        ramMib: number | null;
        activeMs: number;
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
          sandboxCostUsdMicros: number;
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
