import { describe, expect, it, vi } from "vitest";

vi.mock("e2b", () => ({ Sandbox: {} }));

import { formatMemoryUsageReport, type GatewayUsageEntry } from "@opencompany/memory/usage";
import { __test, runMemoryTool } from "./memory-tool";

function fakeSandbox(stdout: string, stderr: string) {
  return {
    commands: {
      run: vi.fn(async () => ({ stdout, stderr, exitCode: 0 })),
    },
  };
}

const env = { vercelAiGatewayApiKey: "gw_secret_key" } as never;

describe("runMemoryTool", () => {
  it("injects the gateway key only into the subprocess and passes --report-usage", async () => {
    const sandbox = fakeSandbox("1. [company] acme", "");

    await runMemoryTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      args: { args: 'query "acme"' },
      env,
    });

    const [command, options] = sandbox.commands.run.mock.calls[0] as unknown as [
      string,
      { cwd: string; envs?: Record<string, string> },
    ];
    expect(command).toBe(
      "bun '/home/user/workspace/skills/memory/memory.js' 'query' 'acme' --report-usage",
    );
    expect(options.envs).toEqual({ VERCEL_AI_GATEWAY_API_KEY: "gw_secret_key" });
    expect(command).not.toContain("gw_secret_key");
  });

  it("parses the stderr usage marker, strips it, and bills aggregated token cost", async () => {
    const entries: GatewayUsageEntry[] = [
      {
        model: "openai/text-embedding-3-small",
        operation: "embeddings",
        inputTokens: 1000,
        outputTokens: 0,
        totalTokens: 1000,
        costUsd: null,
      },
      {
        model: "openai/gpt-5.4-nano",
        operation: "chat",
        inputTokens: 500,
        outputTokens: 200,
        totalTokens: 700,
        costUsd: null,
      },
    ];
    const sandbox = fakeSandbox("results", `${formatMemoryUsageReport(entries)}\n`);

    const result = await runMemoryTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      args: { args: "query acme" },
      env,
    });

    // Marker removed from the model-facing output.
    expect((result.output as { stderr: string }).stderr).toBe("");
    expect((result.output as { stdout: string }).stdout).toBe("results");

    // embeddings: 1000 * 20_000 / 1e6 = 20; chat: 500*200_000/1e6 + 200*1_250_000/1e6 = 100 + 250.
    expect(result.usage).toEqual({
      provider: "vercel-ai-gateway",
      operation: "retrieval",
      costUsdMicros: 370,
      rawUsage: { entries, inputTokens: 1500, outputTokens: 200, calls: 2 },
    });
  });

  it("prefers the Gateway-reported dollar cost when present", async () => {
    const entries: GatewayUsageEntry[] = [
      {
        model: "openai/text-embedding-3-small",
        operation: "embeddings",
        inputTokens: 999,
        outputTokens: 0,
        totalTokens: 999,
        costUsd: 0.0005,
      },
    ];
    const sandbox = fakeSandbox("results", `${formatMemoryUsageReport(entries)}\n`);

    const result = await runMemoryTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      args: { args: "query acme" },
      env,
    });

    // 0.0005 USD → 500 micros, ignoring the token map.
    expect(result.usage?.costUsdMicros).toBe(500);
  });

  it("reports no usage when the lexical-only path makes no Gateway calls", async () => {
    const sandbox = fakeSandbox("results", "");

    const result = await runMemoryTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      args: { args: "query acme --lexical-only" },
      env,
    });

    expect(result.usage).toBeUndefined();
  });

  it("prices unknown override models at zero rather than guessing", () => {
    expect(
      __test.memoryEntryCostUsdMicros({
        model: "custom/some-model",
        operation: "chat",
        inputTokens: 1000,
        outputTokens: 1000,
        totalTokens: 2000,
        costUsd: null,
      }),
    ).toBe(0);
  });
});
