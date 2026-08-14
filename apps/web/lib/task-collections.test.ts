import { describe, expect, it } from "vitest";
import { createGoatCollections } from "@/lib/task-collections";

describe("createGoatCollections", () => {
  it("reuses root Electric collections across callers", () => {
    const first = createGoatCollections();
    const second = createGoatCollections();

    expect(second).toBe(first);
    expect(second.integrations).toBe(first.integrations);
  });

  it("only exposes the physical integration collection that still has a reader", () => {
    const collections = createGoatCollections();

    expect(Object.keys(collections)).toEqual(["integrations"]);
  });
});
