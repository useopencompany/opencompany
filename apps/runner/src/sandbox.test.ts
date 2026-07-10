import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

const e2bMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  create: vi.fn(),
  getInfo: vi.fn(),
  kill: vi.fn(),
}));

vi.mock("e2b", () => ({
  Sandbox: e2bMocks,
}));

import {
  armSandboxIdleTimeout,
  cloneGitHubRepositoryIntoWorkdir,
  commandExitResult,
  connectSandbox,
  createOrConnectSandbox,
  getSandboxLifecycleStatus,
  githubRemoteMatches,
  guardCommandStreamCallbacks,
  prepareWorkspace,
  resolveSandboxBrainRelativePath,
  resolveSandboxSkillPath,
  resolveSandboxToolPath,
  runSandboxTool,
  SandboxPreparationError,
  sandboxLayout,
  sandboxPreparationErrorFields,
  writeSandboxTextFiles,
} from "./sandbox";

afterEach(() => {
  vi.resetAllMocks();
});

describe("connectSandbox", () => {
  it("connects to an existing sandbox and emits success latency", async () => {
    const sandbox = {
      sandboxId: "sbx_existing",
    };
    e2bMocks.connect.mockResolvedValue(sandbox);
    const observations: unknown[] = [];

    await expect(
      connectSandbox({
        sandboxId: "sbx_existing",
        onLatency: (observation) => {
          observations.push(observation);
        },
      }),
    ).resolves.toBe(sandbox);

    expect(e2bMocks.connect).toHaveBeenCalledWith("sbx_existing", {
      timeoutMs: 3_600_000,
      requestTimeoutMs: 30_000,
    });
    expect(observations).toEqual([
      expect.objectContaining({
        operation: "connect",
        outcome: "success",
        sandboxId: "sbx_existing",
        requestedSandboxId: "sbx_existing",
        latencyMs: expect.any(Number),
      }),
    ]);
  });

  it("returns null and emits not-found latency for stale sandbox ids", async () => {
    e2bMocks.connect.mockRejectedValue(new Error("sandbox not found"));
    const observations: unknown[] = [];

    await expect(
      connectSandbox({
        sandboxId: "sbx_missing",
        onLatency: (observation) => {
          observations.push(observation);
        },
      }),
    ).resolves.toBeNull();

    expect(observations).toEqual([
      expect.objectContaining({
        operation: "connect",
        outcome: "not_found",
        requestedSandboxId: "sbx_missing",
        latencyMs: expect.any(Number),
      }),
    ]);
  });

  it("throws and emits error latency for non-not-found connect failures", async () => {
    const error = new Error("permission denied");
    error.name = "E2BPermissionError";
    e2bMocks.connect.mockRejectedValue(error);
    const observations: unknown[] = [];

    await expect(
      connectSandbox({
        sandboxId: "sbx_denied",
        onLatency: (observation) => {
          observations.push(observation);
        },
      }),
    ).rejects.toThrow("permission denied");

    expect(observations).toEqual([
      expect.objectContaining({
        operation: "connect",
        outcome: "error",
        requestedSandboxId: "sbx_denied",
        errorName: "E2BPermissionError",
        latencyMs: expect.any(Number),
      }),
    ]);
  });
});

describe("createOrConnectSandbox", () => {
  it("creates new sandboxes with auto-pause and auto-resume lifecycle", async () => {
    const sandbox = {
      sandboxId: "sbx_new",
      setTimeout: vi.fn().mockResolvedValue(undefined),
    };
    e2bMocks.create.mockResolvedValue(sandbox);
    const observations: unknown[] = [];

    await createOrConnectSandbox({
      envs: { E2B_API_KEY: "e2b" },
      idleTimeoutMs: 30_000,
      onLatency: (observation) => {
        observations.push(observation);
      },
    });

    expect(e2bMocks.create).toHaveBeenCalledWith({
      envs: { E2B_API_KEY: "e2b" },
      timeoutMs: 30_000,
      lifecycle: { onTimeout: "pause", autoResume: true },
    });
    expect(sandbox.setTimeout).toHaveBeenCalledWith(3_600_000, { requestTimeoutMs: 30_000 });
    expect(observations).toEqual([
      expect.objectContaining({
        operation: "create",
        outcome: "success",
        sandboxId: "sbx_new",
        latencyMs: expect.any(Number),
      }),
    ]);
  });

  it("resumes existing sandboxes with the active runner timeout", async () => {
    const sandbox = {
      sandboxId: "sbx_existing",
      setTimeout: vi.fn().mockResolvedValue(undefined),
    };
    e2bMocks.connect.mockResolvedValue(sandbox);
    const observations: unknown[] = [];

    const result = await createOrConnectSandbox({
      sandboxId: "sbx_existing",
      envs: {},
      idleTimeoutMs: 30_000,
      onLatency: (observation) => {
        observations.push(observation);
      },
    });

    expect(result).toBe(sandbox);
    expect(e2bMocks.connect).toHaveBeenCalledWith("sbx_existing", {
      timeoutMs: 3_600_000,
      requestTimeoutMs: 30_000,
    });
    expect(observations).toEqual([
      expect.objectContaining({
        operation: "connect",
        outcome: "success",
        sandboxId: "sbx_existing",
        requestedSandboxId: "sbx_existing",
        latencyMs: expect.any(Number),
      }),
    ]);
  });

  it("creates a replacement sandbox when the stored sandbox id is stale", async () => {
    const sandbox = {
      sandboxId: "sbx_replacement",
      setTimeout: vi.fn().mockResolvedValue(undefined),
    };
    e2bMocks.connect.mockRejectedValue(new Error("sandbox not found"));
    e2bMocks.create.mockResolvedValue(sandbox);
    const observations: unknown[] = [];

    const result = await createOrConnectSandbox({
      sandboxId: "sbx_missing",
      envs: {},
      idleTimeoutMs: 30_000,
      onLatency: (observation) => {
        observations.push(observation);
      },
    });

    expect(result).toBe(sandbox);
    expect(e2bMocks.create).toHaveBeenCalledWith({
      envs: {},
      timeoutMs: 30_000,
      lifecycle: { onTimeout: "pause", autoResume: true },
    });
    expect(observations).toEqual([
      expect.objectContaining({
        operation: "connect",
        outcome: "not_found",
        requestedSandboxId: "sbx_missing",
        latencyMs: expect.any(Number),
      }),
      expect.objectContaining({
        operation: "create",
        outcome: "success",
        sandboxId: "sbx_replacement",
        latencyMs: expect.any(Number),
      }),
    ]);
  });

  it("passes metadata to newly created sandboxes", async () => {
    const sandbox = {
      sandboxId: "sbx_new",
      setTimeout: vi.fn().mockResolvedValue(undefined),
    };
    e2bMocks.create.mockResolvedValue(sandbox);

    await createOrConnectSandbox({
      envs: {},
      metadata: { user_id: "user_123" },
      idleTimeoutMs: 30_000,
    });

    expect(e2bMocks.create).toHaveBeenCalledWith({
      envs: {},
      metadata: { user_id: "user_123" },
      timeoutMs: 30_000,
      lifecycle: { onTimeout: "pause", autoResume: true },
    });
  });
});

