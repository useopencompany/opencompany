import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_COMPOSER_FOCUS_EVENT,
  consumePendingChatComposerFocus,
  HOME_NAVIGATION_EVENT,
} from "@/lib/chat-navigation";
import { clearAllLocalChatStates, setLocalChatState } from "@/lib/chat-session-state";
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
}));
const recentChatsMock = vi.hoisted(() => ({
  value: [] as Array<{
    id: string;
    title: string;
    model: string;
    engine: string;
    codexComposerSettings: null;
    codexRuntime?: {
      status: "queued" | "starting" | "idle" | "running" | "failed" | "interrupted" | "closed";
      activeTurnId?: string | null;
      error: string | null;
      updatedAt: string;
    } | null;
    state?: "working" | "done_unseen" | "done_seen";
    preview: string;
    updatedAt: string;
    lastSeenAt?: string | null;
    pinnedAt: string | null;
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

vi.mock("@/lib/headless-chat-commands", () => chatCommandsMock);

vi.mock("@/components/AppDataProvider", () => ({
  useAppData: () => ({
    user: {
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
    recentChats: recentChatsMock.value,
    featureFlags: {
      taskSpawning: featureFlagsMock.taskSpawning,
      autoModelRouting: featureFlagsMock.autoModelRouting,
    },
    mcpSetup: { preferredClient: null, completedAt: mcpSetupMock.completedAt },
  }),
}));

describe("Sidebar", () => {
  afterEach(() => {
    vi.clearAllMocks();
    pathnameMock.value = "/";
    workspaceRoleMock.value = "admin";
    workspacesMock.value = [{ id: "goat_ws_1", name: "Ada's Workspace", role: "admin" }];
    mcpSetupMock.completedAt = null;
    featureFlagsMock.taskSpawning = false;
    recentChatsMock.value = [];
    tasksMock.value = [];
    clearAllLocalChatStates();
    consumePendingChatComposerFocus("goat_chat_focus");
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
    expect(screen.getByText("Brains")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "General" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "New brain" })).toHaveClass("opacity-0");
    expect(screen.queryByText("New brain")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Manage access to General" }),
    ).not.toBeInTheDocument();

    const account = screen.getByRole("button", { name: "Account menu for Ada Lovelace" });
    expect(account).toBeInTheDocument();

    const feedback = screen.getByRole("button", { name: "Feedback" });
    expect(feedback.nextElementSibling).toBe(account);
    expect(screen.queryByRole("link", { name: "Changelog" })).not.toBeInTheDocument();
  });

  it("opens the account menu with settings, changelog, and sign out", async () => {
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

    const setup = screen.getByRole("link", { name: "Connect your brain" });
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
    const recentNav = screen.getByRole("navigation", { name: "Recent chats" });
    expect(within(recentNav).getByRole("link", { name: "Recent chat" })).toBeInTheDocument();
    expect(within(recentNav).queryByRole("link", { name: "Pinned chat" })).not.toBeInTheDocument();
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
        state: "working",
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
        state: "done_unseen",
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

  it("shows working instead of unseen when a chat still has an active model turn", () => {
    pathnameMock.value = "/";
    recentChatsMock.value = [
      {
        id: "goat_chat_lagging_runtime",
        title: "Still working",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        codexRuntime: {
          status: "idle",
          activeTurnId: "goat_codex_chat_turn_1",
          error: null,
          updatedAt: "2026-07-14T09:00:30.000Z",
        },
        preview: "Ready",
        updatedAt: "2026-07-14T09:01:00.000Z",
        lastSeenAt: "2026-07-14T09:00:00.000Z",
        pinnedAt: null,
        state: "done_unseen",
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
        state: "done_unseen",
      },
    ];

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByTestId("sidebar-chat-working")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-chat-unseen")).not.toBeInTheDocument();
  });

  it("drops a retained local working state after durable runtime reports working", async () => {
    pathnameMock.value = "/";
    setLocalChatState("goat_chat_runtime", "working");
    recentChatsMock.value = [
      {
        id: "goat_chat_runtime",
        title: "Runtime caught up",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        codexRuntime: {
          status: "running",
          activeTurnId: "goat_codex_chat_turn_1",
          error: null,
          updatedAt: "2026-07-14T09:01:00.000Z",
        },
        preview: "Partial answer",
        updatedAt: "2026-07-14T09:01:00.000Z",
        lastSeenAt: "2026-07-14T09:00:00.000Z",
        pinnedAt: null,
        state: "done_unseen",
      },
    ];

    const { rerender } = render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByTestId("sidebar-chat-working")).toBeInTheDocument();
    await waitFor(() => {
      recentChatsMock.value = [
        {
          ...recentChatsMock.value[0]!,
          codexRuntime: {
            status: "idle",
            activeTurnId: null,
            error: null,
            updatedAt: "2026-07-14T09:02:00.000Z",
          },
        },
      ];
      rerender(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);
      expect(screen.getByTestId("sidebar-chat-unseen")).toBeInTheDocument();
    });
  });

  it("hides the unseen marker for the selected completed chat", () => {
    pathnameMock.value = "/chat/goat_chat_unseen";
    recentChatsMock.value = [
      {
        id: "goat_chat_unseen",
        title: "Unread result",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Ready",
        updatedAt: "2026-07-14T09:01:00.000Z",
        pinnedAt: null,
        state: "done_unseen",
      },
    ];

    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByRole("link", { name: "Unread result" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByTestId("sidebar-chat-unseen")).not.toBeInTheDocument();
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

    await act(async () => resolvePin({ transactionId: "1" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Unpin Recent chat" })).toBeEnabled(),
    );

    await act(async () => rejectUnpin(new Error("network unavailable")));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Unpin Pinned chat" })).toBeEnabled(),
    );
  });

  it("keeps the sidebar usable when archiving a chat rejects", async () => {
    const user = userEvent.setup();
    chatCommandsMock.updateHeadlessChatConversation.mockRejectedValueOnce(
      new Error("network unavailable"),
    );
    recentChatsMock.value = [
      {
        id: "goat_chat_archive",
        title: "Archive me",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Ready",
        updatedAt: "2026-07-14T09:00:00.000Z",
        pinnedAt: null,
      },
    ];
    render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const archiveButton = screen.getByRole("button", { name: "Archive Archive me" });
    await user.click(archiveButton);

    expect(chatCommandsMock.updateHeadlessChatConversation).toHaveBeenCalledWith(
      "goat_chat_archive",
      { archived: true },
    );
    await waitFor(() => expect(archiveButton).toBeEnabled());
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
});
