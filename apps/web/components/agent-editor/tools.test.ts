import { describe, expect, test } from "vitest";
import { buildBrainMentionItems } from "./tools";

describe("agent editor mention tools", () => {
  test("includes the root Brain folder before nested Brain paths", () => {
    const items = buildBrainMentionItems(["docs/README.md", "product/notes.md"]);

    expect(items.map((item) => item.mentionId)).toEqual([
      "brain/",
      "brain/docs/",
      "brain/docs/README.md",
      "brain/product/",
      "brain/product/notes.md",
    ]);
    expect(items[0]).toMatchObject({
      kind: "brain",
      path: "/",
      label: "brain/",
      description: "Brain root folder",
    });
  });
});
