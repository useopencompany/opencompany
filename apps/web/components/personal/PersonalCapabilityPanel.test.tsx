import type { AgentConfig } from "@opencompany/agent-runtime/types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
