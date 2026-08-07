import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureLlmUsageRecorded,
  captureModelSpendRecorded,
  captureServerEvent,
  captureTaskSpawned,
} from "./server";
import { captureServerEvent as captureSharedServerEvent } from "./shared-server";

const posthog = vi.hoisted(() => ({
  capture: vi.fn(),
  constructor: vi.fn(),
  info: vi.fn(),
  shutdown: vi.fn(async () => {}),
}));

vi.mock("posthog-node", () => ({
  PostHog: class {
    constructor(token: string, options: unknown) {
      posthog.constructor(token, options);
    }

    capture = posthog.capture;
    shutdown = posthog.shutdown;
  },
}));

vi.mock("@opencompany/observability", () => ({
  createLogger: () => ({ info: posthog.info }),
}));

describe("PostHog server analytics", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("routes typed events to the dedicated Goat PostHog project", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_TOKEN", "phc_goat_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://eu.i.posthog.com");
    vi.stubEnv("NEXT_PUBLIC_ANALYTICS_DEBUG", "true");

    await captureServerEvent(
      "chat_message_sent",
      "user_123",
      {
        workspace_id: "workspace_123",
        session_id: "session_123",
        is_first_message: true,
        engine: "opencompany",
        usage_source: "owned_platform",
        model: "openai/gpt-5.5",
        message_length: 42,
      },
      {
        workspaceId: "workspace_123",
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
      },
    );

    expect(posthog.constructor).toHaveBeenCalledWith(
      "phc_goat_test",
      expect.objectContaining({
        host: "https://eu.i.posthog.com",
        flushAt: 1,
        flushInterval: 0,
      }),
    );
    expect(posthog.capture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "chat_message_sent",
      properties: {
        workspace_id: "workspace_123",
        session_id: "session_123",
        is_first_message: true,
        engine: "opencompany",
        usage_source: "owned_platform",
        model: "openai/gpt-5.5",
        message_length: 42,
        $set: {
          workspace_id: "workspace_123",
          email: "ada@example.com",
          first_name: "Ada",
          last_name: "Lovelace",
          name: "Ada Lovelace",
        },
      },
    });
    expect(posthog.shutdown).toHaveBeenCalledOnce();
    expect(posthog.info).toHaveBeenCalledWith("Analytics server capture", {
      event: "opencompany.analytics_debug",
      project: "goat",
      payload: {
        distinctId: "user_123",
        event: "chat_message_sent",
        properties: {
          workspace_id: "workspace_123",
          session_id: "session_123",
          is_first_message: true,
          engine: "opencompany",
          usage_source: "owned_platform",
          model: "openai/gpt-5.5",
          message_length: 42,
          $set: ["workspace_id", "email", "first_name", "last_name", "name"],
        },
      },
    });
    expect(JSON.stringify(posthog.info.mock.calls)).not.toContain("ada@example.com");
    expect(JSON.stringify(posthog.info.mock.calls)).not.toContain("Ada Lovelace");
  });

  it("is a no-op when the PostHog project is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_TOKEN", "");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "");

    await captureServerEvent("signup_completed", "user_123", {
      source: "user_sync",
    });

    expect(posthog.constructor).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("captures task spawn events with dashboard-safe attributes", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_TOKEN", "phc_goat_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://eu.i.posthog.com");

    await captureTaskSpawned({
      userWorkosId: "user_123",
      workspaceId: "workspace_123",
      taskId: "goat_task_123",
      displayId: "TASK-123",
      engine: "codex",
      model: "openai/gpt-5.5-codex",
      workflowId: "ship-feature",
      trigger: "schedule",
    });

    expect(posthog.capture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "task_spawned",
      properties: {
        workspace_id: "workspace_123",
        task_id: "goat_task_123",
        display_id: "TASK-123",
        task_kind: "scheduled_workflow",
        task_origin: "workflow",
        task_trigger: "schedule",
        engine: "codex",
        model: "openai/gpt-5.5-codex",
        has_workflow: true,
        has_schedule: true,
        workflow_id: "ship-feature",
        $set: {
          workspace_id: "workspace_123",
        },
      },
    });
  });

  it("captures LLM usage with dashboard-friendly model and token properties", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_TOKEN", "phc_goat_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://eu.i.posthog.com");

    await captureLlmUsageRecorded({
      distinctId: "user_123",
      workspaceId: "workspace_123",
      surface: "task",
      stage: "execution",
      sessionId: "goat_chat_123",
      messageId: "goat_chat_msg_123",
      taskId: "goat_task_123",
      turnId: "goat_codex_chat_turn_123",
      stepIndex: 2,
      modelProvider: "vercel-ai-gateway",
      model: "openai/gpt-5.5",
      responseModel: "openai/gpt-5.5-2026-07-01",
      engine: "codex",
      inputTokens: 100,
      inputNoCacheTokens: 80,
      inputCacheReadTokens: 20,
      inputCacheWriteTokens: 0,
      outputTokens: 25,
      outputTextTokens: 20,
      outputReasoningTokens: 5,
      totalTokens: 125,
      providerCostUsdMicros: 1200,
      platformFeeUsdMicros: 240,
      chargedCostUsdMicros: 1440,
      billable: true,
      finishReason: "stop",
    });

    expect(posthog.capture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "llm_usage_recorded",
      properties: {
        workspace_id: "workspace_123",
        surface: "task",
        stage: "execution",
        session_id: "goat_chat_123",
        message_id: "goat_chat_msg_123",
        task_id: "goat_task_123",
        turn_id: "goat_codex_chat_turn_123",
        step_index: 2,
        model_provider: "vercel-ai-gateway",
        model: "openai/gpt-5.5",
        response_model: "openai/gpt-5.5-2026-07-01",
        engine: "codex",
        usage_source: "external_harness",
        input_tokens: 100,
        input_no_cache_tokens: 80,
        input_cache_read_tokens: 20,
        input_cache_write_tokens: 0,
        output_tokens: 25,
        output_text_tokens: 20,
        output_reasoning_tokens: 5,
        total_tokens: 125,
        provider_cost_usd_micros: 1200,
        platform_fee_usd_micros: 240,
        charged_cost_usd_micros: 1440,
        billable: true,
        finish_reason: "stop",
      },
    });
  });

  it("captures model spend with sum-ready micros properties", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_TOKEN", "phc_goat_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://eu.i.posthog.com");

    await captureModelSpendRecorded({
      userWorkosId: "user_123",
      workspaceId: "workspace_123",
      billingSource: "chat_model_usage",
      surface: "chat",
      model: "openai/gpt-5.5",
      stage: "generation",
      engine: "opencompany",
      providerCostUsdMicros: 10_000.2,
      platformFeeUsdMicros: 2_000,
      totalCostUsdMicros: 12_000,
      ledgerId: 42,
      chatSessionId: "goat_chat_123",
    });

    expect(posthog.capture).toHaveBeenCalledWith({
      distinctId: "user_123",
      event: "model_spend_recorded",
      properties: {
        user_id: "user_123",
        workspace_id: "workspace_123",
        billing_source: "chat_model_usage",
        surface: "chat",
        model: "openai/gpt-5.5",
        stage: "generation",
        engine: "opencompany",
        usage_source: "owned_platform",
        provider_cost_usd_micros: 10_000,
        platform_fee_usd_micros: 2_000,
        total_cost_usd_micros: 12_000,
        model_cost_usd_micros: 10_000,
        ledger_id: 42,
        chat_session_id: "goat_chat_123",
      },
    });
  });

  it("does not capture model spend when the model cost is zero", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_TOKEN", "phc_goat_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://eu.i.posthog.com");

    await captureModelSpendRecorded({
      userWorkosId: "user_123",
      billingSource: "ingest_model_usage",
      surface: "brain_ingest",
      model: "anthropic/claude-sonnet-5",
      providerCostUsdMicros: 1_000,
      platformFeeUsdMicros: 200,
      totalCostUsdMicros: 1_200,
      modelCostUsdMicros: 0,
    });

    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("keeps legacy web events on the legacy project configuration", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_TOKEN", "phc_web_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://eu.i.posthog.com");

    await captureSharedServerEvent("goat_billing_payment_failed", "workspace_123", {
      workspace_id: "workspace_123",
      subscription_id: "sub_123",
    });

    expect(posthog.constructor).toHaveBeenCalledWith(
      "phc_web_test",
      expect.objectContaining({ host: "https://eu.i.posthog.com" }),
    );
    expect(posthog.capture).toHaveBeenCalledWith({
      distinctId: "workspace_123",
      event: "goat_billing_payment_failed",
      properties: { workspace_id: "workspace_123", subscription_id: "sub_123" },
    });
  });
});
