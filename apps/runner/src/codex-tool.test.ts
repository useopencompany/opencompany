import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCodexCommand,
  buildCodexConfig,
  buildCodexConfigForAuth,
  buildCodexHome,
  buildCodexWorkRoot,
  codexHostedToolUsage,
  codexIntentToAddCommand,
  codexRuntimeEventsFromJsonEvent,
  createCodexStreamAccumulator,
  resolveCodexTarget,
} from "./codex-tool";

const repo = {
  id: "repo_1",
  fullName: "opencompany/web",
  defaultBranch: "main",
};

describe("resolveCodexTarget", () => {
  it("uses the only attached repository by default", () => {
    expect(resolveCodexTarget({ repositories: [repo] })).toEqual({
      kind: "attached",
      repository: repo,
    });
  });

  it("matches an attached repository by id, full name, or single-repo name", () => {
    expect(
      resolveCodexTarget({
        repositories: [repo],
        requestedRepository: "repo_1",
      }),
    ).toEqual({
      kind: "attached",
      repository: repo,
    });
    expect(
      resolveCodexTarget({
        repositories: [repo],
        requestedRepository: "opencompany/web",
      }),
    ).toEqual({ kind: "attached", repository: repo });
    expect(
      resolveCodexTarget({
        repositories: [repo],
        requestedRepository: "other/web",
      }),
    ).toEqual({
      kind: "attached",
      repository: repo,
    });
  });

  it("supports integration-wide and public GitHub repository targets", () => {
    expect(
      resolveCodexTarget({
        repositories: [],
        allRepositories: true,
        requestedRepository: "opencompany/web",
      }),
    ).toEqual({ kind: "workspace", repositoryFullName: "opencompany/web" });

    expect(
      resolveCodexTarget({
        repositories: [],
        requestedRepository: "https://github.com/opencompany/web",
      }),
    ).toEqual({ kind: "public", repositoryFullName: "opencompany/web" });
  });

  it("requires an explicit repository when there is no unambiguous default", () => {
    expect(() => resolveCodexTarget({ repositories: [] })).toThrow(
      "codex_coder needs a repository argument",
    );
    expect(() =>
      resolveCodexTarget({
        repositories: [repo, { ...repo, id: "repo_2", fullName: "opencompany/runner" }],
      }),
    ).toThrow("More than one repository is attached");
  });
});

describe("buildCodexCommand", () => {
  it("quotes the task, work root, and model without embedding secrets", () => {
    const command = buildCodexCommand({
      task: `edit "README.md"; echo $CODEX_API_KEY`,
      workRoot: "/tmp/work root",
      model: "gpt-5.5",
    });

    expect(command).toContain("codex exec --json");
    expect(command).toContain("--cd '/tmp/work root'");
    expect(command).toContain("--sandbox workspace-write");
    expect(command).toContain("--skip-git-repo-check");
    expect(command).not.toContain("--ask-for-approval");
    expect(command).not.toContain("resume");
    expect(command).toContain("-m 'gpt-5.5'");
    expect(command).toContain(`'edit "README.md"; echo $CODEX_API_KEY'`);
    expect(command).not.toContain("OPENAI_CODEX_API_KEY");
  });

  it("continues an existing Codex session when an id is provided", () => {
    const command = buildCodexCommand({
      task: "follow up",
      workRoot: "/home/user/workspace/work/codex",
      model: "gpt-5.5",
      sessionId: "codex-session-1",
    });

    expect(command).toContain("codex exec --json");
    expect(command).toContain("--cd '/home/user/workspace/work/codex'");
    expect(command).toContain("--sandbox workspace-write");
    expect(command).toContain("--skip-git-repo-check");
    expect(command).toContain("resume -m 'gpt-5.5' 'codex-session-1' 'follow up'");
  });

  it("passes reasoning config overrides", () => {
    const command = buildCodexCommand({
      task: "plan and implement",
      workRoot: "/tmp/work root",
      model: "gpt-5.5",
      reasoningEffort: "high",
      planModeReasoningEffort: "xhigh",
    });

    expect(command).toContain("-m 'gpt-5.5'");
    expect(command).toContain("-c 'model_reasoning_effort=high'");
    expect(command).toContain("-c 'plan_mode_reasoning_effort=xhigh'");
  });
});

describe("buildCodexHome", () => {
  it("places Codex work under the agent work directory", () => {
    expect(buildCodexWorkRoot("/home/user/workspace/work")).toBe("/home/user/workspace/work/codex");
  });

  it("keeps Codex state under the Codex work directory instead of /tmp", () => {
    expect(buildCodexHome("/home/user/workspace/work/codex")).toBe(
      "/home/user/workspace/work/codex/.codex",
    );
  });
});

