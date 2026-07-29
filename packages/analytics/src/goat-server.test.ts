import { afterEach, describe, expect, it, vi } from "vitest";
import { captureGoatServerEvent } from "./goat-server";
import { captureServerEvent } from "./server";

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
    vi.stubEnv("NEXT_PUBLIC_GOAT_POSTHOG_TOKEN", "phc_goat_test");
    vi.stubEnv("NEXT_PUBLIC_GOAT_POSTHOG_HOST", "https://eu.i.posthog.com");
    vi.stubEnv("NEXT_PUBLIC_ANALYTICS_DEBUG", "true");

    await captureGoatServerEvent(
      "chat_message_sent",
      "user_123",
      {
        workspace_id: "workspace_123",
        session_id: "session_123",
        is_first_message: true,
        engine: "opencompany",
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
          model: "openai/gpt-5.5",
          message_length: 42,
          $set: ["workspace_id", "email", "first_name", "last_name", "name"],
        },
      },
    });
    expect(JSON.stringify(posthog.info.mock.calls)).not.toContain("ada@example.com");
    expect(JSON.stringify(posthog.info.mock.calls)).not.toContain("Ada Lovelace");
  });

  it("is a no-op when the dedicated Goat project is not configured", async () => {
    await captureGoatServerEvent("signup_completed", "user_123", {
      source: "user_sync",
    });

    expect(posthog.constructor).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("keeps legacy web events on the legacy project configuration", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_TOKEN", "phc_web_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://eu.i.posthog.com");

    await captureServerEvent("signup_started", "anonymous_123", {
      entrypoint: "signup_page",
    });

    expect(posthog.constructor).toHaveBeenCalledWith(
      "phc_web_test",
      expect.objectContaining({ host: "https://eu.i.posthog.com" }),
    );
    expect(posthog.capture).toHaveBeenCalledWith({
      distinctId: "anonymous_123",
      event: "signup_started",
      properties: { entrypoint: "signup_page" },
    });
  });
});
