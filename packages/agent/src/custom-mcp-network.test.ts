import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));

import {
  createCustomMcpFetch,
  isPublicMcpAddress,
  validateCustomMcpHeaders,
  validateCustomMcpUrl,
} from "./custom-mcp-network";

const endpoint = "https://tools.example.com/mcp";
const canary = "synthetic-credential-canary";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

function respond(
  status = 200,
  body = '{"ok":true}',
  responseHeaders = { "content-type": "application/json" },
) {
  mocks.request.mockImplementation((_url, _options, callback) => {
    const request = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: () => {
        const response = Object.assign(new PassThrough(), {
          statusCode: status,
          headers: responseHeaders,
        });
        callback(response);
        response.end(body);
      },
    });
    return request;
  });
}

describe("custom MCP network boundary", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "100.100.100.200",
    "192.168.1.1",
    "172.16.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])("rejects nonpublic address %s", (address) => {
    expect(isPublicMcpAddress(address)).toBe(false);
  });

  it.each([
    "http://tools.example.com/mcp",
    "file:///etc/passwd",
    "https://localhost/mcp",
    "https://2130706433/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
    "https://tools.example.com/mcp#fragment",
    "https://tools.example.com/mcp?api_key=hidden",
  ])("rejects unsafe endpoint %s", (url) => {
    expect(() => validateCustomMcpUrl(url)).toThrow();
  });

  it("rejects credentials embedded in the endpoint", () => {
    const url = new URL(endpoint);
    url.username = "fixture-user";
    url.password = "fixture-password";
    expect(() => validateCustomMcpUrl(url.toString())).toThrow();
  });

  it("preserves non-secret endpoint configuration and supports public IPv6", () => {
    expect(validateCustomMcpUrl(`${endpoint}?project=abc`)).toBe(`${endpoint}?project=abc`);
    expect(isPublicMcpAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("allows only bounded credential headers", () => {
    expect(
      validateCustomMcpHeaders({ Authorization: `Bearer ${canary}`, "X-API-Key": canary }),
    ).toEqual({ authorization: `Bearer ${canary}`, "x-api-key": canary });
    for (const name of [
      "Host",
      "Cookie",
      "Connection",
      "Mcp-Session-Id",
      "X-Forwarded-Host",
      "Content-Length",
      "Proxy-Authorization",
      "constructor",
    ])
      expect(() => validateCustomMcpHeaders({ [name]: canary })).toThrow();
    expect(() => validateCustomMcpHeaders({ token: "bad\r\nvalue" })).toThrow();
    expect(() => validateCustomMcpHeaders({ TOKEN: canary, token: canary })).toThrow();
  });

  it("pins the validated DNS address while retaining TLS hostname and exact endpoint", async () => {
    respond();
    const response = await createCustomMcpFetch(endpoint, { Authorization: `Bearer ${canary}` })(
      endpoint,
      { method: "POST", body: "{}" },
    );
    expect(await response.json()).toEqual({ ok: true });
    const [url, options] = mocks.request.mock.calls[0]!;
    expect(url.hostname).toBe("tools.example.com");
    expect(options).toMatchObject({
      agent: false,
      family: 4,
      headers: { authorization: `Bearer ${canary}` },
    });
    const callback = vi.fn();
    options.lookup("tools.example.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    await expect(
      createCustomMcpFetch(endpoint, {})("https://elsewhere.example.com/mcp"),
    ).rejects.toThrow();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("revalidates every request and rejects mixed or rebound DNS before sending credentials", async () => {
    respond();
    const fetch = createCustomMcpFetch(endpoint, { Authorization: canary });
    await (await fetch(endpoint)).text();
    mocks.lookup.mockResolvedValue([
      { address: "127.0.0.1", family: 4 },
      { address: "93.184.216.34", family: 4 },
    ]);
    await expect(fetch(endpoint)).rejects.toThrow("public HTTPS");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("never follows redirects or echoes their secret-bearing Location", async () => {
    respond(302, "", {
      "content-type": "application/json",
      location: `https://internal.example/${canary}`,
    } as never);
    const result = createCustomMcpFetch(endpoint, { Authorization: canary })(endpoint);
    await expect(result).rejects.toThrow("final HTTPS URL");
    await expect(result).rejects.not.toThrow(canary);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("bounds response bytes and removes cookies", async () => {
    respond(200, "x".repeat(4 * 1024 * 1024 + 1), {
      "content-type": "application/json",
      "set-cookie": canary,
    } as never);
    const response = await createCustomMcpFetch(endpoint, {})(endpoint);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.text()).rejects.toThrow("size limit");
  });

  it("cancels DNS resolution before any request is sent", async () => {
    mocks.lookup.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = createCustomMcpFetch(endpoint, {})(endpoint, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
