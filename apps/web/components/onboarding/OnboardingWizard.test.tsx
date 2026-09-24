import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingWizard } from "./OnboardingWizard";

const mocks = vi.hoisted(() => ({
  captureProductEvent: vi.fn(),
  createStarterWorkflows: vi.fn(),
  finishOnboardingAction: vi.fn(),
  getOnboardingInstalledPluginsAction: vi.fn(),
  getOnboardingSubscriptionsAction: vi.fn(),
  installOfficialPlugin: vi.fn(),
  pollCodexDeviceAuth: vi.fn(),
  push: vi.fn(),
  saveOnboardingProfileAction: vi.fn(),
  saveOnboardingWorkspaceAction: vi.fn(),
  scanOnboardingRepositoryAction: vi.fn(),
  startCodexDeviceAuth: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@opencompany/analytics/product/client", () => ({
  captureProductEvent: mocks.captureProductEvent,
  identifyProductUser: vi.fn(),
}));

vi.mock("@/lib/onboarding-actions", () => ({
  finishOnboardingAction: mocks.finishOnboardingAction,
  getOnboardingInstalledPluginsAction: mocks.getOnboardingInstalledPluginsAction,
  getOnboardingSubscriptionsAction: mocks.getOnboardingSubscriptionsAction,
  saveOnboardingProfileAction: mocks.saveOnboardingProfileAction,
  saveOnboardingWorkspaceAction: mocks.saveOnboardingWorkspaceAction,
  scanOnboardingRepositoryAction: mocks.scanOnboardingRepositoryAction,
}));

vi.mock("@/lib/starter-workflows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/starter-workflows")>()),
  createStarterWorkflows: mocks.createStarterWorkflows,
}));

vi.mock("@/lib/onboarding-kickoff", () => ({
  queueOnboardingKickoff: vi.fn(() => true),
}));

vi.mock("@/lib/claude-code-auth", () => ({ saveClaudeCodeToken: vi.fn() }));
vi.mock("@/lib/codex-auth", () => ({
  pollCodexDeviceAuth: mocks.pollCodexDeviceAuth,
  startCodexDeviceAuth: mocks.startCodexDeviceAuth,
}));

vi.mock("@/lib/official-plugin-catalog", async () => {
  const stub = (name: string, label: string, connectionProvider: string) => ({
    name,
    label,
    description: `${label} description`,
    connectionProvider,
    connectHref: `/api/integrations/${name}/start`,
    Icon: () => null,
    iconClassName: "",
  });
  return {
    installOfficialPlugin: mocks.installOfficialPlugin,
    OFFICIAL_MCP_PLUGINS: {
      github: stub("github", "GitHub as you", "github_user"),
      linear: stub("linear", "Linear", "linear"),
      gmail: stub("gmail", "Gmail", "gmail"),
      slack: stub("slack", "Slack", "slack"),
      notion: stub("notion", "Notion", "notion"),
      posthog: stub("posthog", "PostHog", "posthog"),
    },
  };
});

const OWNER_PROPS = {
  user: {
    workosUserId: "user_1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    avatarUrl: null,
  },
  currentWorkspaceName: "",
  variant: "owner" as const,
  initialStep: 0,
  initialWorkspaceId: null,
  initialWorkspaceName: "",
  initialRole: null,
  initialCompanyUrl: "",
  initialReferral: null,
};

