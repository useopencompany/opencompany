import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GoatBrainDocumentView, GoatBrainFolderView } from "@/lib/brain";
import { renameGoatBrainDocumentAction, updateGoatBrainDocumentAction } from "@/lib/brain-actions";
import { GoatBrainView } from "./GoatBrainView";

const routerMock = vi.hoisted(() => ({
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => false,
}));

vi.mock("@/components/GoatAppDataProvider", () => ({
  useGoatAppData: () => ({
    activeBrain: {
      id: "goat_brain_1",
      name: "General",
      slug: "general",
      description: null,
      visibility: "workspace",
    },
    workspace: { id: "goat_ws_1", name: "Ada's Workspace", role: "admin" },
  }),
}));

vi.mock("@/components/GoatBrainSwitcher", () => ({
  BrainAccessDialog: () => null,
}));

vi.mock("@/components/MarkdownGoatBrainEditor", () => ({
  MarkdownGoatBrainEditor: ({
    content,
    onChange,
    brainLinks,
  }: {
    content: string;
    onChange: (content: string) => void;
    brainLinks?: Record<string, string>;
  }) => {
    return (
      <div>
        <textarea
          aria-label="Brain body"
          value={content}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <div aria-hidden>
          {Object.entries(brainLinks ?? {}).map(([target, href]) => (
            <a key={target} data-testid={`brain-link:${target}`} href={href}>
              {target}
            </a>
          ))}
        </div>
      </div>
    );
  },
}));

vi.mock("@/lib/brain-actions", () => ({
  deleteGoatBrainDocumentAction: vi.fn(),
  moveGoatBrainDocumentAction: vi.fn(),
  renameGoatBrainDocumentAction: vi.fn(),
  updateGoatBrainDocumentAction: vi.fn(),
}));

