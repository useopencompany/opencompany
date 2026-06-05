import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_CATALOG,
  AGENT_TOOL_DEFINITION_BY_ID,
  isDeferrableRuntimeTool,
  partitionRuntimeToolNames,
  RUNTIME_TOOL_DEFINITION_BY_NAME,
  type RuntimeToolName,
  resolveRuntimeToolNamesForConfigTools,
  searchRuntimeTools,
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

        const isOwnedByTool =
          runtimeTool.configToolId === tool.id ||
          runtimeTool.sharedConfigToolIds?.includes(tool.id) === true;
        expect(isOwnedByTool).toBe(true);
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

    const opencode = AGENT_TOOL_DEFINITION_BY_ID.get("opencode");
    expect(opencode?.credentialSource).toBe("mixed");
    expect(opencode?.requiredPlatformEnvVars).toEqual(["VERCEL_AI_GATEWAY_API_KEY"]);
    expect(opencode?.requiredWorkspaceResource).toBeUndefined();
    const opencodeRuntimeTools = (opencode?.runtimeTools ?? []).map((name) =>
      RUNTIME_TOOL_DEFINITION_BY_NAME.get(name),
    );
    expect(opencodeRuntimeTools).toContainEqual(
      expect.objectContaining({
        name: "opencode_coder",
        configToolId: "opencode",
      }),
    );
    expect(
      opencodeRuntimeTools.find((tool) => tool?.name === "opencode_coder")
        ?.requiresAttachedRepository,
    ).toBeUndefined();
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

  it("documents platform-only credentials for X without workspace resource requirements", () => {
    const x = AGENT_TOOL_DEFINITION_BY_ID.get("x");

    expect(x?.credentialSource).toBe("platform");
    expect(x?.requiredPlatformEnvVars).toEqual(["X_API_BEARER_TOKEN"]);
    expect(x?.requiredWorkspaceResource).toBeUndefined();
    expect(x?.runtimeTools).toEqual([
      "x_search_posts",
      "x_get_profile",
      "x_get_user_posts",
      "x_get_discussion",
      "x_get_trends",
    ]);
  });

  it("documents platform-only credentials for TikTok and Instagram through Apify and Supadata", () => {
    const tiktok = AGENT_TOOL_DEFINITION_BY_ID.get("tiktok");
    const instagram = AGENT_TOOL_DEFINITION_BY_ID.get("instagram");

    expect(tiktok?.credentialSource).toBe("platform");
    expect(tiktok?.requiredPlatformEnvVars).toEqual(["APIFY_API_TOKEN", "SUPADATA_API_KEY"]);
    expect(tiktok?.requiredWorkspaceResource).toBeUndefined();
    expect(tiktok?.runtimeTools).toEqual([
      "tiktok_get_profile",
      "tiktok_list_profile_posts",
      "tiktok_get_video",
      "tiktok_get_comments",
      "tiktok_search",
      "social_get_job",
      "tiktok_get_metadata",
      "tiktok_get_transcript",
    ]);

    expect(instagram?.credentialSource).toBe("platform");
    expect(instagram?.requiredPlatformEnvVars).toEqual(["APIFY_API_TOKEN", "SUPADATA_API_KEY"]);
    expect(instagram?.requiredWorkspaceResource).toBeUndefined();
    expect(instagram?.runtimeTools).toEqual([
      "instagram_get_profile",
      "instagram_list_profile_posts",
      "instagram_get_post",
      "instagram_get_comments",
      "instagram_search_profiles",
      "social_get_job",
      "instagram_get_metadata",
      "instagram_get_transcript",
    ]);
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

  it("exposes read_skill for mounted skill files and keeps generic file tools out of skills", () => {
    const readSkill = RUNTIME_TOOL_DEFINITION_BY_NAME.get("read_skill");
    const readFile = RUNTIME_TOOL_DEFINITION_BY_NAME.get("read_file");
    const listFiles = RUNTIME_TOOL_DEFINITION_BY_NAME.get("list_files");

    if (!readSkill || !readFile || !listFiles) {
      throw new Error("Expected read_skill, read_file, and list_files definitions to exist");
    }

    expect(readSkill.parameters.required).toEqual(["skillId"]);
    expect(readSkill.parameters.properties).toHaveProperty("path");
    expect(readFile.description).not.toContain("skills");
    expect(listFiles.description).not.toContain("skills");
  });

  it("requires reading the self-edit skill and points to it instead of duplicating it", () => {
    const definition = RUNTIME_TOOL_DEFINITION_BY_NAME.get("update_agent_file");

    if (!definition) {
      throw new Error("Expected update_agent_file runtime tool definition to exist");
    }

    expect(definition.description).toContain('read_skill({skillId:"agent-self-edit"})');
    expect(definition.help).toContain('read_skill({skillId:"agent-self-edit"})');
    // The help is a pointer to the skill, not a second copy of the protocol.
    expect(definition.help).toContain("source of truth");
    expect(definition.help).toContain("COMPLETE new Markdown body");
    expect(definition.help).toContain("next session");
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

  it("exposes read-only X tools with visible schemas and help", () => {
    const search = RUNTIME_TOOL_DEFINITION_BY_NAME.get("x_search_posts");
    const userPosts = RUNTIME_TOOL_DEFINITION_BY_NAME.get("x_get_user_posts");
    const discussion = RUNTIME_TOOL_DEFINITION_BY_NAME.get("x_get_discussion");
    const trends = RUNTIME_TOOL_DEFINITION_BY_NAME.get("x_get_trends");

    if (!search || !userPosts || !discussion || !trends) {
      throw new Error("Expected X runtime tool definitions to exist");
    }

    const maxResultsFor = (tool: NonNullable<typeof search>) =>
      tool.parameters.properties.maxResults as { default?: number; description?: string };

    expect(search.configToolId).toBe("x");
    expect(search.parameters.required).toEqual(["query"]);
    expect(search.parameters.properties).toHaveProperty("mode");
    expect(search.parameters.properties).toHaveProperty("paginationToken");
    expect(search.description).toContain("official X API");
    const searchMaxResults = maxResultsFor(search);
    expect(searchMaxResults.default).toBe(10);
    expect(String(searchMaxResults.description)).toContain("Defaults to 10");
    expect(String(searchMaxResults.description)).toContain(
      "ask the user before using larger values",
    );
    expect(search.help).toContain("Start with maxResults=10");
    expect(search.help).toContain("explicitly asks for broader coverage");

    const userPostsMaxResults = maxResultsFor(userPosts);
    expect(userPostsMaxResults.default).toBe(10);
    expect(String(userPostsMaxResults.description)).toContain("Defaults to 10");
    expect(userPosts.help).toContain("Start with maxResults=10");

    expect(discussion.configToolId).toBe("x");
    expect(discussion.parameters.required).toEqual(["postIdOrUrl"]);
    expect(discussion.help).toContain("target post");
    const discussionMaxResults = maxResultsFor(discussion);
    expect(discussionMaxResults.default).toBe(10);
    expect(String(discussionMaxResults.description)).toContain("Defaults to 10");
    expect(discussion.help).toContain("Start with maxResults=10");
    expect(discussion.parameters.properties).not.toHaveProperty("paginationToken");
    expect(discussion.help).not.toContain("pagination");

    const trendsMaxResults = maxResultsFor(trends);
    expect(trendsMaxResults.default).toBe(10);
    expect(String(trendsMaxResults.description)).toContain("Defaults to 10");
    expect(trends.help).toContain("Start with maxResults=10");
  });
});

describe("resolveRuntimeToolNamesForConfigTools", () => {
  const repo = { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" };

  it("always exposes the core file/shell tools and tool_help", () => {
    const names = resolveRuntimeToolNamesForConfigTools({ tools: [] });
    expect(names).toEqual(
      expect.arrayContaining([
        "shell",
        "read_file",
        "read_skill",
        "ask_user_question",
        "tool_help",
      ]),
    );
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

  it("enables opencode_coder when opencode is selected, even without an attached repository", () => {
    const opencodeTool = { id: "opencode" };
    expect(resolveRuntimeToolNamesForConfigTools({ tools: [opencodeTool] })).toContain(
      "opencode_coder",
    );
    expect(
      resolveRuntimeToolNamesForConfigTools({ tools: [opencodeTool], repositories: [repo] }),
    ).toContain("opencode_coder");
    expect(
      resolveRuntimeToolNamesForConfigTools({ tools: [], repositories: [repo] }),
    ).not.toContain("opencode_coder");
  });

  it("adds delegate_to_agent only when delegatable agents are present", () => {
    expect(resolveRuntimeToolNamesForConfigTools({ tools: [] })).not.toContain("delegate_to_agent");
    expect(
      resolveRuntimeToolNamesForConfigTools({
        tools: [],
        agents: [{ path: "agents/x/x.agent" }],
      }),
    ).toContain("delegate_to_agent");
  });

  it("enables X hosted tools only when x is selected", () => {
    expect(resolveRuntimeToolNamesForConfigTools({ tools: [] })).not.toContain("x_search_posts");
    expect(resolveRuntimeToolNamesForConfigTools({ tools: [{ id: "x" }] })).toEqual(
      expect.arrayContaining([
        "x_search_posts",
        "x_get_profile",
        "x_get_user_posts",
        "x_get_discussion",
        "x_get_trends",
      ]),
    );
  });

  it("enables shared social job polling when either social platform is selected", () => {
    expect(resolveRuntimeToolNamesForConfigTools({ tools: [] })).not.toContain("social_get_job");
    expect(resolveRuntimeToolNamesForConfigTools({ tools: [{ id: "instagram" }] })).toEqual(
      expect.arrayContaining(["instagram_get_profile", "social_get_job"]),
    );
    expect(resolveRuntimeToolNamesForConfigTools({ tools: [{ id: "tiktok" }] })).toEqual(
      expect.arrayContaining(["tiktok_get_profile", "social_get_job"]),
    );
  });
});

describe("partitionRuntimeToolNames", () => {
  it("defers capability tools and keeps the core/conditional tools direct", () => {
    const enabled: RuntimeToolName[] = [
      "read_file",
      "edit_file",
      "shell",
      "tool_search",
      "exa_search",
      "instagram_get_profile",
      "amp_coder",
    ];
    const { direct, deferred } = partitionRuntimeToolNames(enabled);
    expect(direct).toEqual(["read_file", "edit_file", "shell", "tool_search"]);
    expect(deferred).toEqual(["exa_search", "instagram_get_profile", "amp_coder"]);
  });

  it("classifies hosted tools and coding agents as deferrable, core tools as not", () => {
    expect(isDeferrableRuntimeTool("exa_search")).toBe(true);
    expect(isDeferrableRuntimeTool("amp_coder")).toBe(true);
    expect(isDeferrableRuntimeTool("web_fetch")).toBe(true);
    expect(isDeferrableRuntimeTool("read_file")).toBe(false);
    expect(isDeferrableRuntimeTool("shell")).toBe(false);
    expect(isDeferrableRuntimeTool("gh")).toBe(false);
    expect(isDeferrableRuntimeTool("tool_search")).toBe(false);
  });
});

describe("searchRuntimeTools", () => {
  const enabled = resolveRuntimeToolNamesForConfigTools({
    tools: [{ id: "exa" }, { id: "instagram" }],
  });

  it("returns deferred enabled tools with their schemas for a capability", () => {
    const results = searchRuntimeTools({ capability: "instagram" }, enabled);
    const names = results.map((result) => result.name);
    expect(names).toContain("instagram_get_profile");
    expect(names).not.toContain("exa_search");
    const profile = results.find((result) => result.name === "instagram_get_profile");
    expect(profile?.parameters.type).toBe("object");
    expect(typeof profile?.description).toBe("string");
  });

  it("filters by a case-insensitive query across name and description", () => {
    const results = searchRuntimeTools({ query: "transcript" }, enabled);
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.every(
        (result) =>
          result.name.toLowerCase().includes("transcript") ||
          result.description.toLowerCase().includes("transcript"),
      ),
    ).toBe(true);
  });

  it("never returns a tool that is not enabled or not deferrable", () => {
    const results = searchRuntimeTools({}, enabled);
    const names = results.map((result) => result.name);
    expect(names).not.toContain("read_file");
    expect(names).not.toContain("tool_search");
    expect(names.every((name) => isDeferrableRuntimeTool(name) && enabled.includes(name))).toBe(
      true,
    );
  });
});
