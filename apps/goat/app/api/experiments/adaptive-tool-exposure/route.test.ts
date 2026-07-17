import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAdaptiveToolAgent } from "@/experiments/adaptive-tool-exposure/runtime";
import { currentGoatUser } from "@/lib/auth";
import { GOAT_MODELS } from "@/lib/model-options";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@/experiments/adaptive-tool-exposure/runtime", () => ({
  runAdaptiveToolAgent: vi.fn(),
}));

describe("POST /api/experiments/adaptive-tool-exposure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("NODE_ENV", "test");
  });

  it("requires an authenticated Goat user", async () => {
    mockCurrentGoatUser().mockResolvedValue(null as never);

    const response = await POST(request({ query: "Search Slack", mode: "analyze" }));

    expect(response.status).toBe(401);
  });

  it("is self-contained in development without Goat auth services", async () => {
    vi.stubEnv("NODE_ENV", "development");
    mockCurrentGoatUser().mockResolvedValue(null as never);

    const response = await POST(request({ query: "Search Slack", mode: "analyze" }));

    expect(response.status).toBe(200);
    expect(currentGoatUser).not.toHaveBeenCalled();
  });

  it("is unavailable outside development and tests", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const response = await POST(request({ query: "Search Slack", mode: "analyze" }));

    expect(response.status).toBe(404);
    expect(currentGoatUser).not.toHaveBeenCalled();
  });

  it("analyzes exposure without an AI Gateway key", async () => {
    mockCurrentGoatUser().mockResolvedValue({ user: { id: "user_1" } } as never);
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "");

    const response = await POST(
      request({ query: "Search Gmail and post the result to Slack", mode: "analyze" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.mode).toBe("analyze");
    expect(
      new Set(body.snapshot.integrations.map((integration: { id: string }) => integration.id)),
    ).toEqual(new Set(["slack", "gmail"]));
    expect(runAdaptiveToolAgent).not.toHaveBeenCalled();
  });

  it("requires AI Gateway only for a simulated agent run", async () => {
    mockCurrentGoatUser().mockResolvedValue({ user: { id: "user_1" } } as never);
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "");

    const response = await POST(
      request({ query: "Search Slack", mode: "agent", model: GOAT_MODELS[0]?.id }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Vercel AI Gateway is not configured.",
    });
  });

  it("runs the model only with a supported model and returns its observations", async () => {
    mockCurrentGoatUser().mockResolvedValue({ user: { id: "user_1" } } as never);
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "gateway-key");
    const model = GOAT_MODELS[0]?.id ?? "openai/gpt-5.5";
    mockRunAdaptiveToolAgent().mockResolvedValue({
      snapshot: { query: "Search Slack" },
      run: { finalText: "Simulated Slack search completed." },
    } as never);

    const response = await POST(request({ query: "Search Slack", mode: "agent", model }));

    expect(response.status).toBe(200);
    expect(mockRunAdaptiveToolAgent()).toHaveBeenCalledWith({
      query: "Search Slack",
      model,
      gatewayApiKey: "gateway-key",
    });
    await expect(response.json()).resolves.toMatchObject({
      mode: "agent",
      run: { finalText: "Simulated Slack search completed." },
    });
  });
});

function request(body: unknown) {
  return new Request("http://goat.test/api/experiments/adaptive-tool-exposure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockCurrentGoatUser() {
  return vi.mocked(currentGoatUser);
}

function mockRunAdaptiveToolAgent() {
  return vi.mocked(runAdaptiveToolAgent);
}
