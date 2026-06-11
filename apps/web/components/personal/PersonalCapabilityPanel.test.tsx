import type { AgentConfig } from "@opencompany/agent-runtime/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceProvider } from "../WorkspaceContext";
import {
  buildPersonalIntegrationRows,
  hasPersonalGitHubIntegrationRequest,
  PersonalCapabilityPanel,
  personalIntegrationCount,
} from "./PersonalCapabilityPanel";

// The Connect badge opens a popup and refreshes via the App Router; stub it so the panel renders.
const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}));

vi.mock("@/lib/skills/client", () => ({
  fetchWorkspaceSkills: vi.fn(async () => []),
}));

// The expanded rows' management actions are server actions; mock the modules so jsdom never
// imports their server-only dependencies (db client, auth).
const disconnectGitHub = vi.fn<(integrationId: string) => Promise<unknown>>(async () => ({
  ok: true,
  status: "disconnected" as const,
  message: "GitHub was disconnected from this workspace.",
}));
const refreshGitHubRepos = vi.fn<(integrationId: string) => Promise<undefined>>(
  async () => undefined,
);
vi.mock("@/lib/integrations/actions", () => ({
  disconnectGitHubIntegrationAction: (integrationId: string) => disconnectGitHub(integrationId),
  refreshGitHubRepositories: (integrationId: string) => refreshGitHubRepos(integrationId),
}));

const disconnectGoogle = vi.fn<
  (input: { provider: string; integrationId: string }) => Promise<unknown>
>(async () => ({
  ok: true,
  status: "disconnected" as const,
  message: "Disconnected the Google account.",
}));
vi.mock("@/lib/integrations/google-actions", () => ({
  disconnectGoogleIntegrationAction: (input: { provider: string; integrationId: string }) =>
    disconnectGoogle(input),
}));

const removeLinearMcp = vi.fn(async () => ({ ok: true }));
vi.mock("@/lib/mcp/actions", () => ({
  removeLinearMcpToken: () => removeLinearMcp(),
  removeSlackMcpConnection: vi.fn(async () => ({ ok: true })),
  removePostHogMcpConnection: vi.fn(async () => ({ ok: true })),
  removeBetterStackMcpConnection: vi.fn(async () => ({ ok: true })),
  removeBraintrustMcpConnection: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/components/agent-editor/AddSkillDialog", () => ({
  AddSkillDialog: () => <div role="dialog" aria-label="Add skill from GitHub or skills.sh" />,
}));

vi.mock("@/components/ToolPolicyEditor", () => ({
  ToolPolicyEditor: ({ providerKey }: { providerKey: string }) => (
    <div data-testid={`tool-policy-${providerKey}`} />
  ),
}));

const baseConfig: AgentConfig = {
  schemaVersion: "agent.v1",
  title: "Personal",
  instructions: "Use @github when code is involved.",
  model: {
    provider: "vercel-ai-gateway",
    name: "openai/gpt-5.4-mini",
  },
  tools: [],
  brain: [],
  integrations: {
    github: {
      repositories: [],
    },
  },
  triggers: [],
};

function renderWithWorkspace(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceProvider workspaceId="wks_test" userId="usr_test">
        {ui}
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
}

