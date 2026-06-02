import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentEditor, type AgentEditorHandle } from "./AgentEditor";
import { buildAgentMentionItems } from "./tools";

const repositoryBinding = {
  provider: "github" as const,
  resourceType: "repository" as const,
  externalId: "repo_123",
  displayName: "opencompany/web",
  connection: {
    externalId: "install_123",
    label: "OpenCompany",
    accountName: "opencompany",
    accountType: "Organization",
  },
};

describe("AgentEditor", () => {
  it("persists selected mention attrs and body text", async () => {
    const user = userEvent.setup();
    const captured: Array<{ body: string; content: unknown }> = [];

    const { container } = render(
      <AgentEditor
        initialBody=""
        mentionItems={buildAgentMentionItems()}
        onChange={(body, content) =>
          captured.push({ body, content: JSON.parse(JSON.stringify(content)) })
        }
      />,
    );
    const editor = container.querySelector(".ProseMirror");
    expect(editor).toBeInstanceOf(HTMLElement);

    (editor as HTMLElement).focus();
    await user.keyboard("@amp");
    await user.click(await screen.findByRole("option", { name: /amp/i }));

    expect(await screen.findByText("@amp")).toBeInTheDocument();
    expect(captured.at(-1)?.body).toBe("@amp");
    const mention = (
      captured.at(-1)?.content as {
        content?: Array<{ content?: Array<{ attrs?: Record<string, unknown>; type?: string }> }>;
      }
    )?.content?.[0]?.content?.[0];
    expect(mention).toMatchObject({
      attrs: {
        id: "tool:amp",
        label: "amp",
      },
      type: "mention",
    });
  });

  it("opens schedule actions without inserting a blank mention", async () => {
    const user = userEvent.setup();
    const captured: Array<{ body: string; content: unknown }> = [];
    const onMentionSelect = vi.fn();

    const { container } = render(
      <AgentEditor
        initialBody=""
        mentionItems={buildAgentMentionItems()}
        onMentionSelect={onMentionSelect}
        onChange={(body, content) =>
          captured.push({ body, content: JSON.parse(JSON.stringify(content)) })
        }
      />,
    );
    const editor = container.querySelector(".ProseMirror");
    expect(editor).toBeInstanceOf(HTMLElement);

    (editor as HTMLElement).focus();
    await user.keyboard("@run");
    await user.click(await screen.findByRole("option", { name: /run every/i }));

    expect(onMentionSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "schedule", mentionId: "schedule:run-every" }),
    );
    expect(screen.queryByText("@run-every")).not.toBeInTheDocument();
    expect(container.querySelector(".agent-mention[data-kind='schedule']")).not.toBeInTheDocument();
    expect(captured.at(-1)?.body ?? "").toBe("");
  });

  it("persists selected repository mention attrs and body text", async () => {
    const user = userEvent.setup();
    const captured: Array<{ body: string; content: unknown }> = [];

    const { container } = render(
      <AgentEditor
        initialBody=""
        mentionItems={buildAgentMentionItems([
          { fullName: "opencompany/web", defaultBranch: "main", binding: repositoryBinding },
        ])}
        onChange={(body, content) =>
          captured.push({ body, content: JSON.parse(JSON.stringify(content)) })
        }
      />,
    );
    const editor = container.querySelector(".ProseMirror");
    expect(editor).toBeInstanceOf(HTMLElement);

    (editor as HTMLElement).focus();
    await user.keyboard("@opencompany/web");
    await user.click(await screen.findByRole("option", { name: /opencompany\/web/i }));

    expect(await screen.findByText("@opencompany/web")).toBeInTheDocument();
    expect(captured.at(-1)?.body).toBe("@opencompany/web");
    const mention = (
      captured.at(-1)?.content as {
        content?: Array<{ content?: Array<{ attrs?: Record<string, unknown>; type?: string }> }>;
      }
    )?.content?.[0]?.content?.[0];
    expect(mention).toMatchObject({
      attrs: {
        id: "integration:github:opencompany-web:install_123:repo_123",
        label: "opencompany/web",
        binding: repositoryBinding,
      },
      type: "mention",
    });
  });

  it("uses repository mention items that arrive after the editor mounts", async () => {
    const user = userEvent.setup();
    const captured: Array<{ body: string; content: unknown }> = [];

    const { container, rerender } = render(
      <AgentEditor
        initialBody=""
        mentionItems={buildAgentMentionItems()}
        onChange={(body, content) =>
          captured.push({ body, content: JSON.parse(JSON.stringify(content)) })
        }
      />,
    );
    const editor = container.querySelector(".ProseMirror");
    expect(editor).toBeInstanceOf(HTMLElement);

    rerender(
      <AgentEditor
        initialBody=""
        mentionItems={buildAgentMentionItems([
          { fullName: "opencompany/web", defaultBranch: "main" },
        ])}
        onChange={(body, content) =>
          captured.push({ body, content: JSON.parse(JSON.stringify(content)) })
        }
      />,
    );

    (editor as HTMLElement).focus();
    await user.keyboard("@opencompany/web");
    await user.click(await screen.findByRole("option", { name: /opencompany\/web/i }));

    expect(captured.at(-1)?.body).toBe("@opencompany/web");
  });

  it("persists mention attrs when selecting through a category", async () => {
    const user = userEvent.setup();
    const captured: Array<{ body: string; content: unknown }> = [];

    const { container } = render(
      <AgentEditor
        initialBody=""
        mentionItems={buildAgentMentionItems()}
        onChange={(body, content) =>
          captured.push({ body, content: JSON.parse(JSON.stringify(content)) })
        }
      />,
    );
    const editor = container.querySelector(".ProseMirror");
    expect(editor).toBeInstanceOf(HTMLElement);

    (editor as HTMLElement).focus();
    await user.keyboard("@");
    await user.click(await screen.findByRole("option", { name: /tools/i }));
    await user.click(await screen.findByRole("option", { name: /amp/i }));

    expect(await screen.findByText("@amp")).toBeInTheDocument();
    expect(captured.at(-1)?.body).toBe("@amp");
    const mention = (
      captured.at(-1)?.content as {
        content?: Array<{ content?: Array<{ attrs?: Record<string, unknown>; type?: string }> }>;
      }
    )?.content?.[0]?.content?.[0];
    expect(mention).toMatchObject({
      attrs: {
        id: "tool:amp",
        label: "amp",
      },
      type: "mention",
    });
  });

  it("rebuilds from the saved body when persisted mention attrs cannot render", async () => {
    render(
      <AgentEditor
        initialBody="Use @amp for code changes."
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

    expect(await screen.findByText("@amp")).toBeInTheDocument();
    expect(screen.queryByText("@null")).not.toBeInTheDocument();
  });

  it("rebuilds from the saved body when persisted content is stale", async () => {
    render(
      <AgentEditor
        initialBody="Use @amp for code changes."
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

    expect(await screen.findByText("@amp")).toBeInTheDocument();
    expect(screen.queryByText(/^@$/)).not.toBeInTheDocument();
  });

  it("rebuilds from the saved body when persisted content flattened mentions to text", async () => {
    const { container } = render(
      <AgentEditor
        initialBody="Use @amp for code changes."
        initialContent={{
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Use @amp for code changes." }],
            },
          ],
        }}
        mentionItems={buildAgentMentionItems()}
        onChange={vi.fn()}
      />,
    );

    expect(await screen.findByText("@amp")).toBeInTheDocument();
    expect(container.querySelector(".agent-mention[data-kind='tool']")).toBeInTheDocument();
  });

  it("renders typed mention ids instead of stale display labels", async () => {
    render(
      <AgentEditor
        initialBody="Use @amp for code changes."
        initialContent={{
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Use " },
                {
                  type: "mention",
                  attrs: { id: "tool:amp", label: "AMP", mentionSuggestionChar: "@" },
                },
                { type: "text", text: " for code changes." },
              ],
            },
          ],
        }}
        mentionItems={buildAgentMentionItems()}
        onChange={vi.fn()}
      />,
    );

    expect(await screen.findByText("@amp")).toBeInTheDocument();
    expect(screen.queryByText("@AMP")).not.toBeInTheDocument();
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

  it("converts pasted plain text containing mentions into mention nodes", async () => {
    const user = userEvent.setup();
    const captured: Array<{ body: string; content: unknown }> = [];

    const { container } = render(
      <AgentEditor
        initialBody=""
        mentionItems={buildAgentMentionItems()}
        onChange={(body, content) =>
          captured.push({ body, content: JSON.parse(JSON.stringify(content)) })
        }
      />,
    );
    const editor = container.querySelector(".ProseMirror") as HTMLElement;
    editor.focus();

    await user.paste("Use @amp for code changes.");

    expect(await screen.findByText("@amp")).toBeInTheDocument();
    expect(captured.at(-1)?.body).toBe("Use @amp for code changes.");

    const paragraph = (
      captured.at(-1)?.content as {
        content?: Array<{ content?: Array<{ type?: string; attrs?: Record<string, unknown> }> }>;
      }
    )?.content?.[0];
    const mention = paragraph?.content?.find((node) => node.type === "mention");
    expect(mention).toMatchObject({
      type: "mention",
      attrs: { id: "tool:amp", label: "amp" },
    });
  });

  it("renders markdown headings and lists from initial body", async () => {
    const { container } = render(
      <AgentEditor
        initialBody={
          "### Notes\n\n- first\n- second\n\n1. step one\n2. step two\n\nA closing paragraph."
        }
        mentionItems={buildAgentMentionItems()}
        onChange={vi.fn()}
      />,
    );

    const heading = await screen.findByRole("heading", { level: 3, name: "Notes" });
    expect(heading).toBeInTheDocument();

    const bulletItems = container.querySelectorAll(".tiptap-agent ul li");
    expect(bulletItems).toHaveLength(2);
    expect(bulletItems[0]?.textContent).toBe("first");
    expect(bulletItems[1]?.textContent).toBe("second");

    const orderedItems = container.querySelectorAll(".tiptap-agent ol li");
    expect(orderedItems).toHaveLength(2);
    expect(orderedItems[0]?.textContent).toBe("step one");
    expect(orderedItems[1]?.textContent).toBe("step two");

    const paragraphs = container.querySelectorAll(".tiptap-agent > p");
    expect(paragraphs[paragraphs.length - 1]?.textContent).toBe("A closing paragraph.");
  });

  it("preserves the start number of an ordered list when loading markdown", async () => {
    const { container } = render(
      <AgentEditor
        initialBody={"3. step three\n4. step four"}
        mentionItems={buildAgentMentionItems()}
        onChange={vi.fn()}
      />,
    );

    const list = await screen.findByRole("list");
    expect(list.tagName).toBe("OL");
    expect(list.getAttribute("start")).toBe("3");
    const items = container.querySelectorAll(".tiptap-agent ol li");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe("step three");
    expect(items[1]?.textContent).toBe("step four");
  });

  it("re-renders an empty heading after a save → reload round-trip", async () => {
    // `tiptapDocToBody` trims trailing whitespace, so an empty H2 persists as
    // "##" rather than "## ". The parser must still treat that as a heading.
    const { container } = render(
      <AgentEditor initialBody={"##"} mentionItems={buildAgentMentionItems()} onChange={vi.fn()} />,
    );

    const heading = await screen.findByRole("heading", { level: 2 });
    expect(heading).toBeInTheDocument();
    expect(container.querySelector(".tiptap-agent h2")).toBeInTheDocument();
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
