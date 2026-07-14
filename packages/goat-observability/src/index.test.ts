import { afterEach, describe, expect, it, vi } from "vitest";
import {
  categorizeGoatFailure,
  createGoatGatewayAttribution,
  goatGatewayProviderOptions,
  goatGatewayReportingHeaders,
  hashGoatUserId,
  isGoatObservabilityEnabled,
  recordGoatCounter,
  recordGoatModelCost,
  recordGoatRunOutcome,
  recordGoatSignup,
  sanitizeGoatAttributes,
  sanitizeGoatMetricAttributes,
  startGoatSpan,
} from ".";

describe("@opencompany/goat-observability", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sanitizes attributes and drops text-like fields", () => {
    expect(
      sanitizeGoatAttributes({
        "goat.task_id": "goat_task_1",
        "goat.prompt": "secret prompt",
        "goat.tool_input": "secret args",
        "goat.tool_name": "exa_search",
        "goat.token_direction": "input",
        "other.value": "ignored",
        "goat.count": 2,
        "goat.empty": null,
      }),
    ).toEqual({
      "goat.task_id": "goat_task_1",
      "goat.tool_name": "exa_search",
      "goat.token_direction": "input",
      "goat.count": 2,
    });
  });

  it("keeps metric labels low-cardinality", () => {
    expect(
      sanitizeGoatMetricAttributes({
        "goat.surface": "task",
        "goat.model": "openai/gpt-5.5",
        "goat.outcome": "failure",
        "goat.failure_category": "tool",
        "goat.task_id": "goat_task_1",
        "goat.chat_session_id": "goat_chat_1",
        "goat.brain_ingest_job_id": "goat_brain_ingest_1",
        "goat.user_id_hash": "abc123",
        "goat.stage": "running",
        "goat.signup_source": "user_sync",
        "goat.cost_source": "brain_query",
        "goat.budget_exhausted": true,
        "goat.budget_accounting_complete": true,
        "goat.prompt": "secret prompt",
      }),
    ).toEqual({
      "goat.surface": "task",
      "goat.model": "openai/gpt-5.5",
      "goat.outcome": "failure",
      "goat.failure_category": "tool",
      "goat.stage": "running",
      "goat.signup_source": "user_sync",
      "goat.cost_source": "brain_query",
      "goat.budget_exhausted": true,
      "goat.budget_accounting_complete": true,
    });
  });

  it("hashes user ids without exposing the source value", () => {
    const first = hashGoatUserId("user_123");
    const second = hashGoatUserId("user_123");
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(first).not.toContain("user_123");
  });

  it("builds non-PII Gateway reporting user and bounded tags", () => {
    const attribution = createGoatGatewayAttribution({
      userWorkosId: "user_123",
      feature: "chat",
      env: "preview",
      chatSessionId: "CHAT_SESSION_123",
      taskId: "task_123",
      ingestJobId: "ingest_123",
      brainRef: "brain_123",
      tags: [
        "owner:louis@example.com",
        "custom:One",
        "custom:One",
        "custom:Two",
        "custom:Three",
        "custom:Four",
        "custom:Five",
        "custom:Six",
      ],
    });

    expect(attribution.user).toMatch(/^goat-[0-9a-f]{16}$/);
    expect(attribution.user).not.toContain("user_123");
    expect(attribution.tags.join(",")).not.toContain("example");
    expect(attribution.tags).toEqual([
      "app:goat",
      "env:preview",
      "feature:chat",
      "chat:chat_session_123",
      "task:task_123",
      "ingest:ingest_123",
      "brain:brain_123",
      "custom:one",
      "custom:two",
      "custom:three",
    ]);
  });

  it("formats Gateway provider options and HTTP reporting headers", () => {
    const attribution = createGoatGatewayAttribution({
      userWorkosId: "user_123",
      feature: "brain-query",
      env: "production",
      tags: ["Bad Tag With Spaces"],
    });

    expect(
      goatGatewayProviderOptions(attribution, {
        gateway: { caching: "auto" },
        anthropic: { thinking: { type: "enabled" } },
      }),
    ).toEqual({
      gateway: {
        caching: "auto",
        user: attribution.user,
        tags: ["app:goat", "env:production", "feature:brain-query", "bad-tag-with-spaces"],
      },
      anthropic: { thinking: { type: "enabled" } },
    });
    expect(goatGatewayReportingHeaders(attribution)).toEqual({
      "ai-reporting-user": attribution.user,
      "ai-reporting-tags": "app:goat,env:production,feature:brain-query,bad-tag-with-spaces",
    });
  });

  it("categorizes common failures", () => {
    expect(categorizeGoatFailure(new Error("Goat task lease lost while trying to complete."))).toBe(
      "lease_lost",
    );
    expect(categorizeGoatFailure(new Error("VERCEL_AI_GATEWAY_API_KEY is required."))).toBe("auth");
    expect(categorizeGoatFailure(new Error("Gmail integration needs reauth."))).toBe("integration");
    expect(categorizeGoatFailure(new Error("Goat Brain ingestion budget exhausted."))).toBe(
      "budget",
    );
    expect(categorizeGoatFailure(new TypeError("Cannot read properties of undefined"))).toBe("bug");
  });

  it("no-ops safely when disabled", () => {
    vi.stubEnv("GOAT_OBSERVABILITY_ENABLED", "false");
    expect(isGoatObservabilityEnabled()).toBe(false);
    expect(() => recordGoatCounter("goat.test", 1, { "goat.task_id": "task" })).not.toThrow();
    expect(() =>
      recordGoatModelCost({
        costUsdMicros: 42,
        attributes: { "goat.model": "openai/gpt-5.5", "goat.surface": "task" },
      }),
    ).not.toThrow();
    expect(() => recordGoatSignup({ source: "user_sync" })).not.toThrow();
    expect(() =>
      recordGoatRunOutcome({
        surface: "brain_ingest",
        durationMs: 1,
        outcome: "success",
        attributes: { "goat.brain_ingest_job_id": "job" },
      }),
    ).not.toThrow();
    const span = startGoatSpan("goat.test", { "goat.task_id": "task" });
    expect(() => {
      span.setAttributes({ "goat.status": "running" });
      span.fail(new Error("boom"));
      span.end();
    }).not.toThrow();
  });
});
