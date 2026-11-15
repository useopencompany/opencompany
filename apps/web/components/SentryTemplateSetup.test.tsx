import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { WORKFLOW_TEMPLATES } from "@/lib/workflow-templates";
import { sentryPluginFixture } from "@/test/sentry";
import { SentryTemplateSetup } from "./SentryTemplateSetup";

const actions = vi.hoisted(() => ({
  listSentryProjectsAction: vi.fn(),
  validateSentryFixAction: vi.fn(),
}));
vi.mock("@/lib/sentry-actions", () => actions);
const plugin = sentryPluginFixture();
beforeEach(() => {
  actions.listSentryProjectsAction.mockResolvedValue({
    projects: [{ id: "1", slug: "web", name: "Web" }],
    nextCursor: null,
  });
  actions.validateSentryFixAction.mockResolvedValue({});
});
it("defaults daily time to 09:00 and saves the selected timezone", async () => {
  const onUse = vi.fn();
  render(
    <SentryTemplateSetup
      template={WORKFLOW_TEMPLATES.find((template) => template.id === "daily-sentry-review")!}
      plugin={plugin}
      pending={false}
      onBack={vi.fn()}
      onUse={onUse}
    />,
  );
  expect(screen.getByLabelText("Daily time")).toHaveValue("09:00");
  await screen.findByRole("option", { name: "Web" });
  await userEvent.selectOptions(screen.getByLabelText("Sentry project"), "1");
  await userEvent.selectOptions(screen.getByLabelText("Schedule timezone"), "Europe/Berlin");
  await userEvent.click(screen.getByRole("button", { name: "Create draft" }));
  expect(onUse).toHaveBeenCalledWith(
    expect.objectContaining({
      triggers: [expect.objectContaining({ cron: "0 9 * * *", timezone: "Europe/Berlin" })],
    }),
  );
});
it("keeps a failed repository or branch check in setup without creating a draft", async () => {
  const onUse = vi.fn();
  actions.validateSentryFixAction.mockRejectedValue(
    new Error("The selected branch does not exist."),
  );
  render(
    <SentryTemplateSetup
      template={WORKFLOW_TEMPLATES.find((template) => template.id === "propose-sentry-fix")!}
      plugin={plugin}
      pending={false}
      onBack={vi.fn()}
      onUse={onUse}
    />,
  );
  await screen.findByRole("option", { name: "Web" });
  await userEvent.selectOptions(screen.getByLabelText("Sentry project"), "1");
  await userEvent.selectOptions(screen.getByLabelText("Coding engine"), "claude-code");
  await userEvent.type(screen.getByLabelText("Fix repository"), "acme/service");
  await userEvent.type(screen.getByLabelText("Fix base branch"), "release/stable");
  await userEvent.click(screen.getByRole("button", { name: "Create draft" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("branch does not exist"));
  expect(actions.validateSentryFixAction).toHaveBeenCalledWith({
    engine: "claude-code",
    repository: "acme/service",
    baseBranch: "release/stable",
  });
  expect(onUse).not.toHaveBeenCalled();
});
