import { describe, expect, it } from "vitest";
import {
  findIntegrationToolDefinition,
  INTEGRATION_PROVIDER_LABELS,
  INTEGRATION_PROVIDER_SUMMARIES,
  INTEGRATION_TOOL_DEFINITIONS,
  integrationToolDefinitionsForProviders,
  toIntegrationToolDefinitionView,
} from "@/lib/integration-tools/registry";
import { INTEGRATION_TOOL_PROVIDERS, providerFromToolName } from "@/lib/integration-tools/types";

describe("integration tool registry", () => {
  it("has unique, provider-prefixed tool names", () => {
    const names = INTEGRATION_TOOL_DEFINITIONS.map((definition) => definition.name);
    expect(new Set(names).size).toBe(names.length);
    for (const definition of INTEGRATION_TOOL_DEFINITIONS) {
      expect(definition.name.startsWith(`${definition.provider}_`)).toBe(true);
      expect(providerFromToolName(definition.name)).toBe(definition.provider);
    }
  });

  it("keeps every provider's curated set minimal", () => {
    for (const provider of INTEGRATION_TOOL_PROVIDERS) {
      const definitions = integrationToolDefinitionsForProviders([provider]);
      expect(definitions.length).toBeGreaterThan(0);
      expect(definitions.length).toBeLessThanOrEqual(6);
      expect(INTEGRATION_PROVIDER_LABELS[provider]).toBeTruthy();
      expect(INTEGRATION_PROVIDER_SUMMARIES[provider]).toBeTruthy();
    }
  });

  it("declares strict flat schemas with primitive properties", () => {
    for (const definition of INTEGRATION_TOOL_DEFINITIONS) {
      const schema = definition.inputSchema;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      for (const property of Object.values(schema.properties)) {
        expect(["string", "number", "boolean"]).toContain(property.type);
      }
      for (const required of schema.required ?? []) {
        expect(Object.keys(schema.properties)).toContain(required);
      }
    }
  });

  it("requires an account on every gmail tool", () => {
    const gmailTools = integrationToolDefinitionsForProviders(["gmail"]);
    expect(gmailTools.length).toBeGreaterThan(0);
    for (const definition of gmailTools) {
      expect(definition.inputSchema.required ?? []).toContain("account");
    }
  });

  it("finds definitions by exact name and projects the model-facing view", () => {
    const definition = findIntegrationToolDefinition("linear_get_issue");
    expect(definition?.provider).toBe("linear");
    expect(findIntegrationToolDefinition("linear_get_issue_v2")).toBeNull();

    const view = toIntegrationToolDefinitionView(definition!);
    expect(view).toEqual({
      name: definition!.name,
      provider: definition!.provider,
      description: definition!.description,
      inputSchema: definition!.inputSchema,
    });
    expect("keywords" in view).toBe(false);
  });
});
