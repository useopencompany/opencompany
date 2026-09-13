import { describe, expect, it } from "vitest";
import {
  presentableEngineFailureMessage,
  UNREADABLE_ENGINE_FAILURE_MESSAGE,
} from "./codex-chat-errors";

describe("presentableEngineFailureMessage", () => {
  it("passes ordinary one-line failures through unchanged", () => {
    const message =
      "[deadline_exceeded] the operation timed out: This error is likely due to exceeding 'timeoutMs'.";
    expect(presentableEngineFailureMessage(message)).toBe(message);
  });

  it("collapses ANSI colour codes, control bytes, and multi-line traces to one line", () => {
    expect(
      presentableEngineFailureMessage(
        "\u001b[31mEngine crashed\u001b[0m\n    at runTurn (harness.ts:1)\n\tcaused by: socket closed\u0000",
      ),
    ).toBe("Engine crashed at runTurn (harness.ts:1) caused by: socket closed");
  });

  it("replaces markup error pages with a readable failure", () => {
    const gatewayBody = [
      "\n<html><head>",
      '<meta http-equiv="content-type" content="text/html;charset=utf-8">',
      "<title>502 Server Error</title>",
      "</head>",
      "<body text=#000000 bgcolor=#ffffff>",
      "<h1>Error: Server Error</h1>",
      "</body></html>",
    ].join("\n");
    expect(presentableEngineFailureMessage(gatewayBody)).toBe(UNREADABLE_ENGINE_FAILURE_MESSAGE);
    expect(presentableEngineFailureMessage("<!DOCTYPE html><p>bad gateway</p>")).toBe(
      UNREADABLE_ENGINE_FAILURE_MESSAGE,
    );
  });

  it("keeps text that merely mentions angle brackets", () => {
    expect(presentableEngineFailureMessage("Expected <string> but received <number>.")).toBe(
      "Expected <string> but received <number>.",
    );
  });

  it("bounds unbounded failure text", () => {
    const long = `Upstream said: ${"x".repeat(2_000)}`;
    const presentable = presentableEngineFailureMessage(long);
    expect(presentable).toHaveLength(500);
    expect(presentable.endsWith("…")).toBe(true);
  });

  it("falls back when nothing displayable remains", () => {
    expect(presentableEngineFailureMessage("  \u0000\u001b[2J \n ")).toBe(
      UNREADABLE_ENGINE_FAILURE_MESSAGE,
    );
  });
});
