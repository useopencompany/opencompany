import { describe, expect, it } from "vitest";
import { buildConfigMentionResolver } from "./mentions";
import { buildAgentTiptapDoc, type MentionResolver } from "./tiptap-builder";
import type { AgentConfig } from "./types";

// Mirror of the web editor's `tiptapDocToBody`/`nodeText` so the round-trip
// assertions below match exactly what the agent detail page compares against.
function mentionIdDisplayText(id: string) {
  if (id.startsWith("tool:")) return id.slice("tool:".length);
  if (id.startsWith("model:")) return id.slice("model:".length);
  if (id.startsWith("brain/")) return id;
  if (id.startsWith("agent/")) return id;
  if (id === "integration:github") return "github";
  if (id === "after-session") return "after-session";
  return "";
}

type Node = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
};

function nodeText(node: Node): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") {
    const id = typeof node.attrs?.id === "string" ? node.attrs.id : "";
    const label = typeof node.attrs?.label === "string" ? node.attrs.label : "";
    const idDisplay = mentionIdDisplayText(id);
    const display = idDisplay.length > 0 ? idDisplay : label.trim();
    const char =
      typeof node.attrs?.mentionSuggestionChar === "string"
        ? node.attrs.mentionSuggestionChar
        : "@";
    return display.length > 0 ? `${char}${display}` : "";
  }
  if (node.type === "heading") {
    const level = typeof node.attrs?.level === "number" ? node.attrs.level : 1;
    const inner = (node.content ?? []).map(nodeText).join("");
    return `${"#".repeat(level)} ${inner}`;
  }
  if (node.type === "bulletList" || node.type === "orderedList") {
    const ordered = node.type === "orderedList";
    const start = ordered && typeof node.attrs?.start === "number" ? node.attrs.start : 1;
    return (node.content ?? [])
      .map((item, index) => {
        const marker = ordered ? `${start + index}.` : "-";
        const inner = (item.content ?? []).map(nodeText).join("\n");
        return `${marker} ${inner}`;
      })
      .join("\n");
  }
  if (node.type === "listItem") return (node.content ?? []).map(nodeText).join("\n");
  return (node.content ?? []).map(nodeText).join("");
}

function tiptapDocToBody(doc: { content?: Node[] }) {
  return (doc.content ?? [])
    .map((node) => nodeText(node))
    .join("\n\n")
    .replace(/\s+$/g, "");
}

function collectMentions(doc: { content?: Node[] }): Node[] {
  const out: Node[] = [];
  const walk = (node: Node) => {
    if (node.type === "mention") out.push(node);
    (node.content ?? []).forEach(walk);
  };
  (doc.content ?? []).forEach(walk);
  return out;
}

// A resolver that pills every recognized form, used for parser-shape tests.
const passthrough: MentionResolver = (token, char) => {
  if (char === "#") return token === "after-session" ? { id: "after-session", label: token } : null;
  if (token.startsWith("brain/")) return { id: token, label: token };
  return { id: `tool:${token}`, label: token };
};

describe("buildAgentTiptapDoc", () => {
  it("parses headings, lists, hard breaks and round-trips", () => {
    const body = "# Title\n\nFirst line\nSecond line\n\n- one\n- two\n\n1. a\n2. b";
    const doc = buildAgentTiptapDoc(body, () => null);
    expect(tiptapDocToBody(doc)).toBe(body);
  });

  it("keeps a heading-marked line a heading but treats #after-session as a mention", () => {
    const doc = buildAgentTiptapDoc("# Heading\n\n#after-session", passthrough);
    const blocks = doc.content ?? [];
    expect(blocks[0]?.type).toBe("heading");
    const mentions = collectMentions(doc);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.attrs).toMatchObject({ id: "after-session", mentionSuggestionChar: "#" });
  });

  it("strips trailing punctuation from a mention token and keeps it as text", () => {
    const doc = buildAgentTiptapDoc("Use @exa.", passthrough);
    const mentions = collectMentions(doc);
    expect(mentions[0]?.attrs).toMatchObject({ id: "tool:exa", label: "exa" });
    expect(tiptapDocToBody(doc)).toBe("Use @exa.");
  });
});

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaVersion: "agent.v1",
    title: "Test",
    instructions: "",
    model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
    tools: [],
    brain: [],
    agents: [],
    integrations: { github: { repositories: [] } },
    triggers: [],
    ...overrides,
  };
}

describe("buildConfigMentionResolver", () => {
  it("resolves tool, brain, github, agent and after-session mentions to web-equivalent pills", () => {
    const resolve = buildConfigMentionResolver(
      config({
        agents: [{ path: "agents/helper/helper.agent", name: "Helper" }],
        integrations: {
          github: {
            repositories: [
              { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" },
            ],
          },
        },
      }),
    );

    expect(resolve("exa", "@")).toEqual({ id: "tool:exa", label: "exa" });
    expect(resolve("brain/notes.md", "@")).toEqual({
      id: "brain/notes.md",
      label: "brain/notes.md",
    });
    expect(resolve("github", "@")).toEqual({ id: "integration:github", label: "github" });
    expect(resolve("agent/helper", "@")).toEqual({ id: "agent/helper", label: "agent/helper" });
    expect(resolve("opencompany/web", "@")).toEqual({
      id: "integration:github:opencompany-web",
      label: "opencompany/web",
    });
    expect(resolve("after-session", "#")).toEqual({ id: "after-session", label: "after-session" });
  });

  it("builds a doc whose pills round-trip with the stored body", () => {
    const body = "Use @exa and read @brain/notes.md.";
    const resolve = buildConfigMentionResolver(
      config({ brain: [{ path: "notes.md", type: "file" }] }),
    );
    const doc = buildAgentTiptapDoc(body, resolve);
    expect(tiptapDocToBody(doc)).toBe(body);
    const mentions = collectMentions(doc);
    expect(mentions.map((m) => m.attrs?.id)).toEqual(["tool:exa", "brain/notes.md"]);
  });

  it("declines tokens whose rendered display would not equal the body token", () => {
    const resolve = buildConfigMentionResolver(
      config({ agents: [{ path: "agents/helper/helper.agent", name: "Helper" }] }),
    );
    // A name-form agent mention would render as "@agent/helper", not "@Helper",
    // so it is left as plain text to preserve the whole-doc round-trip.
    expect(resolve("Helper", "@")).toBeNull();
    // Case-mismatched tool token likewise.
    expect(resolve("Exa", "@")).toBeNull();
  });
});