describe("GoatBrainView", () => {
  it("shows an entry timeline from the selected document toolbar", async () => {
    const user = userEvent.setup();

    render(
      <GoatBrainView
        folders={folders}
        documents={[documentWithTimeline]}
        initialFolderPath="people"
        initialBrainId="ada-lovelace"
      />,
    );

    expect(
      screen.queryByText("Met Ada during the platform planning chat."),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: "Toggle timeline" }));

    expect(screen.getByRole("heading", { name: "Timeline" })).toBeInTheDocument();
    expect(screen.getByText(/Met Ada during the platform planning chat/)).toBeInTheDocument();
    expect(screen.getByText(/Source: goat-chat:goat_chat_msg_1/)).toBeInTheDocument();
  });

  it("shows derived backlinks in the details drawer", async () => {
    const user = userEvent.setup();

    render(
      <GoatBrainView
        folders={folders}
        documents={[documentWithTimeline, documentLinkingToAda]}
        initialFolderPath="people"
        initialBrainId="ada-lovelace"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Toggle file details" }));

    expect(screen.getByRole("heading", { name: "Backlinks" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Roadmap.*wiki_link/ })).toHaveAttribute(
      "href",
      "/brain/projects/roadmap",
    );
  });

  it("shows derived evidence backlinks from timeline inline links", async () => {
    const user = userEvent.setup();

    render(
      <GoatBrainView
        folders={folders}
        documents={[documentWithTimeline, evidenceDocument]}
        initialFolderPath="evidence/chat"
        initialBrainId="ev-platform-planning-chat"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Toggle file details" }));

    expect(screen.getByRole("link", { name: /Ada Lovelace.*cites/ })).toHaveAttribute(
      "href",
      "/brain/people/ada-lovelace",
    );
  });

  it("keeps outgoing sidebar links at the compact sidebar text size", async () => {
    const user = userEvent.setup();

    render(
      <GoatBrainView
        folders={folders}
        documents={[documentWithTimeline, evidenceDocument]}
        initialFolderPath="people"
        initialBrainId="ada-lovelace"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Toggle file details" }));

    const outgoingSection = screen.getByRole("heading", { name: "Outgoing" }).closest("section");
    expect(outgoingSection).not.toBeNull();

    const outgoingList = within(outgoingSection as HTMLElement).getByRole("list");
    expect(outgoingList).toHaveClass("text-[12px]", "leading-5");
    expect(screen.getByRole("link", { name: /Platform planning chat.*cites/ })).toHaveAttribute(
      "href",
      "/brain/evidence/chat/ev-platform-planning-chat",
    );
  });

  it("keeps the route brain id in generated document links", async () => {
    const user = userEvent.setup();

    render(
      <GoatBrainView
        folders={folders}
        documents={[documentWithTimeline, documentLinkingToAda]}
        initialFolderPath="people"
        initialBrainId="ada-lovelace"
        routeBrainId="goat_brain_1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Toggle file details" }));

    expect(screen.getByRole("link", { name: /Roadmap.*wiki_link/ })).toHaveAttribute(
      "href",
      "/brain/goat_brain_1/projects/roadmap",
    );
  });

  it("resolves editor wiki links for folders and folder-qualified files", () => {
    render(
      <GoatBrainView
        folders={folders}
        documents={[documentWithTimeline]}
        initialFolderPath="people"
        initialBrainId="ada-lovelace"
        routeBrainId="goat_brain_1"
      />,
    );

    expect(screen.getByTestId("brain-link:page:people")).toHaveAttribute(
      "href",
      "/brain/goat_brain_1/people",
    );
    expect(screen.getByTestId("brain-link:page:people/ada-lovelace")).toHaveAttribute(
      "href",
      "/brain/goat_brain_1/people/ada-lovelace",
    );
    expect(screen.getByTestId("brain-link:page:wiki/people/ada-lovelace")).toHaveAttribute(
      "href",
      "/brain/goat_brain_1/people/ada-lovelace",
    );
    expect(screen.getByTestId("brain-link:folder:people")).toHaveAttribute(
      "href",
      "/brain/goat_brain_1/people",
    );
  });

  it("expands the timeline inside the details sidebar", async () => {
    const user = userEvent.setup();

    render(
      <GoatBrainView
        folders={folders}
        documents={[documentWithTimeline]}
        initialFolderPath="people"
        initialBrainId="ada-lovelace"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Toggle file details" }));
    const details = screen.getByRole("complementary", { name: "File details" });

    expect(within(details).queryByText("Folder")).not.toBeInTheDocument();
    expect(within(details).queryByText("Kind")).not.toBeInTheDocument();
    expect(within(details).queryByText("MIME")).not.toBeInTheDocument();
    expect(
      within(details).queryByText(/Met Ada during the platform planning chat/),
    ).not.toBeInTheDocument();

    await user.click(within(details).getByRole("button", { name: /Timeline/ }));

    expect(
      within(details).getByText(/Met Ada during the platform planning chat/),
    ).toBeInTheDocument();
  });

  it("renames a document from the page title", async () => {
    const user = userEvent.setup();
    vi.mocked(renameGoatBrainDocumentAction).mockResolvedValueOnce({
      ok: true,
      path: "people/ada-lovelace.md",
      document: { ...documentWithTimeline, title: "Ada King" },
    });

    render(
      <GoatBrainView
        folders={folders}
        documents={[documentWithTimeline]}
        initialFolderPath="people"
        initialBrainId="ada-lovelace"
      />,
    );

    const title = screen.getByRole("textbox", { name: "Page title" });
    await user.clear(title);
    await user.type(title, "Ada King{Enter}");

    await waitFor(() => {
      expect(renameGoatBrainDocumentAction).toHaveBeenCalledWith({
        documentId: "doc_ada",
        title: "Ada King",
      });
    });
  });

  it("autosaves the body with the selected content hash after typing pauses", async () => {
    const user = userEvent.setup();
    vi.mocked(updateGoatBrainDocumentAction).mockResolvedValueOnce({
      ok: true,
      path: "people/ada-lovelace.md",
      document: { ...documentWithTimeline, body: "Updated truth.", contentHash: "hash-next" },
    });

    render(
      <GoatBrainView
        folders={folders}
        documents={[documentWithTimeline]}
        initialFolderPath="people"
        initialBrainId="ada-lovelace"
      />,
    );

    await user.clear(screen.getByRole("textbox", { name: "Brain body" }));
    await user.type(screen.getByRole("textbox", { name: "Brain body" }), "Updated truth.");

    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved");

    await waitFor(
      () => {
        expect(updateGoatBrainDocumentAction).toHaveBeenCalledWith({
          documentId: "doc_ada",
          body: "Updated truth.",
          expectedContentHash: "hash",
        });
      },
      { timeout: 4000 },
    );
    expect(updateGoatBrainDocumentAction).toHaveBeenCalledTimes(1);
  });

  it("renders nested legacy frontmatter as body text and autosaves the normalized value", async () => {
    const user = userEvent.setup();
    vi.mocked(updateGoatBrainDocumentAction).mockResolvedValueOnce({
      ok: true,
      path: "people/ada-lovelace.md",
      document: {
        ...documentWithTimeline,
        body: "Nested truth. Updated.",
        contentHash: "hash-next",
      },
    });

    render(
      <GoatBrainView
        folders={folders}
        documents={[
          {
            ...documentWithTimeline,
            body: nestedLegacyBrainBody,
            contentHash: "polluted-hash",
          },
        ]}
        initialFolderPath="people"
        initialBrainId="ada-lovelace"
      />,
    );

    const body = screen.getByRole("textbox", { name: "Brain body" });
    expect(body).toHaveValue("Nested truth.");

    await user.type(body, " Updated.");

    await waitFor(
      () => {
        expect(updateGoatBrainDocumentAction).toHaveBeenCalledWith({
          documentId: "doc_ada",
          body: "Nested truth. Updated.",
          expectedContentHash: "polluted-hash",
        });
      },
      { timeout: 4000 },
    );
  });
});

