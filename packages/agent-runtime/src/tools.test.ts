import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_CATALOG,
  AGENT_TOOL_DEFINITION_BY_ID,
  RUNTIME_TOOL_DEFINITION_BY_NAME,
  resolveRuntimeToolNamesForConfigTools,
} from "./tools";

describe("AGENT_TOOL_CATALOG", () => {
  it("references existing runtime tools and keeps tools globally enabled by default", () => {
    for (const tool of AGENT_TOOL_CATALOG) {
      expect(tool.defaultEnabled).toBe(true);

      for (const runtimeToolName of tool.runtimeTools) {
        const runtimeTool = RUNTIME_TOOL_DEFINITION_BY_NAME.get(runtimeToolName);
        if (!runtimeTool) {
          throw new Error(`${tool.id} references missing runtime tool ${runtimeToolName}.`);
        }

        expect(runtimeTool.configToolId).toBe(tool.id);
      }
    }
  });

  it("keeps workspace resource requirements aligned with repository-bound runtime tools", () => {
    const amp = AGENT_TOOL_DEFINITION_BY_ID.get("amp");

    expect(amp?.credentialSource).toBe("mixed");
    expect(amp?.requiredPlatformEnvVars).toEqual(["AMP_API_KEY"]);
    expect(amp?.requiredWorkspaceResource).toEqual({
      provider: "github",
      resourceType: "repository",
      binding: "required",
    });

    const ampRuntimeTools = (amp?.runtimeTools ?? []).map((name) =>
      RUNTIME_TOOL_DEFINITION_BY_NAME.get(name),
    );

    expect(ampRuntimeTools).toContainEqual(
      expect.objectContaining({
        name: "amp_coder",
        configToolId: "amp",
        requiresAttachedRepository: true,
      }),
    );
  });

  it("exposes Amp modes on amp_coder", () => {
    const definition = RUNTIME_TOOL_DEFINITION_BY_NAME.get("amp_coder");
    if (!definition) throw new Error("Expected amp_coder runtime tool definition to exist");

    const properties = definition.parameters.properties as Record<
      string,
      { enum?: string[]; default?: string; description?: string }
    >;

    expect(properties.mode).toMatchObject({
      enum: ["smart", "large", "rush", "deep"],
      default: "smart",
    });
    expect(properties.mode?.description).toContain("rush for latency-sensitive tasks");
  });

  it("documents platform-only credentials for Exa without workspace resource requirements", () => {
    const exa = AGENT_TOOL_DEFINITION_BY_ID.get("exa");

    expect(exa?.credentialSource).toBe("platform");
    expect(exa?.requiredPlatformEnvVars).toEqual(["EXA_API_KEY"]);
    expect(exa?.requiredWorkspaceResource).toBeUndefined();
  });
});

describe("runtime tool definitions", () => {
  it("lets delegate_to_agent continue prior child sessions by session id", () => {
    const definition = RUNTIME_TOOL_DEFINITION_BY_NAME.get("delegate_to_agent");

    if (!definition) {
      throw new Error("Expected delegate_to_agent runtime tool definition to exist");
    }

    expect(definition.parameters.required).toEqual(["prompt"]);
    expect(definition.parameters.properties).toHaveProperty("agent");
    expect(definition.parameters.properties).toHaveProperty("sessionId");
    expect(definition.description).toContain("continue a prior delegated child session");
    expect(definition.help).toContain("childSessionId");
  });

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
    expect(descriptionFor("excludeDomains")).toContain(
      "Not supported with category=people or category=company",
    );
    expect(descriptionFor("startPublishedDate")).toContain(
      "Not supported with category=people or category=company",
    );
    expect(descriptionFor("endPublishedDate")).toContain(
      "Not supported with category=people or category=company",
    );
  });
});

describe("resolveRuntimeToolNamesForConfigTools", () => {
  const repo = { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" };

  it("always exposes the core file/shell tools and tool_help", () => {
    const names = resolveRuntimeToolNamesForConfigTools({ tools: [] });
    expect(names).toEqual(expect.arrayContaining(["shell", "read_file", "tool_help"]));
  });

  it("gates the gh tool on an attached repository, independent of amp", () => {
    expect(resolveRuntimeToolNamesForConfigTools({ tools: [] })).not.toContain("gh");
    expect(resolveRuntimeToolNamesForConfigTools({ tools: [], repositories: [repo] })).toContain(
      "gh",
    );
  });

  it("enables amp_coder only when amp is selected and a repository is attached", () => {
    const ampTool = { id: "amp" };
    expect(resolveRuntimeToolNamesForConfigTools({ tools: [ampTool] })).not.toContain("amp_coder");
    expect(
      resolveRuntimeToolNamesForConfigTools({ tools: [ampTool], repositories: [repo] }),
    ).toContain("amp_coder");
    expect(
      resolveRuntimeToolNamesForConfigTools({ tools: [], repositories: [repo] }),
    ).not.toContain("amp_coder");
  });

  it("adds delegate_to_agent only when delegatable agents are present", () => {
    expect(resolveRuntimeToolNamesForConfigTools({ tools: [] })).not.toContain("delegate_to_agent");
    expect(
      resolveRuntimeToolNamesForConfigTools({
        tools: [],
        agents: [{ path: "agents/x/agent.agent" }],
      }),
    ).toContain("delegate_to_agent");
  });
});
