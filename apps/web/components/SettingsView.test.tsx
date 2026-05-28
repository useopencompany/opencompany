import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inviteWorkspaceMember } from "@/lib/workspaces/actions";
import SettingsView from "./SettingsView";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

vi.mock("next/link", () => ({
  default: (props: ComponentProps<"a"> & { prefetch?: boolean }) => {
    const { href, children, prefetch, ...rest } = props;
    void prefetch;
    return (
      <a href={typeof href === "string" ? href : ""} {...rest}>
        {children}
      </a>
    );
  },
}));

vi.mock("@/lib/workspaces/actions", () => ({
  inviteWorkspaceMember: vi.fn(),
  updateWorkspaceName: vi.fn(),
}));

vi.mock("@/lib/billing/actions", () => ({
  createCreditCheckoutSession: vi.fn(),
  redeemCreditCode: vi.fn(),
}));

const inviteWorkspaceMemberMock = vi.mocked(inviteWorkspaceMember);

function settingsProps(canInviteMembers: boolean) {
  return {
    profile: {
      name: "Ada Lovelace",
      email: "ada@example.com",
      avatarUrl: null,
      initials: "AL",
    },
    workspace: {
      name: "OpenCompany",
      createdAt: "May 28, 2026",
      canInviteMembers,
      repository: null,
    },
    billing: {
      balanceUsdMicros: 0,
      spendLast7UsdMicros: 0,
      spendLast30UsdMicros: 0,
      recentSessionCharges: [],
      ledger: [],
    },
  };
}

describe("SettingsView member invitations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the invite form to admins and sends invitations", async () => {
    const user = userEvent.setup();
    inviteWorkspaceMemberMock.mockResolvedValue({
      ok: true,
      email: "member@example.com",
    });

    render(<SettingsView {...settingsProps(true)} />);

    await user.type(screen.getByPlaceholderText("teammate@example.com"), "member@example.com");
    await user.click(screen.getByRole("button", { name: /send invite/i }));

    await waitFor(() => {
      expect(inviteWorkspaceMemberMock).toHaveBeenCalledWith("member@example.com");
    });
    expect(await screen.findByText("Invitation sent to member@example.com.")).toBeInTheDocument();
  });

  it("does not show the invite form to non-admin members", () => {
    render(<SettingsView {...settingsProps(false)} />);

    expect(screen.queryByText("Invite a member")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("teammate@example.com")).not.toBeInTheDocument();
  });
});
