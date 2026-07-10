import { describe, expect, it } from "vitest";
import type { RunnerEnv } from "./env";
import {
  AGENT_BROWSER_ACTION_POLICY,
  buildAgentBrowserCommand,
  buildAgentBrowserEnvironment,
  buildAgentBrowserReadCommand,
  createBrowserObservationBudget,
  createGoatBrowserToolSession,
  modelFacingBrowserOutput,
} from "./goat-browser-tools";

describe("goat browser tools", () => {
  it("builds safe agent-browser arg arrays with session, output, boundary, and policy flags", () => {
    const command = buildAgentBrowserCommand({
      name: "browser_open",
      args: { url: "https://example.com/search?q=mouse" },
      sessionId: "goat-task-1",
      actionPolicyPath: "/tmp/policy.json",
    });

    expect(command).toEqual([
      "--session",
      "goat-task-1",
      "--content-boundaries",
      "--max-output",
      "20000",
      "--action-policy",
      "/tmp/policy.json",
      "open",
      "https://example.com/search?q=mouse",
    ]);
  });

  it("maps browser_read to the installed agent-browser text command", () => {
    expect(
      buildAgentBrowserCommand({
        name: "browser_read",
        args: { filter: "Samsung" },
        sessionId: "goat-task-1",
        actionPolicyPath: "/tmp/policy.json",
      }),
    ).toEqual([
      "--session",
      "goat-task-1",
      "--content-boundaries",
      "--max-output",
      "20000",
      "--action-policy",
      "/tmp/policy.json",
      "get",
      "text",
      "body",
    ]);
  });

  it("builds compact scoped snapshots by default", () => {
    expect(
      buildAgentBrowserCommand({
        name: "browser_snapshot",
        args: {},
        sessionId: "goat-task-1",
        actionPolicyPath: "/tmp/policy.json",
      }),
    ).toEqual([
      "--session",
      "goat-task-1",
      "--content-boundaries",
      "--max-output",
      "20000",
      "--action-policy",
      "/tmp/policy.json",
      "snapshot",
      "-i",
      "-c",
      "-d",
      "5",
    ]);

    expect(
      buildAgentBrowserCommand({
        name: "browser_snapshot",
        args: {
          interactive: false,
          compact: false,
          includeUrls: true,
          depth: 3,
          selector: "#main",
        },
        sessionId: "goat-task-1",
        actionPolicyPath: "/tmp/policy.json",
      }),
    ).toEqual([
      "--session",
      "goat-task-1",
      "--content-boundaries",
      "--max-output",
      "20000",
      "--action-policy",
      "/tmp/policy.json",
      "snapshot",
      "-d",
      "3",
      "-s",
      "#main",
      "--urls",
    ]);
  });

  it("builds targeted browser get, find, scroll, and native read commands", () => {
    expect(
      buildAgentBrowserCommand({
        name: "browser_get",
        args: { target: "attr", ref: "e2", attribute: "href" },
        sessionId: "goat-task-1",
        actionPolicyPath: "/tmp/policy.json",
      }).slice(-4),
    ).toEqual(["get", "attr", "@e2", "href"]);

    expect(
      buildAgentBrowserCommand({
        name: "browser_get",
        args: { target: "text" },
        sessionId: "goat-task-1",
        actionPolicyPath: "/tmp/policy.json",
      }).slice(-3),
    ).toEqual(["get", "text", "body"]);

    expect(
      buildAgentBrowserCommand({
        name: "browser_find",
        args: { by: "label", value: "Search", action: "type", text: "SSD", exact: true },
        sessionId: "goat-task-1",
        actionPolicyPath: "/tmp/policy.json",
      }).slice(-6),
    ).toEqual(["find", "label", "Search", "type", "SSD", "--exact"]);

    expect(
      buildAgentBrowserCommand({
        name: "browser_scroll",
        args: { direction: "down", pixels: 900 },
        sessionId: "goat-task-1",
        actionPolicyPath: "/tmp/policy.json",
      }).slice(-3),
    ).toEqual(["scroll", "down", "900"]);

    expect(
      buildAgentBrowserReadCommand({
        args: { url: "https://example.com/docs", filter: "auth", outline: true },
        sessionId: "goat-task-1",
        actionPolicyPath: "/tmp/policy.json",
      }).slice(-5),
    ).toEqual(["read", "https://example.com/docs", "--filter", "auth", "--outline"]);
  });

  it("compacts oversized browser observations for model context", () => {
    const budget = createBrowserObservationBudget();
    const bigSnapshot = [
      "--- AGENT_BROWSER_PAGE_CONTENT origin=https://example.com ---",
      ...Array.from({ length: 500 }, (_, index) => `- link "Product ${index}" [ref=e${index}]`),
    ].join("\n");

    const output = modelFacingBrowserOutput({
      name: "browser_snapshot",
      output: { ok: true, command: "browser_snapshot", output: bigSnapshot },
      budget,
    }) as Record<string, unknown>;

    expect(output.compacted).toBe(true);
    expect(String(output.output)).toContain("Browser output compacted");
    expect(String(output.output).length).toBeLessThan(bigSnapshot.length);
  });

  it("does not compact action confirmations", () => {
    const budget = createBrowserObservationBudget();
    const confirmation = { ok: true, command: "browser_click", output: "✓ Done".repeat(5000) };

    expect(
      modelFacingBrowserOutput({
        name: "browser_click",
        output: confirmation,
        budget,
      }),
    ).toBe(confirmation);
  });

  it("normalizes element refs and rejects invalid browser input", () => {
    expect(
      buildAgentBrowserCommand({
        name: "browser_click",
        args: { ref: "e12" },
        sessionId: "goat-task-1",
        actionPolicyPath: "/tmp/policy.json",
      }),
    ).toContain("@e12");

    expect(() =>
      buildAgentBrowserCommand({
        name: "browser_open",
        args: { url: "file:///etc/passwd" },
        sessionId: "goat-task-1",
        actionPolicyPath: "/tmp/policy.json",
      }),
    ).toThrow("browser_open url must use http or https.");
  });

  it("passes configured browser provider env through to agent-browser", () => {
    const output = buildAgentBrowserEnvironment(
      env({
        agentBrowserProvider: "browserless",
        browserlessApiKey: "browserless_key",
        browserlessApiUrl: "https://production-lon.browserless.io",
        browserlessTtl: "300000",
        browserlessStealth: "true",
      }),
    );

    expect(output).toMatchObject({
      AGENT_BROWSER_PROVIDER: "browserless",
      BROWSERLESS_API_KEY: "browserless_key",
      BROWSERLESS_API_URL: "https://production-lon.browserless.io",
      BROWSERLESS_TTL: "300000",
      BROWSERLESS_STEALTH: "true",
    });
  });

  it("strips blank browser provider env so local agent-browser can use its default provider", () => {
    const previous = process.env.AGENT_BROWSER_PROVIDER;
    process.env.AGENT_BROWSER_PROVIDER = "";
    try {
      const output = buildAgentBrowserEnvironment(env({ agentBrowserProvider: undefined }));
      expect(output).not.toHaveProperty("AGENT_BROWSER_PROVIDER");
    } finally {
      if (previous === undefined) {
        delete process.env.AGENT_BROWSER_PROVIDER;
      } else {
        process.env.AGENT_BROWSER_PROVIDER = previous;
      }
    }
  });

  it("allows safe internal agent-browser actions used by targeted find and get commands", () => {
    expect(AGENT_BROWSER_ACTION_POLICY.allow).toEqual(
      expect.arrayContaining([
        "getbyrole",
        "getbytext",
        "getbylabel",
        "getbyplaceholder",
        "getbyalttext",
        "getbytitle",
        "getbytestid",
        "first",
        "last",
        "nth",
        "url",
        "title",
        "gettext",
        "inputvalue",
        "getattribute",
        "count",
      ]),
    );
  });

  it("fails before execution when browser tools are disabled or browserless lacks credentials", () => {
    expect(() =>
      createGoatBrowserToolSession({
        taskId: "goat_task_1",
        env: env({ goatBrowserEnabled: false }),
        signal: new AbortController().signal,
      }),
    ).toThrow("Browser tools are disabled.");

    expect(() =>
      createGoatBrowserToolSession({
        taskId: "goat_task_1",
        env: env({
          goatBrowserEnabled: true,
          agentBrowserProvider: "browserless",
          browserlessApiKey: undefined,
        }),
        signal: new AbortController().signal,
      }),
    ).toThrow("BROWSERLESS_API_KEY is not configured");
  });
});

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
    goatBrowserEnabled: true,
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