describe("buildCodexConfig", () => {
  it("configures Codex to use the OpenCompany Responses provider", () => {
    const config = buildCodexConfig({
      baseUrl: "https://runner.example.com/broker/openai/v1",
      apiKeyEnvVar: "OPENCOMPANY_LLM_BROKER_TOKEN",
    });

    expect(config).toContain('model_provider = "opencompany"');
    expect(config).toContain('model_verbosity = "medium"');
    expect(config).toContain("[sandbox_workspace_write]");
    expect(config).toContain("network_access = true");
    expect(config).toContain("[model_providers.opencompany]");
    expect(config).toContain('name = "OpenCompany"');
    expect(config).toContain('base_url = "https://runner.example.com/broker/openai/v1"');
    expect(config).toContain('env_key = "OPENCOMPANY_LLM_BROKER_TOKEN"');
    expect(config).toContain('wire_api = "responses"');
  });

  it("configures Codex to use file-backed ChatGPT auth for subscription-backed runs", () => {
    const config = buildCodexConfigForAuth({
      kind: "chatgpt",
      authJson: { OPENAI_REFRESH_TOKEN: "secret" },
      brokered: false,
    });

    expect(config).toContain('cli_auth_credentials_store = "file"');
    expect(config).toContain('forced_login_method = "chatgpt"');
    expect(config).toContain("[sandbox_workspace_write]");
    expect(config).toContain("network_access = true");
    expect(config).not.toContain("model_provider");
    expect(config).not.toContain("env_key");
  });
});

