import { BROWSER_TOOL_NAMES } from "@opencompany/browser-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrCreate: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    getOrCreate: mocks.getOrCreate,
  },
}));

vi.mock("@vercel/blob", () => ({
  put: mocks.put,
}));

import { createChatBrowserToolSession } from "./browser-tools";
import {
  CHAT_SANDBOX_ACTION_POLICY_PATH,
  CHAT_SANDBOX_AGENT_BROWSER_BIN,
  CHAT_SANDBOX_NETWORK_POLICY,
  CHAT_SANDBOX_ROOT,
  CHAT_SANDBOX_SCREENSHOT_DIR,
  getChatSandbox,
} from "./chat-sandbox";

const runCommand = vi.fn(async (input: { args: string[] }) => {
  const output = input.args.includes("snapshot")
    ? 'Page: Example\nbutton "More" [ref=e1]'
    : input.args.includes("open")
      ? "Opened https://example.com/"
      : "";
  return {
    exitCode: 0,
    stdout: vi.fn(async () => output),
    stderr: vi.fn(async () => ""),
  };
});
const writeFiles = vi.fn(async () => undefined);
const readFileToBuffer = vi.fn(async () => Buffer.from("png"));
const asUser = vi.fn(() => ({ runCommand }));
const sandbox = {
  name: "goat-chat-chat_1",
  runtime: "node24",
  image: undefined,
  region: "iad1",
  vcpus: 2,
  memory: 2_048,
  status: "running",
  runCommand,
  asUser,
  writeFiles,
  readFileToBuffer,
  currentSession: () => ({ sessionId: "sbx_session_1" }),
};

