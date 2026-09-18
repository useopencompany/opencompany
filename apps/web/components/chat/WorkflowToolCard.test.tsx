import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkflowToolCard } from "./WorkflowToolCard";

const workflow = {
  slug: "dia-monitor",
  name: "Dia monitor",
  status: "active",
  scope: "personal",
  memory: { enabled: true },
  triggers: [
    {
      type: "schedule",
      cron: "0 9 * * 5",
      timezone: "Europe/Berlin",
      enabled: true,
      nextRunAt: "2026-09-18T07:00:00Z",
    },
  ],
};
describe("WorkflowToolCard", () => {
  it("shows the actual status, visibility, memory and local schedule with an editor link", () => {
    render(<WorkflowToolCard output={{ ok: true, workflow }} />);
    expect(screen.getByRole("link", { name: "Dia monitor" }).getAttribute("href")).toBe(
      "/workflows/dia-monitor",
    );
    for (const text of ["Active", "Personal", "Memory on", "Friday at 09:00 · Europe/Berlin"])
      expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByText(/Next run:.*09:00/)).toBeTruthy();
  });
  it("does not imply that a paused or disabled schedule will execute", () => {
    const { rerender } = render(
      <WorkflowToolCard output={{ ok: true, workflow: { ...workflow, status: "draft" } }} />,
    );
    expect(screen.queryByText(/Next run:/)).toBeNull();
    rerender(
      <WorkflowToolCard
        output={{
          ok: true,
          workflow: { ...workflow, triggers: [{ ...workflow.triggers[0], enabled: false }] },
        }}
      />,
    );
    expect(screen.queryByText(/Next run:/)).toBeNull();
  });
  it("keeps a failed activation's recoverable draft visible", () => {
    render(
      <WorkflowToolCard
        output={{
          ok: false,
          error: "Connection unavailable",
          workflow: { ...workflow, status: "draft" },
        }}
      />,
    );
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getByText("Connection unavailable")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Dia monitor" })).toBeTruthy();
  });
});
