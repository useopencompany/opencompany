import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createMessageHandler, type SessionGrants } from "./daemon";
import type { BridgeExecutor } from "./executor";
import type { RunnerToDaemonMessage } from "./protocol";
import { type BridgeSettings, loadSettings, saveSettings } from "./settings";

const HOME = homedir();
const tmp = mkdtempSync(join(tmpdir(), "oc-bridge-daemon-"));
const settingsFile = join(tmp, "bridge-settings.json");

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeSettings(overrides: Partial<BridgeSettings> = {}): void {
  saveSettings({ mode: "ask", allow: [], deny: [], ...overrides }, settingsFile);
}

type ExecutorCall = { tool: string; args: unknown };

function fakeExecutor(behavior: Partial<BridgeExecutor> = {}): {
  executor: BridgeExecutor;
  calls: ExecutorCall[];
} {
  const calls: ExecutorCall[] = [];
  const executor: BridgeExecutor = {
    local_shell: async (args) => {
      calls.push({ tool: "local_shell", args });
      return { stdout: "fake-stdout", stderr: "", exitCode: 0 };
    },
    local_read_file: async (args) => {
      calls.push({ tool: "local_read_file", args });
      return { content: "fake-content" };
    },
    local_write_file: async (args) => {
      calls.push({ tool: "local_write_file", args });
      return { path: args.path, bytesWritten: 1 };
    },
    local_list_files: async (args) => {
      calls.push({ tool: "local_list_files", args });
      return { entries: [] };
    },
    ...behavior,
  };
  return { executor, calls };
}

function makeHandler(behavior: Partial<BridgeExecutor> = {}) {
  const { executor, calls } = fakeExecutor(behavior);
  const sessionGrants: SessionGrants = new Map();
  const handler = createMessageHandler({
    loadSettings: () => loadSettings(settingsFile),
    sessionGrants,
    executor,
    settingsPath: settingsFile,
  });
  return { handler, calls, sessionGrants };
}

function shellExecute(
  command: string,
  extra: Partial<Extract<RunnerToDaemonMessage, { kind: "execute" }>> = {},
): RunnerToDaemonMessage {
  return {
    kind: "execute",
    id: "msg_1",
    sessionId: "ses_1",
    tool: "local_shell",
    args: { command },
    ...extra,
  };
}

beforeEach(() => {
  writeSettings();
});

describe("ping", () => {
  it("answers with pong and the same id", async () => {
    const { handler } = makeHandler();
    expect(await handler({ kind: "ping", id: "msg_9" })).toEqual({ kind: "pong", id: "msg_9" });
  });
});

describe("check", () => {
  it("returns an allow verdict with the matching rule and summary", async () => {
    writeSettings({ allow: ["shell(git *)"] });
    const { handler } = makeHandler();
    const response = await handler({
      kind: "check",
      id: "msg_1",
      sessionId: "ses_1",
      tool: "local_shell",
      args: { command: "git status" },
    });
    expect(response).toEqual({
      kind: "verdict",
      id: "msg_1",
      verdict: "allow",
      rule: "shell(git *)",
      summary: "git status",
    });
  });

  it("returns a deny verdict with the matching deny rule", async () => {
    writeSettings({ deny: ["read(~/.ssh/**)"] });
    const { handler } = makeHandler();
    const response = await handler({
      kind: "check",
      id: "msg_2",
      sessionId: "ses_1",
      tool: "local_read_file",
      args: { path: "~/.ssh/id_rsa" },
    });
    expect(response).toEqual({
      kind: "verdict",
      id: "msg_2",
      verdict: "deny",
      rule: "read(~/.ssh/**)",
      summary: join(HOME, ".ssh", "id_rsa"),
    });
  });

  it("returns ask when nothing matches", async () => {
    const { handler } = makeHandler();
    const response = await handler({
      kind: "check",
      id: "msg_3",
      sessionId: "ses_1",
      tool: "local_shell",
      args: { command: "rm -rf /" },
    });
    expect(response).toEqual({ kind: "verdict", id: "msg_3", verdict: "ask", summary: "rm -rf /" });
  });

  it("sees session grants from earlier approvals", async () => {
    const { handler, sessionGrants } = makeHandler();
    sessionGrants.set("ses_1", ["shell(git status)"]);
    const response = await handler({
      kind: "check",
      id: "msg_4",
      sessionId: "ses_1",
      tool: "local_shell",
      args: { command: "git status" },
    });
    expect(response).toMatchObject({ verdict: "allow", rule: "shell(git status)" });
  });

  it("denies an unknown tool name", async () => {
    const { handler } = makeHandler();
    const response = await handler({
      kind: "check",
      id: "msg_5",
      sessionId: "ses_1",
      tool: "local_format_disk" as never,
      args: {},
    });
    expect(response).toMatchObject({ kind: "verdict", id: "msg_5", verdict: "deny" });
  });
});