describe("codexIntentToAddCommand", () => {
  it("adds real untracked files without failing on the ignored Codex state directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-intent-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(join(dir, ".codex"));
      writeFileSync(join(dir, ".codex", "state"), "ignored");
      writeFileSync(join(dir, "new.txt"), "hello");
      writeFileSync(join(dir, ".git", "info", "exclude"), "/.codex/\n");

      execSync(codexIntentToAddCommand(), { cwd: dir, shell: "/bin/sh" });

      expect(execFileSync("git", ["status", "--short"], { cwd: dir, encoding: "utf8" })).toBe(
        " A new.txt\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createCodexStreamAccumulator", () => {
  it("extracts session id, assistant text, and token usage from JSONL", () => {
    const stream = createCodexStreamAccumulator();

    stream.push(
      [
        JSON.stringify({
          type: "session.started",
          session_id: "codex-session-1",
        }),
        JSON.stringify({ type: "assistant_message_delta", delta: "Done" }),
        JSON.stringify({
          type: "usage",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 20,
            output_tokens: 40,
          },
        }),
      ].join("\n") + "\n",
    );
    stream.finish();

    expect(stream.summary({ exitCode: 0, stdout: "", stderr: "" })).toMatchObject({
      sessionId: "codex-session-1",
      status: "success",
      result: "Done",
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 20,
        output_tokens: 40,
      },
    });
  });

  it("extracts final agent_message text from current Codex item.completed JSONL", () => {
    const stream = createCodexStreamAccumulator();
    const stdout =
      [
        JSON.stringify({
          type: "thread.started",
          thread_id: "019efdef-acf7-70d3-90d1-c67d06f4f12f",
        }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_0",
            type: "agent_message",
            text: "Got it. What should I test or work on?",
          },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 13531,
            cached_input_tokens: 12160,
            output_tokens: 36,
            reasoning_output_tokens: 0,
          },
        }),
      ].join("\n") + "\n";

    const activity = stream.push(stdout);
    stream.finish();

    expect(activity).toContain("Codex: Got it. What should I test or work on?");
    expect(stream.summary({ exitCode: 0, stdout, stderr: "" })).toMatchObject({
      sessionId: "019efdef-acf7-70d3-90d1-c67d06f4f12f",
      status: "success",
      result: "Got it. What should I test or work on?",
      usage: {
        input_tokens: 13531,
        cache_read_input_tokens: 12160,
        output_tokens: 36,
      },
    });
  });

  it("extracts app-server style thread ids and agent message deltas", () => {
    const stream = createCodexStreamAccumulator();
    const stdout =
      [
        JSON.stringify({
          method: "thread/started",
          params: { thread: { id: "019efdef-acf7-70d3-90d1-c67d06f4f12f" } },
        }),
        JSON.stringify({
          method: "item/agentMessage/delta",
          params: { itemId: "item_0", delta: "I am checking the command output." },
        }),
      ].join("\n") + "\n";

    const activity = stream.push(stdout);
    stream.finish();

    expect(activity).toContain("Codex: I am checking the command output.");
    expect(stream.summary({ exitCode: 0, stdout, stderr: "" })).toMatchObject({
      sessionId: "019efdef-acf7-70d3-90d1-c67d06f4f12f",
      result: "I am checking the command output.",
    });
  });

  it("uses the latest Codex agent message item as the final result", () => {
    const stream = createCodexStreamAccumulator();
    const stdout =
      [
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_progress",
            type: "agent_message",
            text: "I am checking the repository.",
          },
        }),
        JSON.stringify({
          type: "item.started",
          item: {
            id: "item_command",
            type: "command_execution",
            command: "pwd",
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_final",
            type: "agent_message",
            text: "Done.",
          },
        }),
      ].join("\n") + "\n";

    stream.push(stdout);
    stream.finish();

    expect(stream.summary({ exitCode: 0, stdout, stderr: "" }).result).toBe("Done.");
  });

  it("keeps only the latest Codex agent-message delta item as the final result", () => {
    const stream = createCodexStreamAccumulator();
    const stdout =
      [
        JSON.stringify({
          method: "item/agentMessage/delta",
          params: { itemId: "item_progress", delta: "I am checking " },
        }),
        JSON.stringify({
          method: "item/agentMessage/delta",
          params: { itemId: "item_progress", delta: "the repository." },
        }),
        JSON.stringify({
          method: "item/agentMessage/delta",
          params: { itemId: "item_final", delta: "Done" },
        }),
        JSON.stringify({
          method: "item/agentMessage/delta",
          params: { itemId: "item_final", delta: "." },
        }),
      ].join("\n") + "\n";

    stream.push(stdout);
    stream.finish();

    expect(stream.summary({ exitCode: 0, stdout, stderr: "" }).result).toBe("Done.");
  });

  it("does not mistake Codex item ids for resumable session ids", () => {
    const stream = createCodexStreamAccumulator();
    const stdout =
      [
        JSON.stringify({
          type: "item.started",
          item: {
            id: "item_0",
            type: "command_execution",
            command: "pwd",
          },
        }),
        JSON.stringify({
          type: "thread.started",
          thread_id: "019efdef-acf7-70d3-90d1-c67d06f4f12f",
        }),
      ].join("\n") + "\n";

    stream.push(stdout);
    stream.finish();

    expect(stream.summary({ exitCode: 0, stdout, stderr: "" }).sessionId).toBe(
      "019efdef-acf7-70d3-90d1-c67d06f4f12f",
    );
  });

  it("keeps supporting legacy session start events that only expose a top-level id", () => {
    const stream = createCodexStreamAccumulator();

    stream.push(`${JSON.stringify({ type: "session.started", id: "codex-session-legacy" })}\n`);
    stream.finish();

    expect(stream.summary({ exitCode: 0, stdout: "", stderr: "" }).sessionId).toBe(
      "codex-session-legacy",
    );
  });

  it("uses the latest cumulative token totals instead of summing repeated usage events", () => {
    const stream = createCodexStreamAccumulator();

    stream.push(
      [
        JSON.stringify({
          type: "usage",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 20,
            output_tokens: 40,
          },
        }),
        JSON.stringify({
          type: "usage",
          usage: {
            input_tokens: 150,
            cache_read_input_tokens: 30,
            output_tokens: 65,
          },
        }),
      ].join("\n") + "\n",
    );
    stream.finish();

    expect(stream.summary({ exitCode: 0, stdout: "", stderr: "" }).usage).toEqual({
      input_tokens: 150,
      cache_read_input_tokens: 30,
      output_tokens: 65,
    });
  });

  it("reports timeout state without usage when no usage event is emitted", () => {
    const stream = createCodexStreamAccumulator();
    stream.push(`${JSON.stringify({ type: "assistant_message_delta", delta: "Partial" })}\n`);
    stream.finish();

    expect(
      stream.summary({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: true,
      }),
    ).toEqual({
      sessionId: null,
      status: "timeout",
      result: "Partial",
      error: "Codex timed out before finishing. The partial diff is shown below.",
      usage: null,
    });
  });

  it("drains parsed JSONL events after finish consumes a trailing partial line", () => {
    const stream = createCodexStreamAccumulator();
    stream.push(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item_0",
          type: "command_execution",
          command: "git status",
        },
      }),
    );

    expect(stream.drainEvents()).toEqual([]);
    stream.finish();

    expect(stream.drainEvents()).toEqual([
      {
        type: "item.started",
        item: {
          id: "item_0",
          type: "command_execution",
          command: "git status",
        },
      },
    ]);
  });
});

