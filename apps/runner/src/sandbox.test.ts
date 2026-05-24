import { afterEach, describe, expect, it, vi } from "vitest";

const e2bMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  create: vi.fn(),
  kill: vi.fn(),
}));

vi.mock("e2b", () => ({
  Sandbox: e2bMocks,
}));

import {
  armSandboxIdleTimeout,
  createOrConnectSandbox,
  githubRemoteMatches,
  prepareWorkspace,
} from "./sandbox";

afterEach(() => {
  vi.resetAllMocks();
});

describe("createOrConnectSandbox", () => {
  it("creates new sandboxes with auto-pause and auto-resume lifecycle", async () => {
    const sandbox = {
      sandboxId: "sbx_new",
      setTimeout: vi.fn().mockResolvedValue(undefined),
    };
    e2bMocks.create.mockResolvedValue(sandbox);

    await createOrConnectSandbox({
      envs: { E2B_API_KEY: "e2b" },
      idleTimeoutMs: 30_000,
    });

    expect(e2bMocks.create).toHaveBeenCalledWith({
      envs: { E2B_API_KEY: "e2b" },
      timeoutMs: 30_000,
      lifecycle: { onTimeout: "pause", autoResume: true },
    });
    expect(sandbox.setTimeout).toHaveBeenCalledWith(3_600_000, { requestTimeoutMs: 30_000 });
  });

  it("resumes existing sandboxes with the active runner timeout", async () => {
    const sandbox = {
      sandboxId: "sbx_existing",
      setTimeout: vi.fn().mockResolvedValue(undefined),
    };
    e2bMocks.connect.mockResolvedValue(sandbox);

    const result = await createOrConnectSandbox({
      sandboxId: "sbx_existing",
      envs: {},
      idleTimeoutMs: 30_000,
    });

    expect(result).toBe(sandbox);
    expect(e2bMocks.connect).toHaveBeenCalledWith("sbx_existing", {
      timeoutMs: 3_600_000,
      requestTimeoutMs: 30_000,
    });
  });

  it("creates a replacement sandbox when the stored sandbox id is stale", async () => {
    const sandbox = {
      sandboxId: "sbx_replacement",
      setTimeout: vi.fn().mockResolvedValue(undefined),
    };
    e2bMocks.connect.mockRejectedValue(new Error("sandbox not found"));
    e2bMocks.create.mockResolvedValue(sandbox);

    const result = await createOrConnectSandbox({
      sandboxId: "sbx_missing",
      envs: {},
      idleTimeoutMs: 30_000,
    });

    expect(result).toBe(sandbox);
    expect(e2bMocks.create).toHaveBeenCalledWith({
      envs: {},
      timeoutMs: 30_000,
      lifecycle: { onTimeout: "pause", autoResume: true },
    });
  });
});

describe("armSandboxIdleTimeout", () => {
  it("sets the sandbox timeout to the configured idle window", async () => {
    const sandbox = {
      sandboxId: "sbx_new",
      getInfo: vi.fn().mockResolvedValue({ lifecycle: { onTimeout: "pause", autoResume: true } }),
      pause: vi.fn().mockResolvedValue(true),
      setTimeout: vi.fn().mockResolvedValue(undefined),
    };

    await expect(armSandboxIdleTimeout(sandbox as never, 30_000)).resolves.toBe(true);

    expect(sandbox.getInfo).toHaveBeenCalledWith({ requestTimeoutMs: 30_000 });
    expect(sandbox.pause).not.toHaveBeenCalled();
    expect(sandbox.setTimeout).toHaveBeenCalledWith(30_000, { requestTimeoutMs: 30_000 });
  });

  it("pauses legacy sandboxes that were created without auto-pause lifecycle", async () => {
    const sandbox = {
      sandboxId: "sbx_legacy",
      getInfo: vi.fn().mockResolvedValue({ lifecycle: { onTimeout: "kill", autoResume: false } }),
      pause: vi.fn().mockResolvedValue(true),
      setTimeout: vi.fn().mockResolvedValue(undefined),
    };

    await expect(armSandboxIdleTimeout(sandbox as never, 30_000)).resolves.toBe(true);

    expect(sandbox.pause).toHaveBeenCalledWith({ requestTimeoutMs: 30_000 });
    expect(sandbox.setTimeout).not.toHaveBeenCalledWith(30_000, {
      requestTimeoutMs: 30_000,
    });
  });
});

describe("prepareWorkspace", () => {
  it("clones the configured repository when no git checkout exists", async () => {
    const sandbox = createWorkspaceSandbox(["__opencompany_missing_git__\n"]);

    await prepareWorkspace({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      agentFile: "instructions",
      repositoryFullName: "opencompany/app",
      repositoryDefaultBranch: "main",
      githubToken: "ghs_token",
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("git remote get-url origin"),
      {
        timeoutMs: 30_000,
      },
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("git clone --depth 1 --branch 'main'"),
      { envs: { GITHUB_TOKEN: "ghs_token" }, timeoutMs: 120_000 },
    );
    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/.opencompany/agent.md",
      "instructions",
    );
  });

  it("keeps an existing checkout when origin matches the configured repository", async () => {
    const sandbox = createWorkspaceSandbox(["https://github.com/opencompany/app.git\n"]);

    await prepareWorkspace({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      agentFile: "instructions",
      repositoryFullName: "opencompany/app",
      repositoryDefaultBranch: "main",
      githubToken: "ghs_token",
    });

    const commands = sandbox.commands.run.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(commands.some((command) => command.includes("git clone"))).toBe(false);
    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/.opencompany/agent.md",
      "instructions",
    );
  });

  it("reclones when the existing checkout points at another repository", async () => {
    const sandbox = createWorkspaceSandbox(["https://github.com/opencompany/other.git\n"]);

    await prepareWorkspace({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      agentFile: "instructions",
      repositoryFullName: "opencompany/app",
      repositoryDefaultBranch: "develop",
      githubToken: "ghs_token",
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("git clone --depth 1 --branch 'develop'"),
      { envs: { GITHUB_TOKEN: "ghs_token" }, timeoutMs: 120_000 },
    );
  });

  it("matches tokenized GitHub remotes without exposing the token", () => {
    expect(
      githubRemoteMatches(
        "https://x-access-token:ghs_secret@github.com/opencompany/app.git",
        "opencompany/app",
      ),
    ).toBe(true);
    expect(githubRemoteMatches("git@github.com:opencompany/app.git", "opencompany/app")).toBe(true);
    expect(githubRemoteMatches("https://github.com/opencompany/other.git", "opencompany/app")).toBe(
      false,
    );
  });
});

function createWorkspaceSandbox(stdout: string[]) {
  return {
    commands: {
      run: vi.fn(async () => ({ stdout: stdout.shift() ?? "", stderr: "", exitCode: 0 })),
    },
    files: {
      write: vi.fn(async () => undefined),
    },
  };
}
