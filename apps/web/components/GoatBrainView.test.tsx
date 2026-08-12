import "@testing-library/jest-dom/vitest";
import type { BrainDocumentDto } from "@opencompany/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoatBrainDocumentView, GoatBrainFolderView } from "@/lib/brain";
import {
  createHeadlessBrainDocument,
  createHeadlessBrainFolder,
  deleteHeadlessBrainFolder,
  renameHeadlessBrainDocument,
  renameHeadlessBrainFolder,
  updateHeadlessBrainDocument,
} from "@/lib/headless-knowledge-commands";
import { GoatBrainView } from "./GoatBrainView";

const routerMock = vi.hoisted(() => ({
  replace: vi.fn(),
}));
const workspaceRoleMock = vi.hoisted(() => ({
  value: "admin" as "admin" | "member",
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
    workspace: {
      id: "goat_ws_1",
      name: "Ada's Workspace",
      role: workspaceRoleMock.value,
    },
    workspaces: [
      {
        id: "goat_ws_1",
        name: "Ada's Workspace",
        role: workspaceRoleMock.value,
      },
    ],
    workspaceMembers: [],
  }),
}));

vi.mock("@/components/GoatBrainSwitcher", () => ({
  BrainAccessDialog: () => null,
}));

vi.mock("@/components/GoatBrainActivity", () => ({
  GoatBrainActivity: ({ brainRef }: { brainRef: string }) => (
    <span data-testid="brain-activity">{brainRef}</span>
  ),
  GoatBrainRecentActivity: () => null,
}));

vi.mock("@/components/GoatBrainOverview", () => ({
  GoatBrainOverview: ({ brainName }: { brainName: string }) => (
    <div data-testid="brain-overview">{brainName}</div>
  ),
}));

vi.mock("@/components/GoatBrainImport", () => ({
  GoatBrainImport: ({ brainRef }: { brainRef: string }) => (
    <span data-testid="brain-import">{brainRef}</span>
  ),
}));

