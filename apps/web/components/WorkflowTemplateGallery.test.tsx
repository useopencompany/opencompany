import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKFLOW_TEMPLATES } from "@/lib/workflow-templates";
import { WorkflowTemplateGallery } from "./WorkflowTemplateGallery";

const routerMock = vi.hoisted(() => ({ push: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }));
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const commandsMock = vi.hoisted(() => ({
  createHeadlessWorkflow: vi.fn(),
  updateHeadlessWorkflow: vi.fn(),
  archiveHeadlessWorkflow: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));
vi.mock("@opencompany/ui/components/sonner", () => ({ toast: toastMock }));
vi.mock("@/lib/headless-automation-commands", () => commandsMock);

const template = WORKFLOW_TEMPLATES[0]!;

function createdWorkflow() {
  return {
    id: "workflow_1",
    slug: "weekly-shipping-digest",
    version: 1,
    steps: [{ id: "step_1" }],
  };
}

describe("WorkflowTemplateGallery", () => {
  beforeEach(() => {
    routerMock.push.mockClear();
    toastMock.error.mockClear();
    commandsMock.createHeadlessWorkflow.mockReset().mockResolvedValue(createdWorkflow());
    commandsMock.updateHeadlessWorkflow.mockReset().mockResolvedValue({ version: 2 });
    commandsMock.archiveHeadlessWorkflow.mockReset().mockResolvedValue({ version: 2 });
  });

  it("shows every template with its trigger and outcome", () => {
    render(<WorkflowTemplateGallery missingPlugins={{}} />);

    for (const entry of WORKFLOW_TEMPLATES) {
      expect(screen.getByText(entry.name)).toBeInTheDocument();
      expect(screen.getByText(entry.description)).toBeInTheDocument();
    }
    expect(screen.getByText("Friday at 16:00")).toBeInTheDocument();
    expect(screen.getAllByText("Send Slack").length).toBeGreaterThan(0);
  });

  it("links each missing plugin to its setup page instead of blocking the card", async () => {
    render(
      <WorkflowTemplateGallery
        missingPlugins={{
          [template.id]: [
            { plugin: "slack", label: "Slack", setupHref: "/settings/plugins/slack" },
          ],
        }}
      />,
    );

    expect(screen.getByRole("link", { name: "Slack" })).toHaveAttribute(
      "href",
      "/settings/plugins/slack",
    );

    await userEvent.click(screen.getByRole("button", { name: new RegExp(template.name) }));
    await waitFor(() => expect(commandsMock.createHeadlessWorkflow).toHaveBeenCalled());
  });

  it("hides the setup hints when the plugin snapshot is unavailable", () => {
    render(<WorkflowTemplateGallery missingPlugins={null} />);

    expect(screen.queryByText(/before it can run/)).not.toBeInTheDocument();
  });

  it("fills the draft with the template's step and schedule, then opens it", async () => {
    render(<WorkflowTemplateGallery missingPlugins={{}} />);

    await userEvent.click(screen.getByRole("button", { name: new RegExp(template.name) }));

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
    expect(update.triggers[0]).toMatchObject({
      type: "schedule",
      cron: template.schedule.cron,
      prompt: template.schedule.prompt,
      enabled: true,
    });
    // The legacy single-trigger field has to agree with the automation trigger the editor reads back.
    expect(update.trigger).toMatchObject({ type: "schedule", cron: template.schedule.cron });
  });

  it("archives the empty draft when filling it in fails, so a failed clone leaves no debris", async () => {
    commandsMock.updateHeadlessWorkflow.mockRejectedValue(new Error("Workflow update failed"));
    render(<WorkflowTemplateGallery missingPlugins={{}} />);

    await userEvent.click(screen.getByRole("button", { name: new RegExp(template.name) }));

    await waitFor(() =>
      expect(commandsMock.archiveHeadlessWorkflow).toHaveBeenCalledWith("workflow_1", {
        expectedVersion: 1,
      }),
    );
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith("Workflow update failed");
  });
});
