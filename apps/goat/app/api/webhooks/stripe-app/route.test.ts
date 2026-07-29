import { beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectGoatStripeIntegrationForAccount } from "@/lib/integrations/stripe";
import { parseGoatStripeAppWebhook } from "@/lib/integrations/stripe-app-webhook";
import { POST } from "./route";

vi.mock("@/lib/integrations/stripe-app-webhook", () => ({
  parseGoatStripeAppWebhook: vi.fn(),
}));

vi.mock("@/lib/integrations/stripe", () => ({
  disconnectGoatStripeIntegrationForAccount: vi.fn(),
}));

const parseWebhookMock = vi.mocked(parseGoatStripeAppWebhook);
const disconnectForAccountMock = vi.mocked(disconnectGoatStripeIntegrationForAccount);

function request(signature: string | null) {
  return new Request("https://goat.example.com/api/webhooks/stripe-app", {
    method: "POST",
    headers: signature ? { "stripe-signature": signature } : {},
    body: JSON.stringify({ id: "evt_123" }),
  });
}

describe("Stripe app lifecycle webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects requests without a Stripe signature", async () => {
    const response = await POST(request(null));

    expect(response.status).toBe(400);
    expect(parseWebhookMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid signed payload", async () => {
    parseWebhookMock.mockImplementation(() => {
      throw new Error("signature mismatch");
    });

    const response = await POST(request("sig_bad"));

    expect(response.status).toBe(400);
    expect(disconnectForAccountMock).not.toHaveBeenCalled();
  });

  it("removes matching OAuth connections when the Stripe app is uninstalled", async () => {
    parseWebhookMock.mockReturnValue({
      type: "account.application.deauthorized",
      accountId: "acct_123",
      livemode: true,
    });
    disconnectForAccountMock.mockResolvedValue(2);

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(disconnectForAccountMock).toHaveBeenCalledWith({
      accountId: "acct_123",
      livemode: true,
    });
  });

  it("acknowledges unrelated lifecycle events without deleting a connection", async () => {
    parseWebhookMock.mockReturnValue({
      type: "account.application.authorized",
      accountId: "acct_123",
      livemode: false,
    });

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(disconnectForAccountMock).not.toHaveBeenCalled();
  });
});