describe("execute without a grant", () => {
  it("runs when an allow rule matches and reports allowed_by_rule", async () => {
    writeSettings({ allow: ["shell(git *)"] });
    const { handler, calls } = makeHandler();
    const response = await handler(shellExecute("git status"));
    expect(response).toEqual({
      kind: "result",
      id: "msg_1",
      ok: true,
      output: { stdout: "fake-stdout", stderr: "", exitCode: 0 },
      decision: "allowed_by_rule",
      summary: "git status",
    });
    expect(calls).toEqual([{ tool: "local_shell", args: { command: "git status" } }]);
  });

  it("reports allowed_by_mode when only allow-everything permitted it", async () => {
    writeSettings({ mode: "allow-everything" });
    const { handler } = makeHandler();
    const response = await handler(shellExecute("anything"));
    expect(response).toMatchObject({ ok: true, decision: "allowed_by_mode" });
  });

  it("returns needs_approval without executing when the verdict is ask", async () => {
    const { handler, calls } = makeHandler();
    const response = await handler(shellExecute("rm -rf /tmp/x"));
    expect(response).toMatchObject({
      kind: "result",
      ok: false,
      error: { code: "needs_approval" },
      summary: "rm -rf /tmp/x",
    });
    expect(calls).toEqual([]);
  });

  it("returns permission_denied without executing when a deny rule matches", async () => {
    writeSettings({ deny: ["shell(rm *)"] });
    const { handler, calls } = makeHandler();
    const response = await handler(shellExecute("rm -rf /tmp/x"));
    expect(response).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
      decision: "denied_by_rule",
    });
    expect(calls).toEqual([]);
  });

  it("runs when a session grant from a previous approval matches", async () => {
    const { handler, sessionGrants } = makeHandler();
    sessionGrants.set("ses_1", ["shell(git status)"]);
    const response = await handler(shellExecute("git status"));
    expect(response).toMatchObject({ ok: true, decision: "allowed_by_rule" });
  });
});

