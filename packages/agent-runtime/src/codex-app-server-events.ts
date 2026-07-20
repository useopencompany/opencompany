export type CodexAppServerEventType =
  | "assistant.delta"
  | "assistant.completed"
  | "reasoning.completed"
  | "command.started"
  | "command.output"
  | "command.completed"
  | "command.failed"
  | "file_change.started"
  | "file_change.completed"
  | "mcp_tool.started"
  | "mcp_tool.completed"
  | "web_search.started"
  | "web_search.completed"
  | "plan.updated"
  | "goal.updated"
  | "question.requested"
  | "approval.requested"
  | "turn.started"
  | "turn.completed"
  | "usage.updated"
  | "error"
  | "unknown";

export type CodexAppServerNormalizedEvent = {
  type: CodexAppServerEventType;
  payload: Record<string, unknown>;
  rawEvent: Record<string, unknown>;
};

export function normalizeCodexAppServerEvent(
  event: Record<string, unknown>,
): CodexAppServerNormalizedEvent[] {
  const method = firstString(event.method) ?? "";
  const params = readRecord(event.params);
  const item = readRecord(params?.item);
  const base = {
    threadId: firstString(params?.threadId),
    turnId: firstString(params?.turnId, stringFromPath(params, ["turn", "id"])),
    itemId: firstString(params?.itemId, item?.id),
  };

  if (method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params?.questions) ? params.questions : [];
    const firstQuestion = readRecord(questions[0]);
    return [
      normalized("question.requested", event, {
        ...base,
        requestId: jsonRpcRequestId(event.id),
        method,
        interactionId: firstString(event.interactionId),
        question: firstString(firstQuestion?.question),
        questions,
        autoResolutionMs:
          typeof params?.autoResolutionMs === "number" ? params.autoResolutionMs : undefined,
      }),
    ];
  }

  if (method === "item/agentMessage/delta") {
    const delta = rawString(params?.delta);
    return [
      normalized("assistant.delta", event, {
        ...base,
        delta: delta ?? "",
      }),
    ];
  }

  if (method === "item/commandExecution/outputDelta") {
    const delta = rawString(params?.delta);
    return [
      normalized("command.output", event, {
        ...base,
        delta: delta ?? "",
        stream: firstString(params?.stream),
        command: firstString(params?.command),
      }),
    ];
  }

  if (method === "item/plan/delta") {
    const delta = rawString(params?.delta);
    return [
      normalized("plan.updated", event, {
        ...base,
        text: delta ?? "",
        status: "running",
      }),
    ];
  }

  if (method === "item/started") {
    if (item?.type === "commandExecution") {
      return [
        normalized("command.started", event, {
          ...base,
          command: firstString(item.command) ?? "command",
        }),
      ];
    }
    if (item && isFileChangeItem(item)) {
      return [normalized("file_change.started", event, { ...base, ...fileChangePayload(item) })];
    }
    if (item && isMcpToolCallItem(item)) {
      return [normalized("mcp_tool.started", event, { ...base, ...mcpToolCallPayload(item) })];
    }
    if (item && isWebSearchItem(item)) {
      return [normalized("web_search.started", event, { ...base, ...webSearchPayload(item) })];
    }
    return [normalized("unknown", event, { ...base, method })];
  }

  if (method === "item/completed" && item) {
    if (item.type === "agentMessage") {
      return [
        normalized("assistant.completed", event, {
          ...base,
          content: rawString(item.text) ?? rawString(item.content) ?? "",
        }),
      ];
    }

    if (isReasoningItem(item)) {
      return [
        normalized("reasoning.completed", event, {
          ...base,
          text: rawString(item.text) ?? rawString(item.summary) ?? rawString(item.content) ?? "",
        }),
      ];
    }

    if (isPlanItem(item)) {
      return [
        normalized("plan.updated", event, {
          ...base,
          text: rawString(item.text) ?? rawString(item.summary) ?? rawString(item.content) ?? "",
          status: firstString(item.status) ?? "completed",
        }),
      ];
    }

    if (item.type === "commandExecution") {
      const status = firstString(item.status);
      const command = firstString(item.command) ?? "command";
      const output = {
        status: status ?? "completed",
        exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
      };
      if (status === "failed") {
        return [
          normalized("command.failed", event, {
            ...base,
            command,
            output,
            error: firstString(item.error) ?? "Codex command failed.",
          }),
        ];
      }
      return [
        normalized("command.completed", event, {
          ...base,
          command,
          output,
        }),
      ];
    }

    if (isFileChangeItem(item)) {
      return [
        normalized("file_change.completed", event, {
          ...base,
          ...fileChangePayload(item),
          status: firstString(item.status) ?? "completed",
        }),
      ];
    }

    if (isMcpToolCallItem(item)) {
      return [
        normalized("mcp_tool.completed", event, {
          ...base,
          ...mcpToolCallPayload(item),
          status: firstString(item.status) ?? "completed",
        }),
      ];
    }

    if (isWebSearchItem(item)) {
      return [
        normalized("web_search.completed", event, {
          ...base,
          ...webSearchPayload(item),
          status: firstString(item.status) ?? "completed",
        }),
      ];
    }
  }

  if (method === "turn/started") {
    const turn = readRecord(params?.turn);
    return [
      normalized("turn.started", event, {
        ...base,
        turnId: firstString(turn?.id, base.turnId),
        status: firstString(turn?.status),
      }),
    ];
  }

  if (method === "turn/completed") {
    const turn = readRecord(params?.turn);
    return [
      normalized("turn.completed", event, {
        ...base,
        turnId: firstString(turn?.id, base.turnId),
        status: firstString(turn?.status),
        error: firstString(stringFromPath(turn, ["error", "message"]), turn?.error),
      }),
    ];
  }

  if (method === "thread/tokenUsage/updated") {
    return [
      normalized("usage.updated", event, {
        ...base,
        tokenUsage: readRecord(params?.tokenUsage) ?? params?.tokenUsage ?? null,
      }),
    ];
  }

  if (method === "thread/goal/updated") {
    return [
      normalized("goal.updated", event, {
        ...base,
        ...goalPayload(params),
      }),
    ];
  }

  if (method === "thread/goal/cleared") {
    return [
      normalized("goal.updated", event, {
        ...base,
        status: "cleared",
      }),
    ];
  }

  if (isQuestionRequest(method, params)) {
    return [
      normalized("question.requested", event, {
        ...base,
        requestId: jsonRpcRequestId(event.id),
        method,
        interactionId: firstString(event.interactionId),
        question: firstString(params?.question, stringFromPath(params, ["prompt", "question"])),
        questions: Array.isArray(params?.questions) ? params.questions : undefined,
      }),
    ];
  }

  if (isApprovalRequest(method, params)) {
    return [
      normalized("approval.requested", event, {
        ...base,
        requestId: jsonRpcRequestId(event.id),
        method,
        title: firstString(params?.title, params?.message),
        action: firstString(params?.action, params?.command, params?.reason),
      }),
    ];
  }

  if (method === "error") {
    return [
      normalized("error", event, {
        ...base,
        message: firstString(params?.message, event.message) ?? "Codex app-server error.",
      }),
    ];
  }

  return [normalized("unknown", event, { ...base, method })];
}

