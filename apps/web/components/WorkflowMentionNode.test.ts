// @vitest-environment jsdom
import { extractWorkflowMentionIds } from "@opencompany/agent/workflow-skill-mentions";
import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  filterWorkflowMentionItems,
  WorkflowMention,
  type WorkflowMentionItem,
  workflowMentionContent,
} from "./WorkflowMentionNode";

const REVIEW: WorkflowMentionItem = {
  id: "review-pr",
  name: "Review PR",
  description: "Review a pull request and comment the findings.",
  active: true,
};
const DRAFT: WorkflowMentionItem = {
  id: "notify-team",
  name: "Notify team",
  description: "",
  active: false,
};
const editors: Editor[] = [];

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function makeEditor(content: string, workflows = [REVIEW, DRAFT]) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit, Markdown, WorkflowMention.configure({ workflows })],
    content,
    contentType: "markdown",
  });
  editors.push(editor);
  return editor;
}

function chips(editor: Editor) {
  return Array.from(editor.view.dom.querySelectorAll<HTMLElement>("[data-workflow-mention]"));
}

describe("workflow mention identity and presentation", () => {
  it("renders the chat handle and saves the slug the runner grants", () => {
    const editor = makeEditor("When the PR is open, start **@workflow/review-pr**.");
    expect(chips(editor).map((chip) => chip.textContent)).toEqual(["#review-pr"]);

    const saved = editor.getMarkdown();
    expect(saved).toContain("@workflow/review-pr");
    expect(extractWorkflowMentionIds(saved)).toEqual(["review-pr"]);
    expect(chips(makeEditor(saved))).toHaveLength(1);
  });

  it("tells the author when a mention cannot start anything yet", () => {
    const editor = makeEditor("Then @workflow/notify-team and @workflow/archived-one.");
    const [draft, missing] = chips(editor);
    expect(draft?.title).toContain("is a draft");
    expect(missing?.textContent).toBe("@workflow/archived-one");
    expect(missing?.title).toBe("This workflow is unavailable");
  });

  it("keeps code examples literal", () => {
    const editor = makeEditor("Example: `@workflow/review-pr`.");
    expect(chips(editor)).toHaveLength(0);
    expect(extractWorkflowMentionIds(editor.getMarkdown())).toEqual([]);
  });

  it("inserts a chip followed by a space", () => {
    const editor = makeEditor("");
    editor.commands.insertContent(workflowMentionContent(REVIEW));
    expect(editor.getMarkdown().trim()).toBe("@workflow/review-pr");
  });
});

describe("filterWorkflowMentionItems", () => {
  it("matches name, slug, and description", () => {
    expect(filterWorkflowMentionItems([REVIEW, DRAFT], "comment")).toEqual([REVIEW]);
    expect(filterWorkflowMentionItems([REVIEW, DRAFT], "notify")).toEqual([DRAFT]);
    expect(filterWorkflowMentionItems([REVIEW, DRAFT], "")).toEqual([REVIEW, DRAFT]);
  });
});