describe("execute with a grant", () => {
  it("still denies when a deny rule matches — a grant never overrides deny", async () => {
    writeSettings({ deny: ["read(~/.ssh/**)"] });
    const { handler, calls, sessionGrants } = makeHandler();
    const response = await handler({
      kind: "execute",
      id: "msg_1",
      sessionId: "ses_1",
      tool: "local_read_file",
      args: { path: "~/.ssh/id_rsa" },
      grant: { scope: "always" },
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
      decision: "denied_by_rule",
    });
    expect(calls).toEqual([]);
    expect(sessionGrants.size).toBe(0);
    // the deny also blocks the grant from being persisted
    expect(loadSettings(settingsFile).allow).toEqual([]);
  });

  it("scope once: runs without recording anything", async () => {
    const { handler, calls, sessionGrants } = makeHandler();
    const response = await handler(shellExecute("npm install", { grant: { scope: "once" } }));
    expect(response).toMatchObject({ ok: true, decision: "approved_once" });
    expect(calls.length).toBe(1);
    expect(sessionGrants.size).toBe(0);
    expect(loadSettings(settingsFile).allow).toEqual([]);
  });

  it("scope session: records the derived rule for that session only", async () => {
    const { handler, sessionGrants } = makeHandler();
    const response = await handler(shellExecute("npm install", { grant: { scope: "session" } }));
    expect(response).toMatchObject({ ok: true, decision: "approved_session" });
    expect(sessionGrants.get("ses_1")).toEqual(["shell(npm install)"]);
    expect(loadSettings(settingsFile).allow).toEqual([]);

    // same session now allowed without a grant; other sessions still ask
    expect(await handler(shellExecute("npm install"))).toMatchObject({
      ok: true,
      decision: "allowed_by_rule",
    });
    expect(await handler(shellExecute("npm install", { sessionId: "ses_other" }))).toMatchObject({
      ok: false,
      error: { code: "needs_approval" },
    });
  });

  it("scope always: appends the derived rule to the settings file", async () => {
    const { handler } = makeHandler();
    const response = await handler({
      kind: "execute",
      id: "msg_1",
      sessionId: "ses_1",
      tool: "local_write_file",
      args: { path: "~/Projects/out/result.json", content: "{}" },
      grant: { scope: "always" },
    });
    expect(response).toMatchObject({ ok: true, decision: "approved_always" });

    const expectedRule = `write(${join(HOME, "Projects", "out")}/**)`;
    expect(loadSettings(settingsFile).allow).toEqual([expectedRule]);
    expect(readFileSync(settingsFile, "utf8")).toContain(expectedRule);

    // a fresh handler (new daemon) now allows it by rule
    const fresh = makeHandler();
    const replay = await fresh.handler({
      kind: "execute",
      id: "msg_2",
      sessionId: "ses_99",
      tool: "local_write_file",
      args: { path: "~/Projects/out/other.json", content: "{}" },
    });
    expect(replay).toMatchObject({ ok: true, decision: "allowed_by_rule" });
  });
});

describe("execute failure modes", () => {
  it("maps executor failures to execution_failed with the message", async () => {
    writeSettings({ mode: "allow-everything" });
    const { handler } = makeHandler({
      local_shell: async () => {
        throw new Error("spawn sh ENOENT");
      },
    });
    const response = await handler(shellExecute("ls"));
    expect(response).toMatchObject({
      ok: false,
      error: { code: "execution_failed", message: "spawn sh ENOENT" },
    });
  });

  it("returns invalid_args for malformed args without executing", async () => {
    writeSettings({ mode: "allow-everything" });
    const { handler, calls } = makeHandler();
    const response = await handler({
      kind: "execute",
      id: "msg_1",
      sessionId: "ses_1",
      tool: "local_shell",
      args: { command: 42 },
    });
    expect(response).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(calls).toEqual([]);
  });

  it("returns invalid_args even when a grant is attached", async () => {
    const { handler, calls, sessionGrants } = makeHandler();
    const response = await handler({
      kind: "execute",
      id: "msg_1",
      sessionId: "ses_1",
      tool: "local_read_file",
      args: {},
      grant: { scope: "always" },
    });
    expect(response).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(calls).toEqual([]);
    expect(sessionGrants.size).toBe(0);
    expect(loadSettings(settingsFile).allow).toEqual([]);
  });

  it("returns invalid_args for an unknown tool", async () => {
    writeSettings({ mode: "allow-everything" });
    const { handler, calls } = makeHandler();
    const response = await handler({
      kind: "execute",
      id: "msg_1",
      sessionId: "ses_1",
      tool: "local_format_disk" as never,
      args: { path: "/" },
    });
    expect(response).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(calls).toEqual([]);
  });
});

describe("settings reload", () => {
  it("picks up hand-edits to the settings file between messages", async () => {
    const { handler } = makeHandler();
    expect(await handler(shellExecute("git status"))).toMatchObject({
      ok: false,
      error: { code: "needs_approval" },
    });

    writeFileSync(
      settingsFile,
      JSON.stringify({ mode: "ask", allow: ["shell(git *)"], deny: [] }),
      "utf8",
    );
    expect(await handler(shellExecute("git status"))).toMatchObject({
      ok: true,
      decision: "allowed_by_rule",
    });
  });
});
