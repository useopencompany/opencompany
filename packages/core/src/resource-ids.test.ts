import { describe, expect, it } from "vitest";
import { newResourceId } from "./resource-ids";

describe("resource IDs", () => {
  it.each([
    "conversation",
    "workspace",
    "workflow",
    "task_schedule",
    "workflow_schedule_run",
    "task_schedule_run",
    "share",
    "artifact",
    "artifact_version",
  ] as const)("generates distinct %s IDs with full UUID v4 entropy", (resource) => {
    const id = newResourceId(resource);
    expect(id.startsWith(`${resource}_`)).toBe(true);
    expect(id.slice(resource.length + 1)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(newResourceId(resource)).not.toBe(id);
  });
});
