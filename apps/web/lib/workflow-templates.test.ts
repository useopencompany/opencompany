import { schedulePresetFromCron } from "@opencompany/agent-runtime";
import { describe, expect, it } from "vitest";
import type { IntegrationAccountView } from "@/lib/integration-state";
import { WORKFLOW_TEMPLATES, workflowTemplateMissingPlugins } from "./workflow-templates";

type TestPlugin = Parameters<typeof workflowTemplateMissingPlugins>[1]["plugins"][number];

function plugin(name: string, status = "enabled"): TestPlugin {
  return { name, status } as unknown as TestPlugin;
}

function account(connected = true): IntegrationAccountView {
  return { integrationId: "gint_1", connected } as unknown as IntegrationAccountView;
}

const digest = WORKFLOW_TEMPLATES.find((template) => template.id === "weekly-shipping-digest");
if (!digest) throw new Error("The weekly shipping digest template is missing from the catalog.");

describe("workflow template catalog", () => {
  it("only ships schedules the editor can render, so a clone never opens on an unsupported cron", () => {
    for (const template of WORKFLOW_TEMPLATES) {
      expect(schedulePresetFromCron(template.schedule.cron)).not.toBeNull();
    }
  });

  it("keeps template ids unique and instructions non-empty so every clone is activatable", () => {
    const ids = WORKFLOW_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of WORKFLOW_TEMPLATES) {
      expect(template.step.instructions.trim()).not.toBe("");
      expect(template.name.length).toBeLessThanOrEqual(64);
    }
  });

  it("declares the outcome plugin as required, so the card cannot promise Slack without asking for it", () => {
    for (const template of WORKFLOW_TEMPLATES) {
      if (!template.outcome.plugin) continue;
      expect(template.requiredPlugins).toContain(template.outcome.plugin);
    }
  });
});

describe("workflowTemplateMissingPlugins", () => {
  it("reports nothing when every required plugin is enabled and connected", () => {
    expect(
      workflowTemplateMissingPlugins(digest, {
        plugins: [plugin("github"), plugin("slack")],
        personalAccounts: { github_user: [account()], slack: [account()] },
      }),
    ).toEqual([]);
  });

  it("reports a plugin that is enabled but has no connected account", () => {
    const missing = workflowTemplateMissingPlugins(digest, {
      plugins: [plugin("github"), plugin("slack")],
      personalAccounts: { github_user: [account()], slack: [account(false)] },
    });
    expect(missing).toEqual([{ plugin: "slack", label: "Slack", setupHref: "/plugins/slack" }]);
  });

  it("reports a connected account whose plugin is not enabled", () => {
    const missing = workflowTemplateMissingPlugins(digest, {
      plugins: [plugin("github"), plugin("slack", "disabled")],
      personalAccounts: { github_user: [account()], slack: [account()] },
    });
    expect(missing.map((entry) => entry.plugin)).toEqual(["slack"]);
  });

  it("resolves accounts through the connection provider rather than the plugin name", () => {
    // GitHub's plugin is "github" but its account provider is "github_user"; keying by plugin name
    // would report a connected account as missing.
    const missing = workflowTemplateMissingPlugins(digest, {
      plugins: [plugin("github"), plugin("slack")],
      personalAccounts: { github: [account()], slack: [account()] },
    });
    expect(missing.map((entry) => entry.plugin)).toEqual(["github"]);
  });

  it("names the account rather than the plugin, so setup copy reads as the service", () => {
    const missing = workflowTemplateMissingPlugins(digest, {
      plugins: [],
      personalAccounts: {},
    });
    expect(missing.map((entry) => entry.label)).toEqual(["GitHub", "Slack"]);
  });
});
