// Minimal first-pass Statsig event catalog for the Goat app. Active users are covered by
// Web Analytics auto-capture, so there is deliberately no custom event for them here.
// Mirrors the shape of `@opencompany/analytics`'s events catalog.
export type StatsigEventPropertiesByName = {
  signup_completed: {
    user_id: string;
    // Resolved lazily by the client provider's identify; not always known at signup time.
    workspace_id?: string;
    source: string;
  };
  chat_started: {
    user_id: string;
    workspace_id: string;
    session_id: string;
  };
  chat_message_sent: {
    user_id: string;
    workspace_id: string;
    session_id: string;
    // True on the first message of a new chat, false on follow-ups in an existing chat.
    is_first_message: boolean;
    model: string;
    message_length: number;
  };
  integration_added: {
    user_id: string;
    // Many integrations are user-owned rather than workspace-scoped, so the workspace
    // isn't always in scope at connect time; the client identify carries it on the user.
    workspace_id?: string;
    provider: string;
  };
  brain_ingestion_run: {
    // Some jobs are not workspace- or brain-scoped (e.g. NULL brain_ref), so both are optional.
    workspace_id?: string;
    brain_id?: string;
    source: string;
    run_id?: string;
  };
};

export type StatsigEventName = keyof StatsigEventPropertiesByName;

export type StatsigEventProperties<EventName extends StatsigEventName> =
  StatsigEventPropertiesByName[EventName];

type StatsigEventDefinition<EventName extends StatsigEventName> = {
  name: EventName;
  description: string;
  safeProperties: ReadonlyArray<keyof StatsigEventProperties<EventName>>;
};

export const statsigEvents = {
  signup_completed: {
    name: "signup_completed",
    description: "A WorkOS user was synced into Goat for the first time.",
    safeProperties: ["user_id", "workspace_id", "source"],
  },
  chat_started: {
    name: "chat_started",
    description: "A user started a new chat in the Goat main chat.",
    safeProperties: ["user_id", "workspace_id", "session_id"],
  },
  chat_message_sent: {
    name: "chat_message_sent",
    description: "A user sent a message in the Goat main chat (new chat or follow-up).",
    safeProperties: [
      "user_id",
      "workspace_id",
      "session_id",
      "is_first_message",
      "model",
      "message_length",
    ],
  },
  integration_added: {
    name: "integration_added",
    description: "A user connected an integration.",
    safeProperties: ["user_id", "workspace_id", "provider"],
  },
  brain_ingestion_run: {
    name: "brain_ingestion_run",
    description: "The durable ingestion agent ran for a brain.",
    safeProperties: ["workspace_id", "brain_id", "source", "run_id"],
  },
} as const satisfies {
  [EventName in StatsigEventName]: StatsigEventDefinition<EventName>;
};
