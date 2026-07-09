export type CodexAppServerEventType =
  | "assistant.delta"
  | "assistant.completed"
  | "reasoning.completed"
  | "command.started"
  | "command.output"
  | "command.completed"
  | "command.failed"
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

  if (method === "item/started") {
    if (item?.type === "commandExecution") {
      return [
        normalized("command.started", event, {
          ...base,
          command: firstString(item.command) ?? "command",
        }),
      ];
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
