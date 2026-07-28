// Goat's product analytics are deliberately small. A new chat is derived from
// chat_message_sent.is_first_message instead of emitting a second event for the same action.
export type GoatAnalyticsEventPropertiesByName = {
  app_opened: {
    workspace_id: string;
  };
  signup_completed: {
    source: "user_sync";
  };
  chat_message_sent: {
    workspace_id: string;
    session_id: string;
    is_first_message: boolean;
    model: string;
    message_length: number;
  };
  integration_added: {
    workspace_id?: string;
    provider: string;
  };
};

export type GoatAnalyticsEventName = keyof GoatAnalyticsEventPropertiesByName;

export type GoatAnalyticsEventProperties<EventName extends GoatAnalyticsEventName> =
  GoatAnalyticsEventPropertiesByName[EventName];

type GoatAnalyticsEventDefinition<EventName extends GoatAnalyticsEventName> = {
  name: EventName;
  description: string;
  safeProperties: ReadonlyArray<keyof GoatAnalyticsEventProperties<EventName>>;
};

export const goatAnalyticsEvents = {
  app_opened: {
    name: "app_opened",
    description: "A signed-in user opened Goat.",
    safeProperties: ["workspace_id"],
  },
  signup_completed: {
    name: "signup_completed",
    description: "A WorkOS user was synced into Goat for the first time.",
    safeProperties: ["source"],
  },
  chat_message_sent: {
    name: "chat_message_sent",
    description: "A user sent a message in Goat main chat.",
    safeProperties: ["workspace_id", "session_id", "is_first_message", "model", "message_length"],
  },
  integration_added: {
    name: "integration_added",
    description: "A user connected an integration.",
    safeProperties: ["workspace_id", "provider"],
  },
} as const satisfies {
  [EventName in GoatAnalyticsEventName]: GoatAnalyticsEventDefinition<EventName>;
};
