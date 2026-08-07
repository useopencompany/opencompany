import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadJamieWebhookContextForApiKey } from "@/lib/integrations/jamie";
import { handleJamieWebhookDelivery } from "@/lib/integrations/jamie-webhook";
import { POST } from "./route";

vi.mock("@/lib/integrations/jamie", () => ({
  loadJamieWebhookContextForApiKey: vi.fn(),
}));

vi.mock("@/lib/integrations/jamie-webhook", () => ({
  handleJamieWebhookDelivery: vi.fn(async () => Response.json({ ok: true })),
}));

describe("POST /api/webhooks/jamie", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads the Jamie integration from the default API key header", async () => {
    const context = {
      integrationId: "gint_123",
      userWorkosId: "user_123",
      apiKeyHash: "hash",
      legacySecretHash: null,
    };
    vi.mocked(loadJamieWebhookContextForApiKey).mockResolvedValue(context);

    const request = jamieRequest();
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(loadJamieWebhookContextForApiKey).toHaveBeenCalledWith(jamieApiKey());
    expect(handleJamieWebhookDelivery).toHaveBeenCalledWith({
      request,
      webhookContext: context,
      missingContextStatus: 401,
    });
  });

  it("passes a null context through as an authentication failure", async () => {
    vi.mocked(loadJamieWebhookContextForApiKey).mockResolvedValue(null);

    await POST(jamieRequest());

    expect(handleJamieWebhookDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookContext: null,
        missingContextStatus: 401,
      }),
    );
  });
});

function jamieRequest() {
  return new Request("https://goat.test/api/webhooks/jamie", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-jamie-api-key": jamieApiKey(),
    },
    body: "{}",
  });
}

function jamieApiKey() {
  return "sk_0000000000000000000000000000000000000000000000000000000000000000";
}
