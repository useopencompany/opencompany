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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/lib/skills/client", () => ({
  fetchWorkspaceSkills: vi.fn(async () => []),
}));

vi.mock("@/components/agent-editor/AddSkillDialog", () => ({
  AddSkillDialog: () => <div role="dialog" aria-label="Add skill from GitHub or skills.sh" />,
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