describe("getSandboxLifecycleStatus", () => {
  it("maps E2B running and paused states to UI statuses", async () => {
    e2bMocks.getInfo.mockResolvedValueOnce({ state: "running" });
    await expect(getSandboxLifecycleStatus("sbx_running")).resolves.toBe("running");

    e2bMocks.getInfo.mockResolvedValueOnce({ state: "paused" });
    await expect(getSandboxLifecycleStatus("sbx_sleeping")).resolves.toBe("sleeping");
  });

  it("maps missing sandboxes to deleted", async () => {
    e2bMocks.getInfo.mockRejectedValue(new Error("sandbox not found"));

    await expect(getSandboxLifecycleStatus("sbx_missing")).resolves.toBe("deleted");
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
  it("creates a capability-scoped workspace and root-owned metadata", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
      files: {
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    await prepareWorkspace({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      agentFile: '---\ntitle: "Agent"\n---\n\nInstructions',
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      [
        "mkdir -p '/home/user/workspace/agent' '/home/user/workspace/brain' '/home/user/workspace/work' '/home/user/.opencompany'",
        "git -C '/home/user/workspace/work' init -q",
        "chown -R user:user '/home/user/workspace'",
        "chown root:root '/home/user/.opencompany'",
        "chmod 700 '/home/user/.opencompany'",
      ].join(" && "),
      { user: "root", timeoutMs: 30_000 },
    );
    expect(sandbox.files.write).not.toHaveBeenCalled();
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("base64 -d > '/home/user/.opencompany/agent.agent'"),
      { user: "root", timeoutMs: 30_000 },
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("chmod 600 '/home/user/.opencompany/agent.agent'"),
      { user: "root", timeoutMs: 30_000 },
    );
    expect(
      sandbox.commands.run.mock.calls.some(([command]) => String(command).includes("git clone")),
    ).toBe(false);
  });

  it("wires the GitHub credential helper so plain git can authenticate", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
      files: {
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    await prepareWorkspace({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      agentFile: "agent",
    });

    expect(
      sandbox.commands.run.mock.calls.some(
        ([command]) =>
          String(command).includes("credential.https://github.com.helper") &&
          String(command).includes("!gh auth git-credential"),
      ),
    ).toBe(true);
  });

  it("creates the top-level Codex work root only for Codex engine sessions", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
      files: {
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    await prepareWorkspace({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      agentFile: "agent",
      createCodexRoot: true,
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("'/home/user/workspace/codex'"),
      { user: "root", timeoutMs: 30_000 },
    );
  });

  it("skips the GitHub credential helper when authenticated git is not needed", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
      files: {
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    await prepareWorkspace({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      agentFile: "agent",
      configureGitCredentialHelper: false,
    });

    expect(
      sandbox.commands.run.mock.calls.some(([command]) =>
        String(command).includes("credential.https://github.com.helper"),
      ),
    ).toBe(false);
  });

  it("does not install optional dev tooling during workspace preparation", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
      files: {
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    await prepareWorkspace({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      agentFile: "agent",
    });

    const commands = sandbox.commands.run.mock.calls.map(([command]) => String(command));
    expect(commands.some((command) => command.includes("command -v rg"))).toBe(false);
    expect(commands.some((command) => command.includes("command -v bun"))).toBe(false);
    expect(commands.some((command) => command.includes("apt-get install"))).toBe(false);
    expect(commands.some((command) => command.includes("bun.sh/install"))).toBe(false);
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

describe("writeSandboxTextFiles", () => {
  it("writes files with one bulk E2B request", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
      files: {
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    await writeSandboxTextFiles({
      sandbox: sandbox as never,
      user: "root",
      files: [
        { path: "/tmp/tree/a/one.txt", content: "one" },
        { path: "/tmp/tree/a/two.txt", content: "two" },
        { path: "/tmp/tree/b/three.txt", content: "three" },
        { path: "/tmp/tree/b/four.txt", content: "four" },
      ],
    });

    expect(sandbox.commands.run).not.toHaveBeenCalled();
    expect(sandbox.files.write).toHaveBeenCalledTimes(1);
    expect(sandbox.files.write).toHaveBeenCalledWith(
      [
        { path: "/tmp/tree/a/one.txt", data: "one" },
        { path: "/tmp/tree/a/two.txt", data: "two" },
        { path: "/tmp/tree/b/three.txt", data: "three" },
        { path: "/tmp/tree/b/four.txt", data: "four" },
      ],
      { user: "root" },
    );
  });
});

describe("cloneGitHubRepositoryIntoWorkdir", () => {
  const WORKDIR = "/home/user/workspace/work";

  it("clones the repository when no git checkout exists", async () => {
    const sandbox = createWorkspaceSandbox(["__opencompany_missing_git__\n"]);

    await cloneGitHubRepositoryIntoWorkdir({
      sandbox: sandbox as never,
      workdir: WORKDIR,
      repositoryFullName: "opencompany/app",
      defaultBranch: "main",
      githubToken: "ghs_token",
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("git remote get-url origin"),
      { timeoutMs: 30_000 },
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("clone --depth 1 --branch 'main'"),
      {
        envs: { GITHUB_AUTH_HEADER: expect.stringMatching(/^Authorization: Basic /) },
        timeoutMs: 120_000,
      },
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("-c http.extraheader"),
      {
        envs: { GITHUB_AUTH_HEADER: expect.stringMatching(/^Authorization: Basic /) },
        timeoutMs: 120_000,
      },
    );
    expect(
      sandbox.commands.run.mock.calls.some(([command]) =>
        String(command).includes("x-access-token"),
      ),
    ).toBe(false);
    expect(sandbox.commands.run).toHaveBeenCalledWith(expect.stringContaining(`'${WORKDIR}'`), {
      envs: { GITHUB_AUTH_HEADER: expect.stringMatching(/^Authorization: Basic /) },
      timeoutMs: 120_000,
    });
  });

  it("keeps an existing checkout when origin matches the repository", async () => {
    const sandbox = createWorkspaceSandbox(["https://github.com/opencompany/app.git\n"]);

    await cloneGitHubRepositoryIntoWorkdir({
      sandbox: sandbox as never,
      workdir: WORKDIR,
      repositoryFullName: "opencompany/app",
      defaultBranch: "main",
      githubToken: "ghs_token",
    });

    const commands = sandbox.commands.run.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(commands.some((command) => command.includes("git clone"))).toBe(false);
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("git remote set-url origin"),
      {
        envs: { GITHUB_AUTH_HEADER: expect.stringMatching(/^Authorization: Basic /) },
        timeoutMs: 30_000,
      },
    );
  });

  it("reclones when the existing checkout points at another repository", async () => {
    const sandbox = createWorkspaceSandbox(["https://github.com/opencompany/other.git\n"]);

    await cloneGitHubRepositoryIntoWorkdir({
      sandbox: sandbox as never,
      workdir: WORKDIR,
      repositoryFullName: "opencompany/app",
      defaultBranch: "develop",
      githubToken: "ghs_token",
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("clone --depth 1 --branch 'develop'"),
      {
        envs: { GITHUB_AUTH_HEADER: expect.stringMatching(/^Authorization: Basic /) },
        timeoutMs: 120_000,
      },
    );
  });

  it("adds searchable stage context to clone failures", async () => {
    const cloneError = new Error("exit status 128");
    cloneError.name = "CommandExitError";
    const sandbox = {
      commands: {
        run: vi.fn(async (command: string) => {
          if (command.includes("git remote get-url origin")) {
            return { stdout: "__opencompany_missing_git__\n", stderr: "", exitCode: 0 };
          }
          if (command.includes(" clone --depth")) throw cloneError;
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      },
      files: {
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    let caught: unknown;
    try {
      await cloneGitHubRepositoryIntoWorkdir({
        sandbox: sandbox as never,
        workdir: WORKDIR,
        repositoryFullName: "opencompany/app",
        defaultBranch: "main",
        githubToken: "ghs_token",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SandboxPreparationError);
    expect(sandboxPreparationErrorFields(caught)).toMatchObject({
      sandbox_stage: "clone_work_repository",
      sandbox_command: "git_clone",
      repository_full_name: "opencompany/app",
      repository_default_branch: "main",
      cause_name: "CommandExitError",
      cause_message: "exit status 128",
    });
  });
});

describe("resolveSandboxToolPath", () => {
  it("allows work, brain, and agent paths", () => {
    expect(resolveSandboxToolPath("/home/user/workspace", "work/foo.txt")).toBe(
      "/home/user/workspace/work/foo.txt",
    );
    expect(resolveSandboxToolPath("/home/user/workspace", "brain/foo.md")).toBe(
      "/home/user/workspace/brain/foo.md",
    );
    expect(resolveSandboxToolPath("/home/user/workspace", "agent/memory.md")).toBe(
      "/home/user/workspace/agent/memory.md",
    );
  });

  it("rejects paths outside configured tool roots", () => {
    for (const candidate of [
      ".opencompany/agent.agent",
      "../.opencompany/agent.agent",
      "/home/user/.opencompany/agent.agent",
      "notes.md",
      "agents/foo/agent.agent",
    ]) {
      expect(() => resolveSandboxToolPath("/home/user/workspace", candidate)).toThrow(
        /work\/, brain\/, or agent\//,
      );
    }
  });

  it("rejects skills paths for generic file tools", () => {
    expect(() =>
      resolveSandboxToolPath("/home/user/workspace", "skills/agent-self-edit/SKILL.md"),
    ).toThrow(/work\/, brain\/, or agent\//);
  });

  it("allows work and brain paths for generic file tools", () => {
    expect(resolveSandboxToolPath("/home/user/workspace", "work/foo.txt")).toBe(
      "/home/user/workspace/work/foo.txt",
    );
    expect(resolveSandboxToolPath("/home/user/workspace", "brain/foo.md")).toBe(
      "/home/user/workspace/brain/foo.md",
    );
  });

  it("personal sessions allow personal-brain/ but reject memory/ and the company brain/", () => {
    expect(() => resolveSandboxToolPath("/home/user/workspace", "memory/x.md", true)).toThrow(
      /work\/, personal-brain\/, or agent\//,
    );
    expect(resolveSandboxToolPath("/home/user/workspace", "personal-brain/note.md", true)).toBe(
      "/home/user/workspace/personal-brain/note.md",
    );
    expect(resolveSandboxToolPath("/home/user/workspace", "work/foo.txt", true)).toBe(
      "/home/user/workspace/work/foo.txt",
    );
    expect(resolveSandboxToolPath("/home/user/workspace", "agent/user.md", true)).toBe(
      "/home/user/workspace/agent/user.md",
    );
    expect(() => resolveSandboxToolPath("/home/user/workspace", "brain/foo.md", true)).toThrow(
      /work\/, personal-brain\/, or agent\//,
    );
  });

  it("personal sessions treat personal-brain/ as a plain writable path, not a gated brain", () => {
    expect(
      resolveSandboxBrainRelativePath("/home/user/workspace", "personal-brain/note.md", true),
    ).toBeNull();
    expect(() =>
      resolveSandboxBrainRelativePath("/home/user/workspace", "memory/x.md", true),
    ).toThrow(/work\/, personal-brain\/, or agent\//);
  });

  it("resolves brain-relative paths and ignores non-brain roots", () => {
    expect(resolveSandboxBrainRelativePath("/home/user/workspace", "brain/wiki/page.md")).toBe(
      "wiki/page.md",
    );
    expect(resolveSandboxBrainRelativePath("/home/user/workspace", "brain")).toBe("");
    expect(resolveSandboxBrainRelativePath("/home/user/workspace", "brain/")).toBe("");
    expect(resolveSandboxBrainRelativePath("/home/user/workspace", "work/foo.txt")).toBeNull();
    expect(resolveSandboxBrainRelativePath("/home/user/workspace", "agent/memory.md")).toBeNull();
    expect(() => resolveSandboxBrainRelativePath("/home/user/workspace", "notes.md")).toThrow(
      /work\/, brain\/, or agent\//,
    );
  });

  it("resolves skill file paths only inside the requested skill directory", () => {
    expect(resolveSandboxSkillPath("/home/user/workspace", "agent-self-edit", undefined)).toBe(
      "/home/user/workspace/skills/agent-self-edit/SKILL.md",
    );
    expect(
      resolveSandboxSkillPath("/home/user/workspace", "agent-self-edit", "references/help.md"),
    ).toBe("/home/user/workspace/skills/agent-self-edit/references/help.md");
    expect(() =>
      resolveSandboxSkillPath("/home/user/workspace", "agent-self-edit", "../other/SKILL.md"),
    ).toThrow(/relative file path/);
    expect(() =>
      resolveSandboxSkillPath("/home/user/workspace", "agent-self-edit", "refs/../SKILL.md"),
    ).toThrow(/relative file path/);
    expect(() =>
      resolveSandboxSkillPath("/home/user/workspace", "agent/self-edit", "SKILL.md"),
    ).toThrow(/valid mounted skill id/);
  });
});

describe("runSandboxTool", () => {
  it("runs shell commands from the session work directory", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "done", stderr: "", exitCode: 0 }),
      },
    };

    await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "shell",
      args: { command: "pwd" },
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "pwd",
      expect.objectContaining({ cwd: sandboxLayout("/home/user/workspace").workspaceRoot }),
    );
  });

  it("passes shell envs and redacts streamed and returned shell output", async () => {
    const onOutput = vi.fn();
    const sandbox = {
      commands: {
        run: vi.fn(async (_command: string, options: { onStdout?: (data: string) => void }) => {
          options.onStdout?.("token=github_token_123\n");
          return { stdout: "done github_token_123", stderr: "err github_token_123", exitCode: 0 };
        }),
      },
    };

    const result = await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "shell",
      args: { command: "gh auth status" },
      envs: { GH_TOKEN: "github_token_123" },
      redactOutput: (value) => value.replaceAll("github_token_123", "[redacted]"),
      onOutput,
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "gh auth status",
      expect.objectContaining({
        cwd: sandboxLayout("/home/user/workspace").workspaceRoot,
        envs: { GH_TOKEN: "github_token_123" },
      }),
    );
    expect(onOutput).toHaveBeenCalledWith("stdout", "token=[redacted]\n");
    expect(result).toEqual({
      stdout: "done [redacted]",
      stderr: "err [redacted]",
      exitCode: 0,
    });
  });

  it("rejects personal shell commands that reference memory/", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
    };

    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: "/home/user/workspace",
        name: "shell",
        args: { command: "cat memory/profile.md" },
        personal: true,
      }),
    ).rejects.toThrow(/Shell commands cannot access memory\/.*memory tool/);
    expect(sandbox.commands.run).not.toHaveBeenCalled();
  });

  it("rejects personal shell commands that reference the absolute memory root", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
    };

    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: "/home/user/workspace",
        name: "shell",
        args: { command: "ls /home/user/workspace/memory" },
        personal: true,
      }),
    ).rejects.toThrow(/Shell commands cannot access memory\/.*memory tool/);
    expect(sandbox.commands.run).not.toHaveBeenCalled();
  });

  it("returns shell nonzero exit output instead of throwing", async () => {
    const sandbox = {
      commands: {
        run: vi.fn(async () => {
          throw Object.assign(new Error("exit status 1"), {
            name: "CommandExitError",
            stdout: "partial output",
            stderr: "fatal: not a git repository\n",
            exitCode: 1,
          });
        }),
      },
    };

    const result = await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "shell",
      args: { command: "git status" },
    });

    expect(result).toEqual({
      stdout: "partial output",
      stderr: "fatal: not a git repository\n",
      exitCode: 1,
    });
  });

  it("rejects with the stream-callback error instead of leaking an unhandled rejection", async () => {
    // Regression for the 2026-06-10 prod crash: e2b fires onStdout WITHOUT awaiting it,
    // so a rejecting async callback (the run-control gate throwing RunAbortError on Stop)
    // became an unhandled rejection that exited the whole runner process. The guarded
    // callbacks must never reject; the error must surface from the awaited tool call.
    const abortError = Object.assign(new Error("Run aborted."), { name: "RunAbortError" });
    const sandbox = {
      commands: {
        run: vi.fn(async (_command: string, options: { onStdout?: (data: string) => void }) => {
          // Fire-and-forget, exactly like e2b's CommandHandle.handleEvents. If this
          // returned promise could reject, the test run itself would crash.
          options.onStdout?.("chunk\n");
          return { stdout: "done", stderr: "", exitCode: 0 };
        }),
      },
    };

    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: "/home/user/workspace",
        name: "shell",
        args: { command: "sleep 5" },
        onOutput: async () => {
          throw abortError;
        },
      }),
    ).rejects.toBe(abortError);
  });

  it("runs gh commands from the work directory with injected auth and redaction", async () => {
    const onOutput = vi.fn();
    const sandbox = {
      commands: {
        run: vi.fn(async (_command: string, options: { onStderr?: (data: string) => void }) => {
          options.onStderr?.("using github_token_123\n");
          return { stdout: "ok github_token_123", stderr: "", exitCode: 0 };
        }),
      },
    };

    const result = await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "gh",
      args: { args: "pr create --fill" },
      envs: { GH_TOKEN: "github_token_123" },
      redactOutput: (value) => value.replaceAll("github_token_123", "[redacted]"),
      onOutput,
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "gh 'pr' 'create' '--fill'",
      expect.objectContaining({
        cwd: sandboxLayout("/home/user/workspace").workRoot,
        envs: { GH_TOKEN: "github_token_123" },
      }),
    );
    expect(onOutput).toHaveBeenCalledWith("stderr", "using [redacted]\n");
    expect(result).toEqual({ stdout: "ok [redacted]", stderr: "", exitCode: 0 });
  });

  it("does not attach a permissionHint to a successful gh command that merely echoes the 403 phrase", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({
          // A successful `gh issue view`/`gh pr view` whose body quotes the phrase must not be
          // mistaken for a permission denial.
          stdout: "Body: we hit a 403 Resource not accessible by integration last week",
          stderr: "",
          exitCode: 0,
        }),
      },
    };

    const result = (await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "gh",
      args: { args: "issue view 339" },
    })) as { permissionHint?: string };

    expect(result.permissionHint).toBeUndefined();
  });

  it("attaches a permissionHint when a gh command fails with the 403 permission error", async () => {
    const sandbox = {
      commands: {
        run: vi.fn(async () => {
          throw Object.assign(new Error("exit status 1"), {
            name: "CommandExitError",
            stdout: "",
            stderr: "GraphQL: Resource not accessible by integration (createIssue)",
            exitCode: 1,
          });
        }),
      },
    };

    const result = (await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "gh",
      args: { args: "issue create --title T" },
    })) as { exitCode: number | null; permissionHint?: string };

    expect(result.exitCode).toBe(1);
    expect(result.permissionHint).toMatch(/Issues: Read/);
  });

  it("attaches an operation-aware permissionHint for failed gh commands", async () => {
    const sandbox = {
      commands: {
        run: vi.fn(async () => {
          throw Object.assign(new Error("exit status 1"), {
            name: "CommandExitError",
            stdout: "",
            stderr: "HTTP 403: Resource not accessible by integration",
            exitCode: 1,
          });
        }),
      },
    };

    const result = (await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "gh",
      args: { args: "run list" },
    })) as { exitCode: number | null; permissionHint?: string };

    expect(result.exitCode).toBe(1);
    expect(result.permissionHint).toMatch(/Actions: Read/);
    expect(result.permissionHint).not.toMatch(/Issues: Read/);
  });

  it("quotes parsed gh arguments before dispatching through the sandbox shell", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
    };

    await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "gh",
      args: { args: "pr list && rm -rf work" },
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "gh 'pr' 'list' '&&' 'rm' '-rf' 'work'",
      expect.objectContaining({ cwd: sandboxLayout("/home/user/workspace").workRoot }),
    );
  });

  it("rejects malformed gh arguments before dispatching", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
    };

    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: "/home/user/workspace",
        name: "gh",
        args: { args: "pr view 'unterminated" },
      }),
    ).rejects.toThrow(/empty or malformed/);
    expect(sandbox.commands.run).not.toHaveBeenCalled();
  });

  it("returns gh nonzero exit output instead of throwing", async () => {
    const sandbox = {
      commands: {
        run: vi.fn(async () => {
          throw Object.assign(new Error("exit status 1"), {
            name: "CommandExitError",
            stdout: "",
            stderr: "failed to determine repository\n",
            exitCode: 1,
          });
        }),
      },
    };

    const result = await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "gh",
      args: { args: "pr list" },
    });

    expect(result).toEqual({
      stdout: "",
      stderr: "failed to determine repository\n",
      exitCode: 1,
    });
  });

  it("runs the memory CLI from the workspace root with the gateway key scoped to the subprocess", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "1. [company] acme", stderr: "", exitCode: 0 }),
      },
    };

    await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "memory",
      args: { args: 'query "acme blockers" --limit 5' },
      envs: { VERCEL_AI_GATEWAY_API_KEY: "gw_secret_key" },
      redactOutput: (value) => value.replaceAll("gw_secret_key", "[redacted]"),
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "node '/home/user/workspace/skills/memory/memory.mjs' 'query' 'acme blockers' '--limit' '5' --report-usage",
      expect.objectContaining({
        cwd: sandboxLayout("/home/user/workspace").workspaceRoot,
        // MEMORY_ROOT pins the memory tree so an agent-supplied `--root` is ignored by the CLI.
        envs: {
          VERCEL_AI_GATEWAY_API_KEY: "gw_secret_key",
          MEMORY_ROOT: "/home/user/workspace/agent/memory",
        },
      }),
    );
  });

  it("pins MEMORY_ROOT to the top-level memory/ tree for personal sessions", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
    };

    await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "memory",
      args: { args: "query foo" },
      personal: true,
      envs: { VERCEL_AI_GATEWAY_API_KEY: "gw_secret_key" },
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        envs: expect.objectContaining({ MEMORY_ROOT: "/home/user/workspace/memory" }),
      }),
    );
  });

  it("shell-quotes memory args so a crafted arg cannot break out or read the key", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
    };

    await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "memory",
      args: { args: "query foo; env > /tmp/leak" },
      envs: { VERCEL_AI_GATEWAY_API_KEY: "gw_secret_key" },
    });

    const [command] = sandbox.commands.run.mock.calls[0] as [string, unknown];
    // Each crafted token is quoted, so the shell never interprets ; or > as operators.
    expect(command).toBe(
      "node '/home/user/workspace/skills/memory/memory.mjs' 'query' 'foo;' 'env' '>' '/tmp/leak' --report-usage",
    );
    // The key only ever reaches the subprocess env, never the command string the agent shaped.
    expect(command).not.toContain("gw_secret_key");
  });

  it("redacts the gateway key from streamed and returned memory output", async () => {
    const onOutput = vi.fn();
    const sandbox = {
      commands: {
        run: vi.fn(async (_command: string, options: { onStderr?: (data: string) => void }) => {
          options.onStderr?.("calling gateway gw_secret_key\n");
          return { stdout: "ok gw_secret_key", stderr: "warn gw_secret_key", exitCode: 0 };
        }),
      },
    };

    const result = await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "memory",
      args: { args: "query acme" },
      envs: { VERCEL_AI_GATEWAY_API_KEY: "gw_secret_key" },
      redactOutput: (value) => value.replaceAll("gw_secret_key", "[redacted]"),
      onOutput,
    });

    expect(onOutput).toHaveBeenCalledWith("stderr", "calling gateway [redacted]\n");
    expect(result).toEqual({
      stdout: "ok [redacted]",
      stderr: "warn [redacted]",
      exitCode: 0,
    });
  });

  it("rejects malformed memory arguments before dispatching", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
    };

    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: "/home/user/workspace",
        name: "memory",
        args: { args: "query 'unterminated" },
      }),
    ).rejects.toThrow(/empty or malformed/);
    expect(sandbox.commands.run).not.toHaveBeenCalled();
  });

  it("creates parent directories before writing nested files", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
      files: {
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "write_file",
      args: { path: "work/sub/new/file.txt", content: "content" },
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "mkdir -p '/home/user/workspace/work/sub/new'",
      { timeoutMs: 30_000 },
    );
    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/work/sub/new/file.txt",
      "content",
    );
  });

  it("reads mounted skill files through read_skill", async () => {
    const sandbox = {
      files: {
        read: vi.fn().mockResolvedValue("---\nname: agent-self-edit\n---\n"),
      },
    };

    const result = await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "read_skill",
      args: { skillId: "agent-self-edit" },
    });

    expect(sandbox.files.read).toHaveBeenCalledWith(
      "/home/user/workspace/skills/agent-self-edit/SKILL.md",
    );
    expect(result).toEqual({
      path: "skills/agent-self-edit/SKILL.md",
      content: "---\nname: agent-self-edit\n---\n",
    });
  });

  it("rejects invalid read_skill paths and missing files", async () => {
    const sandbox = {
      files: {
        read: vi.fn().mockRejectedValue(new Error("not found")),
      },
    };

    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: "/home/user/workspace",
        name: "read_skill",
        args: { skillId: "agent-self-edit", path: "/SKILL.md" },
      }),
    ).rejects.toThrow(/relative file path/);

    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: "/home/user/workspace",
        name: "read_skill",
        args: { skillId: "agent-self-edit", path: "missing.md" },
      }),
    ).rejects.toThrow(/Skill file not found/);
  });

  it("applies ordered exact edits atomically", async () => {
    const sandbox = {
      files: {
        read: vi.fn().mockResolvedValue("one\ntwo\nthree\n"),
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "edit_file",
      args: {
        path: "work/file.txt",
        instructions: "Update two lines.",
        edits: [
          { oldString: "one", newString: "ONE" },
          { oldString: "three", newString: "THREE" },
        ],
      },
    });

    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/work/file.txt",
      "ONE\ntwo\nTHREE\n",
    );
    expect(result).toEqual({
      path: "work/file.txt",
      editsApplied: 2,
      replacements: 2,
      bytes: 14,
    });
  });

  it("supports replacing every exact occurrence", async () => {
    const sandbox = {
      files: {
        read: vi.fn().mockResolvedValue("alpha beta alpha"),
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "edit_file",
      args: {
        path: "work/file.txt",
        instructions: "Rename alpha.",
        edits: [{ oldString: "alpha", newString: "omega", replaceAll: true }],
      },
    });

    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/work/file.txt",
      "omega beta omega",
    );
    expect(result).toMatchObject({ replacements: 2 });
  });

  it("rejects ambiguous edits without writing", async () => {
    const sandbox = {
      files: {
        read: vi.fn().mockResolvedValue("alpha beta alpha"),
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: "/home/user/workspace",
        name: "edit_file",
        args: {
          path: "work/file.txt",
          instructions: "Rename one alpha.",
          edits: [{ oldString: "alpha", newString: "omega" }],
        },
      }),
    ).rejects.toThrow(/matched 2 times/);
    expect(sandbox.files.write).not.toHaveBeenCalled();
  });

  it("rejects missing edit matches without writing earlier edits", async () => {
    const sandbox = {
      files: {
        read: vi.fn().mockResolvedValue("one\ntwo\nthree\n"),
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: "/home/user/workspace",
        name: "edit_file",
        args: {
          path: "work/file.txt",
          instructions: "Apply multiple edits.",
          edits: [
            { oldString: "one", newString: "ONE" },
            { oldString: "missing", newString: "MISSING" },
          ],
        },
      }),
    ).rejects.toThrow(/oldString was not found/);
    expect(sandbox.files.write).not.toHaveBeenCalled();
  });

  it("rejects empty oldString edits", async () => {
    const sandbox = {
      files: {
        read: vi.fn().mockResolvedValue("content"),
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: "/home/user/workspace",
        name: "edit_file",
        args: {
          path: "work/file.txt",
          instructions: "Invalid edit.",
          edits: [{ oldString: "", newString: "content" }],
        },
      }),
    ).rejects.toThrow(/oldString must not be empty/);
    expect(sandbox.files.write).not.toHaveBeenCalled();
  });

  it("requires edit_file instructions", async () => {
    const sandbox = {
      files: {
        read: vi.fn().mockResolvedValue("content"),
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: "/home/user/workspace",
        name: "edit_file",
        args: {
          path: "work/file.txt",
          edits: [{ oldString: "content", newString: "updated" }],
        },
      }),
    ).rejects.toThrow(/Tool argument instructions must be a string/);
    expect(sandbox.files.read).not.toHaveBeenCalled();
    expect(sandbox.files.write).not.toHaveBeenCalled();
  });

  it("rejects no-op edit results", async () => {
    const sandbox = {
      files: {
        read: vi.fn().mockResolvedValue("content"),
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: "/home/user/workspace",
        name: "edit_file",
        args: {
          path: "work/file.txt",
          instructions: "No-op edit.",
          edits: [{ oldString: "content", newString: "content" }],
        },
      }),
    ).rejects.toThrow(/No changes made/);
    expect(sandbox.files.write).not.toHaveBeenCalled();
  });

  it("tells the model to use write_file when editing a missing file", async () => {
    const sandbox = {
      files: {
        read: vi.fn().mockRejectedValue(new Error("not found")),
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: "/home/user/workspace",
        name: "edit_file",
        args: {
          path: "work/missing.txt",
          instructions: "Edit missing file.",
          edits: [{ oldString: "old", newString: "new" }],
        },
      }),
    ).rejects.toThrow(/Use write_file to create new files/);
    expect(sandbox.files.write).not.toHaveBeenCalled();
  });

  it("lists files from the requested tool root using the workspace cwd", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "work\nwork/a.txt\n", stderr: "", exitCode: 0 }),
      },
    };

    const result = await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "list_files",
      args: {},
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "find 'work' -maxdepth 2 -print | sort | head -200",
      { cwd: "/home/user/workspace", timeoutMs: 30_000 },
    );
    expect(result).toEqual({ path: "work", entries: ["work", "work/a.txt"] });
  });

  it("returns the scratch diff from the session work git repo including untracked files", async () => {
    const workdir = await createTempWorkdir();
    const sandbox = {
      commands: {
        run: vi.fn(runLocalCommand),
      },
    };
    await writeFile(`${workdir}/work/a.txt`, "hello\n");

    const result = await runSandboxTool({
      sandbox: sandbox as never,
      workdir,
      name: "git_diff",
      args: {},
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining(`WORK='${workdir}/work'`),
      { timeoutMs: 60_000 },
    );
    const diff = readDiffOutput(result);
    expect(diff).toContain("--- work/ ---");
    expect(diff).toContain("?? a.txt");
    expect(diff).toContain("hello");
  });

  it("returns the root checkout diff when work itself is a cloned repo", async () => {
    const workdir = await createTempWorkdir();
    const sandbox = {
      commands: {
        run: vi.fn(runLocalCommand),
      },
    };
    await execFileAsync("git", [
      "-C",
      `${workdir}/work`,
      "config",
      "user.email",
      "test@example.com",
    ]);
    await execFileAsync("git", ["-C", `${workdir}/work`, "config", "user.name", "Test User"]);
    await writeFile(`${workdir}/work/tracked.txt`, "before\n");
    await execFileAsync("git", ["-C", `${workdir}/work`, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", `${workdir}/work`, "commit", "-m", "initial"]);
    await writeFile(`${workdir}/work/tracked.txt`, "after\n");

    const result = await runSandboxTool({
      sandbox: sandbox as never,
      workdir,
      name: "git_diff",
      args: {},
    });

    const diff = readDiffOutput(result);
    expect(diff).toContain("--- work/ ---");
    expect(diff).toContain(" M tracked.txt");
    expect(diff).toContain("-before");
    expect(diff).toContain("+after");
  });

  it("includes staged root checkout changes in the git diff", async () => {
    const workdir = await createTempWorkdir();
    const sandbox = {
      commands: {
        run: vi.fn(runLocalCommand),
      },
    };
    await execFileAsync("git", [
      "-C",
      `${workdir}/work`,
      "config",
      "user.email",
      "test@example.com",
    ]);
    await execFileAsync("git", ["-C", `${workdir}/work`, "config", "user.name", "Test User"]);
    await writeFile(`${workdir}/work/tracked.txt`, "before\n");
    await execFileAsync("git", ["-C", `${workdir}/work`, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", `${workdir}/work`, "commit", "-m", "initial"]);
    await writeFile(`${workdir}/work/tracked.txt`, "after\n");
    await execFileAsync("git", ["-C", `${workdir}/work`, "add", "tracked.txt"]);

    const result = await runSandboxTool({
      sandbox: sandbox as never,
      workdir,
      name: "git_diff",
      args: {},
    });

    const diff = readDiffOutput(result);
    expect(diff).toContain("--- work/ ---");
    expect(diff).toContain("M  tracked.txt");
    expect(diff).toContain("-before");
    expect(diff).toContain("+after");
  });

  it("returns immediate child repository diffs without reporting the child as scratch", async () => {
    const workdir = await createTempWorkdir();
    const sandbox = {
      commands: {
        run: vi.fn(runLocalCommand),
      },
    };
    await mkdir(`${workdir}/work/app`);
    await execFileAsync("git", ["-C", `${workdir}/work/app`, "init", "-q"]);
    await writeFile(`${workdir}/work/app/new.txt`, "nested\n");

    const result = await runSandboxTool({
      sandbox: sandbox as never,
      workdir,
      name: "git_diff",
      args: {},
    });

    const diff = readDiffOutput(result);
    expect(diff).not.toContain("--- work/ ---");
    expect(diff).not.toContain("?? app/");
    expect(diff).toContain("--- work/app/ ---");
    expect(diff).toContain("?? new.txt");
    expect(diff).toContain("nested");
  });
});

describe("guardCommandStreamCallbacks", () => {
  it("captures the first callback rejection, drops later chunks, and rethrows at the boundary", async () => {
    const seen: string[] = [];
    const failure = new Error("Run aborted.");
    const guarded = guardCommandStreamCallbacks({
      onStdout: async (data: string) => {
        if (data === "boom") throw failure;
        seen.push(data);
      },
    });

    // The wrapped callback must never reject — that is the whole point.
    await expect(guarded.options.onStdout?.("a")).resolves.toBeUndefined();
    await expect(guarded.options.onStdout?.("boom")).resolves.toBeUndefined();
    await expect(guarded.options.onStdout?.("b")).resolves.toBeUndefined();

    expect(seen).toEqual(["a"]);
    await expect(guarded.rethrow()).rejects.toBe(failure);
  });

  it("observes a rejection from a fire-and-forget invocation still in flight", async () => {
    // e2b invokes the callback without awaiting it, possibly in the same tick the command
    // result resolves — rethrow must wait for in-flight invocations before deciding.
    const failure = new Error("Run aborted.");
    const guarded = guardCommandStreamCallbacks({
      onStdout: async (_data: string) => {
        await Promise.resolve();
        throw failure;
      },
    });

    void guarded.options.onStdout?.("chunk");
    await expect(guarded.rethrow()).rejects.toBe(failure);
  });

  it("captures stderr failures too and is a no-op when callbacks succeed", async () => {
    const failure = new Error("stderr failed");
    const failing = guardCommandStreamCallbacks({
      onStdout: async (_data: string) => undefined,
      onStderr: async (_data: string) => {
        throw failure;
      },
    });
    await failing.options.onStderr?.("err");
    await expect(failing.rethrow()).rejects.toBe(failure);

    const healthy = guardCommandStreamCallbacks({
      onStdout: async (_data: string) => undefined,
    });
    await healthy.options.onStdout?.("ok");
    await expect(healthy.rethrow()).resolves.toBeUndefined();
  });
});

describe("commandExitResult", () => {
  it("normalizes nested E2B command exit results", () => {
    expect(
      commandExitResult({
        name: "CommandExitError",
        message: "exit status 1",
        result: {
          exitCode: 1,
          stdout: '{"type":"error","message":"upstream_not_configured"}\n',
          stderr: "Reading additional input from stdin...\n",
        },
      }),
    ).toEqual({
      exitCode: 1,
      stdout: '{"type":"error","message":"upstream_not_configured"}\n',
      stderr: "Reading additional input from stdin...\n",
    });
  });

  it("keeps compatibility with flat command exit results", () => {
    expect(
      commandExitResult({
        name: "CommandExitError",
        exitCode: 2,
        stdout: "out",
        stderr: "err",
      }),
    ).toEqual({
      exitCode: 2,
      stdout: "out",
      stderr: "err",
    });
  });

  it("normalizes CommandExitError objects that expose command output through getters", () => {
    const error = Object.create({
      get exitCode() {
        return 1;
      },
      get stdout() {
        return "getter out";
      },
      get stderr() {
        return "getter err";
      },
    }) as { name: string };
    error.name = "CommandExitError";

    expect(commandExitResult(error)).toEqual({
      exitCode: 1,
      stdout: "getter out",
      stderr: "getter err",
    });
  });
});

async function createTempWorkdir() {
  const workdir = await mkdtemp(`${os.tmpdir()}/opencompany-sandbox-test-`);
  await mkdir(`${workdir}/work`);
  await execFileAsync("git", ["-C", `${workdir}/work`, "init", "-q"]);
  return workdir;
}

function readDiffOutput(value: unknown) {
  if (value && typeof value === "object" && "diff" in value && typeof value.diff === "string") {
    return value.diff;
  }
  throw new Error("Expected git_diff output.");
}

async function runLocalCommand(command: string) {
  const result = await execFileAsync("bash", ["-lc", command], {
    maxBuffer: 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
}

function createWorkspaceSandbox(stdout: string[]) {
  return {
    commands: {
      run: vi.fn(async (command: string) => ({
        stdout: command.includes("git remote get-url origin") ? (stdout.shift() ?? "") : "",
        stderr: "",
        exitCode: 0,
      })),
    },
    files: {
      write: vi.fn(async () => undefined),
    },
  };
}