describe("PersonalCapabilityPanel integrations", () => {
  it("detects a generic GitHub request from behavior text", () => {
    expect(hasPersonalGitHubIntegrationRequest("Use @github for code work.")).toBe(true);
    expect(hasPersonalGitHubIntegrationRequest("Use @opencompany/web for code work.")).toBe(false);
  });

  it("shows requested GitHub integration even without configured repositories", () => {
    render(
      <PersonalCapabilityPanel
        section="integrations"
        config={baseConfig}
        personalSkills={[]}
        githubRequested={true}
        githubStatus="not_connected"
      />,
    );

    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(
      screen.getByText("Connect GitHub before your agent can use repositories."),
    ).toBeInTheDocument();
    // Connect opens the OAuth flow in a popup (see useConnectPopup), so it's a button, not a link.
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("renders an enabled MCP integration with a Connect badge when not connected", () => {
    const config: AgentConfig = {
      ...baseConfig,
      tools: [
        {
          id: "linear",
          type: "mcp",
          server: "linear",
          label: "Linear",
          description: "Linear MCP",
        },
      ],
    };

    render(
      <PersonalCapabilityPanel
        section="integrations"
        config={config}
        personalSkills={[]}
        githubRequested={false}
        githubStatus="not_connected"
        connections={{
          github: false,
          gmail: false,
          google_calendar: false,
          linear: false,
          slack: false,
          posthog: false,
          betterstack: false,
          braintrust: false,
        }}
      />,
    );

    expect(screen.getByText("Linear")).toBeInTheDocument();
    // Connect opens the OAuth flow in a popup (see useConnectPopup), so it's a button, not a link.
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("renders permission controls for attached integrations", async () => {
    const user = userEvent.setup();
    const config: AgentConfig = {
      ...baseConfig,
      tools: [
        {
          id: "linear",
          type: "mcp",
          server: "linear",
          label: "Linear",
          description: "Linear MCP",
        },
      ],
    };

    render(
      <PersonalCapabilityPanel
        section="integrations"
        config={config}
        personalSkills={[]}
        githubRequested={false}
        githubStatus="not_connected"
        connections={{
          github: false,
          gmail: false,
          google_calendar: false,
          linear: true,
          slack: false,
          posthog: false,
          betterstack: false,
          braintrust: false,
        }}
        toolPolicies={{ linear: { read: "ask" } }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand Linear details" }));

    expect(screen.getByTestId("tool-policy-linear")).toBeInTheDocument();
  });

  it("saves a disconnected integration before opening OAuth", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockReturnValue({ closed: false } as Window);
    const onAddIntegration = vi.fn(async () => true);

    render(
      <PersonalCapabilityPanel
        section="integrations"
        config={baseConfig}
        personalSkills={[]}
        githubRequested={false}
        githubStatus="not_connected"
        connections={{
          github: false,
          gmail: false,
          google_calendar: false,
          linear: false,
          slack: false,
          posthog: false,
          betterstack: false,
          braintrust: false,
        }}
        onAddIntegration={onAddIntegration}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add integration" }));
    await user.click(screen.getByRole("button", { name: /Linear/i }));

    expect(openSpy).toHaveBeenCalledWith(
      "/api/mcp/linear/start?returnTo=%2Fonboarding%2Fconnected",
      "oc-personal-connect",
      expect.any(String),
    );
    expect(onAddIntegration).toHaveBeenCalledWith("linear");
    expect(onAddIntegration.mock.invocationCallOrder[0]).toBeLessThan(
      openSpy.mock.invocationCallOrder[0]!,
    );

    openSpy.mockRestore();
  });

  it("shows a recovery message when the connect popup is blocked", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const onAddIntegration = vi.fn(async () => true);

    render(
      <PersonalCapabilityPanel
        section="integrations"
        config={baseConfig}
        personalSkills={[]}
        githubRequested={false}
        githubStatus="not_connected"
        connections={{
          github: false,
          gmail: false,
          google_calendar: false,
          linear: false,
          slack: false,
          posthog: false,
          betterstack: false,
          braintrust: false,
        }}
        onAddIntegration={onAddIntegration}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add integration" }));
    await user.click(screen.getByRole("button", { name: /Linear/i }));

    expect(openSpy).toHaveBeenCalled();
    expect(screen.getByText(/couldn't open the Linear connect window/i)).toBeInTheDocument();

    openSpy.mockRestore();
  });

  it("does not open OAuth when adding the integration fails", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockReturnValue({ closed: false } as Window);
    const onAddIntegration = vi.fn(async () => false);

    render(
      <PersonalCapabilityPanel
        section="integrations"
        config={baseConfig}
        personalSkills={[]}
        githubRequested={false}
        githubStatus="not_connected"
        connections={{
          github: false,
          gmail: false,
          google_calendar: false,
          linear: false,
          slack: false,
          posthog: false,
          betterstack: false,
          braintrust: false,
        }}
        onAddIntegration={onAddIntegration}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add integration" }));
    await user.click(screen.getByRole("button", { name: /Linear/i }));

    expect(onAddIntegration).toHaveBeenCalledWith("linear");
    expect(openSpy).not.toHaveBeenCalled();

    openSpy.mockRestore();
  });

  it("renders personal skills with a Personal badge in the skills section", () => {
    render(
      <PersonalCapabilityPanel
        section="skills"
        config={baseConfig}
        personalSkills={[
          {
            id: "weekly-digest",
            name: "Weekly digest",
            description: "How I assemble the Monday digest.",
            origin: "personal",
            provenance: "agent",
          },
          {
            id: "tone",
            name: "House tone",
            description: "Voice rules you taught me.",
            origin: "personal",
            provenance: "user",
          },
        ]}
        githubRequested={false}
        githubStatus="not_connected"
      />,
    );

    expect(screen.getByText("Weekly digest")).toBeInTheDocument();
    expect(screen.getByText("Personal")).toBeInTheDocument();
    expect(screen.getByText("House tone")).toBeInTheDocument();
    expect(screen.getByText("Personal · you")).toBeInTheDocument();
  });

  it("renders add buttons for the skills and tools sections", () => {
    render(
      <PersonalCapabilityPanel
        section="tools"
        config={baseConfig}
        personalSkills={[]}
        githubRequested={false}
        githubStatus="not_connected"
        onAddTool={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Add tool" })).toBeInTheDocument();

    renderWithWorkspace(
      <PersonalCapabilityPanel
        section="skills"
        config={baseConfig}
        personalSkills={[]}
        githubRequested={false}
        githubStatus="not_connected"
        onAddSkill={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Add skill" })).toBeInTheDocument();
  });

  it("shows only non-integration tools in the add tool picker", async () => {
    const user = userEvent.setup();

    render(
      <PersonalCapabilityPanel
        section="tools"
        config={baseConfig}
        personalSkills={[]}
        githubRequested={false}
        githubStatus="not_connected"
        onAddTool={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add tool" }));

    expect(screen.getByText("exa")).toBeInTheDocument();
    expect(screen.queryByText("gmail")).not.toBeInTheDocument();
    expect(screen.queryByText("linear")).not.toBeInTheDocument();
  });

  it("calls the add tool handler when a new tool is selected", async () => {
    const user = userEvent.setup();
    const onAddTool = vi.fn(async () => undefined);

    render(
      <PersonalCapabilityPanel
        section="tools"
        config={baseConfig}
        personalSkills={[]}
        githubRequested={false}
        githubStatus="not_connected"
        onAddTool={onAddTool}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add tool" }));
    await user.click(screen.getByRole("button", { name: /exa/i }));

    expect(onAddTool).toHaveBeenCalledWith("exa");
  });

  it("marks already-added tools as added and disables selecting them", async () => {
    const user = userEvent.setup();
    const onAddTool = vi.fn(async () => undefined);
    const config: AgentConfig = {
      ...baseConfig,
      tools: [
        {
          id: "exa",
          type: "hosted_tool",
          label: "Exa",
          description: "Web research",
        },
      ],
    };

    render(
      <PersonalCapabilityPanel
        section="tools"
        config={config}
        personalSkills={[]}
        githubRequested={false}
        githubStatus="not_connected"
        onAddTool={onAddTool}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add tool" }));
    const exaRow = screen.getByRole("button", { name: /exa/i });

    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(exaRow).toBeDisabled();
    await user.click(exaRow);
    expect(onAddTool).not.toHaveBeenCalled();
  });

  it("marks already-added skills as added and disables selecting them", async () => {
    const user = userEvent.setup();
    const onAddSkill = vi.fn(async () => undefined);
    const config: AgentConfig = {
      ...baseConfig,
      skills: [{ id: "first-principles" }],
    };

    renderWithWorkspace(
      <PersonalCapabilityPanel
        section="skills"
        config={config}
        personalSkills={[]}
        githubRequested={false}
        githubStatus="not_connected"
        onAddSkill={onAddSkill}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add skill" }));
    const skillRow = screen.getByRole("button", { name: /first-principles/i });

    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(skillRow).toBeDisabled();
    await user.click(skillRow);
    expect(onAddSkill).not.toHaveBeenCalled();
  });

  it("shows connection details when a connected GitHub row is expanded", async () => {
    const user = userEvent.setup();
    render(
      <PersonalCapabilityPanel
        section="integrations"
        config={baseConfig}
        personalSkills={[]}
        githubRequested={true}
        githubStatus="connected"
        details={{
          github: {
            summary: "Connected as @acme · 2 repositories",
            accounts: [
              {
                id: "wint_1",
                label: "@acme",
                detail: "Organization",
                status: "connected",
                statusReason: null,
                updatedAt: new Date().toISOString(),
                resources: [
                  { id: "acme/web", name: "acme/web", detail: null, warning: null },
                  { id: "acme/api", name: "acme/api", detail: null, warning: "Access lost" },
                ],
              },
            ],
            resourcesLabel: "Repositories",
            statusReason: null,
          },
        }}
      />,
    );

    // The collapsed row uses the live connection summary as its description.
    expect(screen.getByText("Connected as @acme · 2 repositories")).toBeInTheDocument();
    expect(screen.queryByText("acme/web")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand GitHub details" }));

    expect(screen.getByText("@acme")).toBeInTheDocument();
    expect(screen.getByText("acme/web")).toBeInTheDocument();
    expect(screen.getByText("Access lost")).toBeInTheDocument();
    expect(screen.getByText("What your agent can do")).toBeInTheDocument();
    expect(screen.getByText("Create branches and open pull requests")).toBeInTheDocument();
    // Management actions render per connected account.
    expect(screen.getByRole("button", { name: "Refresh repositories" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
  });

  it("requires confirming before disconnecting and refreshes on success", async () => {
    const user = userEvent.setup();
    render(
      <PersonalCapabilityPanel
        section="integrations"
        config={baseConfig}
        personalSkills={[]}
        githubRequested={true}
        githubStatus="connected"
        details={{
          github: {
            summary: "Connected as @acme · 1 repository",
            accounts: [
              {
                id: "wint_1",
                label: "@acme",
                detail: "Organization",
                status: "connected",
                statusReason: null,
                updatedAt: null,
                resources: [{ id: "acme/web", name: "acme/web", detail: null, warning: null }],
              },
            ],
            resourcesLabel: "Repositories",
            statusReason: null,
          },
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand GitHub details" }));
    await user.click(screen.getByRole("button", { name: "Disconnect" }));

    // First click arms the confirmation; nothing is disconnected yet.
    expect(disconnectGitHub).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Disconnect @acme from GitHub for this workspace? Agents using it will lose access.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirm disconnect" }));

    expect(disconnectGitHub).toHaveBeenCalledWith("wint_1");
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("disconnects an MCP integration via its credential-removal action", async () => {
    const user = userEvent.setup();
    const config: AgentConfig = {
      ...baseConfig,
      tools: [
        {
          id: "linear",
          type: "mcp",
          server: "linear",
          label: "Linear",
          description: "Linear MCP",
        },
      ],
    };

    render(
      <PersonalCapabilityPanel
        section="integrations"
        config={config}
        personalSkills={[]}
        githubRequested={false}
        githubStatus="not_connected"
        connections={{
          github: false,
          gmail: false,
          google_calendar: false,
          linear: true,
          slack: false,
          posthog: false,
          betterstack: false,
          braintrust: false,
        }}
        details={{
          linear: { summary: null, accounts: [], resourcesLabel: null, statusReason: null },
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand Linear details" }));
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    await user.click(screen.getByRole("button", { name: "Confirm disconnect" }));

    expect(removeLinearMcp).toHaveBeenCalled();
  });

  it("previews granted permissions for a not-yet-connected integration", async () => {
    const user = userEvent.setup();
    const config: AgentConfig = {
      ...baseConfig,
      tools: [
        {
          id: "gmail",
          type: "hosted_tool",
          label: "Gmail",
          description: "Read mail",
        },
      ],
    };

    render(
      <PersonalCapabilityPanel
        section="integrations"
        config={config}
        personalSkills={[]}
        githubRequested={false}
        githubStatus="not_connected"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand Gmail details" }));

    expect(screen.getByText("Connecting grants your agent")).toBeInTheDocument();
    expect(screen.getByText("Read-only — cannot send, modify, or delete mail")).toBeInTheDocument();
  });

  it("uses a repository-specific GitHub CTA when repository access is missing", () => {
    render(
      <PersonalCapabilityPanel
        section="integrations"
        config={baseConfig}
        personalSkills={[]}
        githubRequested={true}
        githubStatus="needs_repository_access"
      />,
    );

    expect(screen.getByText("Connected, but no repositories are granted yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose repositories" })).toBeInTheDocument();
  });

  it("flags agent repositories whose workspace access is degraded", () => {
    const config: AgentConfig = {
      ...baseConfig,
      integrations: {
        github: {
          repositories: [{ id: "acme-api", fullName: "acme/api", defaultBranch: "main" }],
        },
      },
    };

    const rows = buildPersonalIntegrationRows(config, {
      githubRequested: false,
      githubStatus: "connected",
      details: {
        github: {
          summary: null,
          accounts: [
            {
              id: "wint_1",
              label: "@acme",
              detail: "Organization",
              status: "connected",
              statusReason: null,
              updatedAt: null,
              resources: [
                { id: "acme/api", name: "acme/api", detail: null, warning: "Access lost" },
              ],
            },
          ],
          resourcesLabel: "Repositories",
          statusReason: null,
        },
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      label: "acme/api",
      description: "GitHub repository",
      badge: "Access lost",
      badgeTone: "warning",
    });
  });

  it("counts the generic GitHub request alongside concrete repositories", () => {
    const config: AgentConfig = {
      ...baseConfig,
      integrations: {
        github: {
          repositories: [
            { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" },
          ],
        },
      },
    };

    expect(personalIntegrationCount({ config, githubRequested: true })).toBe(2);
    expect(
      buildPersonalIntegrationRows(config, { githubRequested: true, githubStatus: "connected" }),
    ).toHaveLength(2);
  });
});
