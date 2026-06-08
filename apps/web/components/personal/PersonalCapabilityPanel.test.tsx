import type { AgentConfig } from "@opencompany/agent-runtime/types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  buildPersonalIntegrationRows,
  hasPersonalGitHubIntegrationRequest,
  PersonalCapabilityPanel,
  personalIntegrationCount,
} from "./PersonalCapabilityPanel";

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
      screen.getByText("Set up GitHub in workspace settings before using repositories."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Requires setup" })).toHaveAttribute(
      "href",
      "/settings/integrations",
    );
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
