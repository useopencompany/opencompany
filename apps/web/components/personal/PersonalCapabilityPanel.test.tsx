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
