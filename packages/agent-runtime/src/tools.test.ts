import { describe, expect, it } from "vitest";
import { RUNTIME_TOOL_DEFINITION_BY_NAME } from "./tools";

describe("runtime tool definitions", () => {
  it("keeps Exa category compatibility guidance in the visible search schema", () => {
    const definition = RUNTIME_TOOL_DEFINITION_BY_NAME.get("exa_search");

    expect(definition?.description).toContain("category=people/company");
    expect(definition?.description).toContain("date filters");
    expect(definition?.description).toContain("LinkedIn-only");

    const properties = definition?.parameters.properties as Record<
      string,
      { description?: string }
    >;

    expect(properties.category.description).toContain("cannot combine with date filters");
    expect(properties.includeDomains.description).toContain("LinkedIn domains only");
    expect(properties.excludeDomains.description).toContain("Not supported with category=people");
    expect(properties.startPublishedDate.description).toContain(
      "Not supported with category=people",
    );
    expect(properties.endPublishedDate.description).toContain("Not supported with category=people");
  });
});
