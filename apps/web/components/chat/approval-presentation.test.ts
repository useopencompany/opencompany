import { CODEX_APPROVAL_TOOL_NAME } from "@opencompany/agent-runtime";
import { describe, expect, it } from "vitest";
import type { ChatUiMessage } from "@/lib/chat-ui";
import { approvalPresentation, pendingApprovals } from "./approval-presentation";

describe("coding engine permission requests", () => {
  it("asks about the command it would run, keeping the engine's own explanation", () => {
    expect(
      approvalPresentation({
        label: "Approval",
        title: "Inspect the file and folder hierarchy on the Desktop",
        action: "find /Users/ada/Desktop -maxdepth 2 -print",
        kind: "execute",
        rawInput: { command: "find /Users/ada/Desktop -maxdepth 2 -print" },
      }),
    ).toEqual({
      kind: "terminal",
      source: "Terminal",
      question: "Run this command?",
      description: "Inspect the file and folder hierarchy on the Desktop",
      code: "find /Users/ada/Desktop -maxdepth 2 -print",
      paths: [],
      lines: [],
    });
  });

  it("drops a title that only repeats the command", () => {
    const presentation = approvalPresentation({
      label: "Approval",
      title: "bun test",
      action: "bun test",
      kind: "execute",
    });
    expect(presentation.description).toBeNull();
    expect(presentation.code).toBe("bun test");
  });

  it("names the files a write would touch instead of the tool that writes them", () => {
    expect(
      approvalPresentation({
        label: "Approval",
        title: "Edit apps/web/components/Surface.tsx",
        action: "Edit",
        kind: "edit",
        locations: [{ path: "apps/web/components/Surface.tsx" }],
      }),
    ).toMatchObject({
      kind: "files",
      source: "Files",
      question: "Apply this file change?",
      description: "Edit apps/web/components/Surface.tsx",
      code: null,
      paths: ["apps/web/components/Surface.tsx"],
    });
  });

  it("counts the files it is asking about", () => {
    const twoFiles = approvalPresentation({
      label: "Approval",
      action: "Edit",
      kind: "edit",
      locations: [{ path: "a.ts" }, { path: "b.ts" }],
    });
    expect(twoFiles.question).toBe("Apply these file changes?");
    expect(
      approvalPresentation({
        label: "Approval",
        action: "Read",
        kind: "read",
        locations: [{ path: "a.ts" }],
      }).question,
    ).toBe("Read this file?");
  });

  it("does not dress a generic tool call up as a terminal", () => {
    expect(approvalPresentation({ label: "Approval", action: "Think" })).toMatchObject({
      kind: "tool",
      source: "Coding engine",
    });
  });

  it("treats fetches as network access", () => {
    expect(
      approvalPresentation({
        label: "Approval",
        title: "Fetch https://example.com/pricing",
        action: "WebFetch",
        kind: "fetch",
      }),
    ).toMatchObject({ kind: "network", source: "Network", question: "Fetch this from the web?" });
  });

  it("infers the request shape for approvals recorded before the tool kind was forwarded", () => {
    expect(approvalPresentation({ label: "Approval", action: "rm -rf build" })).toMatchObject({
      kind: "terminal",
      code: "rm -rf build",
    });
    expect(
      approvalPresentation({ label: "Approval", action: "Write", locations: [{ path: "a.ts" }] }),
    ).toMatchObject({ kind: "files", code: null, paths: ["a.ts"] });
  });

  it("falls back to the raw request when there is no command and no path to show", () => {
    expect(
      approvalPresentation({
        label: "Approval",
        title: "Use the deploy tool",
        action: "deploy",
        rawInput: { environment: "production", confirm: true },
      }),
    ).toMatchObject({
      question: "Allow this tool call?",
      source: "Coding engine",
      code: null,
      lines: [
        { label: "environment", value: "production" },
        { label: "confirm", value: "true" },
      ],
    });
  });
});

describe("connected action approvals", () => {
  it("names the integration once, in the header rather than the question", () => {
    expect(
      approvalPresentation({
        action: "plugin:slack:slack.slack_search_public_and_private",
        params: { query: "launch plan" },
      }),
    ).toMatchObject({
      kind: "integration",
      source: "Slack",
      question: "Run search public and private in Slack?",
      lines: [{ label: "query", value: "launch plan" }],
    });
  });

  it("keeps an unnamespaced tool name intact", () => {
    expect(
      approvalPresentation({ action: "plugin:linear:linear.save_comment", params: {} }),
    ).toMatchObject({ source: "Linear", question: "Run save comment in Linear?" });
  });

  it("does not claim a custom MCP server is a known integration", () => {
    expect(
      approvalPresentation({
        action: "plugin:custom-0123456789abcdef01234567:deploy.release",
        params: {},
      }),
    ).toMatchObject({ source: "Custom integration" });
  });

  it("spells out a calendar event rather than listing its API fields", () => {
    expect(
      approvalPresentation({
        action: "google_calendar.create_event",
        params: {
          summary: "Investor update",
          start: "2026-09-14",
          end: "2026-09-14",
          attendees: ["ada@example.com", "grace@example.com"],
        },
      }),
    ).toMatchObject({
      source: "Google Calendar",
      question: "Add this event to your Google Calendar?",
      lines: [
        { label: "Event", value: "Investor update" },
        { label: "When", value: "2026-09-14 (all day)" },
        { label: "Invites", value: "ada@example.com, grace@example.com" },
      ],
    });
  });

  it("shows the text of every proposed post", () => {
    expect(
      approvalPresentation({
        action: "x_account.post_tweet",
        params: { posts: [{ account: "@opencompany", text: "We shipped approvals." }] },
      }),
    ).toMatchObject({
      source: "X",
      question: "Post to X?",
      lines: [{ label: "Post", value: "@opencompany — We shipped approvals." }],
    });
  });
});

describe("pending approvals in a turn", () => {
  it("lists only the parts that still need a decision", () => {
    const message = {
      id: "assistant_1",
      role: "assistant",
      parts: [
        { type: "text", text: "Ready when you are." },
        {
          type: "dynamic-tool",
          toolName: CODEX_APPROVAL_TOOL_NAME,
          toolCallId: "acp-approval-1",
          state: "approval-requested",
          input: { label: "Approval", action: "bun test", kind: "execute" },
          approval: { id: "approval_1" },
        },
        {
          type: "dynamic-tool",
          toolName: CODEX_APPROVAL_TOOL_NAME,
          toolCallId: "acp-approval-2",
          state: "approval-responded",
          input: { label: "Approval", action: "bun run build", kind: "execute" },
          approval: { id: "approval_2", approved: true },
        },
      ],
    } as ChatUiMessage;

    expect(pendingApprovals(message)).toEqual([
      { approvalId: "approval_1", source: "Terminal", question: "Run this command?" },
    ]);
  });

  it("ignores an approval request that carries no approval id to resolve", () => {
    const message = {
      id: "assistant_2",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: CODEX_APPROVAL_TOOL_NAME,
          toolCallId: "acp-approval-3",
          state: "approval-requested",
          input: { label: "Approval", action: "bun test" },
        },
      ],
    } as ChatUiMessage;

    expect(pendingApprovals(message)).toEqual([]);
  });
});
