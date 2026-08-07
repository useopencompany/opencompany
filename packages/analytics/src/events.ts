// the app's product analytics are deliberately small. A new chat is derived from
// chat_message_sent.is_first_message instead of emitting a second event for the same action.
export type TaskSpawnKind = "adhoc" | "workflow" | "scheduled_task" | "scheduled_workflow";
export type TaskSpawnOrigin = "adhoc" | "workflow";
export type TaskSpawnTrigger = "manual" | "schedule";
export type AnalyticsEngine = "opencompany" | "codex" | "claude_code";
export type AnalyticsUsageSource = "owned_platform" | "external_harness";
export type OnboardingFlow = "owner" | "member";
export type OnboardingStep = "profile" | "workspace" | "sources" | "welcome" | "finish";

export type AnalyticsEventPropertiesByName = {
  app_opened: {
    workspace_id: string;
  };
  signup_completed: {
    source: "user_sync";
  };
  onboarding_started: {
    flow: OnboardingFlow;
    initial_step: OnboardingStep;
    initial_step_index: number;
    total_steps: number;
    is_resume: boolean;
    workspace_id?: string;
  };
  onboarding_step_viewed: {
    flow: OnboardingFlow;
    step: OnboardingStep;
    step_index: number;
    total_steps: number;
    workspace_id?: string;
  };
  onboarding_completed: {
    flow: OnboardingFlow;
    total_steps: number;
    workspace_id: string;
    sources_feeding: number;
    source_goal_met: boolean;
  };
  chat_message_sent: {
    workspace_id: string;
    session_id: string;
    is_first_message: boolean;
    engine: AnalyticsEngine;
    usage_source: AnalyticsUsageSource;
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
    engine: AnalyticsEngine;
    usage_source: AnalyticsUsageSource;
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
    task_kind: TaskSpawnKind;
    task_origin: TaskSpawnOrigin;
    task_trigger: TaskSpawnTrigger;
    engine: AnalyticsEngine;
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
    engine?: AnalyticsEngine;
    usage_source?: AnalyticsUsageSource;
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

export type AnalyticsEventName = keyof AnalyticsEventPropertiesByName;

export type AnalyticsEventProperties<EventName extends AnalyticsEventName> =
  AnalyticsEventPropertiesByName[EventName];

type AnalyticsEventDefinition<EventName extends AnalyticsEventName> = {
  name: EventName;
  description: string;
  safeProperties: ReadonlyArray<keyof AnalyticsEventProperties<EventName>>;
};

export const analyticsEvents = {
  app_opened: {
    name: "app_opened",
    description: "A signed-in user opened the app.",
    safeProperties: ["workspace_id"],
  },
  signup_completed: {
    name: "signup_completed",
    description: "A WorkOS user was synced into opencompany for the first time.",
    safeProperties: ["source"],
  },
  onboarding_started: {
    name: "onboarding_started",
    description: "A user entered or resumed the opencompany onboarding flow.",
    safeProperties: [
      "flow",
      "initial_step",
      "initial_step_index",
      "total_steps",
      "is_resume",
      "workspace_id",
    ],
  },
  onboarding_step_viewed: {
    name: "onboarding_step_viewed",
    description: "A user reached a step in the opencompany onboarding flow.",
    safeProperties: ["flow", "step", "step_index", "total_steps", "workspace_id"],
  },
  onboarding_completed: {
    name: "onboarding_completed",
    description: "A user completed the opencompany onboarding flow.",
    safeProperties: ["flow", "total_steps", "workspace_id", "sources_feeding", "source_goal_met"],
  },
  chat_message_sent: {
    name: "chat_message_sent",
    description: "A user sent a message in main chat.",
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
    description: "An LLM call reported token and cost usage.",
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
    description: "A durable task was created and queued.",
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
    description: "A manual or automatic billing top-up credited a workspace.",
    safeProperties: ["workspace_id", "topup_type", "amount_cents", "amount_usd", "balance_cents"],
  },
  model_spend_recorded: {
    name: "model_spend_recorded",
    description: "A billable model-cost usage row was recorded.",
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
  [EventName in AnalyticsEventName]: AnalyticsEventDefinition<EventName>;
};
