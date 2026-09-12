import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_COMPOSER_FOCUS_EVENT,
  consumePendingChatComposerFocus,
  HOME_NAVIGATION_EVENT,
} from "@/lib/chat-navigation";
import { clearAllLocalChatStates, setLocalChatState } from "@/lib/chat-session-state";
import { clearOptimisticArchives } from "@/lib/optimistic-archives";
import {
  addOptimisticChatSummary,
  clearAllOptimisticChatSummaries,
  removeOptimisticChatSummary,
} from "@/lib/optimistic-chat-summaries";
import { Sidebar } from "./Sidebar";

const pathnameMock = vi.hoisted(() => ({ value: "/" }));
const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
}));
const workspaceRoleMock = vi.hoisted(() => ({
  value: "admin" as "admin" | "member",
}));
const workspacesMock = vi.hoisted(() => ({
  value: [{ id: "goat_ws_1", name: "Ada's Workspace", role: "admin" }] as Array<{
    id: string;
    name: string;
    role: "admin" | "member";
  }>,
}));
const mcpSetupMock = vi.hoisted(() => ({ completedAt: null as string | null }));
const featureFlagsMock = vi.hoisted(() => ({
  taskSpawning: false,
  autoModelRouting: false,
  legacyBrain: true,
  reviewInbox: false,
  sidebarProjects: false,
}));
const searchParamsMock = vi.hoisted(() => ({ value: new URLSearchParams() }));
const reviewCountMock = vi.hoisted(() => ({ value: 0 }));
const recentChatsMock = vi.hoisted(() => ({
  value: [] as Array<{
    id: string;
    title: string;
    model: string;
    engine: string;
    codexComposerSettings: null;
    runtime?: {
      status: "queued" | "starting" | "idle" | "running" | "failed" | "interrupted" | "closed";
      activeRunId: string | null;
      hasError: boolean;
      updatedAt: string;
    } | null;
    activityState?: "working" | "idle";
    hasUnseen?: boolean;
    state?: "working" | "done_unseen" | "done_seen";
    preview: string;
    updatedAt: string;
    lastSeenAt?: string | null;
    pinnedAt: string | null;
  }>,
}));
const sidebarTasksMock = vi.hoisted(() => ({
  value: [] as Array<{
    id: string;
    conversationId: string;
    displayId: string;
    name: string;
    status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "canceled";
    hasUnseen: boolean;
    updatedAt: string;
  }>,
}));
const tasksMock = vi.hoisted(() => ({
  value: [] as Array<{
    id: string;
    displayId: string;
    name: string;
    workflowId: string | null;
    status: "queued" | "running" | "succeeded" | "failed" | "canceled";
    reportedOutcome: "done" | "needs_attention" | null;
    outcomeComment: string | null;
    archivedAt: string | null;
  }>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock.value,
  useRouter: () => routerMock,
  useSearchParams: () => searchParamsMock.value,
}));

const projectsApiMock = vi.hoisted(() => ({
  listProjects: vi.fn(
    async () =>
      [] as Array<{
        id: string;
        name: string;
        conversationIds: string[];
        createdAt: string;
      }>,
  ),
  createProject: vi.fn(),
  renameProject: vi.fn(),
  deleteProject: vi.fn(),
  fileConversationInProject: vi.fn(),
  removeConversationFromProject: vi.fn(),
}));

vi.mock("@/lib/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/projects")>()),
  ...projectsApiMock,
}));

const wikisApiMock = vi.hoisted(() => ({
  listWikis: vi.fn(async () => [] as ReturnType<typeof wikiDto>[]),
  createWiki: vi.fn(),
  updateWiki: vi.fn(),
  getWikiAccess: vi.fn(),
  setWikiAccess: vi.fn(),
}));

vi.mock("@/lib/wikis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/wikis")>()),
  ...wikisApiMock,
}));

const workspaceActionsMock = vi.hoisted(() => ({
  switchBrainAction: vi.fn(),
  switchWorkspaceAction: vi.fn(),
  createBrainAction: vi.fn(),
  createWorkspaceAction: vi.fn(),
  setBrainAccessAction: vi.fn(),
  getBrainAccessDetailsAction: vi.fn(),
}));

vi.mock("@/lib/workspace-actions", () => workspaceActionsMock);

const chatCommandsMock = vi.hoisted(() => ({
  updateHeadlessChatConversation: vi.fn(async () => ({ transactionId: "1" })),
}));

const chatCollectionMocks = vi.hoisted(() => ({
  preloadHeadlessChatMessages: vi.fn(async (conversationId: string) => {
    void conversationId;
  }),
}));

const taskCommandsMock = vi.hoisted(() => ({
  archiveHeadlessTask: vi.fn(async () => ({ id: "task_1" })),
}));

vi.mock("@/lib/headless-chat-commands", () => chatCommandsMock);

vi.mock("@/lib/headless-task-commands", () => taskCommandsMock);

vi.mock("@/lib/headless-chat-collections", () => chatCollectionMocks);

// The provider applies the user's pending archives to the chat list it publishes, so the mock does
// the same: these tests are about what the sidebar shows between the click and the projection.
vi.mock("@/components/AppDataProvider", async () => {
  const { useMemo } = await import("react");
  const { useOptimisticArchives } = await import("@/lib/optimistic-archives");
  return {
    useAppData: () => {
      const pendingArchives = useOptimisticArchives();
      // Memoized like the provider's own list: the sidebar syncs pin overrides against the chat
      // list by identity, so a fresh array on every render would loop.
      const chats = recentChatsMock.value;
      const recentChats = useMemo(
        () =>
          pendingArchives.size === 0
            ? chats
            : chats.filter((chat) => !pendingArchives.has(chat.id)),
        [chats, pendingArchives],
      );
      // Tasks are hidden by their conversation, which is the key the archive store tracks.
      const tasks = sidebarTasksMock.value;
      const sidebarTasks = useMemo(
        () =>
          pendingArchives.size === 0
            ? tasks
            : tasks.filter((task) => !pendingArchives.has(task.conversationId)),
        [pendingArchives, tasks],
      );
      return {
        user: {
          workosUserId: "user_ada",
          email: "ada@example.com",
          firstName: "Ada",
          lastName: "Lovelace",
          avatarUrl: null,
        },
        workspace: { id: "goat_ws_1", name: "Ada's Workspace", role: workspaceRoleMock.value },
        plan: "hobby",
        workspaces: workspacesMock.value,
        workspaceMembers: [],
        brains: [
          {
            id: "goat_brain_1",
            name: "General",
            slug: "general",
            description: null,
            visibility: "workspace",
          },
        ],
        activeBrain: {
          id: "goat_brain_1",
          name: "General",
          slug: "general",
          description: null,
          visibility: "workspace",
        },
        tasks: tasksMock.value,
        sidebarTasks,
        openSidebarTasks: sidebarTasks,
        recentChats,
        openChats: recentChats,
        featureFlags: {
          taskSpawning: featureFlagsMock.taskSpawning,
          autoModelRouting: featureFlagsMock.autoModelRouting,
          legacyBrain: featureFlagsMock.legacyBrain,
          reviewInbox: featureFlagsMock.reviewInbox,
          sidebarProjects: featureFlagsMock.sidebarProjects,
        },
        reviewCount: reviewCountMock.value,
        mcpSetup: { preferredClient: null, completedAt: mcpSetupMock.completedAt },
      };
    },
  };
});

function wikiDto(
  id: string,
  name: string,
  slug: string,
  isDefault = false,
  overrides: { canManage?: boolean; access?: "workspace" | "restricted" } = {},
) {
  return {
    id,
    name,
    slug,
    instructions: "",
    access: overrides.access ?? ("workspace" as const),
    isDefault,
    canManage: overrides.canManage ?? true,
    createdAt: "2026-07-14T09:00:00.000Z",
    updatedAt: "2026-07-14T09:00:00.000Z",
  };
}

