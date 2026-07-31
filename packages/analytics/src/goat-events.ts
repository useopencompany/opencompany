// Goat's product analytics are deliberately small. A new chat is derived from
// chat_message_sent.is_first_message instead of emitting a second event for the same action.
export type GoatTaskSpawnKind = "adhoc" | "workflow" | "scheduled_task" | "scheduled_workflow";
export type GoatTaskSpawnOrigin = "adhoc" | "workflow";
export type GoatTaskSpawnTrigger = "manual" | "schedule";

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
  task_spawned: {
    workspace_id?: string;
    task_id: string;
    display_id?: string;
    task_kind: GoatTaskSpawnKind;
    task_origin: GoatTaskSpawnOrigin;
    task_trigger: GoatTaskSpawnTrigger;
    engine: "opencompany" | "codex" | "claude_code";
    model: string;
    has_workflow: boolean;
    has_schedule: boolean;
    workflow_id?: string;
    schedule_id?: string;
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
    safeProperties: [
      "workspace_id",
      "session_id",
      "is_first_message",
      "engine",
      "model",
      "message_length",
    ],
  },
  task_spawned: {
    name: "task_spawned",
    description: "A durable Goat task was created and queued.",
    safeProperties: [
      "workspace_id",
      "task_id",
      "display_id",
      "task_kind",
      "task_origin",
      "task_trigger",
      "engine",
      "model",
      "has_workflow",
      "has_schedule",
      "workflow_id",
      "schedule_id",
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
} as const satisfies {
  [EventName in GoatAnalyticsEventName]: GoatAnalyticsEventDefinition<EventName>;
};
