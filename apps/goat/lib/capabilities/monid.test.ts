import { describe, expect, it, vi } from "vitest";
import { isTerminalMonidRun, MonidClient } from "@/lib/capabilities/monid";

describe("MonidClient", () => {
  it("inspects the live input and numeric pricing contract", async () => {
    const fetchImpl = jsonFetch({
      provider: "tikhub",
      endpoint: "/api/v1/twitter/web/fetch_search_timeline",
      input: {
        keyword: { type: "string" },
        search_type: { type: "string" },
      },
      price: {
        type: "PER_CALL",
        amount: {
          value: 0.0015,
          currency: "USD",
        },
      },
      tags: ["verified"],
    });
    const client = new MonidClient({ apiKey: "monid_test", fetchImpl });
    await expect(
      client.inspect({
        provider: "tikhub",
        endpoint: "/api/v1/twitter/web/fetch_search_timeline",
      }),
    ).resolves.toMatchObject({
      provider: "tikhub",
      price: { type: "PER_CALL", amount: 0.0015, currency: "USD" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer monid_test",
    });
  });

  it("parses synchronous success and asynchronous run envelopes", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          runEnvelope({
            status: "COMPLETED",
            output: [{ id: "1" }],
            cost: { value: 0.003, currency: "USD" },
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(runEnvelope({ status: "RUNNING" }), { status: 202 }));
    const client = new MonidClient({ apiKey: "monid_test", fetchImpl });
    const sync = await client.run({
      provider: "apify",
      endpoint: "/example",
      input: { maxItems: 1 },
    });
    expect(sync.async).toBe(false);
    expect(sync.run.output).toEqual([{ id: "1" }]);
    expect(sync.run.cost).toEqual({ value: 0.003, currency: "USD" });

    const asyncRun = await client.run({
      provider: "apify",
      endpoint: "/example",
      input: { maxItems: 1 },
    });
    expect(asyncRun.async).toBe(true);
    expect(asyncRun.run.status).toBe("RUNNING");
  });

  it("keeps provider HTTP errors as zero-cost completed runs", async () => {
    const client = new MonidClient({
      apiKey: "monid_test",
      fetchImpl: jsonFetch(
        runEnvelope({
          status: "COMPLETED",
          output: null,
          providerResponse: { httpStatus: 404, error: { message: "not found" } },
          cost: { value: 0, currency: "USD" },
        }),
        404,
      ),
    });
    const result = await client.run({
      provider: "pdl",
      endpoint: "/person/enrich",
      input: { email: "missing@example.com" },
    });
    expect(result.run.providerResponse?.httpStatus).toBe(404);
    expect(result.run.cost?.value).toBe(0);
  });

  it("polls, stops, and reads a wallet response without requiring held funds", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(runEnvelope({ status: "RUNNING" })))
      .mockResolvedValueOnce(jsonResponse(runEnvelope({ status: "STOPPED" })))
      .mockResolvedValueOnce(jsonResponse({ balance: { value: 2.85, currency: "USD" } }));
    const client = new MonidClient({ apiKey: "monid_test", fetchImpl });
    expect((await client.getRun("run_1")).status).toBe("RUNNING");
    expect((await client.stopRun("run_1")).status).toBe("STOPPED");
    await expect(client.getWalletBalance()).resolves.toEqual({
      balance: { value: 2.85, currency: "USD" },
    });
  });

  it("rejects malformed envelopes and API errors without retrying", async () => {
    const fetchImpl = jsonFetch({ code: 402, message: "insufficient wallet" }, 402);
    const client = new MonidClient({ apiKey: "monid_test", fetchImpl });
    await expect(
      client.run({ provider: "pdl", endpoint: "/person/enrich", input: {} }),
    ).rejects.toMatchObject({ status: 402 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves a paid run id when the remaining run envelope is malformed", async () => {
    const fetchImpl = jsonFetch({ runId: "run_drifted", status: "NEW_STATUS" }, 202);
    const client = new MonidClient({ apiKey: "monid_test", fetchImpl });
    await expect(
      client.run({ provider: "apify", endpoint: "/example", input: {} }),
    ).rejects.toMatchObject({
      status: 502,
      runId: "run_drifted",
      async: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("isTerminalMonidRun", () => {
  it("separates active and terminal lifecycle states", () => {
    expect(isTerminalMonidRun("RUNNING")).toBe(false);
    expect(isTerminalMonidRun("READY")).toBe(false);
    expect(isTerminalMonidRun("COMPLETED")).toBe(true);
    expect(isTerminalMonidRun("FAILED")).toBe(true);
    expect(isTerminalMonidRun("STOPPED")).toBe(true);
  });
});

function jsonFetch(value: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(value, { status }));
}

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function runEnvelope(overrides: Record<string, unknown>) {
  return {
    runId: "run_1",
    provider: "apify",
    endpoint: "/example",
    status: "COMPLETED",
    price: {
      type: "PER_CALL",
      amount: 0.003,
      currency: "USD",
    },
    providerResponse: { httpStatus: 200 },
    ...overrides,
  };
}