export function codexAppServerEventText(event: CodexAppServerNormalizedEvent) {
  if (event.type === "assistant.delta") return rawString(event.payload.delta) ?? "";
  if (event.type === "assistant.completed") return rawString(event.payload.content) ?? "";
  return "";
}

export function codexAppServerEventTurnStatus(event: CodexAppServerNormalizedEvent) {
  if (event.type !== "turn.completed") return null;
  const status = firstString(event.payload.status);
  if (status === "completed") return "completed";
  if (status === "interrupted") return "interrupted";
  if (status === "failed") return "failed";
  return status ? "failed" : null;
}

function normalized(
  type: CodexAppServerEventType,
  rawEvent: Record<string, unknown>,
  payload: Record<string, unknown>,
): CodexAppServerNormalizedEvent {
  return {
    type,
    payload: compactPayload(payload),
    rawEvent,
  };
}

function compactPayload(payload: Record<string, unknown>) {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null) output[key] = value;
  }
  return output;
}

function isReasoningItem(item: Record<string, unknown>) {
  return typeof item.type === "string" && item.type.toLowerCase().includes("reasoning");
}

function isPlanItem(item: Record<string, unknown>) {
  return typeof item.type === "string" && item.type.toLowerCase().includes("plan");
}

// Item type names have drifted across Codex releases (fileChange vs patchApply, camelCase vs
// snake_case), so matching strips separators and looks for the stable stem.
function compactItemType(item: Record<string, unknown>) {
  return typeof item.type === "string" ? item.type.toLowerCase().replace(/[_-]/g, "") : "";
}