const folders: GoatBrainFolderView[] = [
  {
    id: "folder_people",
    path: "people",
    name: "People",
    source: "system",
    createdAt: "2026-07-06T12:00:00.000Z",
    updatedAt: "2026-07-06T12:00:00.000Z",
  },
];

const documentWithTimeline: GoatBrainDocumentView = {
  id: "doc_ada",
  brainId: "ada-lovelace",
  folderPath: "people",
  path: "people/ada-lovelace.md",
  title: "Ada Lovelace",
  content: "",
  body: "Compiler and collaborator.",
  timeline: [
    {
      evidenceId: "ev-platform-planning-chat",
      at: "2026-07-06T12:00:00.000Z",
      body: "[[evidence:ev-platform-planning-chat|Platform planning chat]]: Met Ada during the platform planning chat.\n\nSource: goat-chat:goat_chat_msg_1",
    },
  ],
  format: "markdown",
  mimeType: "text/markdown",
  originalFileName: null,
  assetStorageKey: null,
  relations: [],
  sources: [],
  kind: "page",
  type: "person",
  status: "draft",
  aliases: [],
  contentHash: "hash",
  sizeBytes: 128,
  createdAt: "2026-07-06T12:00:00.000Z",
  updatedAt: "2026-07-06T12:00:00.000Z",
};

const documentLinkingToAda: GoatBrainDocumentView = {
  id: "doc_roadmap",
  brainId: "roadmap",
  folderPath: "projects",
  path: "projects/roadmap.md",
  title: "Roadmap",
  content: "",
  body: "Coordinate with [[page:ada-lovelace|Ada]].",
  timeline: [],
  format: "markdown",
  mimeType: "text/markdown",
  originalFileName: null,
  assetStorageKey: null,
  relations: [],
  sources: [],
  kind: "page",
  type: "project",
  status: "draft",
  aliases: [],
  contentHash: "hash",
  sizeBytes: 128,
  createdAt: "2026-07-06T12:00:00.000Z",
  updatedAt: "2026-07-06T12:00:00.000Z",
};

const evidenceDocument: GoatBrainDocumentView = {
  id: "doc_evidence_platform_planning_chat",
  brainId: "ev-platform-planning-chat",
  folderPath: "evidence/chat",
  path: "evidence/chat/ev-platform-planning-chat.md",
  title: "Platform planning chat",
  content: "",
  body: "Met Ada during the platform planning chat.",
  timeline: [],
  format: "markdown",
  mimeType: "text/markdown",
  originalFileName: null,
  assetStorageKey: null,
  relations: [],
  sources: [],
  kind: "evidence",
  type: "source",
  status: "active",
  aliases: [],
  contentHash: "hash",
  sizeBytes: 128,
  createdAt: "2026-07-06T12:00:00.000Z",
  updatedAt: "2026-07-06T12:00:00.000Z",
};

const nestedLegacyBrainBody = `---
id: nested-note
folder: inbox
kind: page
type: note
status: draft
title: Nested note
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
related: []
---

# Nested note

## Compiled truth
Nested truth.

<!-- TIMELINE:BELOW - append only past this marker -->

## Timeline
`;
