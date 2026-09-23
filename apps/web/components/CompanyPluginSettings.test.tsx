import "@testing-library/jest-dom/vitest";
import type { CompanyGitHubPluginDto } from "@opencompany/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { linkCompanyGitHubInstallationAction } from "@/lib/company-plugin-actions";
import { CompanyGitHubPluginDetail, CompanyPluginsRoute } from "./CompanyPluginSettings";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@opencompany/ui/components/sonner", () => ({ toast: toasts }));
vi.mock("@/lib/company-plugin-actions", () => ({
  linkCompanyGitHubInstallationAction: vi.fn(),
  unlinkCompanyGitHubInstallationAction: vi.fn(),
}));

function plugin(overrides: Partial<CompanyGitHubPluginDto> = {}): CompanyGitHubPluginDto {
  return {
    configured: true,
    canManage: true,
    installations: [],
    events: [
      {
        id: "issue.opened",
        label: "Issue opened",
        description: "Someone opens an issue in the repository.",
        delivery: "webhook",
        filters: [],
      },
    ],
    ...overrides,
  };
}

const acme = {
  integrationId: "gint_acme",
  installationId: "7",
  accountLogin: "acme",
  accountType: "Organization" as const,
  status: "connected" as const,
  statusReason: null,
  linkedAt: "2026-09-23T10:00:00.000Z",
};

describe("company plugins", () => {
  beforeEach(() => vi.clearAllMocks());

  it("switches back to personal plugins from the company catalog", async () => {
    render(<CompanyPluginsRoute github={plugin()} />);
    expect(screen.getByRole("link", { name: "Connect" })).toHaveAttribute(
      "href",
      "/plugins/company/github",
    );
    await userEvent.click(screen.getByRole("button", { name: "Personal" }));
    expect(router.push).toHaveBeenCalledWith("/plugins");
  });

  it("connects an installation the admin can reach and hides linked ones", async () => {
    vi.mocked(linkCompanyGitHubInstallationAction).mockResolvedValue({
      ok: true,
      data: plugin({ installations: [acme] }),
    });
    render(
      <CompanyGitHubPluginDetail
        plugin={plugin({ installations: [acme] })}
        available={{
          ok: true,
          data: {
            installations: [
              {
                installationId: "7",
                accountLogin: "acme",
                accountType: "Organization",
                avatarUrl: null,
                suspended: false,
              },
              {
                installationId: "8",
                accountLogin: "acme-labs",
                accountType: "Organization",
                avatarUrl: null,
                suspended: false,
              },
            ],
          },
        }}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(linkCompanyGitHubInstallationAction).toHaveBeenCalledWith("8");
    expect(toasts.success).toHaveBeenCalledWith("acme-labs connected.");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("asks an admin without a GitHub sign-in to sign in first", () => {
    render(
      <CompanyGitHubPluginDetail
        plugin={plugin()}
        available={{ ok: true, data: { installations: null } }}
      />,
    );
    expect(screen.getByRole("link", { name: "Sign in with GitHub" })).toHaveAttribute(
      "href",
      "/api/integrations/github-user/start?returnTo=%2Fplugins%2Fcompany%2Fgithub",
    );
  });

  it("shows members the linked accounts without controls, and flags missing setup", () => {
    render(
      <CompanyGitHubPluginDetail
        plugin={plugin({ canManage: false, configured: false, installations: [acme] })}
        available={null}
      />,
    );
    expect(screen.getByText("acme")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    expect(screen.getByText("GitHub events aren’t set up on this server")).toBeInTheDocument();
  });
});
