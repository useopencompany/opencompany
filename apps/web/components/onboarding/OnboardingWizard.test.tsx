import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingWizard } from "./OnboardingWizard";

const mocks = vi.hoisted(() => ({
  captureProductEvent: vi.fn(),
  checkWorkspaceSlugAction: vi.fn(),
  finishOnboardingAction: vi.fn(),
  push: vi.fn(),
  saveOnboardingProfileAction: vi.fn(),
  saveOnboardingWorkspaceAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@opencompany/analytics/product/client", () => ({
  captureProductEvent: mocks.captureProductEvent,
  identifyProductUser: vi.fn(),
}));

vi.mock("@/lib/onboarding-actions", () => ({
  checkWorkspaceSlugAction: mocks.checkWorkspaceSlugAction,
  finishOnboardingAction: mocks.finishOnboardingAction,
  saveOnboardingProfileAction: mocks.saveOnboardingProfileAction,
  saveOnboardingWorkspaceAction: mocks.saveOnboardingWorkspaceAction,
}));

vi.mock("@/lib/onboarding-kickoff", () => ({
  queueOnboardingKickoff: vi.fn(() => true),
}));

describe("OnboardingWizard", () => {
  beforeEach(() => {
    mocks.captureProductEvent.mockReset();
    mocks.checkWorkspaceSlugAction.mockReset();
    mocks.checkWorkspaceSlugAction.mockResolvedValue({ slug: "acme", available: true });
    mocks.finishOnboardingAction.mockReset();
    mocks.finishOnboardingAction.mockResolvedValue({ ok: true });
    mocks.push.mockReset();
    mocks.saveOnboardingProfileAction.mockReset();
    mocks.saveOnboardingProfileAction.mockResolvedValue({ ok: true });
    mocks.saveOnboardingWorkspaceAction.mockReset();
    mocks.saveOnboardingWorkspaceAction.mockResolvedValue({
      ok: true,
      workspaceId: "workspace_1",
      brainRef: null,
    });
  });

  it("takes owners directly from profile to workspace to completion", async () => {
    const user = userEvent.setup();
    render(
      <OnboardingWizard
        user={{
          workosUserId: "user_1",
          name: "Ada Lovelace",
          email: "ada@example.com",
          avatarUrl: null,
        }}
        currentWorkspaceName=""
        legacyBrainEnabled={false}
        variant="owner"
        initialStep={0}
        initialWorkspaceId={null}
        initialWorkspaceName=""
        initialSlug=""
        initialRole={null}
        initialCompanyUrl=""
        initialReferral={null}
      />,
    );

    expect(screen.getByRole("heading", { name: "Welcome, Ada" })).toBeInTheDocument();
    expect(screen.queryByText("Connect your sources")).not.toBeInTheDocument();
    expect(screen.queryByText("Build your company Wiki")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Founder \/ CEO/u }));
    await user.type(screen.getByLabelText(/Company URL/u), "acme.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByRole("heading", { name: "Create your workspace" }),
    ).toBeInTheDocument();
    expect(mocks.saveOnboardingProfileAction).toHaveBeenCalledWith({
      role: "founder",
      companyUrl: "acme.com",
    });

    await user.type(screen.getByLabelText("Company name"), "Acme");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "You're all set" })).toBeInTheDocument();
    expect(
      screen.getByText(/connect sources or import company context anytime/u),
    ).toBeInTheDocument();
    expect(mocks.saveOnboardingWorkspaceAction).toHaveBeenCalledWith({
      name: "Acme",
      slug: "acme",
    });

    await user.click(screen.getByRole("button", { name: "Finish onboarding" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/"));
    expect(mocks.finishOnboardingAction).toHaveBeenCalledWith({ referralSource: null });
    expect(mocks.captureProductEvent).toHaveBeenCalledWith("onboarding_completed", {
      flow: "owner",
      total_steps: 3,
      workspace_id: "workspace_1",
    });
  });
});
