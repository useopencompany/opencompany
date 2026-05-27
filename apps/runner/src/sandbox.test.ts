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
  resolveSandboxToolPath,
  runSandboxTool,
  sandboxLayout,
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
        "mkdir -p '/home/user/workspace/brain' '/home/user/workspace/work' '/home/user/.opencompany'",
        "chown -R user:user '/home/user/workspace'",
        "chown root:root '/home/user/.opencompany'",
        "chmod 700 '/home/user/.opencompany'",
      ].join(" && "),
      { user: "root", timeoutMs: 30_000 },
    );
    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/.opencompany/agent.agent",
      '---\ntitle: "Agent"\n---\n\nInstructions',
      { user: "root", requestTimeoutMs: 30_000 },
    );
    expect(
      sandbox.commands.run.mock.calls.some(([command]) => String(command).includes("git clone")),
    ).toBe(false);
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "git -C '/home/user/workspace/work' init -q",
      {
        user: "user",
        timeoutMs: 30_000,
      },
    );
  });

  it("clones the configured repository into work when no git checkout exists", async () => {
    const sandbox = createWorkspaceSandbox(["__opencompany_missing_git__\n"]);

    await prepareWorkspace({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      agentFile: '---\ntitle: "Agent"\n---\n\nInstructions',
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
      expect.stringContaining("clone --depth 1 --branch 'main'"),
      { envs: { GITHUB_TOKEN: "ghs_token" }, timeoutMs: 120_000 },
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("-c http.extraheader"),
      { envs: { GITHUB_TOKEN: "ghs_token" }, timeoutMs: 120_000 },
    );
    expect(
      sandbox.commands.run.mock.calls.some(([command]) =>
        String(command).includes("x-access-token"),
      ),
    ).toBe(false);
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("'/home/user/workspace/work'"),
      { envs: { GITHUB_TOKEN: "ghs_token" }, timeoutMs: 120_000 },
    );
    expect(
      sandbox.commands.run.mock.calls.some(([command]) => String(command).includes("git -C")),
    ).toBe(false);
    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/.opencompany/agent.agent",
      '---\ntitle: "Agent"\n---\n\nInstructions',
      { user: "root", requestTimeoutMs: 30_000 },
    );
  });

  it("keeps an existing checkout when origin matches the configured repository", async () => {
    const sandbox = createWorkspaceSandbox(["https://github.com/opencompany/app.git\n"]);

    await prepareWorkspace({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      agentFile: '---\ntitle: "Agent"\n---\n\nInstructions',
      repositoryFullName: "opencompany/app",
      repositoryDefaultBranch: "main",
      githubToken: "ghs_token",
    });

    const commands = sandbox.commands.run.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(commands.some((command) => command.includes("git clone"))).toBe(false);
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("git remote set-url origin"),
      { envs: { GITHUB_TOKEN: "ghs_token" }, timeoutMs: 30_000 },
    );
  });

  it("reclones when the existing checkout points at another repository", async () => {
    const sandbox = createWorkspaceSandbox(["https://github.com/opencompany/other.git\n"]);

    await prepareWorkspace({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      agentFile: '---\ntitle: "Agent"\n---\n\nInstructions',
      repositoryFullName: "opencompany/app",
      repositoryDefaultBranch: "develop",
      githubToken: "ghs_token",
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("clone --depth 1 --branch 'develop'"),
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

describe("resolveSandboxToolPath", () => {
  it("allows work and brain paths", () => {
    expect(resolveSandboxToolPath("/home/user/workspace", "work/foo.txt")).toBe(
      "/home/user/workspace/work/foo.txt",
    );
    expect(resolveSandboxToolPath("/home/user/workspace", "brain/foo.md")).toBe(
      "/home/user/workspace/brain/foo.md",
    );
  });

  it("rejects paths outside configured tool roots", () => {
    for (const candidate of [
      ".opencompany/agent.agent",
      "../.opencompany/agent.agent",
      "/home/user/.opencompany/agent.agent",
      "notes.md",
      "agents/foo.agent",
    ]) {
      expect(() => resolveSandboxToolPath("/home/user/workspace", candidate)).toThrow(
        /work\/ or brain\//,
      );
    }
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

  it("returns the diff from the session work git repo including untracked files", async () => {
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "diff --git a/a.txt b/a.txt\n", stderr: "" }),
      },
    };

    const result = await runSandboxTool({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      name: "git_diff",
      args: {},
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      [
        "git -C '/home/user/workspace/work' diff --",
        "git -C '/home/user/workspace/work' ls-files --others --exclude-standard | while IFS= read -r file; do git -C '/home/user/workspace/work' diff --no-index -- /dev/null \"$file\" || true; done",
      ].join(" && "),
      { timeoutMs: 60_000 },
    );
    expect(result).toEqual({ diff: "diff --git a/a.txt b/a.txt\n", stderr: "" });
  });
});

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
