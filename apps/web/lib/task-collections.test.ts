import { describe, expect, it } from "vitest";
import { createGoatCollections } from "@/lib/task-collections";

describe("createGoatCollections", () => {
  it("reuses root Electric collections across callers", () => {
    const first = createGoatCollections();
    const second = createGoatCollections();

    expect(second).toBe(first);
    expect(second.chatSessions).toBe(first.chatSessions);
    expect(second.integrations).toBe(first.integrations);
  });

  it("reuses brain-scoped Electric collections for the same brain ref", () => {
    const collections = createGoatCollections();

    const first = collections.brainCollections("goat_brain_1");
    const second = collections.brainCollections("goat_brain_1");
    const other = collections.brainCollections("goat_brain_2");

    expect(second).toBe(first);
    expect(second.ingestJobs).toBe(first.ingestJobs);
    expect(second.importRuns).toBe(first.importRuns);
    expect(other.ingestJobs).not.toBe(first.ingestJobs);
  });
});