function archivableChat(id: string, title: string) {
  return {
    id,
    title,
    model: "claude-sonnet-5",
    engine: "opencompany" as const,
    codexComposerSettings: null,
    preview: "Ready",
    updatedAt: "2026-07-14T09:00:00.000Z",
    pinnedAt: null,
  };
}

describe("Sidebar", () => {
  afterEach(() => {
    vi.clearAllMocks();
    pathnameMock.value = "/";
    workspaceRoleMock.value = "admin";
    workspacesMock.value = [{ id: "goat_ws_1", name: "Ada's Workspace", role: "admin" }];
    mcpSetupMock.completedAt = null;
    featureFlagsMock.taskSpawning = false;
    featureFlagsMock.legacyBrain = true;
    featureFlagsMock.reviewInbox = false;
    featureFlagsMock.sidebarProjects = false;
    searchParamsMock.value = new URLSearchParams();
    projectsApiMock.listProjects.mockResolvedValue([]);
    wikisApiMock.listWikis.mockResolvedValue([wikiDto("goat_wiki_1", "Company", "company", true)]);
    reviewCountMock.value = 0;
    recentChatsMock.value = [];
    tasksMock.value = [];
    sidebarTasksMock.value = [];
    clearAllLocalChatStates();
    clearAllOptimisticChatSummaries();
    clearOptimisticArchives();
    consumePendingChatComposerFocus("goat_chat_focus");
    window.localStorage.clear();
  });

  it("renders home, the brain list, and footer links", () => {
    pathnameMock.value = "/";
    const { container } = render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByText("Ada's Workspace")).toBeInTheDocument();
    expect(screen.queryByText("admin")).not.toBeInTheDocument();
    expect(container.querySelector('svg[viewBox="0 0 100 100"]')).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "opencompany primary" });
    const home = within(nav).getByRole("link", { name: "Home" });
    expect(home).toHaveAttribute("href", "/");
    expect(home).toHaveAttribute("aria-current", "page");
    expect(within(nav).queryByRole("link", { name: "Tasks" })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Workflows" })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Brain" })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Wiki" })).not.toBeInTheDocument();
    expect(screen.getByText("Brains")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "General" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "New brain" })).toHaveClass("opacity-0");
    expect(screen.queryByText("New brain")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Manage access to General" }),
    ).not.toBeInTheDocument();

    const account = screen.getByRole("button", { name: "Account menu for Ada Lovelace" });
    expect(account).toBeInTheDocument();

    const plugins = screen.getByRole("link", { name: "Plugins" });
    expect(plugins).toHaveAttribute("href", "/settings/plugins");
    const feedback = screen.getByRole("button", { name: "Feedback" });
    expect(plugins.nextElementSibling).toBe(feedback);
    expect(feedback.nextElementSibling).toBe(account);
    expect(screen.queryByRole("link", { name: "Changelog" })).not.toBeInTheDocument();
  });

  describe("Wiki section", () => {
    it("lists the reachable wikis, default first, and marks the open one", async () => {
      pathnameMock.value = "/wiki/handbook/onboarding";
      wikisApiMock.listWikis.mockResolvedValue([
        wikiDto("goat_wiki_1", "Company", "company", true),
        wikiDto("goat_wiki_2", "Handbook", "handbook"),
      ]);

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

      const section = await screen.findByRole("region", { name: "Wiki" });
      const links = within(section).getAllByRole("link");
      expect(links.map((link) => link.textContent)).toEqual(["Company", "Handbook"]);
      expect(links[0]).toHaveAttribute("href", "/wiki/company");
      expect(links[1]).toHaveAttribute("href", "/wiki/handbook");
      // The reader is inside Handbook, several pages deep.
      expect(links[1]).toHaveAttribute("aria-current", "page");
      expect(links[0]).not.toHaveAttribute("aria-current");
    });

    it("does not mark a wiki current on the static wiki routes", async () => {
      pathnameMock.value = "/wiki/sources";
      wikisApiMock.listWikis.mockResolvedValue([
        wikiDto("goat_wiki_1", "Company", "company", true),
      ]);

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

      expect(await screen.findByRole("link", { name: "Company" })).not.toHaveAttribute(
        "aria-current",
      );
    });

    it("creates a wiki inline and shows its row without a reload", async () => {
      wikisApiMock.listWikis.mockResolvedValue([
        wikiDto("goat_wiki_1", "Company", "company", true),
      ]);
      wikisApiMock.createWiki.mockResolvedValue(wikiDto("goat_wiki_2", "Handbook", "handbook"));

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      await screen.findByRole("region", { name: "Wiki" });

      await userEvent.click(screen.getByRole("button", { name: "New wiki" }));
      await userEvent.type(screen.getByLabelText("Wiki name"), "Handbook{Enter}");

      expect(wikisApiMock.createWiki).toHaveBeenCalledWith({
        name: "Handbook",
        access: "workspace",
      });
      expect(await screen.findByRole("link", { name: "Handbook" })).toHaveAttribute(
        "href",
        "/wiki/handbook",
      );
      expect(wikisApiMock.listWikis).toHaveBeenCalledTimes(1);
    });

    it("keeps the wikis a still-pending first load was going to return", async () => {
      // A create can land before the first load answers. The new wiki is spliced in at once, and
      // the response that predates it must not drop it back out.
      let resolveFirstLoad: (wikis: ReturnType<typeof wikiDto>[]) => void = () => {};
      wikisApiMock.listWikis.mockImplementationOnce(
        () =>
          new Promise<ReturnType<typeof wikiDto>[]>((resolve) => {
            resolveFirstLoad = resolve;
          }),
      );
      wikisApiMock.createWiki.mockResolvedValue(wikiDto("goat_wiki_2", "Handbook", "handbook"));

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      await screen.findByRole("region", { name: "Wiki" });

      await userEvent.click(screen.getByRole("button", { name: "New wiki" }));
      await userEvent.type(screen.getByLabelText("Wiki name"), "Handbook{Enter}");
      expect(await screen.findByRole("link", { name: "Handbook" })).toBeInTheDocument();

      resolveFirstLoad([wikiDto("goat_wiki_1", "Company", "company", true)]);

      expect(await screen.findByRole("link", { name: "Company" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Handbook" })).toBeInTheDocument();
    });

    it("takes a new wiki name while collapsed and reopens the section once it saves", async () => {
      window.localStorage.setItem("opencompany-sidebar-wikis-collapsed", "true");
      wikisApiMock.listWikis.mockResolvedValue([]);
      wikisApiMock.createWiki.mockResolvedValue(wikiDto("goat_wiki_2", "Handbook", "handbook"));

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      await screen.findByRole("region", { name: "Wiki" });

      await userEvent.click(screen.getByRole("button", { name: "New wiki" }));
      expect(screen.getByRole("button", { name: "Wiki" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );

      await userEvent.type(screen.getByLabelText("Wiki name"), "Handbook{Enter}");

      expect(await screen.findByRole("link", { name: "Handbook" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Wiki" })).toHaveAttribute("aria-expanded", "true");
    });

    it("offers settings only on a wiki this reader may change", async () => {
      wikisApiMock.listWikis.mockResolvedValue([
        wikiDto("goat_wiki_1", "Company", "company", true),
        wikiDto("goat_wiki_2", "Handbook", "handbook", false, { canManage: false }),
      ]);

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      await screen.findByRole("region", { name: "Wiki" });

      expect(await screen.findByRole("button", { name: "Company settings" })).toBeInTheDocument();
      // Only an admin or the creator may change a wiki, so a control that would 403 is not offered.
      expect(screen.queryByRole("button", { name: "Handbook settings" })).not.toBeInTheDocument();
    });

    it("reads a restricted wiki with no one else invited as private", async () => {
      wikisApiMock.listWikis.mockResolvedValue([
        wikiDto("goat_wiki_2", "C-level", "c-level", false, { access: "restricted" }),
      ]);
      // The server always keeps the acting user as a member, so "only me" arrives as one member.
      wikisApiMock.getWikiAccess.mockResolvedValue({
        access: "restricted",
        memberIds: ["user_ada"],
        workspaceMembers: [
          { id: "user_ada", email: "ada@example.com", name: "Ada", avatarUrl: null, role: "admin" },
          { id: "user_bo", email: "bo@example.com", name: "Bo", avatarUrl: null, role: "member" },
        ],
      });

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      await userEvent.click(await screen.findByRole("button", { name: "C-level settings" }));

      const dialog = await screen.findByRole("dialog", { name: "C-level settings" });
      expect(await within(dialog).findByRole("button", { name: /Private/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("saves a shared wiki with the people it invites", async () => {
      wikisApiMock.listWikis.mockResolvedValue([
        wikiDto("goat_wiki_2", "C-level", "c-level", false, { access: "restricted" }),
      ]);
      wikisApiMock.getWikiAccess.mockResolvedValue({
        access: "restricted",
        memberIds: ["user_ada"],
        workspaceMembers: [
          { id: "user_ada", email: "ada@example.com", name: "Ada", avatarUrl: null, role: "admin" },
          { id: "user_bo", email: "bo@example.com", name: "Bo", avatarUrl: null, role: "member" },
        ],
      });
      wikisApiMock.setWikiAccess.mockResolvedValue({
        access: "restricted",
        memberIds: ["user_ada", "user_bo"],
        workspaceMembers: [],
      });

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      await userEvent.click(await screen.findByRole("button", { name: "C-level settings" }));
      const dialog = await screen.findByRole("dialog", { name: "C-level settings" });

      await userEvent.click(await within(dialog).findByRole("button", { name: /Shared/ }));
      await userEvent.click(await within(dialog).findByRole("checkbox"));
      await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

      // The reader is not sent: the server adds them, so a restricted wiki is never orphaned.
      expect(wikisApiMock.setWikiAccess).toHaveBeenCalledWith("goat_wiki_2", {
        access: "restricted",
        memberIds: ["user_bo"],
      });
    });

    it("keeps a rename that landed when the access change that followed it failed", async () => {
      wikisApiMock.listWikis.mockResolvedValue([
        wikiDto("goat_wiki_2", "C-level", "c-level", false, { access: "restricted" }),
      ]);
      wikisApiMock.getWikiAccess.mockResolvedValue({
        access: "restricted",
        memberIds: ["user_ada"],
        workspaceMembers: [
          { id: "user_ada", email: "ada@example.com", name: "Ada", avatarUrl: null, role: "admin" },
          { id: "user_bo", email: "bo@example.com", name: "Bo", avatarUrl: null, role: "member" },
        ],
      });
      wikisApiMock.updateWiki.mockResolvedValue({
        ...wikiDto("goat_wiki_2", "Board", "c-level", false, { access: "restricted" }),
      });
      wikisApiMock.setWikiAccess.mockRejectedValue(new Error("Access could not be saved."));

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      await userEvent.click(await screen.findByRole("button", { name: "C-level settings" }));
      const dialog = await screen.findByRole("dialog", { name: "C-level settings" });

      await userEvent.clear(within(dialog).getByLabelText("Name"));
      await userEvent.type(within(dialog).getByLabelText("Name"), "Board");
      await userEvent.click(await within(dialog).findByRole("button", { name: /Shared/ }));
      await userEvent.click(await within(dialog).findByRole("checkbox"));
      await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

      // The rename already reached the server, so the sidebar must not keep showing the old name.
      expect(await screen.findByRole("link", { name: "Board" })).toBeInTheDocument();
    });

    it("explains why the default wiki cannot be restricted instead of offering the choice", async () => {
      wikisApiMock.listWikis.mockResolvedValue([
        wikiDto("goat_wiki_1", "Company", "company", true),
      ]);
      wikisApiMock.getWikiAccess.mockResolvedValue({
        access: "workspace",
        memberIds: [],
        workspaceMembers: [],
      });

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      await userEvent.click(await screen.findByRole("button", { name: "Company settings" }));

      const dialog = await screen.findByRole("dialog", { name: "Company settings" });
      expect(within(dialog).getByText(/agents write when no wiki is named/)).toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: /Private/ })).not.toBeInTheDocument();
    });

    it("discards an abandoned name and leaves a collapsed section closed", async () => {
      window.localStorage.setItem("opencompany-sidebar-wikis-collapsed", "true");

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      await screen.findByRole("region", { name: "Wiki" });

      await userEvent.click(screen.getByRole("button", { name: "New wiki" }));
      await userEvent.keyboard("{Escape}");

      expect(wikisApiMock.createWiki).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Wiki" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });

    it("remembers a collapsed Wiki section across reloads", async () => {
      wikisApiMock.listWikis.mockResolvedValue([
        wikiDto("goat_wiki_1", "Company", "company", true),
      ]);

      const { unmount } = render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      await screen.findByRole("link", { name: "Company" });

      await userEvent.click(screen.getByRole("button", { name: "Wiki" }));
      expect(screen.queryByRole("link", { name: "Company" })).toBeNull();

      unmount();
      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

      expect(screen.getByRole("button", { name: "Wiki" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await waitFor(() => expect(wikisApiMock.listWikis).toHaveBeenCalledTimes(2));
      expect(screen.queryByRole("link", { name: "Company" })).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Wiki" }));

      expect(await screen.findByRole("link", { name: "Company" })).toBeInTheDocument();
    });

    it("offers a retry when the one network call fails", async () => {
      wikisApiMock.listWikis
        .mockRejectedValueOnce(new Error("Wikis are unavailable."))
        .mockResolvedValueOnce([wikiDto("goat_wiki_1", "Company", "company", true)]);

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

      expect(await screen.findByRole("alert")).toHaveTextContent("Wikis are unavailable.");

      await userEvent.click(screen.getByRole("button", { name: "Try again" }));

      expect(await screen.findByRole("link", { name: "Company" })).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("says so when the workspace has no reachable wiki", async () => {
      wikisApiMock.listWikis.mockResolvedValue([]);

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

      expect(
        await screen.findByText("Create a wiki to keep a body of knowledge together."),
      ).toBeInTheDocument();
    });
  });

  it("marks Plugins active throughout plugin settings", () => {
    pathnameMock.value = "/settings/plugins/linear";
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByRole("link", { name: "Plugins" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps the wiki visible and hides legacy Brain navigation by default", async () => {
    featureFlagsMock.legacyBrain = false;
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(await screen.findByRole("link", { name: "Company" })).toHaveAttribute(
      "href",
      "/wiki/company",
    );
    expect(screen.queryByText("Brains")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "General" })).not.toBeInTheDocument();
  });

  it("opens the account menu with settings, changelog, docs, and sign out", async () => {
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Account menu for Ada Lovelace" }));

    const menu = screen.getByRole("dialog");
    expect(within(menu).getByText("ada@example.com")).toBeInTheDocument();
    expect(within(menu).getByText("Hobby plan")).toBeInTheDocument();
    expect(within(menu).getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(within(menu).getByRole("link", { name: "Changelog" })).toHaveAttribute(
      "href",
      "/changelog",
    );
    const docs = within(menu).getByRole("link", { name: "Docs" });
    expect(docs).toHaveAttribute("href", "https://docs.opencompany.cloud");
    expect(docs).toHaveAttribute("target", "_blank");
    expect(docs).toHaveAttribute("rel", "noreferrer noopener");
    expect(docs.previousElementSibling).toHaveTextContent("Changelog");
    expect(within(menu).getByRole("link", { name: "Sign out" })).toHaveAttribute(
      "href",
      "/auth/sign-out",
    );
  });

  it("opens an organization picker even when the user has one organization", async () => {
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.click(
      screen.getByRole("button", {
        name: "Switch organization. Current organization: Ada's Workspace",
      }),
    );

    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^Ada's Workspace/ }),
    ).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Create organization..." })).toBeInTheDocument();
  });

  it("switches to another organization from the picker", async () => {
    workspaceActionsMock.switchWorkspaceAction.mockResolvedValue({ ok: true });
    workspacesMock.value = [
      { id: "goat_ws_1", name: "Ada's Workspace", role: "admin" },
      { id: "goat_ws_2", name: "Research Labs", role: "member" },
    ];
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.click(
      screen.getByRole("button", {
        name: "Switch organization. Current organization: Ada's Workspace",
      }),
    );
    await user.click(screen.getByRole("button", { name: /Research Labs/ }));

    expect(workspaceActionsMock.switchWorkspaceAction).toHaveBeenCalledWith("goat_ws_2");
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalledOnce());
  });

  it("creates a new organization from the picker", async () => {
    workspaceActionsMock.createWorkspaceAction.mockResolvedValue({
      ok: true,
      workspaceId: "goat_ws_new",
    });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.click(
      screen.getByRole("button", {
        name: "Switch organization. Current organization: Ada's Workspace",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Create organization..." }));
    await user.type(screen.getByRole("textbox", { name: "Organization name" }), "Analytical Co");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(workspaceActionsMock.createWorkspaceAction).toHaveBeenCalledWith("Analytical Co");
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalledOnce());
  });

  it("shows organization creation errors inline", async () => {
    workspaceActionsMock.createWorkspaceAction.mockResolvedValue({
      ok: false,
      error: "Could not create the organization.",
    });
    const user = userEvent.setup();
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.click(
      screen.getByRole("button", {
        name: "Switch organization. Current organization: Ada's Workspace",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Create organization..." }));
    await user.type(screen.getByRole("textbox", { name: "Organization name" }), "Analytical Co");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not create the organization.",
    );
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it("requests an immediate home reset on a normal Home click", async () => {
    const user = userEvent.setup();
    const homeNavigation = vi.fn();
    window.addEventListener(HOME_NAVIGATION_EVENT, homeNavigation);
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.click(screen.getByRole("link", { name: "Home" }));

    expect(homeNavigation).toHaveBeenCalledOnce();
    window.removeEventListener(HOME_NAVIGATION_EVENT, homeNavigation);
  });

  it("does not mark home active on nested brain routes", () => {
    pathnameMock.value = "/brain/people/ada-lovelace";
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const nav = screen.getByRole("navigation", { name: "opencompany primary" });
    expect(within(nav).getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "General" })).toHaveAttribute("aria-current", "page");
  });

  it("shows MCP setup until the first successful query is verified", () => {
    pathnameMock.value = "/settings/mcp";
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const setup = screen.getByRole("link", { name: "Connect MCP" });
    expect(setup).toHaveAttribute("href", "/settings/mcp");
    expect(setup).toHaveAttribute("aria-current", "page");
  });

  it("hides MCP setup after completion", () => {
    pathnameMock.value = "/settings/mcp";
    mcpSetupMock.completedAt = "2026-07-13T09:00:00.000Z";
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.queryByRole("link", { name: "Connect your brain" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Account menu for Ada Lovelace" }),
    ).toBeInTheDocument();
  });

  it("does not mark home active on chat subroutes", () => {
    pathnameMock.value = "/chat/goat_chat_123";
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const nav = screen.getByRole("navigation", { name: "opencompany primary" });
    expect(within(nav).getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("shows the Tasks and Workflows nav when the beta feature is enabled", () => {
    featureFlagsMock.taskSpawning = true;
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const nav = screen.getByRole("navigation", { name: "opencompany primary" });
    expect(within(nav).getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/tasks");
    expect(within(nav).getByRole("link", { name: "Workflows" })).toHaveAttribute(
      "href",
      "/workflows",
    );
  });

  it("exposes the active brain as a prefetchable route", () => {
    pathnameMock.value = "/";
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByRole("link", { name: "General" })).toHaveAttribute(
      "href",
      "/brain/goat_brain_1",
    );
  });

  it("shows the Tasks nav on nested task routes without inline task rows", () => {
    pathnameMock.value = "/tasks/TASK-7";
    featureFlagsMock.taskSpawning = true;
    tasksMock.value = [
      {
        id: "goat_task_workflow",
        displayId: "TASK-7",
        name: "Prepare launch brief",
        workflowId: "launch-brief",
        status: "succeeded",
        reportedOutcome: "needs_attention",
        outcomeComment: "Needs legal review",
        archivedAt: null,
      },
      {
        id: "goat_task_ad_hoc",
        displayId: "TASK-8",
        name: "Research competitors",
        workflowId: null,
        status: "running",
        reportedOutcome: null,
        outcomeComment: null,
        archivedAt: null,
      },
    ];

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const primaryNav = screen.getByRole("navigation", { name: "opencompany primary" });
    const home = within(primaryNav).getByRole("link", { name: "Home" });
    const tasks = within(primaryNav).getByRole("link", { name: "Tasks" });
    const workflows = within(primaryNav).getByRole("link", { name: "Workflows" });
    expect(tasks).toHaveAttribute("href", "/tasks");
    // No row is listed for this Task, so the nav row keeps the current-page claim.
    expect(tasks).toHaveAttribute("aria-current", "page");
    expect(home.nextElementSibling).toBe(tasks);
    expect(tasks.nextElementSibling).toBe(workflows);
    expect(screen.queryByRole("navigation", { name: "Workflow tasks" })).not.toBeInTheDocument();
    expect(screen.queryByText("Prepare launch brief")).not.toBeInTheDocument();
    expect(screen.queryByText("Research competitors")).not.toBeInTheDocument();
  });

  it("does not show brain creation to workspace members", () => {
    workspaceRoleMock.value = "member";
    pathnameMock.value = "/";

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByRole("link", { name: "General" })).toBeInTheDocument();
    expect(screen.queryByText("member")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New brain" })).not.toBeInTheDocument();
  });

  it("splits pinned chats into their own section above recent chats", () => {
    pathnameMock.value = "/";
    recentChatsMock.value = [
      {
        id: "goat_chat_pinned",
        title: "Pinned chat",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Pinned",
        updatedAt: "2026-07-01T09:00:00.000Z",
        pinnedAt: "2026-07-13T09:00:00.000Z",
      },
      {
        id: "goat_chat_recent",
        title: "Recent chat",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Recent",
        updatedAt: "2026-07-14T09:00:00.000Z",
        pinnedAt: null,
      },
    ];
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const pinnedNav = screen.getByRole("navigation", { name: "Pinned chats" });
    expect(within(pinnedNav).getByRole("link", { name: "Pinned chat" })).toHaveAttribute(
      "href",
      "/chat/goat_chat_pinned",
    );
    const recentNav = screen.getByRole("navigation", { name: "Recents" });
    expect(within(recentNav).getByRole("link", { name: "Recent chat" })).toBeInTheDocument();
    expect(within(recentNav).queryByRole("link", { name: "Pinned chat" })).not.toBeInTheDocument();
  });

  it("keeps Tasks out of Recents while Tasks are disabled", () => {
    featureFlagsMock.taskSpawning = false;
    sidebarTasksMock.value = [
      taskRow("task_hidden", { name: "Hidden task", updatedAt: "2026-07-14T09:05:00.000Z" }),
    ];
    recentChatsMock.value = [chatRow("chat_only", { title: "Only chat" })];

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByRole("navigation", { name: "Recents" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Hidden task/ })).not.toBeInTheDocument();
  });

  it("lists chats and tasks together in one recency-ordered section", () => {
    featureFlagsMock.taskSpawning = true;
    recentChatsMock.value = [
      chatRow("chat_older", {
        title: "Older chat",
        updatedAt: "2026-07-14T09:00:00.000Z",
      }),
      chatRow("chat_newer", {
        title: "Newer chat",
        updatedAt: "2026-07-14T09:10:00.000Z",
      }),
    ];
    sidebarTasksMock.value = [
      taskRow("task_middle", {
        displayId: "T-12",
        name: "Middle task",
        updatedAt: "2026-07-14T09:05:00.000Z",
      }),
    ];

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const workNav = screen.getByRole("navigation", { name: "Recents" });
    expect(screen.getByRole("button", { name: "Recents" })).toBeInTheDocument();
    expect(
      within(workNav)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/chat/chat_newer", "/tasks/T-12", "/chat/chat_older"]);
    expect(within(workNav).getByRole("link", { name: /Middle task/ })).toHaveTextContent("T-12");
  });

  it("collapses and reopens Recents, and remembers the choice", async () => {
    const user = userEvent.setup();
    recentChatsMock.value = [chatRow("chat_only", { title: "Only chat" })];

    const { unmount } = render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const toggle = screen.getByRole("button", { name: "Recents" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Only chat" })).toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Only chat" })).not.toBeInTheDocument();
    // The header stays put while collapsed so the section is still findable.
    expect(screen.getByRole("button", { name: "Recents" })).toBeInTheDocument();

    unmount();
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByRole("button", { name: "Recents" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("link", { name: "Only chat" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Recents" }));

    expect(screen.getByRole("link", { name: "Only chat" })).toBeInTheDocument();
  });

  it("shows the same unread dot and working spinner for tasks as for chats", () => {
    featureFlagsMock.taskSpawning = true;
    sidebarTasksMock.value = [
      taskRow("task_running", {
        displayId: "T-1",
        name: "Running task",
        status: "running",
        updatedAt: "2026-07-14T09:10:00.000Z",
      }),
      taskRow("task_unread", {
        displayId: "T-2",
        name: "Finished task",
        status: "succeeded",
        hasUnseen: true,
        updatedAt: "2026-07-14T09:05:00.000Z",
      }),
      taskRow("task_read", {
        displayId: "T-3",
        name: "Read task",
        status: "succeeded",
        updatedAt: "2026-07-14T09:00:00.000Z",
      }),
    ];

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByTestId("sidebar-chat-working")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-chat-unseen")).toBeInTheDocument();
    expect(screen.getAllByTestId(/sidebar-chat-/)).toHaveLength(2);
  });

  it("archives a settled task from its row and offers no archive on a running one", async () => {
    const user = userEvent.setup();
    featureFlagsMock.taskSpawning = true;
    pathnameMock.value = "/tasks/T-2";
    sidebarTasksMock.value = [
      taskRow("task_running", {
        displayId: "T-1",
        name: "Running task",
        status: "running",
        updatedAt: "2026-07-14T09:10:00.000Z",
      }),
      taskRow("task_settled", {
        displayId: "T-2",
        name: "Settled task",
        status: "succeeded",
        updatedAt: "2026-07-14T09:05:00.000Z",
      }),
    ];

    taskCommandsMock.archiveHeadlessTask.mockImplementationOnce(() => new Promise(() => {}));
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.queryByRole("button", { name: "Archive Running task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pin Settled task" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Archive Settled task" }));

    expect(taskCommandsMock.archiveHeadlessTask).toHaveBeenCalledWith("task_settled", {
      scopeKey: workspacesMock.value[0]!.id,
    });
    // The row and the route move on the click, like an archived chat's, rather than a beat later
    // when the write and its projection land.
    expect(screen.queryByRole("link", { name: /Settled task/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Running task/ })).toBeInTheDocument();
    expect(routerMock.push).toHaveBeenCalledWith("/tasks");
  });

  it("keeps the Tasks nav row current on the board itself", () => {
    pathnameMock.value = "/tasks";
    featureFlagsMock.taskSpawning = true;

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const nav = screen.getByRole("navigation", { name: "opencompany primary" });
    expect(within(nav).getByRole("link", { name: "Tasks" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  // An older or archived Task has no row in a list bounded by recency, so the nav row keeps the
  // claim rather than leaving the page with nothing marked current.
  it("keeps the Tasks nav row current on a task the list does not hold", () => {
    pathnameMock.value = "/tasks/T-99";
    featureFlagsMock.taskSpawning = true;
    sidebarTasksMock.value = [taskRow("task_other", { displayId: "T-1", name: "Other task" })];

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const nav = screen.getByRole("navigation", { name: "opencompany primary" });
    expect(within(nav).getByRole("link", { name: "Tasks" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getAllByText("Other task")).toHaveLength(1);
  });

  it("marks a task row current on its run subroute and a lowercased display id", () => {
    featureFlagsMock.taskSpawning = true;
    pathnameMock.value = "/tasks/t-12/run";
    sidebarTasksMock.value = [
      taskRow("task_open", { displayId: "T-12", name: "Open task", status: "running" }),
    ];

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByRole("link", { name: /Open task/ })).toHaveAttribute("aria-current", "page");
    // Exactly one element claims the page: the nav row still highlights for its subtree but
    // defers to the row for the Task actually open.
    const nav = screen.getByRole("navigation", { name: "opencompany primary" });
    const tasksNavRow = within(nav).getByRole("link", { name: "Tasks" });
    expect(tasksNavRow).toHaveClass("bg-surface-active");
    expect(tasksNavRow).not.toHaveAttribute("aria-current");
  });

  it("restores the task row and reports the failure when archiving rejects", async () => {
    const user = userEvent.setup();
    featureFlagsMock.taskSpawning = true;
    taskCommandsMock.archiveHeadlessTask.mockRejectedValueOnce(new Error("network unavailable"));
    sidebarTasksMock.value = [
      taskRow("task_settled", { displayId: "T-2", name: "Settled task", status: "succeeded" }),
    ];

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Archive Settled task" }));

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Settled task/ })).toBeInTheDocument(),
    );
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("shows working and unseen chat state in recent rows", () => {
    pathnameMock.value = "/";
    recentChatsMock.value = [
      {
        id: "goat_chat_working",
        title: "Working chat",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Working",
        updatedAt: "2026-07-14T09:00:00.000Z",
        pinnedAt: null,
        activityState: "working",
        hasUnseen: false,
      },
      {
        id: "goat_chat_unseen",
        title: "Unread result",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Ready",
        updatedAt: "2026-07-14T09:01:00.000Z",
        pinnedAt: null,
        activityState: "idle",
        hasUnseen: true,
      },
    ];

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByRole("link", { name: "Working chat" })).toHaveAttribute(
      "href",
      "/chat/goat_chat_working",
    );
    expect(screen.getByRole("link", { name: "Unread result" })).toHaveAttribute(
      "href",
      "/chat/goat_chat_unseen",
    );
    expect(screen.getByTestId("sidebar-chat-working")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-chat-unseen")).toBeInTheDocument();
  });

  it("requests composer focus when a recent chat is opened normally", async () => {
    const user = userEvent.setup();
    const focusRequest = vi.fn();
    window.addEventListener(CHAT_COMPOSER_FOCUS_EVENT, focusRequest);
    recentChatsMock.value = [
      {
        id: "goat_chat_focus",
        title: "Focus chat",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Ready",
        updatedAt: "2026-07-14T09:01:00.000Z",
        pinnedAt: null,
      },
    ];

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.click(screen.getByRole("link", { name: "Focus chat" }));

    expect(focusRequest).toHaveBeenCalledTimes(1);
    expect(consumePendingChatComposerFocus("goat_chat_focus")).toBe(true);
    window.removeEventListener(CHAT_COMPOSER_FOCUS_EVENT, focusRequest);
  });

  it("keeps an optimistic chat local until persistence is confirmed", async () => {
    const user = userEvent.setup();
    const pendingChatId = "chat_pending";
    recentChatsMock.value = [
      {
        id: pendingChatId,
        title: "Pending chat",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Starting",
        updatedAt: "2026-07-14T09:01:00.000Z",
        pinnedAt: null,
        state: "working",
      },
    ];
    addOptimisticChatSummary({
      workspaceId: workspacesMock.value[0]!.id,
      sessionId: pendingChatId,
      prompt: "Pending chat",
      model: "claude-sonnet-5",
      engine: "opencompany",
    });

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const pendingChat = screen.getByRole("button", { name: "Pending chat" });
    expect(screen.queryByRole("link", { name: "Pending chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pin Pending chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Pending chat" })).not.toBeInTheDocument();

    await user.hover(pendingChat);
    await user.click(pendingChat);

    expect(routerMock.prefetch).not.toHaveBeenCalledWith(`/chat/${pendingChatId}`);
    expect(consumePendingChatComposerFocus(pendingChatId)).toBe(true);

    act(() => removeOptimisticChatSummary(pendingChatId));

    const persistedChat = await screen.findByRole("link", { name: "Pending chat" });
    expect(persistedChat).toHaveAttribute("href", `/chat/${pendingChatId}`);
    await user.hover(persistedChat);
    expect(routerMock.prefetch).toHaveBeenCalledWith(`/chat/${pendingChatId}`);
  });

  it("warms the transcript collection when a recent chat is hovered", async () => {
    const user = userEvent.setup();
    recentChatsMock.value = [
      {
        id: "chat_warm",
        title: "Warm chat",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Ready",
        updatedAt: "2026-07-14T09:01:00.000Z",
        pinnedAt: null,
      },
    ];

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.hover(screen.getByRole("link", { name: "Warm chat" }));

    expect(routerMock.prefetch).toHaveBeenCalledWith("/chat/chat_warm");
    expect(chatCollectionMocks.preloadHeadlessChatMessages).toHaveBeenCalledWith("chat_warm");
  });

  it("shows working before unseen when the API reports both", () => {
    pathnameMock.value = "/";
    recentChatsMock.value = [
      {
        id: "goat_chat_lagging_runtime",
        title: "Still working",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        runtime: {
          status: "idle",
          activeRunId: "goat_codex_chat_turn_1",
          hasError: false,
          updatedAt: "2026-07-14T09:00:30.000Z",
        },
        activityState: "working",
        hasUnseen: true,
        preview: "Ready",
        updatedAt: "2026-07-14T09:01:00.000Z",
        lastSeenAt: "2026-07-14T09:00:00.000Z",
        pinnedAt: null,
      },
    ];

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByTestId("sidebar-chat-working")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-chat-unseen")).not.toBeInTheDocument();
  });

  it("uses a retained local working state while durable runtime has not caught up", () => {
    pathnameMock.value = "/";
    setLocalChatState("goat_chat_streaming", "working");
    recentChatsMock.value = [
      {
        id: "goat_chat_streaming",
        title: "Still streaming",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Partial answer",
        updatedAt: "2026-07-14T09:01:00.000Z",
        lastSeenAt: "2026-07-14T09:00:00.000Z",
        pinnedAt: null,
        activityState: "idle",
        hasUnseen: true,
      },
    ];

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByTestId("sidebar-chat-working")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-chat-unseen")).not.toBeInTheDocument();
  });

  it("drops a retained local working state after the API projection reports working", async () => {
    pathnameMock.value = "/";
    setLocalChatState("goat_chat_runtime", "working");
    recentChatsMock.value = [
      {
        id: "goat_chat_runtime",
        title: "Runtime caught up",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        runtime: {
          status: "running",
          activeRunId: "goat_codex_chat_turn_1",
          hasError: false,
          updatedAt: "2026-07-14T09:01:00.000Z",
        },
        activityState: "working",
        hasUnseen: false,
        preview: "Partial answer",
        updatedAt: "2026-07-14T09:01:00.000Z",
        lastSeenAt: "2026-07-14T09:00:00.000Z",
        pinnedAt: null,
      },
    ];

    const { rerender } = render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByTestId("sidebar-chat-working")).toBeInTheDocument();
    await waitFor(() => {
      recentChatsMock.value = [
        {
          ...recentChatsMock.value[0]!,
          activityState: "idle",
          hasUnseen: true,
        },
      ];
      rerender(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      expect(screen.getByTestId("sidebar-chat-unseen")).toBeInTheDocument();
    });
  });

  it("keeps the unseen marker until the selected chat is reset through the API", () => {
    pathnameMock.value = "/chat/goat_chat_unseen";
    recentChatsMock.value = [
      {
        id: "goat_chat_unseen",
        title: "Unread result",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        runtime: {
          status: "idle",
          activeRunId: "goat_codex_chat_turn_1",
          hasError: false,
          updatedAt: "2026-07-14T09:00:30.000Z",
        },
        preview: "Ready",
        updatedAt: "2026-07-14T09:01:00.000Z",
        pinnedAt: null,
        activityState: "idle",
        hasUnseen: true,
      },
    ];

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByRole("link", { name: "Unread result" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByTestId("sidebar-chat-unseen")).toBeInTheDocument();
  });

  it("pins and unpins chats via the row toggle", async () => {
    const user = userEvent.setup();
    pathnameMock.value = "/";
    recentChatsMock.value = [
      {
        id: "goat_chat_pinned",
        title: "Pinned chat",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Pinned",
        updatedAt: "2026-07-01T09:00:00.000Z",
        pinnedAt: "2026-07-13T09:00:00.000Z",
      },
      {
        id: "goat_chat_recent",
        title: "Recent chat",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Recent",
        updatedAt: "2026-07-14T09:00:00.000Z",
        pinnedAt: null,
      },
    ];
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Pin Recent chat" }));
    expect(chatCommandsMock.updateHeadlessChatConversation).toHaveBeenCalledWith(
      "goat_chat_recent",
      { pinned: true },
    );
    expect(screen.getByRole("button", { name: "Unpin Recent chat" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const unpin = screen.getByRole("button", { name: "Unpin Pinned chat" });
    expect(unpin).toHaveAttribute("aria-pressed", "true");
    await user.click(unpin);
    expect(chatCommandsMock.updateHeadlessChatConversation).toHaveBeenCalledWith(
      "goat_chat_pinned",
      { pinned: false },
    );
  });

  it("tracks concurrent pin requests independently and restores failed rows", async () => {
    const user = userEvent.setup();
    let resolvePin!: (value: { transactionId: string }) => void;
    let rejectUnpin!: (reason: Error) => void;
    chatCommandsMock.updateHeadlessChatConversation
      .mockImplementationOnce(() => new Promise((resolve) => (resolvePin = resolve)))
      .mockImplementationOnce(() => new Promise((_, reject) => (rejectUnpin = reject)));
    recentChatsMock.value = [
      {
        id: "goat_chat_pinned",
        title: "Pinned chat",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Pinned",
        updatedAt: "2026-07-01T09:00:00.000Z",
        pinnedAt: "2026-07-13T09:00:00.000Z",
      },
      {
        id: "goat_chat_recent",
        title: "Recent chat",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Recent",
        updatedAt: "2026-07-14T09:00:00.000Z",
        pinnedAt: null,
      },
    ];
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Pin Recent chat" }));
    await user.click(screen.getByRole("button", { name: "Unpin Pinned chat" }));

    expect(chatCommandsMock.updateHeadlessChatConversation).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Unpin Recent chat" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pin Pinned chat" })).toBeDisabled();
    // The rows have already moved between sections, so the toggles show the state the user asked
    // for rather than a spinner over the one they just left.
    expect(
      screen.getByRole("button", { name: "Unpin Recent chat" }).querySelector(".animate-spin"),
    ).toBeNull();

    await act(async () => resolvePin({ transactionId: "1" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Unpin Recent chat" })).toBeEnabled(),
    );

    await act(async () => rejectUnpin(new Error("network unavailable")));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Unpin Pinned chat" })).toBeEnabled(),
    );
  });

  // The write and the projection behind it take about a second. The user has already dismissed the
  // chat, so the row leaves on the click rather than sitting there under a spinner.
  it("drops an archived chat row before the write settles", async () => {
    const user = userEvent.setup();
    let settleArchive!: (value: { transactionId: string }) => void;
    chatCommandsMock.updateHeadlessChatConversation.mockImplementationOnce(
      () => new Promise((resolve) => (settleArchive = resolve)),
    );
    recentChatsMock.value = [
      archivableChat("conversation_archive", "Archive me"),
      archivableChat("conversation_keep", "Keep me"),
    ];
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Archive Archive me" }));

    expect(screen.queryByRole("link", { name: /Archive me/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Keep me/ })).toBeInTheDocument();
    await act(async () => settleArchive({ transactionId: "1" }));
  });

  // Leaving the archived chat open would keep a conversation on screen that is no longer listed
  // anywhere, so the route moves with the row rather than after the write.
  it("leaves the archived chat's route on the click", async () => {
    const user = userEvent.setup();
    pathnameMock.value = "/chat/conversation_archive";
    chatCommandsMock.updateHeadlessChatConversation.mockImplementationOnce(
      () => new Promise(() => {}),
    );
    recentChatsMock.value = [archivableChat("conversation_archive", "Archive me")];
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Archive Archive me" }));

    expect(routerMock.push).toHaveBeenCalledWith("/");
  });

  it("restores the row and reports the failure when archiving rejects", async () => {
    const user = userEvent.setup();
    chatCommandsMock.updateHeadlessChatConversation.mockRejectedValueOnce(
      new Error("network unavailable"),
    );
    recentChatsMock.value = [archivableChat("goat_chat_archive", "Archive me")];
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Archive Archive me" }));

    expect(chatCommandsMock.updateHeadlessChatConversation).toHaveBeenCalledWith(
      "goat_chat_archive",
      { archived: true },
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Archive Archive me" })).toBeInTheDocument(),
    );
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("collapses to zero width and toggles via the sidebar button", () => {
    pathnameMock.value = "/";
    const onToggleCollapsed = vi.fn();
    render(<Sidebar collapsed onToggleCollapsed={onToggleCollapsed} />);

    const aside = document.querySelector("aside");
    expect(aside).toHaveAttribute("aria-hidden", "true");
    expect(aside?.className).toContain("w-0");
  });

  it("hides For review until the beta flag is on", () => {
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.queryByRole("link", { name: /For review/ })).not.toBeInTheDocument();
  });

  it("shows For review directly below Home with its unread count", () => {
    featureFlagsMock.reviewInbox = true;
    reviewCountMock.value = 3;

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const nav = screen.getByRole("navigation", { name: "opencompany primary" });
    const links = within(nav).getAllByRole("link");
    expect(links[0]).toHaveTextContent("Home");
    expect(links[1]).toHaveTextContent("For review");
    expect(links[1]).toHaveTextContent("3");
    expect(links[1]).toHaveAttribute("href", "/review");
  });

  it("omits the count badge when nothing is awaiting review", () => {
    featureFlagsMock.reviewInbox = true;
    reviewCountMock.value = 0;

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByRole("link", { name: /For review/ })).toHaveTextContent(/^For review$/);
  });

  it("marks For review as the current page on its route", () => {
    featureFlagsMock.reviewInbox = true;
    pathnameMock.value = "/review";

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByRole("link", { name: /For review/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  describe("Projects", () => {
    const project = (id: string, name: string, conversationIds: string[] = []) => ({
      id,
      name,
      conversationIds,
      createdAt: "2026-07-01T09:00:00.000Z",
    });

    // The region renders before listProjects resolves. Wait for the loading boundary itself so
    // tests can safely depend on project rows, empty results, or derived membership.
    async function findLoadedProjects() {
      const projects = await screen.findByRole("region", { name: "Projects" });
      await waitFor(() =>
        expect(within(projects).queryByText("Loading projects…")).not.toBeInTheDocument(),
      );
      return projects;
    }

    it("stays hidden until the Projects preference is on", async () => {
      recentChatsMock.value = [chatRow("chat_1")];
      projectsApiMock.listProjects.mockResolvedValue([project("project_1", "Launch")]);

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

      expect(screen.queryByText("Projects")).not.toBeInTheDocument();
      expect(projectsApiMock.listProjects).not.toHaveBeenCalled();
    });

    it("lists a project's chats and keeps them out of Recents", async () => {
      featureFlagsMock.sidebarProjects = true;
      featureFlagsMock.taskSpawning = true;
      recentChatsMock.value = [chatRow("chat_filed"), chatRow("chat_loose")];
      sidebarTasksMock.value = [taskRow("task_filed")];
      projectsApiMock.listProjects.mockResolvedValue([
        project("project_1", "Launch", ["chat_filed", "conversation_task_filed"]),
        project("project_2", "Empty"),
      ]);

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

      const projects = await findLoadedProjects();
      expect(within(projects).getByText("Launch")).toBeInTheDocument();
      expect(within(projects).getByRole("link", { name: "chat_filed title" })).toBeInTheDocument();
      expect(within(projects).getByRole("link", { name: /task_filed name/ })).toBeInTheDocument();
      expect(within(projects).getByText("No chats")).toBeInTheDocument();

      const recents = screen.getByRole("navigation", { name: "Recents" });
      expect(within(recents).getByRole("link", { name: "chat_loose title" })).toBeInTheDocument();
      expect(within(recents).queryByRole("link", { name: "chat_filed title" })).toBeNull();
      expect(within(recents).queryByRole("link", { name: /task_filed name/ })).toBeNull();
    });

    it("files a chat dropped on a project and keeps the row out of Recents", async () => {
      featureFlagsMock.sidebarProjects = true;
      recentChatsMock.value = [chatRow("chat_1")];
      projectsApiMock.listProjects.mockResolvedValue([project("project_1", "Launch")]);
      projectsApiMock.fileConversationInProject.mockResolvedValue([
        project("project_1", "Launch", ["chat_1"]),
      ]);

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      const projects = await findLoadedProjects();
      const folder = within(projects).getByRole("button", { name: "Launch" });

      const target = folder.parentElement;
      if (!target) throw new Error("The project row is missing its drop target.");
      await act(async () => {
        fireEvent.drop(target, { dataTransfer: conversationTransfer("chat_1") });
      });

      await waitFor(() =>
        expect(projectsApiMock.fileConversationInProject).toHaveBeenCalledWith(
          "project_1",
          "chat_1",
        ),
      );
      await waitFor(() =>
        expect(
          within(screen.getByRole("region", { name: "Projects" })).getByRole("link", {
            name: "chat_1 title",
          }),
        ).toBeInTheDocument(),
      );
      // Recents keeps its header as the target for dragging the row back out, and says so now
      // that it holds nothing.
      const recents = screen.getByRole("navigation", { name: "Recents" });
      expect(within(recents).queryByRole("link")).toBeNull();
      expect(
        within(recents).getByText("Drag a chat here to take it out of a project."),
      ).toBeInTheDocument();
    });

    it("returns a dropped chat to Recents", async () => {
      featureFlagsMock.sidebarProjects = true;
      recentChatsMock.value = [chatRow("chat_filed"), chatRow("chat_loose")];
      projectsApiMock.listProjects.mockResolvedValue([
        project("project_1", "Launch", ["chat_filed"]),
      ]);
      projectsApiMock.removeConversationFromProject.mockResolvedValue([
        project("project_1", "Launch"),
      ]);

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      await findLoadedProjects();

      await act(async () => {
        fireEvent.drop(screen.getByRole("button", { name: "Recents" }), {
          dataTransfer: conversationTransfer("chat_filed"),
        });
      });

      await waitFor(() =>
        expect(projectsApiMock.removeConversationFromProject).toHaveBeenCalledWith(
          "project_1",
          "chat_filed",
        ),
      );
      await waitFor(() =>
        expect(
          within(screen.getByRole("navigation", { name: "Recents" })).getByRole("link", {
            name: "chat_filed title",
          }),
        ).toBeInTheDocument(),
      );
    });

    it("collapses one project without hiding the others and remembers the choice", async () => {
      featureFlagsMock.sidebarProjects = true;
      recentChatsMock.value = [chatRow("chat_a"), chatRow("chat_b")];
      projectsApiMock.listProjects.mockResolvedValue([
        project("project_1", "Launch", ["chat_a"]),
        project("project_2", "Research", ["chat_b"]),
      ]);

      const { unmount } = render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      const projects = await findLoadedProjects();
      const folder = within(projects).getByRole("button", { name: "Launch" });
      expect(folder).toHaveAttribute("aria-expanded", "true");

      await userEvent.click(folder);

      expect(within(projects).getByRole("button", { name: "Launch" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      expect(within(projects).queryByRole("link", { name: "chat_a title" })).toBeNull();
      expect(within(projects).getByRole("link", { name: "chat_b title" })).toBeInTheDocument();

      unmount();
      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      const reopened = await findLoadedProjects();
      expect(within(reopened).getByRole("button", { name: "Launch" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });

    it("swaps the folder icon for the open/closed state instead of showing a chevron", async () => {
      featureFlagsMock.sidebarProjects = true;
      recentChatsMock.value = [chatRow("chat_a")];
      projectsApiMock.listProjects.mockResolvedValue([project("project_1", "Launch", ["chat_a"])]);

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      const projects = await findLoadedProjects();
      const folder = within(projects).getByRole("button", { name: "Launch" });

      // The icon is decorative, so aria-expanded (covered above) carries the state for assistive
      // tech. Lucide's per-icon class is the only stable handle on which glyph actually rendered.
      expect(folder.querySelector(".lucide-folder-open")).not.toBeNull();
      expect(folder.querySelector(".lucide-chevron-down")).toBeNull();

      await userEvent.click(folder);

      expect(folder.querySelector(".lucide-folder")).not.toBeNull();
      expect(folder.querySelector(".lucide-folder-open")).toBeNull();
      expect(folder.querySelector(".lucide-chevron-down")).toBeNull();
    });

    it("collapses the whole Projects section and remembers the choice", async () => {
      featureFlagsMock.sidebarProjects = true;
      recentChatsMock.value = [chatRow("chat_a")];
      projectsApiMock.listProjects.mockResolvedValue([project("project_1", "Launch", ["chat_a"])]);

      const { unmount } = render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      await findLoadedProjects();
      const section = screen.getByRole("button", { name: "Projects" });
      expect(section).toHaveAttribute("aria-expanded", "true");

      await userEvent.click(section);

      expect(section).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("button", { name: "Launch" })).toBeNull();
      // The header stays put while collapsed so the section is still findable.
      expect(screen.getByRole("button", { name: "Projects" })).toBeInTheDocument();

      unmount();
      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

      expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await waitFor(() => expect(projectsApiMock.listProjects).toHaveBeenCalled());
      expect(screen.queryByRole("button", { name: "Launch" })).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Projects" }));

      expect(await screen.findByRole("button", { name: "Launch" })).toBeInTheDocument();
    });

    it("takes a new project name while collapsed and reopens the section once it saves", async () => {
      featureFlagsMock.sidebarProjects = true;
      window.localStorage.setItem("opencompany-sidebar-projects-collapsed", "true");
      projectsApiMock.listProjects.mockResolvedValue([]);
      projectsApiMock.createProject.mockResolvedValue([project("project_1", "Launch")]);

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      await screen.findByRole("region", { name: "Projects" });

      await userEvent.click(screen.getByRole("button", { name: "New project" }));

      // The name input is above the fold, so a collapsed section can still take one.
      expect(screen.getByLabelText("Project name")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );

      await userEvent.type(screen.getByLabelText("Project name"), "Launch{Enter}");

      expect(await screen.findByRole("button", { name: "Launch" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    it("keeps a collapsed Projects section closed when a new project is abandoned", async () => {
      featureFlagsMock.sidebarProjects = true;
      window.localStorage.setItem("opencompany-sidebar-projects-collapsed", "true");
      projectsApiMock.listProjects.mockResolvedValue([]);

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      await screen.findByRole("region", { name: "Projects" });

      await userEvent.click(screen.getByRole("button", { name: "New project" }));
      await userEvent.keyboard("{Escape}");

      expect(projectsApiMock.createProject).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });

    it("starts a new chat in a project and marks that project as the target", async () => {
      featureFlagsMock.sidebarProjects = true;
      searchParamsMock.value = new URLSearchParams("project=project_1");
      projectsApiMock.listProjects.mockResolvedValue([project("project_1", "Launch")]);

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      const projects = await findLoadedProjects();

      expect(within(projects).getByRole("link", { name: "New chat in Launch" })).toHaveAttribute(
        "href",
        "/?project=project_1",
      );
      expect(within(projects).getByRole("button", { name: "Launch" }).parentElement).toHaveClass(
        "bg-surface-active",
      );
    });

    it("renames a project when the reader clicks away from the field", async () => {
      featureFlagsMock.sidebarProjects = true;
      recentChatsMock.value = [chatRow("chat_a")];
      projectsApiMock.listProjects.mockResolvedValue([project("project_1", "Launch", ["chat_a"])]);
      projectsApiMock.renameProject.mockResolvedValue([
        project("project_1", "Launch week", ["chat_a"]),
      ]);

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      const projects = await findLoadedProjects();

      await userEvent.click(
        within(projects).getByRole("button", { name: "Project options for Launch" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Rename" }));
      const field = screen.getByLabelText("Project name");
      await userEvent.clear(field);
      await userEvent.type(field, "Launch week");
      await act(async () => {
        fireEvent.blur(field);
      });

      await waitFor(() =>
        expect(projectsApiMock.renameProject).toHaveBeenCalledWith("project_1", "Launch week"),
      );
      expect(await screen.findByText("Launch week")).toBeInTheDocument();
    });

    it("deletes a project and returns its chats to Recents", async () => {
      featureFlagsMock.sidebarProjects = true;
      recentChatsMock.value = [chatRow("chat_a")];
      projectsApiMock.listProjects.mockResolvedValue([project("project_1", "Launch", ["chat_a"])]);
      projectsApiMock.deleteProject.mockResolvedValue([]);

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      const projects = await findLoadedProjects();

      await userEvent.click(
        within(projects).getByRole("button", { name: "Project options for Launch" }),
      );
      await userEvent.click(screen.getByRole("button", { name: /Delete project/ }));

      await waitFor(() => expect(projectsApiMock.deleteProject).toHaveBeenCalledWith("project_1"));
      await waitFor(() =>
        expect(
          within(screen.getByRole("navigation", { name: "Recents" })).getByRole("link", {
            name: "chat_a title",
          }),
        ).toBeInTheDocument(),
      );
    });

    it("creates a project from the section header", async () => {
      featureFlagsMock.sidebarProjects = true;
      projectsApiMock.listProjects.mockResolvedValue([]);
      projectsApiMock.createProject.mockResolvedValue([project("project_1", "Launch")]);

      render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      await findLoadedProjects();

      await userEvent.click(screen.getByRole("button", { name: "New project" }));
      await userEvent.type(screen.getByLabelText("Project name"), "Launch{Enter}");

      await waitFor(() =>
        expect(projectsApiMock.createProject).toHaveBeenCalledWith({
          id: expect.stringMatching(/^project_/),
          name: "Launch",
        }),
      );
      expect(await screen.findByText("Launch")).toBeInTheDocument();
    });
  });
});

// jsdom has no DataTransfer, so the drag payload is the minimal surface the sidebar reads.
function conversationTransfer(conversationId: string) {
  const type = "application/x-opencompany-conversation";
  return {
    types: [type],
    getData: (requested: string) => (requested === type ? conversationId : ""),
    dropEffect: "none",
    effectAllowed: "all",
  };
}

function chatRow(
  id: string,
  overrides: Partial<(typeof recentChatsMock.value)[number]> = {},
): (typeof recentChatsMock.value)[number] {
  return {
    id,
    title: `${id} title`,
    model: "claude-sonnet-5",
    engine: "opencompany",
    codexComposerSettings: null,
    preview: "Ready",
    updatedAt: "2026-07-14T09:00:00.000Z",
    pinnedAt: null,
    ...overrides,
  };
}

function taskRow(
  id: string,
  overrides: Partial<(typeof sidebarTasksMock.value)[number]> = {},
): (typeof sidebarTasksMock.value)[number] {
  return {
    id,
    conversationId: `conversation_${id}`,
    displayId: id.toUpperCase(),
    name: `${id} name`,
    status: "succeeded",
    hasUnseen: false,
    updatedAt: "2026-07-14T09:00:00.000Z",
    ...overrides,
  };
}