describe("codexRuntimeEventsFromJsonEvent", () => {
  it("maps Codex agent message JSONL to live assistant text", () => {
    expect(
      codexRuntimeEventsFromJsonEvent(
        {
          type: "item.completed",
          item: {
            id: "item_text",
            type: "agent_message",
            text: "The command builder emits the expected shape.",
          },
        },
        "msg_assistant",
      ),
    ).toEqual([
      {
        type: "message.delta",
        payload: {
          messageId: "msg_assistant",
          delta: "The command builder emits the expected shape.",
        },
      },
    ]);
  });

  it("maps app-server Codex text, reasoning, and command output deltas", () => {
    expect(
      codexRuntimeEventsFromJsonEvent(
        {
          method: "item/agentMessage/delta",
          params: {
            itemId: "item_text",
            delta: "I am checking the installed CLI.",
          },
        },
        "msg_assistant",
      ),
    ).toEqual([
      {
        type: "message.delta",
        payload: {
          messageId: "msg_assistant",
          delta: "I am checking the installed CLI.",
        },
      },
    ]);

    expect(
      codexRuntimeEventsFromJsonEvent(
        {
          method: "item/agentMessage/delta",
          params: {
            itemId: "item_text",
            delta: " ",
          },
        },
        "msg_assistant",
      ),
    ).toEqual([
      {
        type: "message.delta",
        payload: {
          messageId: "msg_assistant",
          delta: " ",
        },
      },
    ]);

    expect(
      codexRuntimeEventsFromJsonEvent(
        {
          method: "item/reasoning/summaryTextDelta",
          params: {
            itemId: "item_reasoning",
            delta: "Need to inspect the event stream mapper.",
          },
        },
        "msg_assistant",
      ),
    ).toEqual([
      {
        type: "message.reasoning_delta",
        payload: {
          messageId: "msg_assistant",
          delta: "Need to inspect the event stream mapper.",
        },
      },
    ]);

    expect(
      codexRuntimeEventsFromJsonEvent(
        {
          method: "item/commandExecution/outputDelta",
          params: {
            itemId: "item_cmd",
            command: "/bin/bash -lc 'rg --files'",
            stream: "stderr",
            delta: "No files found\n",
          },
        },
        "msg_assistant",
      ),
    ).toEqual([
      {
        type: "command.output",
        payload: {
          command: "/bin/bash -lc 'rg --files'",
          toolCallId: "codex:item_cmd",
          stream: "stderr",
          delta: "No files found\n",
        },
      },
    ]);
  });

  it("maps Codex turn completion to an internal completed engine activity", () => {
    expect(
      codexRuntimeEventsFromJsonEvent(
        {
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
        },
        "msg_assistant",
      ),
    ).toEqual([
      {
        type: "engine.activity",
        payload: {
          messageId: "msg_assistant",
          engine: "codex",
          label: "Codex",
          status: "completed",
          activity: "Codex completed",
        },
      },
    ]);
  });

  it("maps Codex command execution JSONL to shell tool events", () => {
    expect(
      codexRuntimeEventsFromJsonEvent(
        {
          type: "item.started",
          item: {
            id: "item_0",
            type: "command_execution",
            command: "git clone https://github.com/octocat/Hello-World.git hello-world",
            aggregated_output: "",
            status: "in_progress",
          },
        },
        "msg_assistant",
      ),
    ).toEqual([
      {
        type: "tool.started",
        payload: {
          messageId: "msg_assistant",
          toolCallId: "codex:item_0",
          name: "shell",
          input: {
            command: "git clone https://github.com/octocat/Hello-World.git hello-world",
          },
        },
      },
    ]);

    expect(
      codexRuntimeEventsFromJsonEvent(
        {
          type: "item.completed",
          item: {
            id: "item_0",
            type: "command_execution",
            command: "git clone https://github.com/octocat/Hello-World.git hello-world",
            aggregated_output: "Cloning into 'hello-world'...\n",
            exit_code: 0,
            status: "completed",
          },
        },
        "msg_assistant",
      ),
    ).toEqual([
      {
        type: "tool.completed",
        payload: {
          messageId: "msg_assistant",
          toolCallId: "codex:item_0",
          name: "shell",
          outputPreview: "Cloning into 'hello-world'...",
          output: {
            command: "git clone https://github.com/octocat/Hello-World.git hello-world",
            exitCode: 0,
            output: "Cloning into 'hello-world'...",
          },
        },
      },
    ]);
  });

  it("maps app-server Codex command execution events to shell tool events", () => {
    expect(
      codexRuntimeEventsFromJsonEvent(
        {
          method: "item/started",
          params: {
            item: {
              id: "item_0",
              type: "commandExecution",
              command: "/bin/bash -lc 'git status --short --branch'",
              status: "inProgress",
            },
          },
        },
        "msg_assistant",
      ),
    ).toEqual([
      {
        type: "tool.started",
        payload: {
          messageId: "msg_assistant",
          toolCallId: "codex:item_0",
          name: "shell",
          input: {
            command: "/bin/bash -lc 'git status --short --branch'",
          },
        },
      },
    ]);

    expect(
      codexRuntimeEventsFromJsonEvent(
        {
          method: "item/completed",
          params: {
            item: {
              id: "item_0",
              type: "commandExecution",
              command: "/bin/bash -lc 'git status --short --branch'",
              aggregatedOutput: "## main\n",
              exitCode: 0,
              status: "completed",
            },
          },
        },
        "msg_assistant",
      ),
    ).toEqual([
      {
        type: "tool.completed",
        payload: {
          messageId: "msg_assistant",
          toolCallId: "codex:item_0",
          name: "shell",
          outputPreview: "## main",
          output: {
            command: "/bin/bash -lc 'git status --short --branch'",
            exitCode: 0,
            output: "## main",
          },
        },
      },
    ]);
  });

  it("maps failed Codex command execution JSONL to failed shell tool events", () => {
    expect(
      codexRuntimeEventsFromJsonEvent(
        {
          type: "item.completed",
          item: {
            id: "item_1",
            type: "command_execution",
            command: "git status",
            aggregated_output: "fatal: not a git repository\n",
            exit_code: 128,
            status: "failed",
          },
        },
        "msg_assistant",
      ),
    ).toEqual([
      {
        type: "tool.failed",
        payload: {
          messageId: "msg_assistant",
          toolCallId: "codex:item_1",
          name: "shell",
          outputPreview: "fatal: not a git repository",
          output: {
            command: "git status",
            exitCode: 128,
            output: "fatal: not a git repository",
          },
          error: {
            message: "Codex command exited with code 128.",
            code: "codex_command_failed",
            recoverable: true,
          },
        },
      },
    ]);
  });

  it("maps wrapped Codex JSONL message envelopes to shell tool events", () => {
    expect(
      codexRuntimeEventsFromJsonEvent(
        {
          msg: {
            type: "item.started",
            item: {
              id: "item_2",
              type: "command_execution",
              command: "pwd",
            },
          },
        },
        "msg_assistant",
      ),
    ).toEqual([
      {
        type: "tool.started",
        payload: {
          messageId: "msg_assistant",
          toolCallId: "codex:item_2",
          name: "shell",
          input: { command: "pwd" },
        },
      },
    ]);
  });
});

