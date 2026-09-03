import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceSettingsPanel } from "./WorkspaceSettingsPanel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/lib/workspace-actions", () => ({
  inviteToWorkspaceAction: vi.fn(),
  removeWorkspaceMemberAction: vi.fn(),
  revokeWorkspaceInvitationAction: vi.fn(),
  updateWorkspaceNameAction: vi.fn(),
}));

const owner = {
  userWorkosId: "user_owner",
  email: "owner@example.com",
  name: "Workspace Owner",
  firstName: "Workspace",
  lastName: "Owner",
  avatarUrl: null,
  role: "admin" as const,
};

const hobbyWorkspace = {
  workspace: { id: "workspace_1", name: "Acme" },
  role: "admin" as const,
  plan: "hobby" as const,
  memberCap: 1,
  members: [owner],
  invitations: [],
};

describe("WorkspaceSettingsPanel", () => {
  it("explains the Hobby member limit and links to the upgrade path", () => {
    render(<WorkspaceSettingsPanel initial={hobbyWorkspace} />);

    expect(
      screen.getByText("Hobby includes one member. Upgrade to Pro to invite teammates."),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Upgrade to Pro" })).toHaveAttribute(
      "href",
      "/settings/workspace/billing",
    );
    expect(screen.queryByPlaceholderText("teammate@company.example")).toBeNull();
  });

  it("keeps the invitation form available below the Pro member limit", () => {
    render(<WorkspaceSettingsPanel initial={{ ...hobbyWorkspace, plan: "pro", memberCap: 10 }} />);

    expect(screen.getByPlaceholderText("teammate@company.example")).toBeVisible();
    expect(screen.getByRole("button", { name: "Invite" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Upgrade to Pro" })).toBeNull();
  });

  it("explains how a Pro admin can make room at the member limit", () => {
    render(
      <WorkspaceSettingsPanel
        initial={{
          ...hobbyWorkspace,
          plan: "pro",
          memberCap: 1,
        }}
      />,
    );

    expect(
      screen.getByText(
        "This workspace has reached its 1-member limit. Remove a member or revoke a pending invitation first.",
      ),
    ).toBeVisible();
    expect(screen.queryByPlaceholderText("teammate@company.example")).toBeNull();
  });
});
