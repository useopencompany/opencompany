import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import {
  detectSandboxHttpPreview,
  detectSandboxHttpPreviews,
  orderPreviewPorts,
  parseListeningTcpPorts,
  resolveSessionPreviewUrl,
} from "./preview-url";
import { connectSandbox } from "./sandbox";
import { loadSession } from "./session-lifecycle";

vi.mock("./session-lifecycle", () => ({
  loadSession: vi.fn(),
}));

vi.mock("./sandbox", () => ({
  armSandboxIdleTimeout: vi.fn(async () => true),
  connectSandbox: vi.fn(),
}));

const env = {
  e2bSandboxIdleTimeoutMs: 30_000,
} as RunnerEnv;

const loadSessionMock = loadSession as unknown as {
  mockResolvedValueOnce: (value: Awaited<ReturnType<typeof loadSession>>) => void;
};
const connectSandboxMock = connectSandbox as unknown as {
  mockResolvedValueOnce: (value: Awaited<ReturnType<typeof connectSandbox>>) => void;
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("parseListeningTcpPorts", () => {
  it("parses ss output and ignores internal/system ports", () => {
    expect(
      parseListeningTcpPorts(
        [
          "LISTEN 0 4096 127.0.0.1:22 0.0.0.0:*",
          "LISTEN 0 4096 127.0.0.1:47345 0.0.0.0:*",
          "LISTEN 0 4096 0.0.0.0:49983 0.0.0.0:*",
          "LISTEN 0 4096 0.0.0.0:50005 0.0.0.0:*",
          "LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*",
          "LISTEN 0 4096 [::]:5173 [::]:*",
          "LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*",
        ].join("\n"),
      ),
    ).toEqual([3000, 5173]);
  });
});

describe("orderPreviewPorts", () => {
  it("prefers common dev ports before arbitrary listening ports", () => {
    expect(orderPreviewPorts([9999, 8080, 5173, 3001])).toEqual([3001, 5173, 8080, 9999]);
  });
});

describe("detectSandboxHttpPreview", () => {
  it("returns the first HTTP-responsive preferred port", async () => {
    const sandbox = fakeSandbox({
      "ss -H -ltn": {
        stdout: [
          "LISTEN 0 4096 0.0.0.0:9999 0.0.0.0:*",
          "LISTEN 0 4096 0.0.0.0:5173 0.0.0.0:*",
        ].join("\n"),
      },
      ":5173/": { stdout: "HTTP/1.1 200 OK\r\nserver: vite\r\n\r\n" },
      ":9999/": { stdout: "HTTP/1.1 200 OK\r\nserver: arbitrary\r\n\r\n" },
    });

    await expect(detectSandboxHttpPreview(sandbox)).resolves.toEqual({
      port: 5173,
      url: "https://sbx_123-5173.example.com",
    });
  });

  it("returns every HTTP-responsive preview port in preference order", async () => {
    const sandbox = fakeSandbox({
      "ss -H -ltn": {
        stdout: [
          "LISTEN 0 4096 0.0.0.0:9999 0.0.0.0:*",
          "LISTEN 0 4096 0.0.0.0:5173 0.0.0.0:*",
          "LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*",
        ].join("\n"),
      },
      ":3000/": { stdout: "HTTP/1.1 200 OK\r\nserver: next\r\n\r\n" },
      ":5173/": { stdout: "HTTP/1.1 200 OK\r\nserver: vite\r\n\r\n" },
      ":9999/": { stdout: "HTTP/1.1 200 OK\r\nserver: arbitrary\r\n\r\n" },
    });

    await expect(detectSandboxHttpPreviews(sandbox)).resolves.toEqual([
      { port: 3000, url: "https://sbx_123-3000.example.com" },
      { port: 5173, url: "https://sbx_123-5173.example.com" },
      { port: 9999, url: "https://sbx_123-9999.example.com" },
    ]);
  });

  it("skips E2B internal auth responses and keeps probing candidates", async () => {
    const sandbox = fakeSandbox({
      "ss -H -ltn": {
        stdout: [
          "LISTEN 0 4096 0.0.0.0:61234 0.0.0.0:*",
          "LISTEN 0 4096 0.0.0.0:61235 0.0.0.0:*",
        ].join("\n"),
      },
      ":61234/": {
        stdout:
          'HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\n\r\n{"code":401,"message":"unauthorized access, please provide a valid access token or method signing if supported"}',
      },
      ":61235/": { stdout: "HTTP/1.1 204 No Content\r\n\r\n" },
    });

    await expect(detectSandboxHttpPreview(sandbox)).resolves.toEqual({
      port: 61235,
      url: "https://sbx_123-61235.example.com",
    });
  });

  it("returns null when only E2B internal auth responses are present", async () => {
    const sandbox = fakeSandbox({
      "ss -H -ltn": {
        stdout: "LISTEN 0 4096 0.0.0.0:61234 0.0.0.0:*",
      },
      ":61234/": {
        stdout:
          'HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\n\r\n{"code":401,"message":"unauthorized access, please provide a valid access token or method signing if supported"}',
      },
    });

    await expect(detectSandboxHttpPreview(sandbox)).resolves.toBeNull();
  });
});

describe("resolveSessionPreviewUrl", () => {
  it("returns no_http_ports when listening ports do not respond over HTTP", async () => {
    loadSessionMock.mockResolvedValueOnce({
      session: {
        id: "ses_123",
        workspaceId: "wks_123",
        engine: "codex",
        e2bSandboxId: "sbx_123",
      },
    } as Awaited<ReturnType<typeof loadSession>>);
    const sandbox = fakeSandbox({
      "ss -H -ltn": { stdout: "LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*" },
      ":3000/": { stdout: "" },
    });
    connectSandboxMock.mockResolvedValueOnce(sandbox as never);

    await expect(
      resolveSessionPreviewUrl({ sessionId: "ses_123", workspaceId: "wks_123", env }),
    ).resolves.toEqual({
      available: false,
      reason: "no_http_ports",
      message: "No HTTP dev server is currently listening in the sandbox.",
    });
  });
});

function fakeSandbox(
  responses: Record<string, { stdout: string }>,
): Parameters<typeof detectSandboxHttpPreviews>[0] {
  return {
    sandboxId: "sbx_123",
    getHost: (port: number) => `sbx_123-${port}.example.com`,
    commands: {
      run: vi.fn(async (command: string) => {
        for (const [match, response] of Object.entries(responses)) {
          if (command.includes(match)) return response;
        }
        return { stdout: "" };
      }),
    },
  } as never;
}
