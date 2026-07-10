import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDeviceLoginDetails, startGoatCodexDeviceAuthFlow } from "./codex-auth";
import type { RunnerEnv } from "./env";

const mocks = vi.hoisted(() => ({
  activeFlows: [] as Array<{ id: string; sandboxId: string }>,
  inserts: [] as Record<string, unknown>[],
  order: [] as string[],
  sandboxCreate: vi.fn(),
  killSandbox: vi.fn(),
  updates: [] as Record<string, unknown>[],
}));

vi.mock("e2b", () => ({
  Sandbox: {
    create: mocks.sandboxCreate,
    connect: vi.fn(),
  },
}));

vi.mock("./codex-tool", () => ({
  CODEX_FALLBACK_NPM_PACKAGE: "@openai/codex",
}));

vi.mock("./db", () => ({
  getDb: () => dbMock(),
}));

vi.mock("./sandbox", () => ({
  killSandbox: mocks.killSandbox,
}));

describe("parseDeviceLoginDetails", () => {
  it("extracts the OpenAI verification URL and user code from Codex CLI output", () => {
    expect(
      parseDeviceLoginDetails(`
To sign in, visit https://chatgpt.com/activate and enter code:

ABCD-EFGH
`),
    ).toEqual({
      verificationUri: "https://chatgpt.com/activate",
      userCode: "ABCD-EFGH",
      browserAuthFallback: false,
    });
  });

  it("accepts alternate code formatting", () => {
    expect(
      parseDeviceLoginDetails("Open https://auth.openai.com/device, then use code: abc12345"),
    ).toEqual({
      verificationUri: "https://auth.openai.com/device",
      userCode: "ABC12345",
      browserAuthFallback: false,
    });
  });

  it("extracts ANSI-colored Codex CLI device output", () => {
    expect(
      parseDeviceLoginDetails(`
Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m

2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m
   \u001b[94m6MZJ-7O6QK\u001b[0m
`),
    ).toEqual({
      verificationUri: "https://auth.openai.com/codex/device",
      userCode: "6MZJ-7O6QK",
      browserAuthFallback: false,
    });
  });

  it("does not treat browser OAuth authorization text as a device code", () => {
    expect(
      parseDeviceLoginDetails(
        "Open https://auth.openai.com/oauth/authorize?response_type=code&code_challenge=abc and complete authorization.",
      ),
    ).toEqual({
      verificationUri: null,
      userCode: null,
      browserAuthFallback: true,
    });
  });
});

describe("startGoatCodexDeviceAuthFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeFlows.length = 0;
    mocks.inserts.length = 0;
    mocks.order.length = 0;
    mocks.updates.length = 0;
    mocks.killSandbox.mockImplementation(async (sandboxId: string) => {
      mocks.order.push(`kill:${sandboxId}`);
      return true;
    });
    mocks.sandboxCreate.mockImplementation(async () => {
      mocks.order.push("create");
      return fakeSandbox();
    });
  });

  it("supersedes active Goat Codex auth flows before creating a replacement sandbox", async () => {
    mocks.activeFlows.push({ id: "gcodf_old", sandboxId: "sbx_old" });

    const flow = await startGoatCodexDeviceAuthFlow({
      userWorkosId: "user_1",
      env: env(),
    });

    expect(flow).toMatchObject({
      status: "pending",
      statusReason: "Waiting for Codex to print a device login code.",
    });
    expect(mocks.updates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        statusReason: "Superseded by a new Codex device authentication attempt.",
      }),
    );
    expect(mocks.killSandbox).toHaveBeenCalledWith("sbx_old");
    expect(mocks.order.indexOf("kill:sbx_old")).toBeLessThan(mocks.order.indexOf("create"));
    expect(mocks.inserts).toHaveLength(1);
  });

  it("continues starting a replacement flow when old sandbox cleanup fails", async () => {
    mocks.activeFlows.push({ id: "gcodf_old", sandboxId: "sbx_old" });
    mocks.killSandbox.mockImplementationOnce(async (sandboxId: string) => {
      mocks.order.push(`kill:${sandboxId}`);
      throw new Error("sandbox already gone");
    });

    await expect(
      startGoatCodexDeviceAuthFlow({
        userWorkosId: "user_1",
        env: env(),
      }),
    ).resolves.toMatchObject({ status: "pending" });

    expect(mocks.updates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        statusReason: "Superseded by a new Codex device authentication attempt.",
      }),
    );
    expect(mocks.order.indexOf("kill:sbx_old")).toBeLessThan(mocks.order.indexOf("create"));
    expect(mocks.inserts).toHaveLength(1);
  });
});

function dbMock() {
  return {
    select: () => ({
      from: () => ({
        where: async () => mocks.activeFlows,
        limit: async () => [],
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          mocks.updates.push(values);
          return [];
        },
      }),
    }),
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        mocks.inserts.push(values);
        return [];
      },
    }),
  };
}

function fakeSandbox() {
  return {
    sandboxId: "sbx_new",
    setTimeout: vi.fn(async () => undefined),
    commands: {
      run: vi.fn(async (_command: string, options?: { background?: boolean }) =>
        options?.background ? { pid: 123 } : { stdout: "", stderr: "", exitCode: 0 },
      ),
    },
    files: {
      write: vi.fn(async () => undefined),
    },
  };
}

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    databaseUrl: "postgres://test",
    internalToken: "internal",
    streamTokenSecret: "stream",
    e2bApiKey: "e2b",
    vercelAiGatewayApiKey: "gateway",
    openaiCodexApiKey: undefined,
    publicUrl: undefined,
    llmBrokerEnabled: true,
    integrationCredentialEncryptionKey: Buffer.alloc(32, 0),
    exaApiKey: "exa",
    goatBrowserEnabled: false,
    agentBrowserProvider: undefined,
    browserlessApiKey: undefined,
    browserlessApiUrl: undefined,
    browserlessTtl: undefined,
    browserlessStealth: undefined,
    xApiBearerToken: undefined,
    supadataApiKey: undefined,
    ampApiKey: undefined,
    e2bTemplate: undefined,
    ampE2bTemplate: undefined,
    codexE2bTemplate: undefined,
    e2bSandboxIdleTimeoutMs: 30_000,
    opencodeTimeoutMs: 1_200_000,
    codexTimeoutMs: 1_200_000,
    codexModel: "gpt-5.5",
    goatCodexChatIdleTimeoutMs: 1_800_000,
    toolArgRepairEnabled: false,
    jobLeaseTtlMs: 300_000,
    jobMaxLeaseBusyAttempts: 10,
    goatTaskWorkerEnabled: false,
    workerConcurrency: 2,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner_1",
    ...overrides,
  };
}
