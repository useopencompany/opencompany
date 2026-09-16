import type { HarnessNormalizedEvent } from "@opencompany/agent-runtime";
import { describe, expect, it } from "vitest";
import { createPullRequestCaptureScanner } from "./session-pull-request-capture";

function event(type: string, payload: Record<string, unknown>): HarnessNormalizedEvent {
  return { type, payload, rawEvent: {} } as HarnessNormalizedEvent;
}

function commandOutput(itemId: string, command: string, delta: string) {
  return event("command.output", { itemId, command, delta });
}

describe("createPullRequestCaptureScanner", () => {
  it("captures the PR the hosted GitHub MCP tool just created", () => {
    const scanner = createPullRequestCaptureScanner();
    const found = scanner.scan(
      event("mcp_tool.completed", {
        status: "completed",
        tool: "create_pull_request",
        result: JSON.stringify({
          number: 1620,
          html_url: "https://github.com/useopencompany/opencompany/pull/1620",
        }),
      }),
    );
    expect(found).toEqual([
      {
        repository: "useopencompany/opencompany",
        number: 1620,
        url: "https://github.com/useopencompany/opencompany/pull/1620",
      },
    ]);
  });

  it("ignores a create tool call that failed", () => {
    const scanner = createPullRequestCaptureScanner();
    expect(
      scanner.scan(
        event("mcp_tool.completed", {
          status: "failed",
          tool: "create_pull_request",
          result: "https://github.com/acme/web/pull/4",
        }),
      ),
    ).toEqual([]);
  });

  it("ignores tools that read pull requests rather than create them", () => {
    const scanner = createPullRequestCaptureScanner();
    expect(
      scanner.scan(
        event("mcp_tool.completed", {
          status: "completed",
          tool: "list_pull_requests",
          result: "https://github.com/acme/web/pull/4",
        }),
      ),
    ).toEqual([]);
  });

  it("captures the PR `gh pr create` printed", () => {
    const scanner = createPullRequestCaptureScanner();
    const found = scanner.scan(
      commandOutput("cmd-1", "gh pr create --fill", "https://github.com/acme/web/pull/42\n"),
    );
    expect(found.map((ref) => ref.number)).toEqual([42]);
  });

  it("captures a URL split across two output deltas", () => {
    const scanner = createPullRequestCaptureScanner();
    expect(
      scanner.scan(commandOutput("cmd-1", "gh pr create", "https://github.com/acme/w")),
    ).toEqual([]);
    const found = scanner.scan(commandOutput("cmd-1", "gh pr create", "eb/pull/42\n"));
    expect(found.map((ref) => ref.url)).toEqual(["https://github.com/acme/web/pull/42"]);
  });

  it("ignores PR URLs printed by commands that only read", () => {
    const scanner = createPullRequestCaptureScanner();
    for (const command of ["gh pr list", "gh pr view 42", "gh pr checks 42", "git log"]) {
      expect(
        scanner.scan(
          commandOutput(`cmd-${command}`, command, "https://github.com/acme/web/pull/42"),
        ),
      ).toEqual([]);
    }
  });

  it("matches `gh pr create` behind flags and a path prefix", () => {
    const scanner = createPullRequestCaptureScanner();
    expect(
      scanner
        .scan(
          commandOutput(
            "cmd-1",
            "/usr/bin/gh pr create --draft",
            "https://github.com/acme/web/pull/7",
          ),
        )
        .map((ref) => ref.number),
    ).toEqual([7]);
  });

  it("forgets a command's buffered output once the command ends", () => {
    const scanner = createPullRequestCaptureScanner();
    scanner.scan(commandOutput("cmd-1", "gh pr create", "https://github.com/acme/w"));
    scanner.scan(event("command.completed", { itemId: "cmd-1" }));
    expect(scanner.scan(commandOutput("cmd-1", "gh pr create", "eb/pull/42\n"))).toEqual([]);
  });

  it("never captures a PR the agent only talked about", () => {
    const scanner = createPullRequestCaptureScanner();
    expect(
      scanner.scan(
        event("assistant.delta", {
          delta: "This mirrors https://github.com/vercel/next.js/pull/900",
        }),
      ),
    ).toEqual([]);
  });
});
