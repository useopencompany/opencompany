import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GoatBrainDocumentView, GoatBrainFolderView } from "@/lib/brain";
import { updateGoatBrainDocumentAction } from "@/lib/brain-actions";
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

vi.mock("@/components/MarkdownGoatBrainEditor", () => ({
  MarkdownGoatBrainEditor: ({
    content,
    onChange,
  }: {
    content: string;
    onChange: (content: string) => void;
  }) => (
    <textarea
      aria-label="Brain body"
      value={content}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

vi.mock("@/lib/brain-actions", () => ({
  createGoatBrainDocumentAction: vi.fn(),
  createGoatBrainFolderAction: vi.fn(),
  deleteGoatBrainDocumentAction: vi.fn(),
  moveGoatBrainDocumentAction: vi.fn(),
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

  it("passes the selected content hash when saving a document", async () => {
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
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateGoatBrainDocumentAction).toHaveBeenCalledWith({
        documentId: "doc_ada",
        body: "Updated truth.",
        expectedContentHash: "hash",
      });
    });
    expect(routerMock.replace).toHaveBeenCalledWith("/brain/people/ada-lovelace");
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
  kind: "markdown",
  mimeType: "text/markdown",
  originalFileName: null,
  assetStorageKey: null,
  relations: [],
  sources: [],
  type: "person",
  status: "draft",
  aliases: [],
  tags: [],
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
  kind: "markdown",
  mimeType: "text/markdown",
  originalFileName: null,
  assetStorageKey: null,
  relations: [],
  sources: [],
  type: "project",
  status: "draft",
  aliases: [],
  tags: [],
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
  kind: "markdown",
  mimeType: "text/markdown",
  originalFileName: null,
  assetStorageKey: null,
  relations: [],
  sources: [],
  type: "evidence",
  evidenceKind: "chat",
  status: "active",
  aliases: [],
  tags: [],
  contentHash: "hash",
  sizeBytes: 128,
  createdAt: "2026-07-06T12:00:00.000Z",
  updatedAt: "2026-07-06T12:00:00.000Z",
};
