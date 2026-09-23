import { describe, expect, it } from "vitest";
import {
  COMPANY_GITHUB_PROVIDER,
  companyPluginEvent,
  companyPluginEventKeys,
  companyPluginIntegrationProvider,
  isCompanyPluginProvider,
} from "./company-plugins";

describe("company plugins", () => {
  it("names triggers with the plugin-name grammar event runs require", () => {
    // Mirrors goat.workflow_event_runs' provider check constraint.
    expect(COMPANY_GITHUB_PROVIDER).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/u);
  });

  it("maps the GitHub trigger provider to its workspace connection and declared events", () => {
    expect(isCompanyPluginProvider("github-app")).toBe(true);
    expect(isCompanyPluginProvider("github")).toBe(false);
    expect(companyPluginIntegrationProvider("github-app")).toBe("github_app");
    expect(companyPluginEvent("github-app", "issue.opened")?.filters).toEqual([
      expect.objectContaining({ id: "repository", required: true }),
    ]);
    expect(companyPluginEvent("github-app", "issue.closed")).toBeNull();
    expect(companyPluginEventKeys()).toEqual([
      "github-app:github_app:issue.opened",
      "github-app:github_app:pull_request.opened",
    ]);
  });
});
