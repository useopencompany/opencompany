import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyHeadlessApiRequest = vi.hoisted(() => vi.fn());

vi.mock("@/lib/headless-api-proxy", () => ({ proxyHeadlessApiRequest }));

import { proxyV1Request } from "./route";

describe("web /v1 compatibility route", () => {
  beforeEach(() => proxyHeadlessApiRequest.mockReset());

  it("forwards the complete canonical path to the streaming proxy", async () => {
    const expected = new Response("stream");
    proxyHeadlessApiRequest.mockResolvedValue(expected);
    const request = new Request("https://app.example.test/v1/runs/run_1/events?cursor=v1%3A4");

    const response = await proxyV1Request(request, {
      params: Promise.resolve({ path: ["runs", "run_1", "events"] }),
    });

    expect(response).toBe(expected);
    expect(proxyHeadlessApiRequest).toHaveBeenCalledWith(request, ["runs", "run_1", "events"]);
  });

  it("uses the version root when the optional catch-all path is absent", async () => {
    proxyHeadlessApiRequest.mockResolvedValue(new Response(null, { status: 204 }));
    const request = new Request("https://app.example.test/v1");

    await proxyV1Request(request, { params: Promise.resolve({}) });

    expect(proxyHeadlessApiRequest).toHaveBeenCalledWith(request, []);
  });
});
