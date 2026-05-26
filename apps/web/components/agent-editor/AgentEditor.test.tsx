import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentEditor, type AgentEditorHandle } from "./AgentEditor";
import { buildAgentMentionItems } from "./tools";

describe("AgentEditor", () => {
  it("rebuilds from the saved body when persisted mention attrs cannot render", async () => {
    render(
      <AgentEditor
        initialBody="Use @AMP for code changes."
        initialContent={{
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "mention", attrs: { id: null, label: null } }],
            },
          ],
        }}
        mentionItems={buildAgentMentionItems()}
        onChange={vi.fn()}
      />,
    );

    expect(await screen.findByText("@AMP")).toBeInTheDocument();
    expect(screen.queryByText("@null")).not.toBeInTheDocument();
  });

  it("rebuilds from the saved body when persisted content is stale", async () => {
    render(
      <AgentEditor
        initialBody="Use @AMP for code changes."
        initialContent={{
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Use " },
                { type: "text", text: "@" },
              ],
            },
          ],
        }}
        mentionItems={buildAgentMentionItems()}
        onChange={vi.fn()}
      />,
    );

    expect(await screen.findByText("@AMP")).toBeInTheDocument();
    expect(screen.queryByText(/^@$/)).not.toBeInTheDocument();
  });

  it("strips broken empty mentions from saved content and body", async () => {
    // Reproduces the DB-observed shape: a mention persisted without attrs
    // would otherwise survive editor edits and re-pollute the next save.
    const ref = createRef<AgentEditorHandle>();
    const captured: Array<{ body: string; content: unknown }> = [];
    const items = buildAgentMentionItems([{ fullName: "opencompany/web", defaultBranch: "main" }]);

    render(
      <AgentEditor
        ref={ref}
        initialBody="testing\n@"
        initialContent={{
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "testing" },
                { type: "hardBreak" },
                { type: "mention" },
                { type: "text", text: " " },
              ],
            },
          ],
        }}
        mentionItems={items}
        onChange={(body, content) =>
          captured.push({ body, content: JSON.parse(JSON.stringify(content)) })
        }
      />,
    );

    act(() => {
      ref.current?.selectRepositoryMention({
        fullName: "opencompany/web",
        defaultBranch: "main",
      });
    });

    const last = captured.at(-1);
    expect(last).toBeDefined();
    const mentions: Array<{ attrs?: Record<string, unknown> }> = [];
    function walk(node: unknown) {
      if (typeof node !== "object" || node === null) return;
      const n = node as { type?: string; content?: unknown[] };
      if (n.type === "mention") mentions.push(node as { attrs?: Record<string, unknown> });
      (n.content ?? []).forEach(walk);
    }
    walk(last?.content);

    expect(mentions.length).toBeGreaterThan(0);
    for (const mention of mentions) {
      const label = mention.attrs?.label;
      const id = mention.attrs?.id;
      const hasUsableLabel = typeof label === "string" && label.length > 0;
      const hasUsableId = typeof id === "string" && id.length > 0;
      expect(hasUsableLabel || hasUsableId).toBe(true);
    }
  });

  it("replaces generic GitHub mentions when a repository is chosen", async () => {
    const ref = createRef<AgentEditorHandle>();
    const onChange = vi.fn();
    render(
      <AgentEditor
        ref={ref}
        initialBody="Use @github"
        mentionItems={buildAgentMentionItems([
          { fullName: "opencompany/web", defaultBranch: "main" },
        ])}
        onChange={onChange}
      />,
    );

    await screen.findByText("@github");

    act(() => {
      ref.current?.selectRepositoryMention({
        fullName: "opencompany/web",
        defaultBranch: "main",
      });
    });

    expect(await screen.findByText("@opencompany/web")).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith(
      "Use @opencompany/web",
      expect.objectContaining({ type: "doc" }),
    );
  });
});
