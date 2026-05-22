export type SessionMessage = {
  id: string;
  role: string;
  content: string;
  status: string;
};

export type RuntimeEvent = {
  id: number;
  type: string;
  messageId: string | null;
  payload: Record<string, unknown>;
};

export type SessionRuntimeState = {
  events: RuntimeEvent[];
  messages: SessionMessage[];
  currentStatus: string;
  lastError: string | null;
};

export function applyRuntimeEventToState(
  state: SessionRuntimeState,
  event: RuntimeEvent,
): SessionRuntimeState {
  if (state.events.some((item) => item.id === event.id)) return state;

  let next: SessionRuntimeState = {
    ...state,
    events: [...state.events, event],
  };

  if (event.type === "session.status") {
    const status = readString(event.payload.status);
    if (status) {
      next = {
        ...next,
        currentStatus: status,
        lastError: status === "failed" ? next.lastError : null,
      };
    }
  }

  if (event.type === "session.error") {
    const message = readString(event.payload.message);
    next = {
      ...next,
      currentStatus: "failed",
      lastError: message || "The session failed.",
    };
  }

  if (event.type === "message.created") {
    const messageId = readString(event.payload.messageId);
    const role = readString(event.payload.role);
    if (messageId && role && !next.messages.some((message) => message.id === messageId)) {
      next = {
        ...next,
        messages: [...next.messages, { id: messageId, role, content: "", status: "running" }],
      };
    }
  }

  if (event.type === "message.delta") {
    const messageId = readString(event.payload.messageId);
    const delta = readString(event.payload.delta);
    if (messageId && delta) {
      next = {
        ...next,
        messages: next.messages.map((message) =>
          message.id === messageId
            ? { ...message, content: `${message.content}${delta}` }
            : message,
        ),
      };
    }
  }

  if (event.type === "message.completed") {
    const messageId = readString(event.payload.messageId);
    const content = optionalString(event.payload.content);
    if (messageId) {
      next = {
        ...next,
        messages: next.messages.map((message) =>
          message.id === messageId
            ? { ...message, status: "completed", content: content ?? message.content }
            : message,
        ),
      };
    }
  }

  return next;
}

export function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function optionalString(value: unknown) {
  return typeof value === "string" ? value : null;
}