describe("OnboardingWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/");
    mocks.finishOnboardingAction.mockResolvedValue({ ok: true });
    mocks.saveOnboardingProfileAction.mockResolvedValue({ ok: true });
    mocks.saveOnboardingWorkspaceAction.mockResolvedValue({
      ok: true,
      workspaceId: "workspace_1",
    });
    mocks.getOnboardingSubscriptionsAction.mockResolvedValue({
      claudeCode: { connected: false, needsReauth: false },
      codex: { connected: false, needsReauth: false },
    });
    mocks.getOnboardingInstalledPluginsAction.mockResolvedValue([]);
    mocks.installOfficialPlugin.mockResolvedValue({ name: "github" });
    mocks.createStarterWorkflows.mockResolvedValue(undefined);
    mocks.scanOnboardingRepositoryAction.mockResolvedValue({
      ok: true,
      scan: { status: "not_connected" },
    });
    mocks.pollCodexDeviceAuth.mockReset();
    mocks.startCodexDeviceAuth.mockReset();
  });

  it("walks an owner through profile, workspace, subscriptions, plugins, and completion", async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard {...OWNER_PROPS} />);

    expect(screen.getByRole("heading", { name: "Welcome, Ada" })).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 5")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Sales \/ GTM/u }));
    await user.type(screen.getByLabelText(/Company URL/u), "acme.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByRole("heading", { name: "Create your workspace" }),
    ).toBeInTheDocument();
    expect(mocks.saveOnboardingProfileAction).toHaveBeenCalledWith({
      role: "sales",
      companyUrl: "acme.com",
    });
    // The workspace URL screen is gone; the slug is derived from the name.
    expect(screen.queryByText("Workspace URL")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/Company name/u), "Acme");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(mocks.saveOnboardingWorkspaceAction).toHaveBeenCalledWith({ name: "Acme" });

    expect(
      await screen.findByRole("heading", { name: "Bring your own AI subscription" }),
    ).toBeInTheDocument();
    // Nothing connected yet, so the primary action reads as an explicit skip.
    await user.click(await screen.findByRole("button", { name: "Skip for now" }));

    expect(
      await screen.findByRole("heading", { name: "Give your agent some tools" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Skip for now" }));

    expect(await screen.findByRole("heading", { name: "You're all set" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Finish onboarding" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/"));
    expect(mocks.finishOnboardingAction).toHaveBeenCalledWith({ referralSource: null });
    expect(mocks.captureProductEvent).toHaveBeenCalledWith("onboarding_completed", {
      flow: "owner",
      total_steps: 5,
      workspace_id: "workspace_1",
    });
  });

  it("presents the Claude setup command as its own copyable line", async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard {...OWNER_PROPS} initialStep={2} initialWorkspaceId="workspace_1" />);

    const claudeCard = (await screen.findByText("Claude")).closest("div.rounded-xl");
    expect(claudeCard).not.toBeNull();
    await user.click(within(claudeCard as HTMLElement).getByRole("button", { name: "Connect" }));

    expect(screen.getByText("Run this in your terminal:")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy claude setup-token" }));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("claude setup-token"),
    );
    expect(screen.getByPlaceholderText(/Paste your token/u)).toBeInTheDocument();
  });

  it("refreshes onboarding subscription state when Codex authentication completes", async () => {
    vi.useFakeTimers();
    try {
      mocks.getOnboardingSubscriptionsAction
        .mockResolvedValueOnce({
          claudeCode: { connected: false, needsReauth: false },
          codex: { connected: false, needsReauth: false },
        })
        .mockResolvedValue({
          claudeCode: { connected: false, needsReauth: false },
          codex: { connected: true, needsReauth: false },
        });
      mocks.startCodexDeviceAuth.mockResolvedValue({
        ok: true,
        flow: {
          id: "gcodf_1",
          status: "code_ready",
          verificationUri: "https://example.com/device",
          userCode: "ABCD-EFGH",
          statusReason: null,
        },
      });
      mocks.pollCodexDeviceAuth.mockResolvedValue({
        ok: true,
        flow: {
          id: "gcodf_1",
          status: "completed",
          verificationUri: null,
          userCode: null,
          statusReason: null,
        },
      });
      render(
        <OnboardingWizard {...OWNER_PROPS} initialStep={2} initialWorkspaceId="workspace_1" />,
      );

      await act(async () => {
        await Promise.resolve();
      });
      const codexCard = screen.getByText("ChatGPT").closest("div.rounded-xl");
      expect(codexCard).not.toBeNull();
      await act(async () => {
        fireEvent.click(within(codexCard as HTMLElement).getByRole("button", { name: "Connect" }));
      });
      expect(screen.getByRole("link", { name: "Open ChatGPT sign-in" })).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(mocks.pollCodexDeviceAuth).toHaveBeenCalledWith("gcodf_1");
      expect(mocks.getOnboardingSubscriptionsAction).toHaveBeenCalledTimes(2);
      expect(within(codexCard as HTMLElement).getByText("Connected")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("installs and starts connecting the recommended plugin in one click", async () => {
    const user = userEvent.setup();
    const popup = { close: vi.fn(), focus: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    try {
      render(
        <OnboardingWizard {...OWNER_PROPS} initialStep={3} initialWorkspaceId="workspace_1" />,
      );

      expect(
        await screen.findByRole("heading", { name: "Give your agent some tools" }),
      ).toBeInTheDocument();

      const githubRow = screen.getByText("GitHub as you").closest("div.rounded-xl");
      expect(githubRow).not.toBeNull();
      await user.click(within(githubRow as HTMLElement).getByRole("button", { name: "Connect" }));

      // Nothing opens until the founder has seen what the agent may do with the account.
      const dialog = await screen.findByRole("dialog", { name: "Connect GitHub as you" });
      expect(open).not.toHaveBeenCalled();
      expect(within(dialog).getByText("Read GitHub")).toBeInTheDocument();
      expect(within(dialog).getByText("Manage GitHub")).toBeInTheDocument();
      expect(within(dialog).getByText("waits for your approval in chat")).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Continue to GitHub as you" }));

      expect(open).toHaveBeenCalledWith(
        "/api/integrations/github/start?returnTo=%2Fonboarding%2Fconnected",
        "_blank",
        "width=600,height=760,noopener=no,noreferrer=no",
      );
      expect(popup.focus).toHaveBeenCalledOnce();
      await waitFor(() =>
        expect(mocks.installOfficialPlugin).toHaveBeenCalledWith(
          expect.objectContaining({ name: "github" }),
        ),
      );
      expect(
        await within(githubRow as HTMLElement).findByRole("button", { name: "Connect" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Continue/u })).toBeInTheDocument();
    } finally {
      open.mockRestore();
    }
  });

  it("reads a technical founder's repository and starts them with #build and #review-pr", async () => {
    const user = userEvent.setup();
    render(
      <OnboardingWizard
        {...OWNER_PROPS}
        initialStep={3}
        initialWorkspaceId="workspace_1"
        initialWorkspaceName="Acme"
        initialRole="founder"
      />,
    );

    expect(await screen.findByRole("heading", { name: "Connect your code" })).toBeInTheDocument();
    expect(screen.queryByText("Give your agent some tools")).not.toBeInTheDocument();

    mocks.getOnboardingInstalledPluginsAction.mockResolvedValue(["github"]);
    mocks.scanOnboardingRepositoryAction.mockResolvedValue({
      ok: true,
      scan: {
        status: "scanned",
        repository: { fullName: "acme/app", private: true },
        repositories: ["acme/app"],
        plugins: [{ plugin: "posthog", reason: "posthog-js in package.json" }],
        recommendedBy: "jev",
      },
    });
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: {
            type: "goat-onboarding-connection",
            provider: "github_user",
            status: "connected",
            reason: null,
          },
        }),
      );
    });

    expect(
      await screen.findByRole("heading", { name: "Here's what Acme runs on" }),
    ).toBeInTheDocument();
    expect(screen.getByText("posthog-js in package.json")).toBeInTheDocument();
    expect(screen.getByText("For your team")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Acme is ready" })).toBeInTheDocument();
    expect(screen.getByText("#build")).toBeInTheDocument();
    expect(screen.getByText("#review-pr")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Finish onboarding" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/"));
    expect(mocks.createStarterWorkflows).toHaveBeenCalledWith("acme/app");
  });

  it("consumes a same-tab connection result when browser storage is unavailable", async () => {
    window.history.replaceState(
      {},
      "",
      "/onboarding?variant=owner&integration=github_user&setup=connected",
    );
    render(<OnboardingWizard {...OWNER_PROPS} initialStep={3} initialWorkspaceId="workspace_1" />);

    const githubRow = (await screen.findByText("GitHub as you")).closest("div.rounded-xl");
    expect(githubRow).not.toBeNull();
    expect(within(githubRow as HTMLElement).getByText("Connected")).toBeInTheDocument();
    expect(window.location.search).toBe("?variant=owner");
  });

  it("gives invited members a welcome and their own subscription step only", async () => {
    const user = userEvent.setup();
    render(
      <OnboardingWizard
        {...OWNER_PROPS}
        variant="member"
        currentWorkspaceName="Acme"
        initialWorkspaceId="workspace_1"
      />,
    );

    expect(screen.getByRole("heading", { name: "Welcome to Acme" })).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByRole("heading", { name: "Bring your own AI subscription" }),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Skip for now" }));

    expect(await screen.findByRole("heading", { name: "You're all set" })).toBeInTheDocument();
    // Plugins are workspace-level and stay with the admin.
    expect(screen.queryByText("Give your agent some tools")).not.toBeInTheDocument();
    // Members are not asked the referral question.
    expect(screen.queryByText(/how did you hear about opencompany/u)).not.toBeInTheDocument();
  });
});
