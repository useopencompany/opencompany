import { createHmac } from "node:crypto";
import { GitHubUserAccessAuthError } from "@opencompany/agent/integrations/github-user";
import type { Actor } from "@opencompany/core";
import {
  connectCompanyGitHubInstallation,
  listCompanyGitHubInstallations,
  listGitHubAppInstallationIntegrations,
  markGitHubAppInstallationRemoved,
} from "@opencompany/db/company-github";
import {
  enqueueWorkflowEventRuns,
  listCompanyWorkflowEventTriggerRoutes,
} from "@opencompany/db/workflow-event-routes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCompanyGitHubService, validateCompanyGitHubTriggerAccess } from "./company-github";
import { createGitHubAppIngress } from "./github-app-ingress";

vi.mock("@opencompany/db/company-github", () => ({
  connectCompanyGitHubInstallation: vi.fn(),
  disconnectCompanyGitHubInstallation: vi.fn(),
  listCompanyGitHubInstallations: vi.fn(async () => []),
  listGitHubAppInstallationIntegrations: vi.fn(),
  markGitHubAppInstallationRemoved: vi.fn(),
}));
vi.mock("@opencompany/db/workflow-event-routes", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listCompanyWorkflowEventTriggerRoutes: vi.fn(),
  enqueueWorkflowEventRuns: vi.fn(),
}));

const admin: Actor = {
  userId: "admin_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: [],
  authenticationMethod: "session",
} as unknown as Actor;
const member = { ...admin, userId: "member_1", role: "member" } as Actor;

const installation = (overrides: Record<string, unknown> = {}) => ({
  id: "7",
  account: {
    id: "1",
    login: "acme",
    type: "Organization" as const,
    avatarUrl: null,
    htmlUrl: null,
  },
  repositorySelection: "all" as const,
  permissions: {},
  pendingPermissions: [],
  suspendedAt: null,
  ...overrides,
});

describe("company GitHub plugin", () => {
  afterEach(() => vi.clearAllMocks());

  it("lets members read the plugin but not change it", async () => {
    const service = createCompanyGitHubService({ db: {}, listInstallations: vi.fn() });
    await expect(service.get(member)).resolves.toMatchObject({
      canManage: false,
      events: [
        expect.objectContaining({ id: "issue.opened" }),
        expect.objectContaining({ id: "pull_request.opened" }),
      ],
    });
    await expect(service.link(member, "7")).rejects.toMatchObject({ status: 403 });
    await expect(service.unlink(member, "gint_1")).rejects.toMatchObject({ status: 403 });
  });

  it("links only installations the admin's own GitHub account can reach", async () => {
    const listInstallations = vi.fn(async () => [installation()]);
    const service = createCompanyGitHubService({ db: {}, listInstallations });

    await expect(service.link(admin, "999")).rejects.toMatchObject({ status: 404 });
    expect(connectCompanyGitHubInstallation).not.toHaveBeenCalled();

    await service.link(admin, "7");
    expect(connectCompanyGitHubInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        userWorkosId: "admin_1",
        installationId: "7",
        accountLogin: "acme",
      }),
    );
    expect(listCompanyGitHubInstallations).toHaveBeenCalled();
  });

  it("refuses suspended installations and asks for a GitHub sign-in when there is none", async () => {
    const suspended = createCompanyGitHubService({
      db: {},
      listInstallations: vi.fn(async () => [installation({ suspendedAt: "2026-09-01T00:00:00Z" })]),
    });
    await expect(suspended.link(admin, "7")).rejects.toMatchObject({ status: 409 });

    const signedOut = createCompanyGitHubService({
      db: {},
      listInstallations: vi.fn(async () => {
        throw new GitHubUserAccessAuthError("Connect GitHub.");
      }),
    });
    await expect(signedOut.listAvailableInstallations(admin)).resolves.toEqual({
      installations: null,
    });
    await expect(signedOut.link(admin, "7")).rejects.toMatchObject({ status: 409 });
  });
});

