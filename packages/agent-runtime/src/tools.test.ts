import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_CATALOG,
  AGENT_TOOL_DEFINITION_BY_ID,
  buildCapabilityDiscovery,
  getRuntimeToolDefinition,
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

describe("run_subagent runtime tool", () => {
  it("is always-on, directly callable, and documented in the runtime registry", () => {
    const definition = getRuntimeToolDefinition("run_subagent");

    expect(definition).toMatchObject({
      name: "run_subagent",
      kind: "internal",
    });
    expect(definition?.configToolId).toBeUndefined();
    expect(partitionRuntimeToolNames(["run_subagent"] as RuntimeToolName[])).toEqual({
      direct: ["run_subagent"],
      deferred: [],
    });
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
    expect(definition.help).toContain("next turn in this same session");
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

  it("treats the @github all-repositories scope as an attached repository", () => {
    expect(resolveRuntimeToolNamesForConfigTools({ tools: [], allRepositories: true })).toContain(
      "gh",
    );
    expect(
      resolveRuntimeToolNamesForConfigTools({ tools: [{ id: "amp" }], allRepositories: true }),
    ).toContain("amp_coder");
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

  it("gates the memory, recall, and fetch_transcript tools on the memory skill being enabled", () => {
    const withoutMemory = resolveRuntimeToolNamesForConfigTools({ tools: [] });
    expect(withoutMemory).not.toContain("memory");
    expect(withoutMemory).not.toContain("recall");
    expect(withoutMemory).not.toContain("fetch_transcript");

    const withMemory = resolveRuntimeToolNamesForConfigTools({
      tools: [],
      memorySkillEnabled: true,
    });
    expect(withMemory).toContain("memory");
    expect(withMemory).toContain("recall");
    expect(withMemory).toContain("fetch_transcript");
  });

  it("guides broad time-bounded recap requests toward query-less recall", () => {
    const definition = RUNTIME_TOOL_DEFINITION_BY_NAME.get("recall");
    if (!definition) throw new Error("Expected recall runtime tool definition to exist");

    expect(definition.description).toContain('omit query and pass only time_window');
    expect(definition.description).toContain("what did we discuss today?");

    const query = definition.parameters.properties.query as { description?: string };
    expect(query.description).toContain("Omit when the user asks for a broad recap");
    expect(definition.help).toContain("Mode 3, time-bounded recap");
    expect(definition.help).toContain("pass time_window without query");
  });

  it("hard-gates the inbox tools to the personal agent", () => {
    const teamAgent = resolveRuntimeToolNamesForConfigTools({ tools: [] });
    expect(teamAgent).not.toContain("inbox_add");
    expect(teamAgent).not.toContain("inbox_list");
    expect(teamAgent).not.toContain("inbox_update");

    const personalAgent = resolveRuntimeToolNamesForConfigTools({
      tools: [],
      personalInboxEnabled: true,
    });
    expect(personalAgent).toContain("inbox_list");
    expect(personalAgent).toContain("inbox_add");
    expect(personalAgent).toContain("inbox_update");
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
  it("defers capability tools and update_agent_file, keeps the core/conditional tools direct", () => {
    const enabled: RuntimeToolName[] = [
      "read_file",
      "edit_file",
      "shell",
      "find_tools",
      "update_agent_file",
      "exa_search",
      "instagram_get_profile",
      "amp_coder",
    ];
    const { direct, deferred } = partitionRuntimeToolNames(enabled);
    expect(direct).toEqual(["read_file", "edit_file", "shell", "find_tools"]);
    expect(deferred).toEqual([
      "update_agent_file",
      "exa_search",
      "instagram_get_profile",
      "amp_coder",
    ]);
  });

  it("classifies hosted tools, coding agents and update_agent_file as deferrable, core tools as not", () => {
    expect(isDeferrableRuntimeTool("exa_search")).toBe(true);
    expect(isDeferrableRuntimeTool("amp_coder")).toBe(true);
    expect(isDeferrableRuntimeTool("web_fetch")).toBe(true);
    expect(isDeferrableRuntimeTool("update_agent_file")).toBe(true);
    expect(isDeferrableRuntimeTool("read_file")).toBe(false);
    expect(isDeferrableRuntimeTool("shell")).toBe(false);
    expect(isDeferrableRuntimeTool("gh")).toBe(false);
    expect(isDeferrableRuntimeTool("find_tools")).toBe(false);
    // ask_user_question stays direct so its durable turn-suspend (keyed on the literal call name)
    // is not wrapped behind use_tool.
    expect(isDeferrableRuntimeTool("ask_user_question")).toBe(false);
  });
});

describe("getRuntimeToolDefinition", () => {
  it("renders personal file tool descriptions without brain/ or memory/ file access", () => {
    const readFile = getRuntimeToolDefinition("read_file", { personalAgent: true });
    const listFiles = getRuntimeToolDefinition("list_files", { personalAgent: true });
    const shell = getRuntimeToolDefinition("shell", { personalAgent: true });

    expect(readFile?.description).toContain("./personal-brain");
    expect(readFile?.description).not.toContain("./brain");
    expect(readFile?.parameters.properties.path).toMatchObject({
      description: expect.stringContaining("personal-brain/"),
    });
    expect(JSON.stringify(readFile?.parameters.properties.path)).not.toContain("memory/");
    expect(listFiles?.description).toContain("generic file tools cannot access memory/");
    expect(shell?.description).toContain("./personal-brain");
    expect(shell?.description).toContain("Personal shell commands cannot access memory/");
    expect(shell?.description).not.toContain("./brain");
  });

  it("keeps company file tool descriptions on brain/", () => {
    const readFile = getRuntimeToolDefinition("read_file");

    expect(readFile?.description).toContain("./brain");
    expect(readFile?.parameters.properties.path).toMatchObject({
      description: expect.stringContaining("brain/"),
    });
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

  it("returns compact entries without the verbose per-tool help (that is tool_help's job)", () => {
    const results = searchRuntimeTools({ capability: "instagram" }, enabled);
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result).not.toHaveProperty("help");
      expect(Object.keys(result).sort()).toEqual(["description", "name", "parameters"]);
    }
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

  it("ignores the query filter when a capability is named so the capability is always listed", () => {
    // The model often misuses `query` as a search topic (e.g. "Louis Morgner") alongside a
    // capability; the filter must not strip every tool in that case.
    const results = searchRuntimeTools(
      { capability: "exa", query: "Louis Morgner summary" },
      enabled,
    );
    const names = results.map((result) => result.name);
    expect(names).toContain("exa_search");
  });

  it("never returns a tool that is not enabled or not deferrable", () => {
    const results = searchRuntimeTools({}, enabled);
    const names = results.map((result) => result.name);
    expect(names).not.toContain("read_file");
    expect(names).not.toContain("find_tools");
    expect(names.every((name) => isDeferrableRuntimeTool(name) && enabled.includes(name))).toBe(
      true,
    );
  });

  it("discovers update_agent_file by query when self-edit is enabled", () => {
    const selfEditEnabled: RuntimeToolName[] = ["find_tools", "update_agent_file"];
    const results = searchRuntimeTools({ query: "update_agent_file" }, selfEditEnabled);
    const match = results.find((result) => result.name === "update_agent_file");
    expect(match).toBeDefined();
    expect(match?.parameters.type).toBe("object");
  });
});

describe("buildCapabilityDiscovery", () => {
  // Default: everything's credentials are present (so status hinges on enabled/repo only).
  const allCredentialsAvailable = () => true;
  const byId = (results: ReturnType<typeof buildCapabilityDiscovery>) =>
    new Map(results.map((result) => [result.id, result]));

  it("lists only platform/mixed-credential capabilities (excludes workspace-OAuth ones)", () => {
    const results = buildCapabilityDiscovery({
      enabledTools: [],
      hasAttachedRepository: false,
      credentialAvailable: allCredentialsAvailable,
    });
    const ids = results.map((result) => result.id);
    // Platform/mixed hosted + coding capabilities are present...
    expect(ids).toEqual(expect.arrayContaining(["exa", "x", "youtube", "amp", "opencode"]));
    // ...workspace-OAuth capabilities (MCP servers + Google tools) are not discoverable in v1.
    for (const excluded of [
      "linear",
      "slack",
      "posthog",
      "betterstack",
      "braintrust",
      "gmail",
      "google_calendar",
    ]) {
      expect(ids).not.toContain(excluded);
    }
    // The discoverable set is exactly the platform/mixed-credential hosted/coding entries.
    const discoverableIds = AGENT_TOOL_CATALOG.filter(
      (entry) =>
        (entry.type === "hosted_tool" || entry.type === "coding_agent") &&
        (entry.credentialSource === "platform" || entry.credentialSource === "mixed"),
    ).map((entry) => entry.id);
    expect(new Set(ids)).toEqual(new Set(discoverableIds));
  });

  it("marks a capability enabled when any of its runtime tools is enabled", () => {
    const results = buildCapabilityDiscovery({
      enabledTools: ["exa_search"],
      hasAttachedRepository: false,
      credentialAvailable: allCredentialsAvailable,
    });
    expect(byId(results).get("exa")?.status).toBe("enabled");
  });

  it("marks an unenabled capability with present credentials as available, with a how-to-enable hint", () => {
    const results = buildCapabilityDiscovery({
      enabledTools: [],
      hasAttachedRepository: false,
      credentialAvailable: allCredentialsAvailable,
    });
    const exa = byId(results).get("exa");
    expect(exa?.status).toBe("available");
    expect(exa?.reason).toBeUndefined();
    expect(exa?.howToEnable).toBe("add @exa to your behavior");
  });

  it("marks a capability as needs_setup when its platform credential is missing", () => {
    const results = buildCapabilityDiscovery({
      enabledTools: [],
      hasAttachedRepository: true,
      // Only exa's credential is unavailable.
      credentialAvailable: (entry) => entry.id !== "exa",
    });
    const exa = byId(results).get("exa");
    expect(exa?.status).toBe("needs_setup");
    expect(exa?.reason).toContain("EXA_API_KEY");
  });

  it("marks a github-repo-gated capability (amp) as needs_setup when no repository is attached", () => {
    const noRepo = buildCapabilityDiscovery({
      enabledTools: [],
      hasAttachedRepository: false,
      credentialAvailable: allCredentialsAvailable,
    });
    expect(byId(noRepo).get("amp")?.status).toBe("needs_setup");
    expect(byId(noRepo).get("amp")?.reason).toContain("repository");
    // opencode does not require an attached repository, so it stays available.
    expect(byId(noRepo).get("opencode")?.status).toBe("available");

    const withRepo = buildCapabilityDiscovery({
      enabledTools: [],
      hasAttachedRepository: true,
      credentialAvailable: allCredentialsAvailable,
    });
    expect(byId(withRepo).get("amp")?.status).toBe("available");
  });

  it("filters by a case-insensitive query over id, label, and description", () => {
    const results = buildCapabilityDiscovery({
      enabledTools: [],
      hasAttachedRepository: false,
      credentialAvailable: allCredentialsAvailable,
      query: "WEB",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.every(
        (result) =>
          result.id.toLowerCase().includes("web") ||
          result.label.toLowerCase().includes("web") ||
          result.description.toLowerCase().includes("web"),
      ),
    ).toBe(true);
    // exa's description mentions web research.
    expect(results.map((result) => result.id)).toContain("exa");
  });
});