describe("codexHostedToolUsage", () => {
  it("prices Codex token usage with platform model pricing", () => {
    const usage = codexHostedToolUsage({
      model: "gpt-5.5",
      summary: {
        usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 100,
          output_tokens: 500,
        },
      },
    });

    expect(usage).toMatchObject({
      provider: "codex",
      operation: "session",
      costSource: "platform_model_pricing",
      rawUsage: {
        model: "gpt-5.5",
        billing_model: "openai/gpt-5.5",
      },
    });
    expect(usage?.costUsdMicros).toBeGreaterThan(0);
  });

  it("records brokered Codex token usage as display-only at zero cost", () => {
    const usage = codexHostedToolUsage({
      model: "gpt-5.2-codex",
      brokered: true,
      summary: {
        usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 100,
          output_tokens: 500,
        },
      },
    });

    expect(usage).toMatchObject({
      provider: "codex",
      operation: "session",
      costUsdMicros: 0,
      costSource: "broker_metered",
      rawUsage: {
        model: "gpt-5.2-codex",
        billing_model: "openai/gpt-5.2-codex",
        cost_source: "broker_metered",
        display_only: true,
      },
    });
  });

  it("records subscription-backed Codex token usage as display-only at zero cost", () => {
    const usage = codexHostedToolUsage({
      model: "gpt-5.2-codex",
      subscriptionBacked: true,
      summary: {
        usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 100,
          output_tokens: 500,
        },
      },
    });

    expect(usage).toMatchObject({
      provider: "codex",
      operation: "session",
      costUsdMicros: 0,
      costSource: "subscription",
      rawUsage: {
        model: "gpt-5.2-codex",
        billing_model: "openai/gpt-5.2-codex",
        cost_source: "subscription",
        display_only: true,
      },
    });
  });
});
