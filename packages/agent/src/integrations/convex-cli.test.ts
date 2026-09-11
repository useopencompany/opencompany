import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runConvexCli } from "./convex-cli";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
const key = "dev:happy-animal-123|abcdefgh";
let child: EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};
let operation: Record<string, any>;
let result: unknown;

describe("Convex CLI isolation", () => {
  beforeEach(() => {
    result = { content: [{ type: "text", text: "ok" }] };
    mocks.spawn.mockImplementation(() => {
      child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        kill: vi.fn(() => {
          child.emit("close", 0);
          return true;
        }),
      });
      child.stdin.on("data", (chunk) => {
        const rpc = JSON.parse(chunk.toString());
        if (rpc.id === 1)
          queueMicrotask(() =>
            child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`),
          );
        if (rpc.id === 2) {
          operation = rpc;
          queueMicrotask(() =>
            child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result })}\n`),
          );
        }
      });
      return child;
    });
  });
  it("uses a private project, no inherited credentials, and removes it after killing the child", async () => {
    vi.stubEnv("UNRELATED_SECRET", "must-not-inherit");
    try {
      await runConvexCli({ apiKey: key, tool: "tables", args: {} });
      const [command, args, options] = mocks.spawn.mock.calls.at(-1)!;
      expect(command).toBe(process.execPath);
      expect(args).not.toContain(key);
      expect(args).toContain("status,insights");
      expect(options.env).toEqual({
        HOME: options.cwd,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        CI: "1",
        NODE_ENV: "production",
        CONVEX_DEPLOY_KEY: key,
      });
      expect(options.stdio).toEqual(["pipe", "pipe", "ignore"]);
      const selector = operation.params.arguments.deploymentSelector.split(":")[1];
      expect(JSON.parse(Buffer.from(selector, "base64").toString())).toEqual({
        projectDir: options.cwd,
        deployment: { kind: "unspecified" },
      });
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      await expect(stat(options.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("redacts the connected key in returned content", async () => {
    result = { content: [{ type: "text", text: `provider echoed ${key}` }] };
    const response = await runConvexCli({ apiKey: key, tool: "tables", args: {} });
    expect(JSON.stringify(response)).not.toContain(key);
    expect(JSON.stringify(response)).toContain("[redacted]");
  });
  it("bounds upstream output and cleans up on failure", async () => {
    result = { content: [{ type: "text", text: "x".repeat(4 * 1024 * 1024) }] };
    await expect(runConvexCli({ apiKey: key, tool: "tables", args: {} })).rejects.toThrow(
      "size limit",
    );
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(stat(mocks.spawn.mock.calls.at(-1)![2].cwd)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("preserves the production guard in the server-owned selector", async () => {
    await runConvexCli({ apiKey: key.replace("dev:", "prod:"), tool: "tables", args: {} });
    expect(operation.params.arguments.deploymentSelector).toMatch(/^prod:/);
  });
});
