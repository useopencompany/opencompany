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

  it("no longer exposes physical brain-scoped collections", () => {
    const collections = createGoatCollections();

    expect("brainCollections" in collections).toBe(false);
  });
});
