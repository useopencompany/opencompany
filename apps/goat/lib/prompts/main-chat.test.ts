import { describe, expect, it } from "vitest";
import { createOpenCompanyChatSystemPrompt } from "@/lib/prompts/main-chat";

const CAPABILITIES = [
  { id: "slack", indexLine: "slack — CAN read history. CANNOT post." },
  { id: "linear", indexLine: "linear — CAN read and create issues. CANNOT update." },
  { id: "youtube_transcript", indexLine: "youtube_transcript — fetches transcripts." },
];

describe("createOpenCompanyChatSystemPrompt capabilities", () => {
  it("produces an identical prompt when capabilities are absent or empty", () => {
    const currentDate = "2026-07-18";
    const base = createOpenCompanyChatSystemPrompt({ currentDate });
    expect(createOpenCompanyChatSystemPrompt({ currentDate, capabilities: [] })).toBe(base);
    expect(base).not.toContain("<capabilities>");
    expect(base).not.toContain("use_capability");
  });

  it("renders the index block and behavior lines when capabilities are present", () => {
    const prompt = createOpenCompanyChatSystemPrompt({ capabilities: CAPABILITIES });
    expect(prompt).toContain("<capabilities>");
    expect(prompt).toContain("- slack — CAN read history. CANNOT post.");
    expect(prompt).toContain("- youtube_transcript — fetches transcripts.");
    expect(prompt).toContain("use with the use_capability tool");
    expect(prompt).toContain("fully self-contained");
    expect(prompt).toContain("Set operation to read for lookups");
    expect(prompt).toContain("latest user message explicitly and unambiguously asks");
    expect(prompt).toContain("Ask a concise follow-up instead of guessing a material write target");
    expect(prompt).toContain("Choose the lightest path");
    expect(prompt).toContain("start a task for deep, multi-step, or cross-source work");
    expect(prompt).toContain("follow its hint");
    // Index block stays inside the prompt-token budget (~300 tokens ≈ 1400 chars)
    // even with headroom for more capabilities.
    const block = prompt.slice(prompt.indexOf("<capabilities>"), prompt.indexOf("</capabilities>"));
    expect(block.length).toBeLessThan(1400);
  });

  it("drops the start-a-task routing when task tools are disabled", () => {
    const prompt = createOpenCompanyChatSystemPrompt({
      capabilities: CAPABILITIES,
      taskToolsEnabled: false,
    });
    expect(prompt).toContain("Choose the lightest path");
    expect(prompt).not.toContain("start a task for deep, multi-step, or cross-source work");
  });
});
