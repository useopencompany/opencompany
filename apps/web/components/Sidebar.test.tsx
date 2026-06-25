import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ToastProvider";
import { WorkspaceProvider } from "@/components/WorkspaceContext";
import Sidebar from "./Sidebar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({
    prefetch: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock("next/link", () => ({
  default: (input: ComponentProps<"a"> & { prefetch?: boolean }) => {
    const { href, children, prefetch, ...props } = input;
    void prefetch;
    return (
      <a href={typeof href === "string" ? href : ""} {...props}>
        {children}
      </a>
    );
  },
}));

vi.mock("@/components/FeedbackDialog", () => ({
  default: () => null,
}));

// SidebarAccountFooter imports the feedback server action directly (to send optimistically). Stub
// it so the test doesn't pull the server-action import chain (auth → workos → next/cache) in.
vi.mock("@/lib/feedback/actions", () => ({
  submitFeedback: vi.fn(),
}));

// The sidebar reads its sessions from TanStack DB live queries and writes
// through the workspace collections. Stub both so this status-menu test renders
// without mounting CollectionsProvider (which pulls the server-action import
// chain into the test) or opening real Electric shape streams.
vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/components/CollectionsProvider", () => ({
  useCollections: () => ({
    agentSessions: { delete: vi.fn(() => ({ isPersisted: { promise: Promise.resolve() } })) },
    sessionStars: {
      insert: vi.fn(() => ({ isPersisted: { promise: Promise.resolve() } })),
      delete: vi.fn(() => ({ isPersisted: { promise: Promise.resolve() } })),
    },
  }),
}));

const statusPageUrl = "https://myopencompany.betteruptime.com";

describe("Sidebar status menu item", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("keeps personal and workspace spaces available from the space switcher", async () => {
    const user = userEvent.setup();

    renderSidebar();
    await user.click(screen.getByRole("button", { name: "Switch space" }));

    expect(await screen.findByRole("link", { name: "Personal" })).toHaveAttribute(
      "href",
      "/personal",
    );
    const workspaceLink = screen.getByRole("link", { name: "OpenCompany" });
    expect(workspaceLink).toHaveAttribute("href", "/");
    expect(workspaceLink).toHaveAttribute("title", "OpenCompany");
    expect(workspaceLink).toHaveAttribute("aria-current", "page");
  });

  it("links to the Better Stack status page from the account menu", async () => {
    mockStatusPageFetch("operational");
    const user = userEvent.setup();

    renderSidebar();
    await user.click(screen.getByRole("button", { name: "Open account menu" }));

    const statusLink = screen.getByRole("link", { name: /all systems operational/i });
    expect(statusLink).toHaveAttribute("href", statusPageUrl);
    expect(statusLink).toHaveAttribute("target", "_blank");
    expect(statusLink).toHaveAttribute("rel", "noreferrer");
  });

  it("shows the operational aggregate state", async () => {
    mockStatusPageFetch("operational");
    const user = userEvent.setup();

    renderSidebar();
    await user.click(screen.getByRole("button", { name: "Open account menu" }));

    expect(await screen.findByText("All systems operational")).toBeInTheDocument();
  });

  it("keeps the status link available when the status fetch fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network unavailable"));
    const user = userEvent.setup();

    renderSidebar();
    await user.click(screen.getByRole("button", { name: "Open account menu" }));

    expect(await screen.findByText("Status unavailable")).toBeInTheDocument();
    const statusLink = screen.getByRole("link", { name: /status unavailable/i });
    expect(statusLink).toHaveAttribute("href", statusPageUrl);
  });
});

function renderSidebar() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceProvider workspaceId="wks_test" userId="usr_test">
        <ToastProvider>
          <Sidebar
            userName="Ada Lovelace"
            userEmail="ada@example.com"
            workspaceName="OpenCompany"
            initialCollapsed={false}
            initialSessions={[]}
          />
        </ToastProvider>
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
}

function mockStatusPageFetch(aggregateState: string) {
  vi.mocked(fetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        data: {
          attributes: {
            aggregate_state: aggregateState,
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}
