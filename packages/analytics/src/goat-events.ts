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
  brain_source_added: {
    workspace_id: string;
    brain_id: string;
    provider: string;
  };
  brain_ingestion_completed: {
    workspace_id: string;
    brain_id: string;
    provider: string;
    source_type: string;
  };
  billing_topup_completed: {
    workspace_id: string;
    topup_type: "manual" | "auto_refill";
    amount_cents: number;
    balance_cents: number;
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
  brain_source_added: {
    name: "brain_source_added",
    description: "A user added an enabled integration source to a Brain.",
    safeProperties: ["workspace_id", "brain_id", "provider"],
  },
  brain_ingestion_completed: {
    name: "brain_ingestion_completed",
    description: "A full Brain ingestion job completed successfully.",
    safeProperties: ["workspace_id", "brain_id", "provider", "source_type"],
  },
  billing_topup_completed: {
    name: "billing_topup_completed",
    description: "A manual or automatic billing top-up credited a Goat workspace.",
    safeProperties: ["workspace_id", "topup_type", "amount_cents", "balance_cents"],
  },
} as const satisfies {
  [EventName in GoatAnalyticsEventName]: GoatAnalyticsEventDefinition<EventName>;
};
