import { expect, it, vi } from "vitest";
import { type GitHubSandboxCapability, prepareGitHubSandboxAuth } from "./github-sandbox-auth";
import type { SandboxHandle } from "./sandbox";

const capability: GitHubSandboxCapability = {
  ticket: "attempt-ticket",
  localToken: "ghu_local",
  root: "/tmp/oc-gh-test",
  lifetimeSeconds: 60,
  redactionValues: [],
};

it("removes relay credentials when setup fails before the process starts", async () => {
  const run = vi.fn(async (command: string) => {
    if (command.startsWith("rm -rf")) return { stdout: "" };
    return { stdout: "" };
  });
  const sandbox = {
    files: { write: vi.fn(async () => Promise.reject(new Error("write failed"))) },
    commands: { run, kill: vi.fn() },
  } as unknown as SandboxHandle;

  await expect(
    prepareGitHubSandboxAuth({
      sandbox,
      brokerUrl: "https://runner.example.com",
      capability,
      identity: {},
    }),
  ).rejects.toThrow("write failed");

  expect(sandbox.commands.kill).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledWith("rm -rf -- '/tmp/oc-gh-test'", { timeoutMs: 15_000 });
});

it("removes relay credentials and retains bounded stderr when startup fails", async () => {
  const run = vi.fn(async (command: string, options?: { onStderr?: (data: string) => void }) => {
    if (options?.onStderr) {
      options.onStderr(`${"x".repeat(2_000)}relay diagnostic`);
      return { pid: 42, stdout: "" };
    }
    if (command.startsWith("python3 -c")) throw new Error("readiness failed");
    return { stdout: "" };
  });
  const sandbox = {
    files: { write: vi.fn() },
    commands: { run, kill: vi.fn(async () => Promise.reject(new Error("already exited"))) },
  } as unknown as SandboxHandle;

  await expect(
    prepareGitHubSandboxAuth({
      sandbox,
      brokerUrl: "https://runner.example.com",
      capability,
      identity: {},
    }),
  ).rejects.toThrow("relay diagnostic");

  expect(sandbox.commands.kill).toHaveBeenCalledWith(42);
  expect(run).toHaveBeenCalledWith("rm -rf -- '/tmp/oc-gh-test'", { timeoutMs: 15_000 });
});
