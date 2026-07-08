import { describe, expect, it } from "vitest";
import { createGoatCollections } from "@/lib/task-collections";

describe("createGoatCollections", () => {
  it("reuses root Electric collections across callers", () => {
    const first = createGoatCollections();
    const second = createGoatCollections();

    expect(second).toBe(first);
    expect(second.tasks).toBe(first.tasks);
    expect(second.chatSessions).toBe(first.chatSessions);
    expect(second.integrations).toBe(first.integrations);
  });

  it("reuses brain-scoped Electric collections for the same brain ref", () => {
    const collections = createGoatCollections();

    const first = collections.brainCollections("goat_brain_1");
    const second = collections.brainCollections("goat_brain_1");
    const other = collections.brainCollections("goat_brain_2");

    expect(second).toBe(first);
    expect(second.documents).toBe(first.documents);
    expect(second.timelineEntries).toBe(first.timelineEntries);
    expect(second.edges).toBe(first.edges);
    expect(other.documents).not.toBe(first.documents);
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
