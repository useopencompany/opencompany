import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MentionList } from "./MentionList";
import { buildAgentMentionItems } from "./tools";

describe("MentionList", () => {
  it("runs the Tiptap command before selection side effects", () => {
    const events: string[] = [];
    const repository = buildAgentMentionItems([
      { fullName: "opencompany/web", defaultBranch: "main" },
    ]).find((item) => item.kind === "integration" && item.id === "opencompany-web")!;

    render(
      <MentionList
        items={[repository]}
        query="opencompany"
        command={vi.fn(() => events.push("command"))}
        onSelect={vi.fn(() => events.push("select"))}
      />,
    );

    fireEvent.click(screen.getByRole("option", { name: /opencompany\/web/i }));

    expect(events).toEqual(["command", "select"]);
  });
});
