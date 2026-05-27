import { describe, expect, it } from "vitest";
import { RUNTIME_TOOL_DEFINITION_BY_NAME } from "./tools";

describe("runtime tool definitions", () => {
  it("keeps Exa category compatibility guidance in the visible search schema", () => {
    const definition = RUNTIME_TOOL_DEFINITION_BY_NAME.get("exa_search");

    if (!definition) {
      throw new Error("Expected exa_search runtime tool definition to exist");
    }

    expect(definition.description).toContain("category=people/company");
    expect(definition.description).toContain("date filters");
    expect(definition.description).toContain("LinkedIn-only");

    const properties = definition.parameters.properties as Record<string, { description?: string }>;
    const descriptionFor = (propertyName: string) => {
      const property = properties[propertyName];

      if (!property?.description) {
        throw new Error(`Expected ${propertyName} to have a description`);
      }

      return property.description;
    };

    expect(descriptionFor("category")).toContain("cannot combine with date filters");
    expect(descriptionFor("includeDomains")).toContain("LinkedIn domains only");
    expect(descriptionFor("excludeDomains")).toContain("Not supported with category=people");
    expect(descriptionFor("startPublishedDate")).toContain("Not supported with category=people");
    expect(descriptionFor("endPublishedDate")).toContain("Not supported with category=people");
  });
});
