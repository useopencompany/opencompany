import { describe, expect, it } from "vitest";
import { createGoatCollections } from "@/lib/task-collections";

describe("createGoatCollections", () => {
  it("reuses root Electric collections across callers", () => {
    const first = createGoatCollections();
    const second = createGoatCollections();

    expect(second).toBe(first);
    expect(second.tasks).toBe(first.tasks);
    expect(second.integrations).toBe(first.integrations);
    expect(second.brainDocuments).toBe(first.brainDocuments);
    expect(second.brainTimelineEntries).toBe(first.brainTimelineEntries);
    expect(second.brainEdges).toBe(first.brainEdges);
  });

  it("reuses task-scoped Electric collections for the same task id", () => {
    const collections = createGoatCollections();

    const first = collections.taskRunCollections("goat_task_1");
    const second = collections.taskRunCollections("goat_task_1");
    const other = collections.taskRunCollections("goat_task_2");

    expect(second).toBe(first);
    expect(second.messages).toBe(first.messages);
    expect(second.events).toBe(first.events);
    expect(other).not.toBe(first);
    expect(other.messages).not.toBe(first.messages);
  });
});
