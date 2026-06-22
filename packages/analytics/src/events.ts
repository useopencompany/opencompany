export type AnalyticsEventPropertiesByName = {
  signup_started: {
    entrypoint: "signup_page";
  };
  signup_completed: {
    user_id: string;
    workspace_id: string;
  };
  onboarding_started: {
    user_id: string;
    workspace_id: string;
  };
  onboarding_completed: {
    user_id: string;
    workspace_id: string;
    heard_from: string;
    team_size: string;
    agent_experience: string;
    goal_provided: boolean;
  };
  agent_created: {
    user_id: string;
    workspace_id: string;
    agent_id: string;
  };
  agent_saved: {
    user_id: string;
    workspace_id: string;
    agent_id: string;
    changed_fields: Array<"name" | "body" | "model" | "config">;
  };
  agent_deleted: {
    user_id: string;
    workspace_id: string;
    agent_id: string;
  };
  personal_agent_reset: {
    user_id: string;
    workspace_id: string;
    agent_id: string | null;
  };
  session_started: {
    user_id: string;
    workspace_id: string;
    agent_id: string;
    session_id: string;
    model_provider: string;
    model_name: string;
    source: "agent" | "prompt" | "schedule" | "onboarding";
    trigger_id?: string;
  };
  session_message_sent: {
    user_id: string;
    workspace_id: string;
    agent_id: string;
    session_id: string;
    message_id: string;
    model_provider: string;
    model_name: string;
    is_initial_message: boolean;
    message_length: number;
  };
  session_first_token: {
    workspace_id: string;
    agent_id: string;
    session_id: string;
    message_id: string;
    model_provider: string;
    model_name: string;
    ttft_ms: number;
    first_token_kind: "text" | "reasoning";
  };
  session_turn_completed: {
    user_id: string;
    workspace_id: string;
    agent_id: string;
    session_id: string;
    user_message_id: string;
    assistant_message_id: string;
    model_provider: string;
    model_name: string;
    provider_cost_usd_micros: number;
    platform_fee_usd_micros: number;
    total_cost_usd_micros: number;
    model_cost_usd_micros: number;
    tool_cost_usd_micros: number;
    sandbox_cost_usd_micros: number;
    // Latency rollup for the turn: run start → completion, plus the per-phase sums of every
    // tool call's ToolCallTimings (see agent-runtime). Optional so older captures stay valid.
    turn_duration_ms?: number;
    tool_call_count?: number;
    tool_failed_count?: number;
    tool_total_ms?: number;
    tool_exec_ms?: number;
    tool_sandbox_wait_ms?: number;
    tool_gate_wait_ms?: number;
    tool_persist_ms?: number;
    tool_max_total_ms?: number;
    slowest_tool_name?: string;
  };
  // One event per tool call slower than the runner's slow-call threshold (~2s). The aggregate
  // picture lives on session_turn_completed; this keeps the tail individually visible with its
  // phase breakdown without paying per-call event volume.
  tool_call_slow: {
    user_id: string;
    workspace_id?: string;
    agent_id?: string;
    session_id: string;
    message_id: string;
    tool_call_id: string;
    tool_name: string;
    tool_kind: "hosted" | "internal" | "sandbox";
    failed: boolean;
    total_ms: number;
    exec_ms: number;
    persist_ms: number;
    gate_wait_ms?: number;
    sandbox_wait_ms?: number;
    sandbox_id?: string;
  };
  e2b_sandbox_latency: {
    user_id: string;
    workspace_id: string;
    agent_id: string;
    session_id: string;
    phase: "e2b_request" | "sandbox_ready";
    operation: "create" | "connect" | "hydrate";
    outcome: "success" | "not_found" | "error";
    latency_ms: number;
    existing_sandbox: boolean;
    template: string;
    sandbox_id?: string;
    requested_sandbox_id?: string;
    error_name?: string;
  };
  credit_top_up_started: {
    user_id: string;
    workspace_id: string;
    checkout_record_id: string;
    amount_cents: number;
  };
  credit_top_up_completed: {
    user_id: string;
    workspace_id: string;
    checkout_record_id: string;
    ledger_id: number;
    amount_cents: number;
    balance_cents: number;
  };
  sign_out: {
    user_id: string;
    workspace_id: string;
    source: "settings" | "onboarding_switch_email" | "direct";
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
  signup_started: {
    name: "signup_started",
    description: "A visitor clicked the primary signup action.",
    safeProperties: ["entrypoint"],
  },
  signup_completed: {
    name: "signup_completed",
    description: "A WorkOS user was synced into opencompany for the first time.",
    safeProperties: ["user_id", "workspace_id"],
  },
  onboarding_started: {
    name: "onboarding_started",
    description: "A signed-in user viewed the onboarding form.",
    safeProperties: ["user_id", "workspace_id"],
  },
  onboarding_completed: {
    name: "onboarding_completed",
    description: "A signed-in user completed onboarding successfully.",
    safeProperties: [
      "user_id",
      "workspace_id",
      "heard_from",
      "team_size",
      "agent_experience",
      "goal_provided",
    ],
  },
  agent_created: {
    name: "agent_created",
    description: "A user created a new agent.",
    safeProperties: ["user_id", "workspace_id", "agent_id"],
  },
  agent_saved: {
    name: "agent_saved",
    description: "A user saved changes to an agent.",
    safeProperties: ["user_id", "workspace_id", "agent_id", "changed_fields"],
  },
  agent_deleted: {
    name: "agent_deleted",
    description: "A user deleted an agent.",
    safeProperties: ["user_id", "workspace_id", "agent_id"],
  },
  personal_agent_reset: {
    name: "personal_agent_reset",
    description: "A user reset their local-only personal agent.",
    safeProperties: ["user_id", "workspace_id", "agent_id"],
  },
  session_started: {
    name: "session_started",
    description: "A user started a new agent session.",
    safeProperties: [
      "user_id",
      "workspace_id",
      "agent_id",
      "session_id",
      "model_provider",
      "model_name",
      "source",
    ],
  },
  session_message_sent: {
    name: "session_message_sent",
    description: "A user sent a message in an agent session.",
    safeProperties: [
      "user_id",
      "workspace_id",
      "agent_id",
      "session_id",
      "message_id",
      "model_provider",
      "model_name",
      "is_initial_message",
      "message_length",
    ],
  },
  session_first_token: {
    name: "session_first_token",
    description:
      "The first streamed token rendered in the browser for a user's message (felt time-to-first-token).",
    safeProperties: [
      "workspace_id",
      "agent_id",
      "session_id",
      "message_id",
      "model_provider",
      "model_name",
      "ttft_ms",
      "first_token_kind",
    ],
  },
  session_turn_completed: {
    name: "session_turn_completed",
    description: "An agent completed a turn in response to a user message.",
    safeProperties: [
      "user_id",
      "workspace_id",
      "agent_id",
      "session_id",
      "user_message_id",
      "assistant_message_id",
      "model_provider",
      "model_name",
      "provider_cost_usd_micros",
      "platform_fee_usd_micros",
      "total_cost_usd_micros",
      "model_cost_usd_micros",
      "tool_cost_usd_micros",
      "sandbox_cost_usd_micros",
      "turn_duration_ms",
      "tool_call_count",
      "tool_failed_count",
      "tool_total_ms",
      "tool_exec_ms",
      "tool_sandbox_wait_ms",
      "tool_gate_wait_ms",
      "tool_persist_ms",
      "tool_max_total_ms",
      "slowest_tool_name",
    ],
  },
  tool_call_slow: {
    name: "tool_call_slow",
    description:
      "A tool call exceeded the runner's slow-call threshold, with its per-phase latency breakdown.",
    safeProperties: [
      "user_id",
      "workspace_id",
      "agent_id",
      "session_id",
      "message_id",
      "tool_call_id",
      "tool_name",
      "tool_kind",
      "failed",
      "total_ms",
      "exec_ms",
      "persist_ms",
      "gate_wait_ms",
      "sandbox_wait_ms",
      "sandbox_id",
    ],
  },
  e2b_sandbox_latency: {
    name: "e2b_sandbox_latency",
    description: "An E2B sandbox request or full runner hydration completed or failed.",
    safeProperties: [
      "user_id",
      "workspace_id",
      "agent_id",
      "session_id",
      "phase",
      "operation",
      "outcome",
      "latency_ms",
      "existing_sandbox",
      "template",
      "sandbox_id",
      "requested_sandbox_id",
      "error_name",
    ],
  },
  credit_top_up_started: {
    name: "credit_top_up_started",
    description: "A user started a credit top-up by opening a Stripe Checkout Session.",
    safeProperties: ["user_id", "workspace_id", "checkout_record_id", "amount_cents"],
  },
  credit_top_up_completed: {
    name: "credit_top_up_completed",
    description: "A paid Stripe Checkout Session credited a workspace balance.",
    safeProperties: [
      "user_id",
      "workspace_id",
      "checkout_record_id",
      "ledger_id",
      "amount_cents",
      "balance_cents",
    ],
  },
  sign_out: {
    name: "sign_out",
    description: "A signed-in user started sign-out.",
    safeProperties: ["user_id", "workspace_id", "source"],
  },
} as const satisfies {
  [EventName in AnalyticsEventName]: AnalyticsEventDefinition<EventName>;
};