describe("company GitHub trigger access", () => {
  const trigger = {
    id: "trigger_1",
    type: "event" as const,
    provider: "github-app",
    event: "issue.opened",
    integrationId: "gint_company",
    filters: { repository: { id: "42", name: "acme/app" } },
    prompt: "Triage it.",
  };

  it("requires a repository the author's GitHub account can access", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([]) // not an unchanged trigger
      .mockResolvedValueOnce([{ installationId: "7" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ installationId: "7" }]);
    const listRepositories = vi
      .fn()
      .mockResolvedValueOnce([{ id: "41" }])
      .mockResolvedValueOnce([{ id: "42" }]);

    await expect(
      validateCompanyGitHubTriggerAccess({
        execute,
        actor: member,
        trigger,
        listRepositories: listRepositories as never,
      }),
    ).resolves.toBe("Choose a repository your GitHub account can access.");
    await expect(
      validateCompanyGitHubTriggerAccess({
        execute,
        actor: member,
        trigger,
        listRepositories: listRepositories as never,
      }),
    ).resolves.toBeNull();
    expect(listRepositories).toHaveBeenCalledWith({
      userWorkosId: "member_1",
      installationId: "7",
    });
  });

  it("skips GitHub when the stored trigger is unchanged, and other providers entirely", async () => {
    const execute = vi.fn().mockResolvedValueOnce([{ id: "agent_1" }]);
    const listRepositories = vi.fn();
    await expect(
      validateCompanyGitHubTriggerAccess({
        execute,
        actor: member,
        trigger,
        listRepositories: listRepositories as never,
      }),
    ).resolves.toBeNull();
    await expect(
      validateCompanyGitHubTriggerAccess({
        execute,
        actor: member,
        trigger: { ...trigger, provider: "linear" },
        listRepositories: listRepositories as never,
      }),
    ).resolves.toBeNull();
    expect(listRepositories).not.toHaveBeenCalled();
  });
});

describe("GitHub App webhook ingress", () => {
  const SECRET = "github-app-webhook-secret";
  const route = {
    workflowId: "agent_1",
    workspaceId: "workspace_1",
    userWorkosId: "owner_1",
    workflowSlug: "triage",
    workflowName: "Triage",
    prompt: "Triage it.",
    harnessSpec: {},
    provider: "github-app",
    event: "issue.opened",
    filters: { repository: { id: "42" } },
  };
  const body = JSON.stringify({
    action: "opened",
    installation: { id: 7 },
    sender: { type: "User" },
    repository: { id: 42, full_name: "acme/app" },
    issue: { number: 1, title: "Bug", created_at: "2026-09-23T10:00:00Z" },
  });
  const request = (signature: string, event = "issues") =>
    new Request("https://api.example.test/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "x-hub-signature-256": signature,
        "x-github-event": event,
        "x-github-delivery": "delivery_1",
      },
    });
  const sign = (value: string) =>
    `sha256=${createHmac("sha256", SECRET).update(value).digest("hex")}`;

  beforeEach(() => vi.stubEnv("GITHUB_USER_APP_WEBHOOK_SECRET", SECRET));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("rejects unsigned deliveries", async () => {
    const response = await createGitHubAppIngress({ db: {} }).webhook(request("sha256=bad"));
    expect(response.status).toBe(401);
    expect(listGitHubAppInstallationIntegrations).not.toHaveBeenCalled();
  });

  it("enqueues one run per trigger watching the delivery's repository", async () => {
    vi.mocked(listGitHubAppInstallationIntegrations).mockResolvedValue([
      {
        id: "gint_company",
        workspaceId: "workspace_1",
        userWorkosId: "admin_1",
        status: "connected",
      },
    ]);
    vi.mocked(listCompanyWorkflowEventTriggerRoutes).mockResolvedValue([
      route,
      { ...route, workflowId: "agent_2", filters: { repository: { id: "99" } } },
      { ...route, workflowId: "agent_3", event: "pull_request.opened" },
    ] as never);
    vi.mocked(enqueueWorkflowEventRuns).mockResolvedValue(1);

    const response = await createGitHubAppIngress({ db: {} }).webhook(request(sign(body)));

    expect(response.status).toBe(200);
    expect(listGitHubAppInstallationIntegrations).toHaveBeenCalledWith("7", {});
    expect(enqueueWorkflowEventRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        routes: [route],
        deliveryId: "delivery_1",
        eventAt: new Date("2026-09-23T10:00:00Z"),
      }),
      {},
    );
  });

  it("disconnects linked workspaces when the App is uninstalled", async () => {
    const uninstall = JSON.stringify({ action: "deleted", installation: { id: 7 } });
    const response = await createGitHubAppIngress({ db: {} }).webhook(
      new Request("https://api.example.test/webhooks/github", {
        method: "POST",
        body: uninstall,
        headers: { "x-hub-signature-256": sign(uninstall), "x-github-event": "installation" },
      }),
    );
    expect(response.status).toBe(200);
    expect(markGitHubAppInstallationRemoved).toHaveBeenCalledWith({ installationId: "7", db: {} });
  });

  it("asks GitHub to redeliver when persistence fails", async () => {
    vi.mocked(listGitHubAppInstallationIntegrations).mockRejectedValue(new Error("db down"));
    const response = await createGitHubAppIngress({ db: {} }).webhook(request(sign(body)));
    expect(response.status).toBe(503);
  });
});