function isFileChangeItem(item: Record<string, unknown>) {
  const type = compactItemType(item);
  return type.includes("filechange") || type.includes("patch");
}

function isMcpToolCallItem(item: Record<string, unknown>) {
  return compactItemType(item).includes("mcptool");
}

function isWebSearchItem(item: Record<string, unknown>) {
  return compactItemType(item).includes("websearch");
}

function fileChangePayload(item: Record<string, unknown>) {
  const raw = Array.isArray(item.changes) ? item.changes : [];
  const changes: Array<Record<string, unknown>> = [];
  for (const entry of raw) {
    const record = readRecord(entry);
    if (!record) continue;
    const path = firstString(record.path, record.file, record.filename);
    if (!path) continue;
    const kind = firstString(record.kind, record.type);
    changes.push({ path, ...(kind ? { kind } : {}) });
  }
  return { changes };
}

function mcpToolCallPayload(item: Record<string, unknown>) {
  return {
    server: firstString(item.server),
    tool: firstString(item.tool),
    error: firstString(stringFromPath(item, ["error", "message"]), item.error),
  };
}

function webSearchPayload(item: Record<string, unknown>) {
  return { query: firstString(item.query) };
}

function goalPayload(params: Record<string, unknown> | null | undefined) {
  const goal = readRecord(params?.goal) ?? params;
  return {
    objective: firstString(goal?.objective),
    status: firstString(goal?.status),
    tokenBudget: typeof goal?.tokenBudget === "number" ? goal.tokenBudget : undefined,
    tokensUsed: typeof goal?.tokensUsed === "number" ? goal.tokensUsed : undefined,
    timeUsedSeconds: typeof goal?.timeUsedSeconds === "number" ? goal.timeUsedSeconds : undefined,
  };
}

function isQuestionRequest(method: string, params: Record<string, unknown> | null | undefined) {
  const normalizedMethod = method.toLowerCase();
  return (
    (normalizedMethod.includes("question") || normalizedMethod.includes("userinput")) &&
    (normalizedMethod.includes("request") || normalizedMethod.includes("required")) &&
    (typeof params?.question === "string" || Array.isArray(params?.questions))
  );
}

function isApprovalRequest(method: string, params: Record<string, unknown> | null | undefined) {
  const normalizedMethod = method.toLowerCase();
  return (
    normalizedMethod.includes("approval") &&
    (normalizedMethod.includes("request") || normalizedMethod.includes("required")) &&
    (typeof params?.title === "string" ||
      typeof params?.message === "string" ||
      typeof params?.action === "string" ||
      typeof params?.command === "string")
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringFromPath(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    const record = readRecord(current);
    if (!record) return null;
    current = record[key];
  }
  return firstString(current);
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function rawString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function jsonRpcRequestId(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}