vi.mock("@/components/MarkdownGoatBrainEditor", () => ({
  MarkdownGoatBrainEditor: ({
    content,
    onChange,
    brainLinks,
    readOnly,
  }: {
    content: string;
    onChange: (content: string) => void;
    brainLinks?: Record<string, string>;
    readOnly?: boolean;
  }) => {
    return (
      <div>
        <textarea
          aria-label="Brain body"
          value={content}
          disabled={readOnly}
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

vi.mock("@/lib/headless-knowledge-commands", () => ({
  createHeadlessBrainDocument: vi.fn(),
  createHeadlessBrainFolder: vi.fn(),
  deleteHeadlessBrainDocument: vi.fn(),
  deleteHeadlessBrainFolder: vi.fn(),
  renameHeadlessBrainDocument: vi.fn(),
  renameHeadlessBrainFolder: vi.fn(),
  updateHeadlessBrainDocument: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  workspaceRoleMock.value = "admin";
});

const defaultBrain = {
  id: "goat_brain_1",
  name: "General",
  slug: "general",
  description: null,
  visibility: "workspace" as const,
};

describe("GoatBrainView", () => {
  it("opens on Overview and returns to the folder browser when a folder is selected", async () => {
    const user = userEvent.setup();
    window.history.pushState(null, "", "/brain/goat_brain_1");
    const replaceState = vi.spyOn(window.history, "replaceState");

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
        folders={folders}
        documents={[documentWithTimeline]}
        initialFolderPath={null}
        initialBrainId={null}
        initialOverview
      />,
    );

    expect(screen.getByTestId("brain-overview")).toHaveTextContent("General");
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await user.click(screen.getByRole("treeitem", { name: /people/i }));

    expect(screen.queryByTestId("brain-overview")).not.toBeInTheDocument();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/brain/people");
    replaceState.mockRestore();
  });

  it("shows an entry timeline from the selected document toolbar", async () => {
    const user = userEvent.setup();

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
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
    const evidenceAboutAda = {
      ...evidenceDocument,
      relations: [{ type: "about", to: "ada-lovelace" }],
    };

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
        folders={folders}
        documents={[documentWithTimeline, documentLinkingToAda, evidenceAboutAda]}
        initialFolderPath="people"
        initialBrainId="ada-lovelace"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Toggle file details" }));

    expect(screen.getByRole("heading", { name: "Backlinks" })).toBeInTheDocument();
    const backlinksSection = screen.getByRole("heading", { name: "Backlinks" }).closest("section");
    expect(backlinksSection).not.toBeNull();
    expect(within(backlinksSection as HTMLElement).getByText("1")).toBeInTheDocument();
    expect(
      within(backlinksSection as HTMLElement).getByRole("link", {
        name: /Roadmap.*wiki_link/,
      }),
    ).toHaveAttribute("href", "/brain/projects/roadmap");
    expect(
      within(backlinksSection as HTMLElement).queryByRole("link", {
        name: /Platform planning chat.*about/,
      }),
    ).not.toBeInTheDocument();
    const evidenceSection = screen.getByRole("heading", { name: "Evidence" }).closest("section");
    expect(evidenceSection).not.toBeNull();
    expect(
      within(evidenceSection as HTMLElement).getByRole("link", {
        name: /Platform planning chat.*cites, about/,
      }),
    ).toHaveAttribute("href", "/brain/evidence/chat/ev-platform-planning-chat");
  });

  it("shows derived evidence backlinks from timeline inline links", async () => {
    const user = userEvent.setup();

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
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

  it("shows evidence separately from compact outgoing page links", async () => {
    const user = userEvent.setup();

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
        folders={folders}
        documents={[documentWithTimeline, evidenceDocument]}
        initialFolderPath="people"
        initialBrainId="ada-lovelace"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Toggle file details" }));

    const outgoingSection = screen.getByRole("heading", { name: "Outgoing" }).closest("section");
    expect(outgoingSection).not.toBeNull();
    expect(within(outgoingSection as HTMLElement).getByText("0")).toBeInTheDocument();
    expect(
      within(outgoingSection as HTMLElement).getByText("No outgoing links."),
    ).toBeInTheDocument();

    const evidenceSection = screen.getByRole("heading", { name: "Evidence" }).closest("section");
    expect(evidenceSection).not.toBeNull();
    const evidenceList = within(evidenceSection as HTMLElement).getByRole("list");
    expect(evidenceList).toHaveClass("text-[12px]", "leading-5");
    expect(
      within(evidenceSection as HTMLElement).getByRole("link", {
        name: /Platform planning chat.*cites/,
      }),
    ).toHaveAttribute("href", "/brain/evidence/chat/ev-platform-planning-chat");
  });

  it("keeps the route brain id in generated document links", async () => {
    const user = userEvent.setup();

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
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

  it("selects same-brain documents instantly and syncs the URL with browser history", async () => {
    const user = userEvent.setup();
    window.history.pushState(null, "", "/brain/people/ada-lovelace");
    const replaceState = vi.spyOn(window.history, "replaceState");

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
        folders={folders}
        documents={[documentWithTimeline, documentLinkingToAda]}
        initialFolderPath="people"
        initialBrainId="ada-lovelace"
      />,
    );

    expect(screen.getByRole("textbox", { name: "Brain body" })).toHaveValue(
      "Compiler and collaborator.",
    );

    await user.click(screen.getByRole("treeitem", { name: /projects/i }));
    await user.click(screen.getByRole("treeitem", { name: /roadmap\.md/i }));

    expect(screen.getByRole("textbox", { name: "Brain body" })).toHaveValue(
      "Coordinate with [[page:ada-lovelace|Ada]].",
    );
    expect(replaceState).toHaveBeenCalledWith(null, "", "/brain/projects/roadmap");
    expect(routerMock.replace).not.toHaveBeenCalled();
    replaceState.mockRestore();
  });

  it("opens a stale inbox document route after the filing agent moved it", async () => {
    const movedCapture = {
      ...inboxCaptureDocument,
      folderPath: "thoughts",
      path: "thoughts/customer-feedback.md",
    };
    window.history.pushState(null, "", "/brain/inbox/customer-feedback");
    const replaceState = vi.spyOn(window.history, "replaceState");

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
        folders={[folder("inbox", "system"), folder("thoughts", "custom")]}
        documents={[movedCapture]}
        initialFolderPath="inbox"
        initialBrainId="customer-feedback"
      />,
    );

    expect(screen.getByRole("textbox", { name: "Brain body" })).toHaveValue(
      "Customer wants searchable meeting notes.",
    );
    expect(screen.getByTitle("thoughts/customer-feedback.md")).toBeInTheDocument();
    await waitFor(() => {
      expect(replaceState).toHaveBeenCalledWith(null, "", "/brain/thoughts/customer-feedback");
    });
    replaceState.mockRestore();
  });

  it("keeps an open inbox item selected when live filing moves it away", async () => {
    window.history.pushState(null, "", "/brain/inbox/customer-feedback");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const { rerender } = render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
        folders={[folder("inbox", "system"), folder("thoughts", "custom")]}
        documents={[inboxCaptureDocument]}
        initialFolderPath="inbox"
        initialBrainId="customer-feedback"
      />,
    );

    expect(screen.getByRole("textbox", { name: "Brain body" })).toHaveValue(
      "Customer wants searchable meeting notes.",
    );
    expect(replaceState).not.toHaveBeenCalled();

    rerender(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
        folders={[folder("inbox", "system"), folder("thoughts", "custom")]}
        documents={[
          {
            ...inboxCaptureDocument,
            id: "doc_unrelated_note",
            brainId: "unrelated-note",
            folderPath: "thoughts",
            path: "thoughts/unrelated-note.md",
            title: "Unrelated note",
            body: "This should not become selected.",
          },
          {
            ...inboxCaptureDocument,
            folderPath: "thoughts",
            path: "thoughts/customer-feedback.md",
          },
        ]}
        initialFolderPath="inbox"
        initialBrainId="customer-feedback"
      />,
    );

    expect(screen.getByRole("textbox", { name: "Brain body" })).toHaveValue(
      "Customer wants searchable meeting notes.",
    );
    expect(screen.getByTitle("thoughts/customer-feedback.md")).toBeInTheDocument();
    await waitFor(() => {
      expect(replaceState).toHaveBeenCalledWith(null, "", "/brain/thoughts/customer-feedback");
    });
    replaceState.mockRestore();
  });

  it("orders root folders with hard-folder dividers", () => {
    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
        folders={orderedFolders}
        documents={[]}
        initialFolderPath="inbox"
        initialBrainId={null}
      />,
    );

    expect(screen.getAllByRole("treeitem").map((item) => item.textContent)).toEqual([
      "inbox",
      "thoughts",
      "projects",
      "meetings",
      "research",
      "decisions",
      "concepts",
      "partners",
      "people",
      "companies",
      "evidence",
    ]);
    expect(screen.getAllByTestId("brain-root-divider")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Rename folder" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete folder" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add folder" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload PDF" })).not.toBeInTheDocument();
    expect(screen.getByTestId("brain-activity")).toBeInTheDocument();
    expect(screen.getByTestId("brain-import")).toHaveTextContent("goat_brain_1");
    expect(screen.getByRole("button", { name: /Open settings for/ })).toBeInTheDocument();
  });

  it("renders workspace-member brain access as browse-only", async () => {
    const user = userEvent.setup();
    workspaceRoleMock.value = "member";

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
        folders={folders}
        documents={[documentWithTimeline]}
        initialFolderPath="people"
        initialBrainId="ada-lovelace"
      />,
    );

    expect(screen.queryByRole("button", { name: "Add folder" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload PDF" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open settings for/ })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Page title" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Brain body" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "More actions" }));

    expect(screen.getByRole("button", { name: "Toggle timeline" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete document" })).not.toBeInTheDocument();
    expect(updateHeadlessBrainDocument).not.toHaveBeenCalled();
    expect(renameHeadlessBrainDocument).not.toHaveBeenCalled();
  });

  it("creates a nested folder from the sidebar context menu", async () => {
    const user = userEvent.setup();
    vi.mocked(createHeadlessBrainFolder).mockResolvedValueOnce({
      id: "folder_projects_partners",
      path: "projects/partners",
      source: "custom",
      createdAt: "2026-07-06T12:00:00.000Z",
      updatedAt: "2026-07-06T12:00:00.000Z",
    });

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
        folders={orderedFolders}
        documents={[]}
        initialFolderPath="inbox"
        initialBrainId={null}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /projects/i }));
    await user.click(screen.getByRole("menuitem", { name: "New folder" }));
    await user.type(screen.getByLabelText("Path"), "partners");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(createHeadlessBrainFolder).toHaveBeenCalledWith("goat_brain_1", {
        path: "projects/partners",
      });
    });
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("creates a Markdown file in the context-clicked folder", async () => {
    const user = userEvent.setup();
    vi.mocked(createHeadlessBrainDocument).mockResolvedValueOnce(
      brainDocumentDto({
        ...documentLinkingToAda,
        id: "doc_roadmap_new",
        brainId: "roadmap",
        folderPath: "projects",
        path: "projects/roadmap.md",
        title: "Roadmap",
        body: "",
        content: "",
      }),
    );

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
        folders={orderedFolders}
        documents={[]}
        initialFolderPath="inbox"
        initialBrainId={null}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /projects/i }));
    await user.click(screen.getByRole("menuitem", { name: "New Markdown file" }));
    await user.type(screen.getByLabelText("File name"), "Roadmap.md");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(createHeadlessBrainDocument).toHaveBeenCalledWith("goat_brain_1", {
        folderPath: "projects",
        fileName: "Roadmap.md",
      });
    });
    expect(window.location.pathname).toBe("/brain/projects/roadmap");
  });

  it("keeps extracted skills and workflows out of the Brain surface", () => {
    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
        folders={[...orderedFolders, folder("workflows", "system")]}
        documents={[
          codingWorkSkill,
          {
            ...codingWorkSkill,
            id: "doc_release_workflow",
            brainId: "release-workflow",
            folderPath: "workflows",
            path: "workflows/release-workflow.md",
            title: "Release workflow",
          },
        ]}
        initialFolderPath="inbox"
        initialBrainId={null}
      />,
    );

    expect(screen.queryByRole("treeitem", { name: /skills/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /workflows/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Coding work")).not.toBeInTheDocument();
    expect(screen.queryByText("Release workflow")).not.toBeInTheDocument();
  });

  it("renames only adjustable folders", async () => {
    const user = userEvent.setup();
    vi.mocked(renameHeadlessBrainFolder).mockResolvedValueOnce({
      id: "folder_projects",
      path: "initiatives",
      source: "custom",
      createdAt: "2026-07-06T12:00:00.000Z",
      updatedAt: "2026-07-06T12:00:00.000Z",
    });

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
        folders={orderedFolders}
        documents={[]}
        initialFolderPath="projects"
        initialBrainId={null}
      />,
    );

    expect(screen.getByRole("button", { name: "Rename folder" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete folder" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Rename folder" }));
    await user.clear(screen.getByLabelText("Path"));
    await user.type(screen.getByLabelText("Path"), "initiatives");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() => {
      expect(renameHeadlessBrainFolder).toHaveBeenCalledWith("goat_brain_1", {
        fromPath: "projects",
        toPath: "initiatives",
      });
    });
  });

  it("deletes only adjustable folders after confirmation", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    vi.mocked(deleteHeadlessBrainFolder).mockResolvedValueOnce({
      deleted: true,
    });

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
        folders={orderedFolders}
        documents={[]}
        initialFolderPath="projects"
        initialBrainId={null}
      />,
    );

    expect(screen.getByRole("button", { name: "Rename folder" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete folder" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Delete folder" }));
    await waitFor(() => {
      expect(deleteHeadlessBrainFolder).toHaveBeenCalledWith("goat_brain_1", {
        path: "projects",
      });
    });
    confirm.mockRestore();
  });

  it("resolves editor wiki links for folders and folder-qualified files", () => {
    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
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

  it("resolves source pointers to their canonical source URLs", async () => {
    const user = userEvent.setup();

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
        folders={folders}
        documents={[documentWithGitHubSource]}
        initialFolderPath="projects"
        initialBrainId="github-source-note"
      />,
    );

    expect(screen.getByTestId("brain-link:source:github:acme/api:pull:123")).toHaveAttribute(
      "href",
      "https://github.com/acme/api/pull/123",
    );

    await user.click(screen.getByRole("button", { name: "Toggle file details" }));

    expect(screen.getByRole("link", { name: "acme/api #123" })).toHaveAttribute(
      "href",
      "https://github.com/acme/api/pull/123",
    );
  });

  it("expands the timeline inside the details sidebar", async () => {
    const user = userEvent.setup();

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
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
    vi.mocked(renameHeadlessBrainDocument).mockResolvedValueOnce(
      brainDocumentDto({ ...documentWithTimeline, title: "Ada King" }),
    );

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
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
      expect(renameHeadlessBrainDocument).toHaveBeenCalledWith("goat_brain_1", "doc_ada", {
        title: "Ada King",
      });
    });
  });

  it("autosaves the body with the selected content hash after typing pauses", async () => {
    const user = userEvent.setup();
    vi.mocked(updateHeadlessBrainDocument).mockResolvedValueOnce(
      brainDocumentDto({
        ...documentWithTimeline,
        body: "Updated truth.",
        contentHash: "hash-next",
      }),
    );

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
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
        expect(updateHeadlessBrainDocument).toHaveBeenCalledWith("goat_brain_1", "doc_ada", {
          body: "Updated truth.",
          expectedContentHash: "hash",
        });
      },
      { timeout: 4000 },
    );
    expect(updateHeadlessBrainDocument).toHaveBeenCalledTimes(1);
  });

  it("renders nested legacy frontmatter as body text and autosaves the normalized value", async () => {
    const user = userEvent.setup();
    vi.mocked(updateHeadlessBrainDocument).mockResolvedValueOnce(
      brainDocumentDto({
        ...documentWithTimeline,
        body: "Nested truth. Updated.",
        contentHash: "hash-next",
      }),
    );

    render(
      <GoatBrainView
        brainRef="goat_brain_1"
        brain={defaultBrain}
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
        expect(updateHeadlessBrainDocument).toHaveBeenCalledWith("goat_brain_1", "doc_ada", {
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

const orderedFolders: GoatBrainFolderView[] = [
  folder("evidence", "system"),
  folder("people", "system"),
  folder("companies", "system"),
  folder("inbox", "system"),
  folder("skills", "system"),
  folder("partners", "custom"),
  folder("thoughts", "custom"),
  folder("concepts", "custom"),
  folder("research", "custom"),
  folder("projects", "custom"),
  folder("decisions", "custom"),
  folder("meetings", "custom"),
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

const codingWorkSkill: GoatBrainDocumentView = {
  ...documentLinkingToAda,
  id: "doc_coding_work",
  brainId: "coding-work",
  folderPath: "skills",
  path: "skills/coding-work.md",
  title: "Coding work",
  description: "How coding work should happen.",
  content: "",
  body: "Inspect, implement, and verify.",
  type: "note",
  contentHash: "skill-hash",
};

const inboxCaptureDocument: GoatBrainDocumentView = {
  id: "doc_customer_feedback",
  brainId: "customer-feedback",
  folderPath: "inbox",
  path: "inbox/customer-feedback.md",
  title: "Customer feedback",
  content: "",
  body: "Customer wants searchable meeting notes.",
  timeline: [],
  format: "markdown",
  mimeType: "text/markdown",
  originalFileName: null,
  assetStorageKey: null,
  relations: [],
  sources: [],
  kind: "page",
  type: "note",
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

const documentWithGitHubSource: GoatBrainDocumentView = {
  id: "doc_github_source",
  brainId: "github-source-note",
  folderPath: "projects",
  path: "projects/github-source-note.md",
  title: "GitHub Source Note",
  content: "",
  body: "Review [[source:github:acme/api:pull:123|PR #123]].",
  timeline: [],
  format: "markdown",
  mimeType: "text/markdown",
  originalFileName: null,
  assetStorageKey: null,
  relations: [],
  sources: [{ ref: "github:acme/api:pull:123", title: "acme/api #123" }],
  kind: "page",
  type: "project",
  status: "draft",
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

function folder(folderPath: string, source: GoatBrainFolderView["source"]): GoatBrainFolderView {
  return {
    id: `folder_${folderPath.replaceAll("/", "_")}`,
    path: folderPath,
    name: folderPath,
    source,
    createdAt: "2026-07-06T12:00:00.000Z",
    updatedAt: "2026-07-06T12:00:00.000Z",
  };
}

function brainDocumentDto(document: GoatBrainDocumentView): BrainDocumentDto {
  return {
    ...document,
    assetSizeBytes: null,
    createdByActorId: null,
  };
}