describe("Goat chat browser sandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.getOrCreate.mockResolvedValue(sandbox);
    mocks.put.mockResolvedValue({});
  });

  it("configures a named persistent sandbox and provisions the stock runtime once", async () => {
    const signal = new AbortController().signal;
    await getChatSandbox({ chatSessionId: "chat/1", signal });

    expect(mocks.getOrCreate).toHaveBeenCalledOnce();
    const params = mocks.getOrCreate.mock.calls[0]?.[0] as {
      name: string;
      persistent: boolean;
      runtime?: string;
      networkPolicy: unknown;
      signal: AbortSignal;
      onCreate: (value: typeof sandbox) => Promise<void>;
    };
    expect(params).toMatchObject({
      name: "goat-chat-chat-1",
      persistent: true,
      runtime: "node24",
      networkPolicy: CHAT_SANDBOX_NETWORK_POLICY,
      signal,
    });
    expect(CHAT_SANDBOX_NETWORK_POLICY).toMatchObject({
      subnets: {
        deny: expect.arrayContaining([
          "0.0.0.0/8",
          "10.0.0.0/8",
          "169.254.0.0/16",
          "172.16.0.0/12",
          "192.168.0.0/16",
        ]),
      },
    });

    await params.onCreate(sandbox);
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cmd: "mkdir",
        args: ["-p", CHAT_SANDBOX_SCREENSHOT_DIR],
        signal,
      }),
    );
    expect(writeFiles).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          path: CHAT_SANDBOX_ACTION_POLICY_PATH,
          mode: 0o600,
        }),
      ],
      { signal },
    );
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: "npm",
        args: expect.arrayContaining(["agent-browser@0.27.3"]),
        signal,
      }),
    );
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: CHAT_SANDBOX_AGENT_BROWSER_BIN,
        args: ["install", "--with-deps"],
        signal,
        env: expect.objectContaining({
          AGENT_BROWSER_SCREENSHOT_DIR: CHAT_SANDBOX_SCREENSHOT_DIR,
        }),
      }),
    );
    expect(asUser).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: "chmod",
        args: expect.arrayContaining(["a+rX", `${CHAT_SANDBOX_ROOT}/agent-browser`]),
        signal,
      }),
    );
  });

  it("creates lazily, reuses one sandbox, and snapshots after page-changing actions", async () => {
    const controller = new AbortController();
    const session = createChatBrowserToolSession({
      chatSessionId: "chat_1",
      userWorkosId: "user_1",
      signal: controller.signal,
    });

    expect(session.getUsage()).toBeNull();
    expect(mocks.getOrCreate).not.toHaveBeenCalled();

    const opened = await session.execute({
      name: "browser_open",
      args: { url: "https://example.com" },
    });
    const title = await session.execute({
      name: "browser_get",
      args: { target: "title" },
    });

    expect(opened).toMatchObject({
      ok: true,
      command: "browser_open",
      snapshot: {
        ok: true,
        command: "browser_snapshot",
        output: expect.stringContaining("[ref=e1]"),
      },
    });
    expect(title).toMatchObject({ ok: true, command: "browser_get" });
    expect(mocks.getOrCreate).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledTimes(3);
    expect(
      runCommand.mock.calls.every(
        ([call]) => (call as { signal?: AbortSignal }).signal === controller.signal,
      ),
    ).toBe(true);
    expect(session.getUsage()).toMatchObject({
      sandboxId: "sbx_session_1",
      sandboxName: "goat-chat-chat_1",
      rawMetrics: {
        commandCount: 3,
      },
    });
  });

  it("uploads screenshots privately and returns only an authenticated transcript URL", async () => {
    const signal = new AbortController().signal;
    const session = createChatBrowserToolSession({
      chatSessionId: "chat_1",
      userWorkosId: "user_1",
      signal,
    });

    const output = await session.execute({
      name: "browser_screenshot",
      args: { fullPage: true },
    });

    expect(output).toMatchObject({
      ok: true,
      command: "browser_screenshot",
      screenshotUrl: expect.stringMatching(
        /^\/api\/chat-screenshots\/chat_1\/\d+-[a-f0-9-]+\.png$/,
      ),
    });
    expect(readFileToBuffer).toHaveBeenCalledWith(
      {
        path: expect.stringMatching(
          new RegExp(`^${CHAT_SANDBOX_SCREENSHOT_DIR}/\\d+-[a-f0-9-]+\\.png$`),
        ),
      },
      { signal },
    );
    expect(mocks.put).toHaveBeenCalledWith(
      expect.stringMatching(/^goat-chat\/user_1\/screenshots\/chat_1\/\d+-[a-f0-9-]+\.png$/),
      Buffer.from("png"),
      {
        access: "private",
        addRandomSuffix: false,
        contentType: "image/png",
      },
    );
    expect(JSON.stringify(output)).not.toContain("blob.vercel-storage.com");
  });

  it("returns a failed tool result when private screenshot storage is unavailable", async () => {
    mocks.put.mockRejectedValueOnce(new Error("Blob unavailable"));
    const session = createChatBrowserToolSession({
      chatSessionId: "chat_1",
      userWorkosId: "user_1",
      signal: new AbortController().signal,
    });

    await expect(
      session.execute({
        name: "browser_screenshot",
        args: {},
      }),
    ).resolves.toMatchObject({
      ok: false,
      command: "browser_screenshot",
      error: "The screenshot was captured but could not be stored.",
    });
  });

  it("counts both browser commands used by browser_read with a URL", async () => {
    const session = createChatBrowserToolSession({
      chatSessionId: "chat_1",
      userWorkosId: "user_1",
      signal: new AbortController().signal,
    });

    await session.execute({
      name: "browser_read",
      args: { url: "https://example.com" },
    });

    expect(session.getUsage()).toMatchObject({
      rawMetrics: { commandCount: 2 },
    });
  });

  it("exposes the same tool-name contract used by the runner", () => {
    expect(BROWSER_TOOL_NAMES).toHaveLength(11);
    expect(BROWSER_TOOL_NAMES).toContain("browser_screenshot");
  });
});
