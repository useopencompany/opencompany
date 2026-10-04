import { sentryPluginFixture } from "@/test/sentry";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKFLOW_TEMPLATES } from "@/lib/workflow-templates";
import { WorkflowTemplatesButton } from "./WorkflowTemplatesButton";

const routerMock = vi.hoisted(() => ({ push: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }));
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const commandsMock = vi.hoisted(() => ({
  createHeadlessWorkflow: vi.fn(),
  updateHeadlessWorkflow: vi.fn(),
  archiveHeadlessWorkflow: vi.fn(),
}));
const sentryMock = vi.hoisted(() => ({
  listSentryProjectsAction: vi.fn(),
  validateSentryFixAction: vi.fn(),
}));
vi.mock("@/lib/sentry-actions", () => sentryMock);
const filtersMock = vi.hoisted(() => ({ loadWorkflowEventFilterOptions: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));
vi.mock("@opencompany/ui/components/sonner", () => ({ toast: toastMock }));
vi.mock("@/lib/headless-automation-commands", () => commandsMock);
vi.mock("@/lib/workflow-event-filters", () => filtersMock);

const template = WORKFLOW_TEMPLATES[0]!;
const eventTemplate = WORKFLOW_TEMPLATES.find((entry) => entry.trigger.kind === "event")!;
const companyGitHub = {
  configured: true,
  canManage: true,
  installations: [
    {
      integrationId: "gint_company",
      installationId: "1",
      accountLogin: "acme",
      accountType: "Organization",
      status: "connected",
      statusReason: null,
      linkedAt: "2026-09-01T00:00:00.000Z",
    },
  ],
  events: [],
} as unknown as Parameters<typeof WorkflowTemplatesButton>[0]["companyGitHub"];

function createdWorkflow() {
  return {
    id: "workflow_1",
    slug: "weekly-shipping-digest",
    version: 1,
    steps: [{ id: "step_1" }],
  };
}

async function openTemplates() {
  await userEvent.click(screen.getByRole("button", { name: "Workflow templates" }));
}

async function useTemplate(name: string) {
  await openTemplates();
  await userEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
}

describe("WorkflowTemplatesButton", () => {
  beforeEach(() => {
    routerMock.push.mockClear();
    toastMock.error.mockClear();
    commandsMock.createHeadlessWorkflow.mockReset().mockResolvedValue(createdWorkflow());
    commandsMock.updateHeadlessWorkflow.mockReset().mockResolvedValue({ version: 2 });
    commandsMock.archiveHeadlessWorkflow.mockReset().mockResolvedValue({ version: 2 });
    filtersMock.loadWorkflowEventFilterOptions
      .mockReset()
      .mockResolvedValue({ ok: true, options: [{ id: "repo_1", name: "acme/web" }] });
  });

  it("keeps the templates behind the button until it is pressed", async () => {
    render(<WorkflowTemplatesButton missingPlugins={{}} scope="company" />);

    expect(screen.queryByText(template.name)).not.toBeInTheDocument();

    await openTemplates();

    expect(screen.getByRole("dialog", { name: "Workflow templates" })).toBeInTheDocument();
  });

  it("shows every template with its trigger and outcome", async () => {
    render(<WorkflowTemplatesButton missingPlugins={{}} scope="company" />);
    await openTemplates();

    for (const entry of WORKFLOW_TEMPLATES) {
      expect(screen.getByText(entry.name)).toBeInTheDocument();
      expect(screen.getByText(entry.description)).toBeInTheDocument();
    }
    expect(screen.getByText("Friday at 16:00")).toBeInTheDocument();
    expect(screen.getAllByText("Send Slack").length).toBeGreaterThan(0);
  });

  it("links each missing plugin to its setup page instead of blocking the card", async () => {
    render(
      <WorkflowTemplatesButton
        missingPlugins={{
          [template.id]: [{ plugin: "slack", label: "Slack", setupHref: "/plugins/slack" }],
        }}
        scope="company"
      />,
    );
    await openTemplates();

    expect(screen.getByRole("link", { name: "Slack" })).toHaveAttribute("href", "/plugins/slack");

    await userEvent.click(screen.getByRole("button", { name: new RegExp(template.name) }));
    await waitFor(() => expect(commandsMock.createHeadlessWorkflow).toHaveBeenCalled());
  });

  it("hides the setup hints when the plugin snapshot is unavailable", async () => {
    render(<WorkflowTemplatesButton missingPlugins={null} scope="company" />);
    await openTemplates();

    expect(screen.queryByText(/before it can run/)).not.toBeInTheDocument();
  });

  it("fills the draft with the template's step and schedule, then opens it", async () => {
    render(<WorkflowTemplatesButton missingPlugins={{}} scope="company" />);

    await useTemplate(template.name);

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/workflows/weekly-shipping-digest"),
    );
    expect(commandsMock.createHeadlessWorkflow).toHaveBeenCalledWith({
      name: template.name,
      description: template.description,
      scope: "company",
    });
    const update = commandsMock.updateHeadlessWorkflow.mock.calls[0]![1];
    expect(update.status).toBe("draft");
    expect(update.steps).toEqual([
      {
        id: "step_1",
        title: template.step.title,
        model: "",
        instructions: template.step.instructions,
      },
    ]);
    expect(update.triggers).toHaveLength(1);
    const schedule = template.trigger.kind === "schedule" ? template.trigger : null;
    expect(update.triggers[0]).toMatchObject({
      type: "schedule",
      cron: schedule?.cron,
      prompt: schedule?.prompt,
      enabled: true,
    });
    // The legacy single-trigger field has to agree with the automation trigger the editor reads back.
    expect(update.trigger).toMatchObject({ type: "schedule", cron: schedule?.cron });
  });

  it("asks an event template for its repository before cloning, and binds the trigger to it", async () => {
    render(
      <WorkflowTemplatesButton missingPlugins={{}} companyGitHub={companyGitHub} scope="company" />,
    );

    await useTemplate(eventTemplate.name);

    const repository = await screen.findByRole("combobox", { name: "Repository" });
    await waitFor(() => expect(screen.getByRole("option", { name: "acme/web" })).toBeEnabled());
    await userEvent.selectOptions(repository, "repo_1");
    await userEvent.click(screen.getByRole("button", { name: "Use template" }));

    await waitFor(() => expect(commandsMock.updateHeadlessWorkflow).toHaveBeenCalled());
    const update = commandsMock.updateHeadlessWorkflow.mock.calls[0]![1];
    expect(update.status).toBe("draft");
    expect(update.triggers[0]).toMatchObject({
      type: "event",
      provider: "github-app",
      event: "pull_request.opened",
      integrationId: "gint_company",
      filters: { repository: { id: "repo_1", name: "acme/web" } },
    });
  });

  it("reopens on the gallery after the setup step is dismissed", async () => {
    render(
      <WorkflowTemplatesButton missingPlugins={{}} companyGitHub={companyGitHub} scope="company" />,
    );

    await useTemplate(eventTemplate.name);
    await screen.findByRole("combobox", { name: "Repository" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await openTemplates();

    expect(screen.getByRole("dialog", { name: "Workflow templates" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Repository" })).not.toBeInTheDocument();
  });

  it("cannot clone an event template before a repository is chosen", async () => {
    render(
      <WorkflowTemplatesButton missingPlugins={{}} companyGitHub={companyGitHub} scope="company" />,
    );

    await useTemplate(eventTemplate.name);

    expect(await screen.findByRole("button", { name: "Use template" })).toBeDisabled();
    expect(commandsMock.createHeadlessWorkflow).not.toHaveBeenCalled();
  });

  it("keeps an event template on the gallery while its company connection is missing", async () => {
    render(
      <WorkflowTemplatesButton
        missingPlugins={{
          [eventTemplate.id]: [
            {
              plugin: "github",
              label: "GitHub (company)",
              setupHref: "/plugins/company/github",
            },
          ],
        }}
        companyGitHub={null}
        scope="company"
      />,
    );

    await openTemplates();

    expect(screen.getByRole("button", { name: new RegExp(eventTemplate.name) })).toBeDisabled();
    expect(screen.queryByRole("combobox", { name: "Repository" })).not.toBeInTheDocument();
    expect(commandsMock.createHeadlessWorkflow).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "GitHub (company)" })).toHaveAttribute(
      "href",
      "/plugins/company/github",
    );
  });

  it("reports a repository list the GitHub account could not serve", async () => {
    filtersMock.loadWorkflowEventFilterOptions.mockResolvedValue({
      ok: false,
      error: "Reconnect GitHub to list repositories.",
    });
    render(
      <WorkflowTemplatesButton missingPlugins={{}} companyGitHub={companyGitHub} scope="company" />,
    );

    await useTemplate(eventTemplate.name);

    expect(await screen.findByText("Reconnect GitHub to list repositories.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use template" })).toBeDisabled();
  });

  it("clones into the scope the list is filtered to, matching New workflow", async () => {
    render(<WorkflowTemplatesButton missingPlugins={{}} scope="personal" />);

    await useTemplate(template.name);

    await waitFor(() =>
      expect(commandsMock.createHeadlessWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "personal" }),
      ),
    );
  });

  it("stays dismissable while a clone is in flight, so a slow navigation cannot trap the user", async () => {
    // The create call never settles, so the card keeps its spinner for the whole test.
    commandsMock.createHeadlessWorkflow.mockReturnValue(new Promise(() => {}));
    render(<WorkflowTemplatesButton missingPlugins={{}} scope="company" />);

    await useTemplate(template.name);
    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("archives the empty draft when filling it in fails, so a failed clone leaves no debris", async () => {
    commandsMock.updateHeadlessWorkflow.mockRejectedValue(new Error("Workflow update failed"));
    render(<WorkflowTemplatesButton missingPlugins={{}} scope="company" />);

    await useTemplate(template.name);

    await waitFor(() =>
      expect(commandsMock.archiveHeadlessWorkflow).toHaveBeenCalledWith("workflow_1", {
        expectedVersion: 1,
      }),
    );
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith("Workflow update failed");
  });
});

it("clones both Sentry triggers as a draft and archives a partially initialized draft on failure", async () => {
  sentryMock.listSentryProjectsAction.mockResolvedValue({
    projects: [{ id: "1", name: "Web", slug: "web" }],
    nextCursor: null,
  });
  const companySentry = sentryPluginFixture();
  commandsMock.createHeadlessWorkflow.mockResolvedValue(createdWorkflow());
  commandsMock.updateHeadlessWorkflow
    .mockReset()
    .mockRejectedValue(new Error("Conditions rejected"));
  commandsMock.archiveHeadlessWorkflow.mockReset().mockResolvedValue({});
  render(
    <WorkflowTemplatesButton missingPlugins={{}} companySentry={companySentry} scope="company" />,
  );
  await useTemplate("Investigate Sentry issues");
  const project = await screen.findByRole("combobox", { name: "Sentry project" });
  await waitFor(() => expect(screen.getByRole("option", { name: "Web" })).toBeEnabled());
  await userEvent.selectOptions(project, "1");
  await userEvent.type(screen.getByRole("textbox", { name: "Sentry environment" }), "production");
  await userEvent.click(screen.getByRole("button", { name: "Create draft" }));
  await waitFor(() =>
    expect(commandsMock.archiveHeadlessWorkflow).toHaveBeenCalledWith("workflow_1", {
      expectedVersion: 1,
    }),
  );
  expect(commandsMock.updateHeadlessWorkflow.mock.calls[0]![1]).toMatchObject({
    status: "draft",
    steps: [{ model: "kimi-k2.6" }],
    triggers: [
      {
        event: "issue.created",
        filters: { project: { id: "1" }, environment: { id: "production" } },
      },
      { event: "issue.regressed", filters: { environment: { id: "production" } } },
    ],
  });
});

it("clones the Sentry fix template with its repository as typed step data", async () => {
  sentryMock.listSentryProjectsAction.mockResolvedValue({
    projects: [{ id: "1", name: "Web", slug: "web" }],
    nextCursor: null,
  });
  sentryMock.validateSentryFixAction.mockResolvedValue({});
  commandsMock.createHeadlessWorkflow.mockReset().mockResolvedValue(createdWorkflow());
  commandsMock.updateHeadlessWorkflow.mockReset().mockResolvedValue({ version: 2 });
  render(
    <WorkflowTemplatesButton
      missingPlugins={{}}
      companySentry={sentryPluginFixture()}
      scope="company"
    />,
  );
  await useTemplate("Propose a Sentry fix");
  await waitFor(() => expect(screen.getByRole("option", { name: "Web" })).toBeEnabled());
  await userEvent.selectOptions(screen.getByLabelText("Sentry project"), "1");
  await userEvent.type(screen.getByLabelText("Fix repository"), "acme/service");
  await userEvent.type(screen.getByLabelText("Fix base branch"), "release/stable");
  await userEvent.click(screen.getByRole("button", { name: "Create draft" }));

  await waitFor(() => expect(commandsMock.updateHeadlessWorkflow).toHaveBeenCalled());
  const update = commandsMock.updateHeadlessWorkflow.mock.calls[0]![1];
  expect(update.steps).toEqual([
    expect.objectContaining({
      id: "step_1",
      model: "codex",
      repository: { fullName: "acme/service", baseBranch: "release/stable" },
    }),
  ]);
  expect(update.steps[0].instructions).not.toContain("acme/service");
  expect(update.trigger).toMatchObject({ type: "event", event: "issue.created" });
  expect(update.triggers.map((trigger: { event: string }) => trigger.event)).toEqual([
    "issue.created",
    "issue.regressed",
  ]);
});
