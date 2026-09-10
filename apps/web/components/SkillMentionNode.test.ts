// @vitest-environment jsdom
import { extractWorkflowSkillMentionRefs } from "@opencompany/agent/workflow-skill-mentions";
import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SkillCatalogItem } from "@/lib/skills";
import { SkillMention, skillMentionContent } from "./SkillMentionNode";

const SKILL: SkillCatalogItem = {
  scope: "company",
  id: "skill_installation_0123456789abcdef",
  name: "feature-blog-post",
  description: "Draft a feature announcement",
};
const TOKEN = `@skill/${SKILL.id}`;
const editors: Editor[] = [];

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function makeEditor(content: string, skills = [SKILL]) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit, Markdown, SkillMention.configure({ skills })],
    content,
    contentType: "markdown",
  });
  editors.push(editor);
  return editor;
}

function chips(editor: Editor) {
  return Array.from(editor.view.dom.querySelectorAll("[data-skill-mention]"));
}

describe("skill mention identity and presentation", () => {
  it.each([`Use **${TOKEN}**.`, `Use *${TOKEN}*.`, `Use (${TOKEN}).`])(
    "extracts the same reference that the editor renders and saves: %s",
    (input) => {
      const editor = makeEditor(input);
      expect(chips(editor).map((chip) => chip.textContent)).toEqual(["@feature-blog-post"]);
      const saved = editor.getMarkdown();
      expect(extractWorkflowSkillMentionRefs(saved)).toEqual([{ id: SKILL.id }]);
      const reopened = makeEditor(saved);
      expect(chips(reopened)).toHaveLength(1);
      expect(extractWorkflowSkillMentionRefs(reopened.getMarkdown())).toEqual([{ id: SKILL.id }]);
    },
  );

  it.each([
    "https://example.com/@skill/url-example",
    "<https://example.com/@skill/url-example>",
    "www.example.com/@skill/url-example",
  ])("does not activate URL text the editor renders as a link: %s", (input) => {
    const editor = makeEditor(input);
    expect(chips(editor)).toHaveLength(0);
    expect(extractWorkflowSkillMentionRefs(editor.getMarkdown())).toEqual([]);
  });

  it("does not activate literal code examples after saving and reopening", () => {
    const editor = makeEditor(`Example: \`use ${TOKEN}\`.\n\n\`\`\`text\n${TOKEN}\n\`\`\``);
    expect(chips(editor)).toHaveLength(0);
    expect(extractWorkflowSkillMentionRefs(editor.getMarkdown())).toEqual([]);
    const reopened = makeEditor(editor.getMarkdown());
    expect(chips(reopened)).toHaveLength(0);
    expect(extractWorkflowSkillMentionRefs(reopened.getMarkdown())).toEqual([]);
  });

  it("loads a saved installation reference as an atomic named chip and round-trips its ID", () => {
    const input = `Use ${TOKEN}.`;
    const editor = makeEditor(input);
    expect(chips(editor).map((chip) => chip.textContent)).toEqual(["@feature-blog-post"]);
    expect(editor.state.doc.firstChild?.child(1).isAtom).toBe(true);
    expect(editor.getMarkdown()).toBe(input);
  });

  it("repairs escaped IDs saved by the previous editor", () => {
    const editor = makeEditor(`Use ${TOKEN.replaceAll("_", "\\_")}.`);
    expect(chips(editor).map((chip) => chip.textContent)).toEqual(["@feature-blog-post"]);
    expect(editor.getMarkdown()).toBe(`Use ${TOKEN}.`);
  });

  it("uses the current catalog name when a saved workflow reopens after a rename", () => {
    const editor = makeEditor(TOKEN, [{ ...SKILL, name: "renamed-skill" }]);
    expect(chips(editor)[0]?.textContent).toBe("@renamed-skill");
    expect(editor.getMarkdown()).toBe(TOKEN);
  });

  it("preserves unavailable references without inventing a name", () => {
    const editor = makeEditor(TOKEN, []);
    expect(chips(editor)[0]?.textContent).toBe(TOKEN);
    expect(chips(editor)[0]?.getAttribute("title")).toBe("This skill is unavailable");
    expect(editor.getMarkdown()).toBe(TOKEN);
  });

  it("resolves legacy names only when unambiguous, keeping same-named installations distinct", () => {
    const duplicate = { ...SKILL, id: "skill_installation_other" };
    const input = `${TOKEN} @skill/${duplicate.id} @skill/feature-blog-post`;
    const editor = makeEditor(input, [SKILL, duplicate]);
    expect(chips(editor).map((chip) => chip.textContent)).toEqual([
      "@feature-blog-post",
      "@feature-blog-post",
      "@skill/feature-blog-post",
    ]);
    expect(editor.getMarkdown()).toBe(input);
    expect(chips(makeEditor("@skill/feature-blog-post"))[0]?.textContent).toBe(
      "@feature-blog-post",
    );
  });

  it("leaves mention-looking text in code literal", () => {
    const input = `Inline \`${TOKEN}\`\n\n\`\`\`text\n${TOKEN}\n\`\`\``;
    const editor = makeEditor(input);
    expect(chips(editor)).toHaveLength(0);
    expect(editor.getMarkdown()).toBe(input);
  });

  it("preserves IDs in clipboard HTML and plain text", () => {
    const editor = makeEditor(TOKEN);
    expect(editor.getText()).toBe(TOKEN);
    expect(editor.getHTML()).toContain(`data-skill-mention="${SKILL.id}"`);
    const pasted = makeEditor("");
    pasted.commands.insertContent(editor.getHTML());
    expect(pasted.getMarkdown()).toBe(TOKEN);
    expect(chips(pasted)[0]?.textContent).toBe("@feature-blog-post");
  });

  it("undoes and redoes insertion without changing the reference", () => {
    const editor = makeEditor("Before ");
    editor.commands.insertContentAt(8, skillMentionContent(SKILL));
    expect(chips(editor)).toHaveLength(1);
    editor.commands.undo();
    expect(chips(editor)).toHaveLength(0);
    editor.commands.redo();
    expect(chips(editor)[0]?.textContent).toBe("@feature-blog-post");
    expect(editor.getMarkdown()).toContain(TOKEN);
  });
});
