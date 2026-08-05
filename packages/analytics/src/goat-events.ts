// Goat's product analytics are deliberately small. A new chat is derived from
// chat_message_sent.is_first_message instead of emitting a second event for the same action.
export type GoatTaskSpawnKind = "adhoc" | "workflow" | "scheduled_task" | "scheduled_workflow";
export type GoatTaskSpawnOrigin = "adhoc" | "workflow";
export type GoatTaskSpawnTrigger = "manual" | "schedule";
export type GoatAnalyticsEngine = "opencompany" | "codex" | "claude_code";
export type GoatAnalyticsUsageSource = "owned_platform" | "external_harness";

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
    engine: GoatAnalyticsEngine;
    usage_source: GoatAnalyticsUsageSource;
    model: string;
    message_length: number;
    selection_mode?: "manual" | "auto";
    routing_tier?: "standard" | "frontier";
    routing_reason?: string;
    routing_outcome?: string;
    routing_duration_ms?: number;
  };
  llm_usage_recorded: {
    workspace_id?: string;
    surface: "chat" | "task";
    stage: "generation" | "routing" | "planner" | "execution" | "closer";
    session_id?: string;
    message_id?: string;
    task_id?: string;
    turn_id?: string;
    step_index?: number;
    model_provider: string;
    model: string;
    response_model?: string;
    engine: GoatAnalyticsEngine;
    usage_source: GoatAnalyticsUsageSource;
    input_tokens: number;
    input_no_cache_tokens: number;
    input_cache_read_tokens: number;
    input_cache_write_tokens: number;
    output_tokens: number;
    output_text_tokens: number;
    output_reasoning_tokens: number;
    total_tokens: number;
    provider_cost_usd_micros: number;
    platform_fee_usd_micros: number;
    charged_cost_usd_micros: number;
    billable: boolean;
    finish_reason?: string;
  };
  task_spawned: {
    workspace_id?: string;
    task_id: string;
    display_id?: string;
    task_kind: GoatTaskSpawnKind;
    task_origin: GoatTaskSpawnOrigin;
    task_trigger: GoatTaskSpawnTrigger;
    engine: GoatAnalyticsEngine;
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
    amount_usd: number;
    balance_cents: number;
  };
  model_spend_recorded: {
    user_id: string;
    workspace_id?: string;
    billing_source: "chat_model_usage" | "ingest_model_usage" | "task_model_usage";
    surface: "chat" | "task" | "slack_bot" | "brain_ingest";
    model: string;
    stage?: string;
    engine?: GoatAnalyticsEngine;
    usage_source?: GoatAnalyticsUsageSource;
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
      "usage_source",
      "model",
      "message_length",
      "selection_mode",
      "routing_tier",
      "routing_reason",
      "routing_outcome",
      "routing_duration_ms",
    ],
  },
  llm_usage_recorded: {
    name: "llm_usage_recorded",
    description: "A Goat LLM call reported token and cost usage.",
    safeProperties: [
      "workspace_id",
      "surface",
      "stage",
      "session_id",
      "message_id",
      "task_id",
      "turn_id",
      "step_index",
      "model_provider",
      "model",
      "response_model",
      "engine",
      "usage_source",
      "input_tokens",
      "input_no_cache_tokens",
      "input_cache_read_tokens",
      "input_cache_write_tokens",
      "output_tokens",
      "output_text_tokens",
      "output_reasoning_tokens",
      "total_tokens",
      "provider_cost_usd_micros",
      "platform_fee_usd_micros",
      "charged_cost_usd_micros",
      "billable",
      "finish_reason",
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
    safeProperties: ["workspace_id", "topup_type", "amount_cents", "amount_usd", "balance_cents"],
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
      "usage_source",
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
