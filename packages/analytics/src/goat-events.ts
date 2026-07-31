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
    engine: "opencompany" | "codex" | "claude_code";
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
  model_spend_recorded: {
    user_id: string;
    workspace_id?: string;
    billing_source: "chat_model_usage" | "ingest_model_usage" | "task_model_usage";
    surface: "chat" | "task" | "slack_bot" | "brain_ingest";
    model: string;
    stage?: string;
    engine?: "opencompany" | "codex" | "claude_code";
    provider_cost_usd_micros: number;
    platform_fee_usd_micros: number;
    total_cost_usd_micros: number;
    model_cost_usd_micros: number;
    ledger_id?: number;
    chat_session_id?: string;
    ingest_job_id?: string;
    task_id?: string;
    message_id?: string;
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
    safeProperties: [
      "workspace_id",
      "session_id",
      "is_first_message",
      "engine",
      "model",
      "message_length",
    ],
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
  model_spend_recorded: {
    name: "model_spend_recorded",
    description: "A billable Goat model-cost usage row was recorded.",
    safeProperties: [
      "user_id",
      "workspace_id",
      "billing_source",
      "surface",
      "model",
      "stage",
      "engine",
      "provider_cost_usd_micros",
      "platform_fee_usd_micros",
      "total_cost_usd_micros",
      "model_cost_usd_micros",
      "ledger_id",
      "chat_session_id",
      "ingest_job_id",
      "task_id",
      "message_id",
    ],
  },
} as const satisfies {
  [EventName in GoatAnalyticsEventName]: GoatAnalyticsEventDefinition<EventName>;
};
