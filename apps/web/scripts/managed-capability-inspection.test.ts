import { describe, expect, it, vi } from "vitest";
import { inspectManagedCapability } from "./managed-capability-inspection";

const input = {
  apiKey: "monid_test",
  provider: "tikhub",
  endpoint: "/example",
};

describe("inspectManagedCapability", () => {
  it("returns a valid inspection without retrying", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(inspectionResponse());

    await expect(inspectManagedCapability(input, { fetchImpl })).resolves.toMatchObject({
      provider: "tikhub",
      endpoint: "/example",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After for a rate limit and then succeeds", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "rate limited" }), {
          status: 429,
          headers: { "Retry-After": "2" },
        }),
      )
      .mockResolvedValueOnce(inspectionResponse());
    const sleep = vi.fn(async () => undefined);

    await expect(inspectManagedCapability(input, { fetchImpl, sleep })).resolves.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("retries a malformed success response before failing with its real category", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ message: "busy" }));

    await expect(
      inspectManagedCapability(input, {
        fetchImpl,
        attempts: 2,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("malformed success response after 2 attempts");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry authentication or other caller errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "unauthorized" }), {
        status: 401,
      }),
    );

    await expect(inspectManagedCapability(input, { fetchImpl })).rejects.toThrow("HTTP 401");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function inspectionResponse() {
  return jsonResponse({
    id: "tikhub:/example",
    provider: "tikhub",
    endpoint: "/example",
    input: { body: { type: "object" } },
    price: { type: "PER_CALL", amount: { value: 0.001, currency: "USD" } },
    tags: [],
  });
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
