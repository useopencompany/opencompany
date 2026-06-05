import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getRuntimeToolHelp,
  type RuntimeToolName,
  searchRuntimeTools,
} from "@opencompany/agent-runtime";
import type { RunnerEnv } from "./env";

export type HostedToolUsage = {
  provider: string;
  operation: string;
  providerRequestId?: string;
  costUsdMicros: number;
  rawUsage: Record<string, unknown>;
};

export type HostedToolResult = {
  output: unknown;
  usage?: HostedToolUsage;
};

type HostedToolHandler = {
  execute: (input: {
    args: unknown;
    env: RunnerEnv;
    enabledTools: RuntimeToolName[];
    signal: AbortSignal;
  }) => HostedToolResult | Promise<HostedToolResult>;
  validateEnvironment?: (env: RunnerEnv) => void;
  failureContext?: (input: { args: unknown; error: unknown }) => Record<string, unknown>;
};

type NormalizedExaResult = {
  id?: string;
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  image?: string;
  favicon?: string;
  highlights?: string[];
  summary?: string;
  text?: string;
  extras?: { links?: string[] };
  subpages?: NormalizedExaResult[];
};

type XPost = {
  id?: string;
  text?: string;
  author_id?: string;
  created_at?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  public_metrics?: Record<string, unknown>;
  referenced_tweets?: Array<{ type?: string; id?: string }>;
};

type XUser = {
  id?: string;
  username?: string;
  name?: string;
  description?: string;
  location?: string;
  created_at?: string;
  profile_image_url?: string;
  profile_banner_url?: string;
  protected?: boolean;
  verified?: boolean;
  is_identity_verified?: boolean;
  public_metrics?: Record<string, unknown>;
};

type NormalizedXUser = {
  id: string;
  username: string;
  name?: string;
  description?: string;
  location?: string;
  createdAt?: string;
  profileImageUrl?: string;
  profileBannerUrl?: string;
  protected?: boolean;
  verified?: boolean;
  isIdentityVerified?: boolean;
  metrics?: Record<string, number>;
  url: string;
};

type SupadataSocialPlatform = "tiktok" | "instagram";
type SocialPlatform = SupadataSocialPlatform;
type SocialOperation =
  | "get_profile"
  | "list_profile_posts"
  | "get_post"
  | "get_comments"
  | "search_profiles"
  | "search";
type SocialRunMode = "sync" | "async";

type SocialProviderRequest = {
  platform: SocialPlatform;
  operation: SocialOperation;
  actorId: string;
  input: Record<string, unknown>;
  limit: number;
  sourceUrl?: string | undefined;
  query?: string | undefined;
  runMode: SocialRunMode;
};

type SocialJobPayload = {
  provider: "apify";
  platform: SocialPlatform;
  operation: SocialOperation;
  runId: string;
  limit: number;
  sourceUrl?: string | undefined;
  query?: string | undefined;
};

// Estimated Supadata (YouTube) costs for internal usage tracking; persisted raw usage marks them
// estimated. Supadata bills in credits, not per-call USD, so these are rough per-operation values.
const YOUTUBE_OPERATION_COST_USD_MICROS: Record<string, number> = {
  search: 2_000,
  get_video: 1_000,
  get_transcript: 4_000,
  get_channel: 1_000,
  list_channel_videos: 2_000,
};

const SUPADATA_UNIVERSAL_OPERATION_COST_USD_MICROS: Record<string, number> = {
  get_metadata: 1_000,
  get_transcript: 4_000,
  poll_transcript: 0,
};

const APIFY_ACTORS = {
  instagramProfile: "instagram-scraper/instagram-profile-scraper",
  instagramApi: "apify/instagram-api-scraper",
  tiktokProfile: "clockworks/tiktok-profile-scraper",
  tiktokScraper: "clockworks/tiktok-scraper",
  tiktokComments: "clockworks/tiktok-comments-scraper",
} as const;

const APIFY_OPERATION_COST_USD_MICROS: Record<SocialOperation | "poll_job", number> = {
  get_profile: 2_000,
  list_profile_posts: 8_000,
  get_post: 3_000,
  get_comments: 8_000,
  search_profiles: 6_000,
  search: 6_000,
  poll_job: 0,
};

// Estimated X API read costs for internal usage tracking; persisted raw usage marks them estimated.
const X_POST_READ_COST_USD_MICROS = 5_000;
const X_USER_READ_COST_USD_MICROS = 10_000;
const X_TREND_READ_COST_USD_MICROS = 10_000;
const X_TWEET_FIELDS = [
  "author_id",
  "conversation_id",
  "created_at",
  "in_reply_to_user_id",
  "public_metrics",
  "referenced_tweets",
].join(",");
const X_USER_FIELDS = [
  "created_at",
  "description",
  "is_identity_verified",
  "location",
  "profile_banner_url",
  "profile_image_url",
  "protected",
  "public_metrics",
  "verified",
].join(",");

export class MissingEnvError extends Error {
  constructor(
    readonly envName: string,
    message: string,
  ) {
    super(message);
    this.name = "MissingEnvError";
  }
}

export function getHostedToolFailureContext(input: {
  name: RuntimeToolName;
  args: unknown;
  error: unknown;
}): Record<string, unknown> {
  const handler = HOSTED_TOOL_HANDLERS[input.name];
  if (handler?.failureContext) {
    return handler.failureContext({ args: input.args, error: input.error });
  }

  return {
    tool_error_stage: "unknown",
    tool_error_code: "hosted_tool_failed",
  };
}

export async function executeHostedTool(input: {
  name: RuntimeToolName;
  args: unknown;
  env: RunnerEnv;
  enabledTools: RuntimeToolName[];
  signal: AbortSignal;
}): Promise<HostedToolResult> {
  const handler = HOSTED_TOOL_HANDLERS[input.name];
  if (!handler) throw new Error(`Unknown hosted tool: ${input.name}`);
  return handler.execute(input);
}

export function validateHostedToolEnvironment(input: {
  enabledTools: RuntimeToolName[];
  env: RunnerEnv;
}) {
  for (const tool of input.enabledTools) {
    HOSTED_TOOL_HANDLERS[tool]?.validateEnvironment?.(input.env);
  }
}

const HOSTED_TOOL_HANDLERS: Partial<Record<RuntimeToolName, HostedToolHandler>> = {
  tool_help: {
    execute: ({ args, enabledTools }) => executeToolHelp(args, enabledTools),
  },
  find_tools: {
    execute: ({ args, enabledTools }) => executeToolSearch(args, enabledTools),
  },
  exa_search: {
    execute: ({ args, env, signal }) => executeExaSearch(args, env, signal),
    failureContext: ({ args, error }) => getExaSearchFailureContext(args, error),
    validateEnvironment: (env) => validateExaEnvironment(env, "exa_search"),
  },
  exa_contents: {
    execute: ({ args, env, signal }) => executeExaContents(args, env, signal),
    failureContext: ({ args, error }) => getExaContentsFailureContext(args, error),
    validateEnvironment: (env) => validateExaEnvironment(env, "exa_contents"),
  },
  exa_answer: {
    execute: ({ args, env, signal }) => executeExaAnswer(args, env, signal),
    failureContext: ({ args, error }) => getExaAnswerFailureContext(args, error),
    validateEnvironment: (env) => validateExaEnvironment(env, "exa_answer"),
  },
  x_search_posts: {
    execute: ({ args, env, signal }) => executeXSearchPosts(args, env, signal),
    failureContext: ({ args, error }) => getXFailureContext("search_posts", args, error),
    validateEnvironment: (env) => validateXEnvironment(env, "x_search_posts"),
  },
  x_get_profile: {
    execute: ({ args, env, signal }) => executeXGetProfile(args, env, signal),
    failureContext: ({ args, error }) => getXFailureContext("get_profile", args, error),
    validateEnvironment: (env) => validateXEnvironment(env, "x_get_profile"),
  },
  x_get_user_posts: {
    execute: ({ args, env, signal }) => executeXGetUserPosts(args, env, signal),
    failureContext: ({ args, error }) => getXFailureContext("get_user_posts", args, error),
    validateEnvironment: (env) => validateXEnvironment(env, "x_get_user_posts"),
  },
  x_get_discussion: {
    execute: ({ args, env, signal }) => executeXGetDiscussion(args, env, signal),
    failureContext: ({ args, error }) => getXFailureContext("get_discussion", args, error),
    validateEnvironment: (env) => validateXEnvironment(env, "x_get_discussion"),
  },
  x_get_trends: {
    execute: ({ args, env, signal }) => executeXGetTrends(args, env, signal),
    failureContext: ({ args, error }) => getXFailureContext("get_trends", args, error),
    validateEnvironment: (env) => validateXEnvironment(env, "x_get_trends"),
  },
  youtube_search: {
    execute: ({ args, env, signal }) => executeYoutubeSearch(args, env, signal),
    failureContext: ({ args, error }) => getYoutubeFailureContext("search", args, error),
    validateEnvironment: (env) => validateYoutubeEnvironment(env, "youtube_search"),
  },
  youtube_get_video: {
    execute: ({ args, env, signal }) => executeYoutubeGetVideo(args, env, signal),
    failureContext: ({ args, error }) => getYoutubeFailureContext("get_video", args, error),
    validateEnvironment: (env) => validateYoutubeEnvironment(env, "youtube_get_video"),
  },
  youtube_get_transcript: {
    execute: ({ args, env, signal }) => executeYoutubeGetTranscript(args, env, signal),
    failureContext: ({ args, error }) => getYoutubeFailureContext("get_transcript", args, error),
    validateEnvironment: (env) => validateYoutubeEnvironment(env, "youtube_get_transcript"),
  },
  youtube_get_channel: {
    execute: ({ args, env, signal }) => executeYoutubeGetChannel(args, env, signal),
    failureContext: ({ args, error }) => getYoutubeFailureContext("get_channel", args, error),
    validateEnvironment: (env) => validateYoutubeEnvironment(env, "youtube_get_channel"),
  },
  youtube_list_channel_videos: {
    execute: ({ args, env, signal }) => executeYoutubeListChannelVideos(args, env, signal),
    failureContext: ({ args, error }) =>
      getYoutubeFailureContext("list_channel_videos", args, error),
    validateEnvironment: (env) => validateYoutubeEnvironment(env, "youtube_list_channel_videos"),
  },
  tiktok_get_profile: {
    execute: ({ args, env, signal }) =>
      executeSocialTool("tiktok", "get_profile", args, env, signal),
    failureContext: ({ args, error }) =>
      getSocialFailureContext("tiktok", "get_profile", args, error),
    validateEnvironment: (env) => validateApifyEnvironment(env, "tiktok_get_profile"),
  },
  tiktok_list_profile_posts: {
    execute: ({ args, env, signal }) =>
      executeSocialTool("tiktok", "list_profile_posts", args, env, signal),
    failureContext: ({ args, error }) =>
      getSocialFailureContext("tiktok", "list_profile_posts", args, error),
    validateEnvironment: (env) => validateApifyEnvironment(env, "tiktok_list_profile_posts"),
  },
  tiktok_get_video: {
    execute: ({ args, env, signal }) => executeSocialTool("tiktok", "get_post", args, env, signal),
    failureContext: ({ args, error }) => getSocialFailureContext("tiktok", "get_post", args, error),
    validateEnvironment: (env) => validateApifyEnvironment(env, "tiktok_get_video"),
  },
  tiktok_get_comments: {
    execute: ({ args, env, signal }) =>
      executeSocialTool("tiktok", "get_comments", args, env, signal),
    failureContext: ({ args, error }) =>
      getSocialFailureContext("tiktok", "get_comments", args, error),
    validateEnvironment: (env) => validateApifyEnvironment(env, "tiktok_get_comments"),
  },
  tiktok_search: {
    execute: ({ args, env, signal }) => executeSocialTool("tiktok", "search", args, env, signal),
    failureContext: ({ args, error }) => getSocialFailureContext("tiktok", "search", args, error),
    validateEnvironment: (env) => validateApifyEnvironment(env, "tiktok_search"),
  },
  tiktok_get_metadata: {
    execute: ({ args, env, signal }) =>
      executeSupadataSocialGetMetadata("tiktok", args, env, signal),
    failureContext: ({ args, error }) =>
      getSupadataSocialFailureContext("tiktok", "get_metadata", args, error),
    validateEnvironment: (env) => validateYoutubeEnvironment(env, "tiktok_get_metadata"),
  },
  tiktok_get_transcript: {
    execute: ({ args, env, signal }) =>
      executeSupadataSocialGetTranscript("tiktok", args, env, signal),
    failureContext: ({ args, error }) =>
      getSupadataSocialFailureContext("tiktok", "get_transcript", args, error),
    validateEnvironment: (env) => validateYoutubeEnvironment(env, "tiktok_get_transcript"),
  },
  instagram_get_metadata: {
    execute: ({ args, env, signal }) =>
      executeSupadataSocialGetMetadata("instagram", args, env, signal),
    failureContext: ({ args, error }) =>
      getSupadataSocialFailureContext("instagram", "get_metadata", args, error),
    validateEnvironment: (env) => validateYoutubeEnvironment(env, "instagram_get_metadata"),
  },
  instagram_get_transcript: {
    execute: ({ args, env, signal }) =>
      executeSupadataSocialGetTranscript("instagram", args, env, signal),
    failureContext: ({ args, error }) =>
      getSupadataSocialFailureContext("instagram", "get_transcript", args, error),
    validateEnvironment: (env) => validateYoutubeEnvironment(env, "instagram_get_transcript"),
  },
  instagram_get_profile: {
    execute: ({ args, env, signal }) =>
      executeSocialTool("instagram", "get_profile", args, env, signal),
    failureContext: ({ args, error }) =>
      getSocialFailureContext("instagram", "get_profile", args, error),
    validateEnvironment: (env) => validateApifyEnvironment(env, "instagram_get_profile"),
  },
  instagram_list_profile_posts: {
    execute: ({ args, env, signal }) =>
      executeSocialTool("instagram", "list_profile_posts", args, env, signal),
    failureContext: ({ args, error }) =>
      getSocialFailureContext("instagram", "list_profile_posts", args, error),
    validateEnvironment: (env) => validateApifyEnvironment(env, "instagram_list_profile_posts"),
  },
  instagram_get_post: {
    execute: ({ args, env, signal }) =>
      executeSocialTool("instagram", "get_post", args, env, signal),
    failureContext: ({ args, error }) =>
      getSocialFailureContext("instagram", "get_post", args, error),
    validateEnvironment: (env) => validateApifyEnvironment(env, "instagram_get_post"),
  },
  instagram_get_comments: {
    execute: ({ args, env, signal }) =>
      executeSocialTool("instagram", "get_comments", args, env, signal),
    failureContext: ({ args, error }) =>
      getSocialFailureContext("instagram", "get_comments", args, error),
    validateEnvironment: (env) => validateApifyEnvironment(env, "instagram_get_comments"),
  },
  instagram_search_profiles: {
    execute: ({ args, env, signal }) =>
      executeSocialTool("instagram", "search_profiles", args, env, signal),
    failureContext: ({ args, error }) =>
      getSocialFailureContext("instagram", "search_profiles", args, error),
    validateEnvironment: (env) => validateApifyEnvironment(env, "instagram_search_profiles"),
  },
  social_get_job: {
    execute: ({ args, env, signal }) => executeSocialGetJob(args, env, signal),
    failureContext: ({ args, error }) => getSocialJobFailureContext(args, error),
    validateEnvironment: (env) => validateApifyEnvironment(env, "social_get_job"),
  },
  web_fetch: {
    execute: ({ args, signal }) => executeWebFetch(args, signal),
    failureContext: () => ({
      hosted_provider: "direct_http",
      hosted_operation: "fetch",
      tool_error_stage: "unknown",
      tool_error_code: "hosted_tool_failed",
    }),
  },
};

function validateExaEnvironment(env: RunnerEnv, toolName: RuntimeToolName) {
  if (!env.exaApiKey) {
    throw new MissingEnvError(
      "EXA_API_KEY",
      `The ${toolName} tool is enabled, but EXA_API_KEY is not configured.`,
    );
  }
}

function validateXEnvironment(env: RunnerEnv, toolName: RuntimeToolName) {
  if (!env.xApiBearerToken) {
    throw new MissingEnvError(
      "X_API_BEARER_TOKEN",
      `The ${toolName} tool is enabled, but X_API_BEARER_TOKEN is not configured.`,
    );
  }
}

function validateApifyEnvironment(env: RunnerEnv, toolName: RuntimeToolName) {
  if (!env.apifyApiToken) {
    throw new MissingEnvError(
      "APIFY_API_TOKEN",
      `The ${toolName} tool is enabled, but APIFY_API_TOKEN is not configured.`,
    );
  }
}

function validateYoutubeEnvironment(env: RunnerEnv, toolName: RuntimeToolName) {
  if (!env.supadataApiKey) {
    throw new MissingEnvError(
      "SUPADATA_API_KEY",
      `The ${toolName} tool is enabled, but SUPADATA_API_KEY is not configured.`,
    );
  }
}

function executeToolHelp(args: unknown, enabledTools: RuntimeToolName[]): HostedToolResult {
  const toolName = readString(asRecord(args), "tool");
  const help = getRuntimeToolHelp(toolName, enabledTools);
  if (!help) {
    return {
      output: {
        tool: toolName,
        error: "Tool is not enabled for this session or does not exist.",
        enabledTools,
      },
    };
  }

  return { output: help };
}

function executeToolSearch(args: unknown, enabledTools: RuntimeToolName[]): HostedToolResult {
  const record = asRecord(args);
  // Both are optional in the find_tools schema — omitting them lists every tool. readString throws
  // on a missing key, so use readOptionalString to avoid rejecting a valid capability-only (or
  // argument-less) discovery call.
  const capability = readOptionalString(record, "capability");
  const query = readOptionalString(record, "query");
  const tools = searchRuntimeTools(
    {
      ...(capability ? { capability } : {}),
      ...(query ? { query } : {}),
    },
    enabledTools,
  );
  return {
    output: {
      toolCount: tools.length,
      useTool: "use_tool",
      // Discovery results are compact (no per-tool help). Point the model at tool_help so it can
      // pull a single tool's detailed usage instructions before invoking it via use_tool.
      toolHelp: "tool_help",
      tools,
    },
  };
}

async function executeExaSearch(
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  if (!env.exaApiKey) {
    throw new MissingEnvError("EXA_API_KEY", "EXA_API_KEY is required for exa_search.");
  }

  const request = buildExaSearchRequest(args);
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.exaApiKey,
    },
    body: JSON.stringify(request),
    signal,
  });

  const body = await readJsonResponse(response, "search");
  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.error === "string" ? body.error : response.statusText;
    throw new Error(`Exa search failed (${response.status}): ${message}`);
  }
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new Error("Exa search returned an unexpected response shape.");
  }

  const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
  const searchType = typeof body.searchType === "string" ? body.searchType : request.type;
  const costDollars = readCostDollars(body.costDollars);
  const costUsdMicros = Math.round(costDollars * 1_000_000);

  return {
    output: {
      requestId,
      searchType,
      costDollars,
      results: body.results
        .map((result) => normalizeExaResult(result))
        .slice(0, request.numResults),
    },
    usage: {
      provider: "exa",
      operation: "search",
      ...(requestId ? { providerRequestId: requestId } : {}),
      costUsdMicros,
      rawUsage: {
        requestId,
        searchType,
        costDollars: isRecord(body.costDollars) ? body.costDollars : {},
      },
    },
  };
}

async function executeExaContents(
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  if (!env.exaApiKey) {
    throw new MissingEnvError("EXA_API_KEY", "EXA_API_KEY is required for exa_contents.");
  }

  const request = buildExaContentsRequest(args);
  const response = await fetch("https://api.exa.ai/contents", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.exaApiKey,
    },
    body: JSON.stringify(request.body),
    signal,
  });

  const body = await readJsonResponse(response, "contents");
  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.error === "string" ? body.error : response.statusText;
    throw new Error(`Exa contents failed (${response.status}): ${message}`);
  }
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new Error("Exa contents returned an unexpected response shape.");
  }

  const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
  const costDollars = readCostDollars(body.costDollars);

  return {
    output: omitUndefined({
      requestId,
      costDollars,
      results: body.results.map((result) =>
        normalizeExaResult(result, {
          includeText: request.includeText,
          textMaxCharacters: request.textMaxCharacters,
          includeExtras: request.includeExtras,
          includeSubpages: request.includeSubpages,
        }),
      ),
      statuses: Array.isArray(body.statuses)
        ? body.statuses.map(normalizeExaContentStatus)
        : undefined,
    }),
    usage: {
      provider: "exa",
      operation: "contents",
      ...(requestId ? { providerRequestId: requestId } : {}),
      costUsdMicros: Math.round(costDollars * 1_000_000),
      rawUsage: {
        requestId,
        costDollars: isRecord(body.costDollars) ? body.costDollars : {},
      },
    },
  };
}

async function executeExaAnswer(
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  if (!env.exaApiKey) {
    throw new MissingEnvError("EXA_API_KEY", "EXA_API_KEY is required for exa_answer.");
  }

  const request = buildExaAnswerRequest(args);
  const response = await fetch("https://api.exa.ai/answer", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.exaApiKey,
    },
    body: JSON.stringify(request),
    signal,
  });

  const body = await readJsonResponse(response, "answer");
  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.error === "string" ? body.error : response.statusText;
    throw new Error(`Exa answer failed (${response.status}): ${message}`);
  }
  if (!isRecord(body) || !("answer" in body)) {
    throw new Error("Exa answer returned an unexpected response shape.");
  }

  const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
  const costDollars = readCostDollars(body.costDollars);
  const includeText = Boolean(request.text);

  return {
    output: {
      requestId,
      answer: body.answer,
      costDollars,
      citations: Array.isArray(body.citations)
        ? body.citations.map((citation) =>
            normalizeExaResult(citation, {
              includeText,
              textMaxCharacters: 2500,
            }),
          )
        : [],
    },
    usage: {
      provider: "exa",
      operation: "answer",
      ...(requestId ? { providerRequestId: requestId } : {}),
      costUsdMicros: Math.round(costDollars * 1_000_000),
      rawUsage: {
        requestId,
        costDollars: isRecord(body.costDollars) ? body.costDollars : {},
      },
    },
  };
}

async function executeXSearchPosts(
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  const token = requireXBearerToken(env, "x_search_posts");
  const request = buildXSearchPostsRequest(args);
  const endpoint = request.mode === "all" ? "/tweets/search/all" : "/tweets/search/recent";
  const url = xApiUrl(endpoint, {
    query: request.query,
    max_results: String(request.maxResults),
    ...(request.paginationToken ? { next_token: request.paginationToken } : {}),
    "tweet.fields": X_TWEET_FIELDS,
    expansions: "author_id,referenced_tweets.id,in_reply_to_user_id",
    "user.fields": X_USER_FIELDS,
  });
  const body = await fetchXJsonWithArchiveAccessContext(
    url,
    token,
    signal,
    "search_posts",
    request.mode,
  );
  const normalized = normalizeXPostCollection(body);

  return {
    output: normalized,
    usage: xUsage("search_posts", normalized.usageCounts),
  };
}

async function executeXGetProfile(
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  const token = requireXBearerToken(env, "x_get_profile");
  const username = readXUsername(asRecord(args));
  const url = xApiUrl(`/users/by/username/${encodeURIComponent(username)}`, {
    "user.fields": X_USER_FIELDS,
  });
  const body = await fetchXJson(url, token, signal, "get_profile");
  if (!isRecord(body) || !isRecord(body.data)) {
    throw new Error("X get_profile returned an unexpected response shape.");
  }
  const user = normalizeXUser(body.data);
  if (!user?.id) {
    throw new Error("X get_profile returned an unexpected response shape.");
  }

  return {
    output: { user },
    usage: xUsage("get_profile", { posts: 0, users: 1, trends: 0 }),
  };
}

async function executeXGetUserPosts(
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  const token = requireXBearerToken(env, "x_get_user_posts");
  const request = buildXGetUserPostsRequest(args);
  const user = await fetchXUserByUsername(request.username, token, signal);
  const url = xApiUrl(`/users/${encodeURIComponent(user.id)}/tweets`, {
    max_results: String(request.maxResults),
    ...(request.paginationToken ? { pagination_token: request.paginationToken } : {}),
    ...(request.excludeReplies ? { exclude: "replies" } : {}),
    "tweet.fields": X_TWEET_FIELDS,
    expansions: "author_id,referenced_tweets.id,in_reply_to_user_id",
    "user.fields": X_USER_FIELDS,
  });
  const body = await fetchXJson(url, token, signal, "get_user_posts");
  const normalized = normalizeXPostCollection(body);
  const users = mergeXUsers([user], normalized.users);

  return {
    output: omitUndefined({
      user,
      posts: normalized.posts,
      users,
      meta: normalized.meta,
      nextToken: normalized.nextToken,
    }),
    usage: xUsage("get_user_posts", {
      posts: normalized.usageCounts.posts,
      users: users.length,
      trends: 0,
    }),
  };
}

async function executeXGetDiscussion(
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  const token = requireXBearerToken(env, "x_get_discussion");
  const request = buildXDiscussionRequest(args);
  const targetBody = await fetchXJson(
    xApiUrl(`/tweets/${encodeURIComponent(request.postId)}`, {
      "tweet.fields": X_TWEET_FIELDS,
      expansions: "author_id,referenced_tweets.id,in_reply_to_user_id",
      "user.fields": X_USER_FIELDS,
    }),
    token,
    signal,
    "get_discussion",
  );
  const targetCollection = normalizeXPostCollection(targetBody);
  const targetPost = targetCollection.posts[0];
  if (!targetPost) {
    throw new Error("X get_discussion returned an unexpected response shape.");
  }

  const conversationId = targetPost.conversationId ?? request.postId;
  const searchEndpoint = request.mode === "all" ? "/tweets/search/all" : "/tweets/search/recent";
  const repliesBody = await fetchXJsonWithArchiveAccessContext(
    xApiUrl(searchEndpoint, {
      query: `conversation_id:${conversationId} -is:retweet`,
      max_results: String(request.maxResults),
      "tweet.fields": X_TWEET_FIELDS,
      expansions: "author_id,referenced_tweets.id,in_reply_to_user_id",
      "user.fields": X_USER_FIELDS,
    }),
    token,
    signal,
    "get_discussion",
    request.mode,
  );
  const quotesBody = await fetchXJson(
    xApiUrl(`/tweets/${encodeURIComponent(request.postId)}/quote_tweets`, {
      max_results: String(request.maxResults),
      "tweet.fields": X_TWEET_FIELDS,
      expansions: "author_id,referenced_tweets.id,in_reply_to_user_id",
      "user.fields": X_USER_FIELDS,
    }),
    token,
    signal,
    "get_discussion",
  );
  const replies = normalizeXPostCollection(repliesBody);
  const quotes = normalizeXPostCollection(quotesBody);
  const users = mergeXUsers(targetCollection.users, replies.users, quotes.users);
  const postIds = new Set([
    ...targetCollection.posts.map((post) => post.id),
    ...replies.posts.map((post) => post.id),
    ...quotes.posts.map((post) => post.id),
  ]);

  return {
    output: omitUndefined({
      targetPost,
      conversationId,
      replies: replies.posts.filter((post) => post.id !== targetPost.id),
      quotePosts: quotes.posts,
      users,
      replyMeta: replies.meta,
      quoteMeta: quotes.meta,
    }),
    usage: xUsage("get_discussion", {
      posts: postIds.size,
      users: users.length,
      trends: 0,
    }),
  };
}

async function executeXGetTrends(
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  const token = requireXBearerToken(env, "x_get_trends");
  const request = buildXTrendsRequest(args);
  const body = await fetchXJson(
    xApiUrl(`/trends/by/woeid/${request.woeid}`),
    token,
    signal,
    "get_trends",
  );
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error("X get_trends returned an unexpected response shape.");
  }
  const trends = body.data.map(normalizeXTrend).slice(0, request.maxResults);

  return {
    output: { woeid: request.woeid, trends },
    usage: xUsage("get_trends", { posts: 0, users: 0, trends: trends.length }),
  };
}

async function executeWebFetch(args: unknown, signal: AbortSignal): Promise<HostedToolResult> {
  const request = buildWebFetchRequest(args);
  const response = await fetch(request.url.toString(), {
    headers: {
      Accept: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1",
      "User-Agent": "OpenCompanyAgent/0.2.0 (+https://opencompany.ai)",
    },
    redirect: "follow",
    signal,
  });

  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Web fetch failed (${response.status}): ${response.statusText}`);
  }

  const finalUrl = response.url || request.url.toString();
  const isHtml = /\bhtml\b/i.test(contentType) || looksLikeHtml(body);
  const isText = /^text\//i.test(contentType) || !contentType;
  if (!isHtml && !isText) {
    throw new Error(`Web fetch only supports HTML or text responses, got ${contentType}.`);
  }

  const page = isHtml ? extractHtmlPage(body, finalUrl) : extractTextPage(body);
  const text = truncate(page.text, request.maxCharacters);

  return {
    output: omitUndefined({
      url: request.url.toString(),
      finalUrl,
      status: response.status,
      contentType,
      title: page.title,
      description: page.description,
      text,
      truncated: page.text.length > text.length,
      links: request.includeLinks ? page.links.slice(0, 50) : [],
    }),
    usage: {
      provider: "direct_http",
      operation: "fetch",
      costUsdMicros: 0,
      rawUsage: {
        status: response.status,
        contentType,
        bytesRead: new TextEncoder().encode(body).byteLength,
      },
    },
  };
}

function buildExaSearchRequest(args: unknown) {
  const record = asRecord(args);
  const query = readString(record, "query").trim();
  if (!query) throw new Error("exa_search query must not be empty.");

  const category = readOptionalEnum(record, "category", [
    "company",
    "people",
    "research paper",
    "news",
    "personal site",
    "financial report",
  ]);
  const startPublishedDate = readOptionalString(record, "startPublishedDate");
  const endPublishedDate = readOptionalString(record, "endPublishedDate");
  const includeDomains = readOptionalStringArray(record, "includeDomains");
  const excludeDomains = readOptionalStringArray(record, "excludeDomains");

  if (
    (category === "company" || category === "people") &&
    (excludeDomains.length > 0 || startPublishedDate || endPublishedDate)
  ) {
    throw new Error(
      "Exa company and people category searches do not support excludeDomains or published date filters.",
    );
  }
  if (category === "people" && includeDomains.some((domain) => !isLinkedInDomain(domain))) {
    throw new Error("Exa people category searches only support LinkedIn includeDomains.");
  }

  const numResults = Math.min(Math.max(readOptionalNumber(record, "numResults") ?? 5, 1), 10);
  const fresh = readOptionalBoolean(record, "fresh") ?? false;
  const contents: Record<string, unknown> = { highlights: true };
  if (fresh) contents.maxAgeHours = 0;

  return omitUndefined({
    query,
    type:
      readOptionalEnum(record, "type", [
        "auto",
        "fast",
        "instant",
        "deep-lite",
        "deep",
        "deep-reasoning",
      ]) ?? "auto",
    numResults,
    category,
    includeDomains: nonEmptyArray(includeDomains),
    excludeDomains: nonEmptyArray(excludeDomains),
    startPublishedDate,
    endPublishedDate,
    contents,
  });
}

function buildExaContentsRequest(args: unknown) {
  const record = asRecord(args);
  const urls = readOptionalStringArray(record, "urls");
  if (urls.length === 0) throw new Error("exa_contents urls must include at least one URL.");
  if (urls.length > 10) throw new Error("exa_contents supports a maximum of 10 URLs per call.");
  for (const url of urls) {
    assertHttpUrl(url, "exa_contents urls");
  }

  const mode =
    readOptionalEnum(record, "mode", ["highlights", "text", "summary"] as const) ?? "highlights";
  const query = readOptionalString(record, "query");
  const maxCharacters = readBoundedOptionalInteger(record, "maxCharacters", 500, 30_000);
  const maxAgeHours = readBoundedOptionalInteger(record, "maxAgeHours", -1, 24 * 30);
  const subpages = readBoundedOptionalInteger(record, "subpages", 0, 10);
  const subpageTarget = readOptionalStringArray(record, "subpageTarget");
  const includeLinks = readOptionalBoolean(record, "includeLinks") ?? false;
  const summarySchema = readOptionalObject(record, "summarySchema");
  if (summarySchema && mode !== "summary") {
    throw new Error("exa_contents summarySchema requires mode=summary.");
  }

  const body: Record<string, unknown> = {
    urls,
    ...(maxAgeHours !== undefined ? { maxAgeHours, livecrawlTimeout: 15_000 } : {}),
    ...(subpages !== undefined && subpages > 0 ? { subpages } : {}),
    ...(subpageTarget.length > 0 ? { subpageTarget } : {}),
    ...(includeLinks ? { extras: { links: 20 } } : {}),
  };

  if (mode === "text") {
    body.text = maxCharacters ? { maxCharacters } : true;
  } else if (mode === "summary") {
    body.summary = omitUndefined({
      query,
      schema: summarySchema,
    });
    if (Object.keys(body.summary as Record<string, unknown>).length === 0) body.summary = true;
  } else {
    body.highlights = omitUndefined({
      query,
      ...(maxCharacters ? { maxCharacters } : {}),
    });
    if (Object.keys(body.highlights as Record<string, unknown>).length === 0) {
      body.highlights = true;
    }
  }

  return {
    body,
    includeText: mode === "text",
    textMaxCharacters: maxCharacters ?? 12_000,
    includeExtras: includeLinks,
    includeSubpages: Boolean(subpages && subpages > 0),
  };
}

function buildExaAnswerRequest(args: unknown) {
  const record = asRecord(args);
  const query = readString(record, "query").trim();
  if (!query) throw new Error("exa_answer query must not be empty.");

  return omitUndefined({
    query,
    text: readOptionalBoolean(record, "includeText") || undefined,
    outputSchema: readOptionalObject(record, "outputSchema"),
  });
}

function getExaSearchFailureContext(args: unknown, error: unknown) {
  const record = isRecord(args) ? args : {};
  const category = readOptionalString(record, "category");
  const excludeDomains = readOptionalStringArray(record, "excludeDomains");
  const hasPublishedDateFilter =
    Boolean(readOptionalString(record, "startPublishedDate")) ||
    Boolean(readOptionalString(record, "endPublishedDate"));
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const context: Record<string, unknown> = {
    hosted_provider: "exa",
    hosted_operation: "search",
    tool_error_stage: "unknown",
    tool_error_code: "hosted_tool_failed",
    ...(category ? { exa_category: category } : {}),
    exa_has_exclude_domains: excludeDomains.length > 0,
    exa_has_published_date_filter: hasPublishedDateFilter,
  };

  if (!readOptionalString(record, "query")?.trim()) {
    return {
      ...context,
      tool_error_stage: "request_validation",
      tool_error_code: "exa_invalid_query",
    };
  }

  if (
    (category === "company" || category === "people") &&
    (excludeDomains.length > 0 || hasPublishedDateFilter)
  ) {
    return {
      ...context,
      tool_error_stage: "request_validation",
      tool_error_code: "exa_unsupported_category_filter_combination",
    };
  }

  if (
    category === "people" &&
    readOptionalStringArray(record, "includeDomains").some((domain) => !isLinkedInDomain(domain))
  ) {
    return {
      ...context,
      tool_error_stage: "request_validation",
      tool_error_code: "exa_unsupported_people_domain_filter",
    };
  }

  if (message.startsWith("EXA_API_KEY") || message.includes("EXA_API_KEY is not configured")) {
    return {
      ...context,
      tool_error_stage: "configuration",
      tool_error_code: "exa_missing_api_key",
    };
  }

  if (message.startsWith("Exa search failed (")) {
    return {
      ...context,
      tool_error_stage: "provider_response",
      tool_error_code: "exa_http_error",
      ...readHttpStatusFromMessage(message),
    };
  }

  if (message.includes("unexpected response shape") || message.includes("non-JSON response")) {
    return {
      ...context,
      tool_error_stage: "provider_response",
      tool_error_code: "exa_malformed_response",
    };
  }

  return context;
}

function getExaContentsFailureContext(args: unknown, error: unknown) {
  const record = isRecord(args) ? args : {};
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const context = baseExaFailureContext("contents");

  const urls = readOptionalStringArray(record, "urls");
  if (urls.length === 0 || urls.length > 10) {
    return {
      ...context,
      tool_error_stage: "request_validation",
      tool_error_code: "exa_invalid_urls",
    };
  }

  if (message.includes("summarySchema requires")) {
    return {
      ...context,
      tool_error_stage: "request_validation",
      tool_error_code: "exa_invalid_contents_options",
    };
  }

  return classifySharedExaFailure(message, context, "contents");
}

function getExaAnswerFailureContext(args: unknown, error: unknown) {
  const record = isRecord(args) ? args : {};
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const context = baseExaFailureContext("answer");

  if (!readOptionalString(record, "query")?.trim()) {
    return {
      ...context,
      tool_error_stage: "request_validation",
      tool_error_code: "exa_invalid_query",
    };
  }

  return classifySharedExaFailure(message, context, "answer");
}

function baseExaFailureContext(operation: "contents" | "answer") {
  return {
    hosted_provider: "exa",
    hosted_operation: operation,
    tool_error_stage: "unknown",
    tool_error_code: "hosted_tool_failed",
  };
}

function classifySharedExaFailure(
  message: string,
  context: Record<string, unknown>,
  operation: "contents" | "answer",
) {
  if (message.startsWith("EXA_API_KEY") || message.includes("EXA_API_KEY is not configured")) {
    return {
      ...context,
      tool_error_stage: "configuration",
      tool_error_code: "exa_missing_api_key",
    };
  }

  if (message.startsWith(`Exa ${operation} failed (`)) {
    return {
      ...context,
      tool_error_stage: "provider_response",
      tool_error_code: "exa_http_error",
      ...readHttpStatusFromMessage(message),
    };
  }

  if (message.includes("unexpected response shape") || message.includes("non-JSON response")) {
    return {
      ...context,
      tool_error_stage: "provider_response",
      tool_error_code: "exa_malformed_response",
    };
  }

  return context;
}

function readHttpStatusFromMessage(message: string) {
  const match = message.match(/\((\d{3})\)/);
  return match?.[1] ? { provider_status: Number(match[1]) } : {};
}

function getXFailureContext(operation: string, args: unknown, error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const context: Record<string, unknown> = {
    hosted_provider: "x",
    hosted_operation: operation,
    tool_error_stage: "unknown",
    tool_error_code: "hosted_tool_failed",
  };

  if (message.startsWith("X_API_BEARER_TOKEN") || message.includes("X_API_BEARER_TOKEN")) {
    return {
      ...context,
      tool_error_stage: "configuration",
      tool_error_code: "x_missing_bearer_token",
    };
  }

  if (message.startsWith("X ") && message.includes("must")) {
    return {
      ...context,
      tool_error_stage: "request_validation",
      tool_error_code: "x_invalid_request",
    };
  }
  if (operation === "search_posts" && !readOptionalString(asRecord(args), "query")?.trim()) {
    return {
      ...context,
      tool_error_stage: "request_validation",
      tool_error_code: "x_invalid_request",
    };
  }

  if (message.startsWith(`X ${operation} failed (`)) {
    const status = readHttpStatusFromMessage(message);
    const code = status.provider_status === 429 ? "x_rate_limited" : "x_http_error";
    return {
      ...context,
      tool_error_stage: "provider_response",
      tool_error_code: code,
      ...status,
    };
  }

  if (message.includes("unexpected response shape") || message.includes("non-JSON response")) {
    return {
      ...context,
      tool_error_stage: "provider_response",
      tool_error_code: "x_malformed_response",
    };
  }

  return context;
}

function requireXBearerToken(env: RunnerEnv, toolName: RuntimeToolName) {
  if (!env.xApiBearerToken) {
    throw new MissingEnvError(
      "X_API_BEARER_TOKEN",
      `X_API_BEARER_TOKEN is required for ${toolName}.`,
    );
  }
  return env.xApiBearerToken;
}

function buildXSearchPostsRequest(args: unknown) {
  const record = asRecord(args);
  const query = readString(record, "query").trim();
  if (!query) throw new Error("X search query must not be empty.");
  return {
    query,
    mode: readOptionalEnum(record, "mode", ["recent", "all"] as const) ?? "recent",
    maxResults: readXMaxResults(record, 10, 100, 10),
    paginationToken: readOptionalString(record, "paginationToken"),
  };
}

function buildXGetUserPostsRequest(args: unknown) {
  const record = asRecord(args);
  return {
    username: readXUsername(record),
    maxResults: readXMaxResults(record, 10, 100, 10),
    paginationToken: readOptionalString(record, "paginationToken"),
    excludeReplies: readOptionalBoolean(record, "excludeReplies") ?? false,
  };
}

function buildXDiscussionRequest(args: unknown) {
  const record = asRecord(args);
  return {
    postId: readXPostId(record),
    mode: readOptionalEnum(record, "mode", ["recent", "all"] as const) ?? "recent",
    maxResults: readXMaxResults(record, 10, 100, 10),
  };
}

function buildXTrendsRequest(args: unknown) {
  const record = asRecord(args);
  const rawWoeid = readOptionalNumber(record, "woeid") ?? 1;
  const woeid = Math.floor(rawWoeid);
  if (!Number.isInteger(woeid) || woeid <= 0) {
    throw new Error("X trends woeid must be a positive integer.");
  }
  return {
    woeid,
    maxResults: readXMaxResults(record, 10, 50, 1),
  };
}

function readXMaxResults(
  record: Record<string, unknown>,
  fallback: number,
  max: number,
  min: number,
) {
  const value = readOptionalNumber(record, "maxResults") ?? fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("X maxResults must be a positive number.");
  }
  return Math.min(Math.max(Math.floor(value), min), max);
}

function readXUsername(record: Record<string, unknown>) {
  const username = readString(record, "username").trim().replace(/^@+/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) {
    throw new Error("X username must be 1-15 letters, numbers, or underscores.");
  }
  return username;
}

function readXPostId(record: Record<string, unknown>) {
  const raw = readString(record, "postIdOrUrl").trim();
  const fromUrl = raw.match(/(?:x|twitter)\.com\/[^/]+\/status(?:es)?\/(\d+)/i)?.[1];
  const postId = fromUrl ?? raw;
  if (!/^\d{1,30}$/.test(postId)) {
    throw new Error("X postIdOrUrl must be a post ID or public X status URL.");
  }
  return postId;
}

function xApiUrl(path: string, params: Record<string, string | undefined> = {}) {
  const url = new URL(`https://api.x.com/2${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url;
}

function supadataUrl(path: string, params: Record<string, string | undefined> = {}) {
  const url = new URL(`https://api.supadata.ai/v1${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url;
}

function requireSupadataApiKey(env: RunnerEnv, operation: string, provider = "youtube") {
  if (!env.supadataApiKey) {
    throw new MissingEnvError(
      "SUPADATA_API_KEY",
      `SUPADATA_API_KEY is required for ${provider} ${operation}.`,
    );
  }
  return env.supadataApiKey;
}

async function supadataGet(
  url: URL,
  env: RunnerEnv,
  signal: AbortSignal,
  operation: string,
  options: { provider?: string; providerLabel?: string } = {},
) {
  const provider = options.provider ?? "youtube";
  const providerLabel = options.providerLabel ?? "YouTube";
  const apiKey = requireSupadataApiKey(env, operation, provider);
  const response = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      Accept: "application/json",
    },
    signal,
  });
  const body = await readProviderJsonResponse(response, providerLabel, operation);
  if (!response.ok) {
    const message = providerErrorMessage(body) ?? response.statusText;
    throw new Error(`${providerLabel} ${operation} failed (${response.status}): ${message}`);
  }
  return body;
}

function youtubeUsage(operation: string): HostedToolUsage {
  return {
    provider: "youtube",
    operation,
    costUsdMicros: YOUTUBE_OPERATION_COST_USD_MICROS[operation] ?? 1_000,
    rawUsage: { estimated: true, operation },
  };
}

async function executeYoutubeSearch(
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  const record = asRecord(args);
  const query = readString(record, "query").trim();
  if (!query) throw new Error("YouTube search query must not be empty.");
  const type =
    readOptionalEnum(record, "type", ["all", "video", "channel", "playlist", "movie"] as const) ??
    "video";
  const uploadDate = readOptionalEnum(record, "uploadDate", [
    "all",
    "hour",
    "today",
    "week",
    "month",
    "year",
  ] as const);
  const duration = readOptionalEnum(record, "duration", ["short", "medium", "long"] as const);
  const sortBy =
    readOptionalEnum(record, "sortBy", ["relevance", "rating", "date", "views"] as const) ??
    "relevance";
  const limit = readBoundedOptionalInteger(record, "limit", 1, 50) ?? 10;

  const url = supadataUrl("/youtube/search", {
    query,
    type,
    uploadDate,
    duration,
    sortBy,
    limit: String(limit),
  });
  const body = await supadataGet(url, env, signal, "search");
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new Error("YouTube search returned an unexpected response shape.");
  }

  return {
    output: omitUndefined({
      query,
      results: body.results.slice(0, limit).map(normalizeYoutubeSearchResult),
      nextPageToken: readOptionalString(body, "nextPageToken"),
    }),
    usage: youtubeUsage("search"),
  };
}

async function executeYoutubeGetVideo(
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  const record = asRecord(args);
  const id = readString(record, "id").trim();
  if (!id) throw new Error("YouTube video id must not be empty.");
  const url = supadataUrl("/youtube/video", { id });
  const body = await supadataGet(url, env, signal, "get_video");
  if (!isRecord(body)) {
    throw new Error("YouTube get_video returned an unexpected response shape.");
  }

  return {
    output: { video: normalizeYoutubeVideo(body) },
    usage: youtubeUsage("get_video"),
  };
}

async function executeYoutubeGetTranscript(
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  const record = asRecord(args);
  const videoUrl = readOptionalString(record, "url");
  const videoId = readOptionalString(record, "videoId");
  if (!videoUrl && !videoId) {
    throw new Error("YouTube get_transcript requires either url or videoId.");
  }
  if (videoUrl && videoId) {
    throw new Error("YouTube get_transcript accepts either url or videoId, not both.");
  }
  const lang = readOptionalString(record, "lang");
  const text = readOptionalBoolean(record, "text") ?? true;

  const url = supadataUrl("/transcript", {
    url: videoUrl,
    videoId,
    lang,
    text: text ? "true" : "false",
  });
  const body = await supadataGet(url, env, signal, "get_transcript");
  if (!isRecord(body)) {
    throw new Error("YouTube get_transcript returned an unexpected response shape.");
  }

  const availableLangs = readOptionalStringArray(body, "availableLangs");
  return {
    output: omitUndefined({
      content: body.content,
      lang: readOptionalString(body, "lang"),
      availableLangs: availableLangs.length > 0 ? availableLangs : undefined,
    }),
    usage: youtubeUsage("get_transcript"),
  };
}

async function executeYoutubeGetChannel(
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  const record = asRecord(args);
  const id = readString(record, "id").trim();
  if (!id) throw new Error("YouTube channel id must not be empty.");
  const url = supadataUrl("/youtube/channel", { id });
  const body = await supadataGet(url, env, signal, "get_channel");
  if (!isRecord(body)) {
    throw new Error("YouTube get_channel returned an unexpected response shape.");
  }

  return {
    output: { channel: normalizeYoutubeChannel(body) },
    usage: youtubeUsage("get_channel"),
  };
}

async function executeYoutubeListChannelVideos(
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  const record = asRecord(args);
  const id = readString(record, "id").trim();
  if (!id) throw new Error("YouTube channel id must not be empty.");
  const limit = readBoundedOptionalInteger(record, "limit", 1, 50) ?? 20;
  const url = supadataUrl("/youtube/channel/videos", { id, limit: String(limit) });
  const body = await supadataGet(url, env, signal, "list_channel_videos");
  if (!isRecord(body)) {
    throw new Error("YouTube list_channel_videos returned an unexpected response shape.");
  }

  return {
    output: {
      videoIds: readOptionalStringArray(body, "videoIds").slice(0, limit),
      shortIds: readOptionalStringArray(body, "shortIds").slice(0, limit),
      liveIds: readOptionalStringArray(body, "liveIds").slice(0, limit),
    },
    usage: youtubeUsage("list_channel_videos"),
  };
}

async function executeSocialTool(
  platform: SocialPlatform,
  operation: SocialOperation,
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  const request = buildSocialProviderRequest(platform, operation, args);
  if (request.runMode === "async") {
    const runId = await startApifyRun(request, env, signal);
    return {
      output: {
        status: "processing",
        jobId: encodeSocialJobId(
          {
            provider: "apify",
            platform,
            operation,
            runId,
            limit: request.limit,
            sourceUrl: request.sourceUrl,
            query: request.query,
          },
          env,
        ),
      },
      usage: apifyUsage(platform, operation, request, { asyncStarted: true }),
    };
  }

  const items = await runApifyActorSync(request, env, signal);
  return {
    output: normalizeSocialOutput(request, items),
    usage: apifyUsage(platform, operation, request, { itemsReturned: items.length }),
  };
}

async function executeSocialGetJob(
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  const jobId = readString(asRecord(args), "jobId").trim();
  const job = decodeSocialJobId(jobId, env);
  const body = await apifyGet(
    `/actor-runs/${encodeURIComponent(job.runId)}`,
    env,
    signal,
    "poll_job",
  );
  if (!isRecord(body) || !isRecord(body.data)) {
    throw new Error("Apify poll_job returned an unexpected response shape.");
  }

  const status = readOptionalString(body.data, "status") ?? "UNKNOWN";
  if (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
    return {
      output: { status: "processing", providerStatus: status, jobId },
      usage: apifyUsage(job.platform, "poll_job", undefined, { providerStatus: status }),
    };
  }
  if (status !== "SUCCEEDED") {
    const message =
      readOptionalString(body.data, "statusMessage") ??
      readOptionalString(body.data, "errorMessage") ??
      status;
    throw new Error(`Apify poll_job failed (${status}): ${message}`);
  }

  const items = await apifyGet(
    `/actor-runs/${encodeURIComponent(job.runId)}/dataset/items`,
    env,
    signal,
    "poll_job",
    { clean: "true", format: "json", limit: String(job.limit) },
  );
  if (!Array.isArray(items)) {
    throw new Error("Apify poll_job returned an unexpected dataset shape.");
  }

  const request: SocialProviderRequest = {
    platform: job.platform,
    operation: job.operation,
    actorId: "apify/job-result",
    input: {},
    limit: job.limit,
    sourceUrl: job.sourceUrl,
    query: job.query,
    runMode: "async",
  };
  return {
    output: { status: "completed", ...normalizeSocialOutput(request, items) },
    usage: apifyUsage(job.platform, "poll_job", request, {
      providerStatus: status,
      itemsReturned: items.length,
    }),
  };
}

function buildSocialProviderRequest(
  platform: SocialPlatform,
  operation: SocialOperation,
  args: unknown,
): SocialProviderRequest {
  const record = asRecord(args);
  const limit = readSocialLimit(record, operation);
  const runMode = readOptionalEnum(record, "runMode", ["sync", "async"] as const) ?? "sync";

  if (platform === "instagram") {
    return buildInstagramProviderRequest(operation, record, limit, runMode);
  }
  return buildTikTokProviderRequest(operation, record, limit, runMode);
}

function buildInstagramProviderRequest(
  operation: SocialOperation,
  record: Record<string, unknown>,
  limit: number,
  runMode: SocialRunMode,
): SocialProviderRequest {
  if (operation === "get_profile") {
    const username = readSocialHandle(record, "username", "Instagram", "instagram");
    return {
      platform: "instagram",
      operation,
      actorId: APIFY_ACTORS.instagramProfile,
      input: { instagramUsernames: [username] },
      limit: 1,
      sourceUrl: instagramProfileUrl(username),
      runMode,
    };
  }

  if (operation === "list_profile_posts") {
    const username = readSocialHandle(record, "username", "Instagram", "instagram");
    const sourceUrl = instagramProfileUrl(username);
    return {
      platform: "instagram",
      operation,
      actorId: APIFY_ACTORS.instagramApi,
      input: {
        directUrls: [sourceUrl],
        resultsType: "posts",
        resultsLimit: limit,
        maxResults: limit,
      },
      limit,
      sourceUrl,
      runMode,
    };
  }

  if (operation === "get_post") {
    const sourceUrl = readSocialUrl(record, "url", "Instagram", isInstagramMediaUrl);
    return {
      platform: "instagram",
      operation,
      actorId: APIFY_ACTORS.instagramApi,
      input: { directUrls: [sourceUrl], resultsType: "details", resultsLimit: 1, maxResults: 1 },
      limit: 1,
      sourceUrl,
      runMode,
    };
  }

  if (operation === "get_comments") {
    const sourceUrl = readSocialUrl(record, "url", "Instagram", isInstagramMediaUrl);
    return {
      platform: "instagram",
      operation,
      actorId: APIFY_ACTORS.instagramApi,
      input: {
        directUrls: [sourceUrl],
        resultsType: "comments",
        resultsLimit: limit,
        maxResults: limit,
        maxComments: limit,
        maxReplies: 3,
      },
      limit,
      sourceUrl,
      runMode,
    };
  }

  if (operation === "search_profiles") {
    const query = readSocialQuery(record);
    return {
      platform: "instagram",
      operation,
      actorId: APIFY_ACTORS.instagramApi,
      input: {
        search: query,
        searchType: "user",
        resultsType: "search",
        resultsLimit: limit,
        maxResults: limit,
      },
      limit,
      query,
      runMode,
    };
  }

  throw new Error(`Instagram ${operation} is not supported.`);
}

function buildTikTokProviderRequest(
  operation: SocialOperation,
  record: Record<string, unknown>,
  limit: number,
  runMode: SocialRunMode,
): SocialProviderRequest {
  if (operation === "get_profile") {
    const username = readSocialHandle(record, "username", "TikTok", "tiktok");
    return {
      platform: "tiktok",
      operation,
      actorId: APIFY_ACTORS.tiktokProfile,
      input: { profiles: [username], resultsPerPage: 1, shouldDownloadVideos: false },
      limit: 1,
      sourceUrl: tiktokProfileUrl(username),
      runMode,
    };
  }

  if (operation === "list_profile_posts") {
    const username = readSocialHandle(record, "username", "TikTok", "tiktok");
    const sourceUrl = tiktokProfileUrl(username);
    return {
      platform: "tiktok",
      operation,
      actorId: APIFY_ACTORS.tiktokProfile,
      input: { profiles: [username], resultsPerPage: limit },
      limit,
      sourceUrl,
      runMode,
    };
  }

  if (operation === "get_post") {
    const sourceUrl = readSocialUrl(record, "url", "TikTok", isTikTokVideoUrl);
    return {
      platform: "tiktok",
      operation,
      actorId: APIFY_ACTORS.tiktokScraper,
      input: { postURLs: [sourceUrl], resultsPerPage: 1 },
      limit: 1,
      sourceUrl,
      runMode,
    };
  }

  if (operation === "get_comments") {
    const sourceUrl = readSocialUrl(record, "url", "TikTok", isTikTokVideoUrl);
    return {
      platform: "tiktok",
      operation,
      actorId: APIFY_ACTORS.tiktokComments,
      input: { postURLs: [sourceUrl], commentsPerPost: limit, maxComments: limit },
      limit,
      sourceUrl,
      runMode,
    };
  }

  if (operation === "search") {
    const query = readSocialQuery(record);
    return {
      platform: "tiktok",
      operation,
      actorId: APIFY_ACTORS.tiktokScraper,
      input: { searchQueries: [query], resultsPerPage: limit },
      limit,
      query,
      runMode,
    };
  }

  throw new Error(`TikTok ${operation} is not supported.`);
}

async function executeSupadataSocialGetMetadata(
  platform: SupadataSocialPlatform,
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  const record = asRecord(args);
  const mediaUrl = readString(record, "url").trim();
  assertSupadataPlatformUrl(platform, mediaUrl);

  const body = await supadataGet(
    supadataUrl("/metadata", { url: mediaUrl }),
    env,
    signal,
    "get_metadata",
    {
      provider: platform,
      providerLabel: supadataPlatformLabel(platform),
    },
  );
  if (!isRecord(body)) {
    throw new Error(
      `${supadataPlatformLabel(platform)} get_metadata returned an unexpected response shape.`,
    );
  }

  return {
    output: { metadata: normalizeSupadataMetadata(body) },
    usage: supadataUniversalUsage(platform, "get_metadata"),
  };
}

async function executeSupadataSocialGetTranscript(
  platform: SupadataSocialPlatform,
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  const record = asRecord(args);
  const mediaUrl = readOptionalString(record, "url")?.trim();
  const jobId = readOptionalString(record, "jobId")?.trim();
  if (!mediaUrl && !jobId) {
    throw new Error(
      `${supadataPlatformLabel(platform)} get_transcript requires either url or jobId.`,
    );
  }
  if (mediaUrl && jobId) {
    throw new Error(
      `${supadataPlatformLabel(platform)} get_transcript accepts either url or jobId, not both.`,
    );
  }

  const label = supadataPlatformLabel(platform);
  if (mediaUrl) assertSupadataPlatformUrl(platform, mediaUrl);
  const body = jobId
    ? await supadataGet(
        supadataUrl(`/transcript/${encodeURIComponent(jobId)}`),
        env,
        signal,
        "get_transcript",
        {
          provider: platform,
          providerLabel: label,
        },
      )
    : await supadataGet(
        supadataUrl("/transcript", {
          url: mediaUrl,
          lang: readOptionalString(record, "lang"),
          text: String(readOptionalBoolean(record, "text") ?? true),
          mode: readOptionalEnum(record, "mode", ["native", "auto", "generate"] as const) ?? "auto",
          chunkSize: readOptionalChunkSize(record),
        }),
        env,
        signal,
        "get_transcript",
        { provider: platform, providerLabel: label },
      );

  if (!isRecord(body)) {
    throw new Error(`${label} get_transcript returned an unexpected response shape.`);
  }

  return {
    output: normalizeSupadataTranscript(body),
    usage: supadataUniversalUsage(platform, jobId ? "poll_transcript" : "get_transcript"),
  };
}

function readOptionalChunkSize(record: Record<string, unknown>) {
  const value = readOptionalNumber(record, "chunkSize");
  if (value === undefined) return undefined;
  return String(Math.min(Math.max(Math.floor(value), 50), 10_000));
}

function supadataUniversalUsage(
  platform: SupadataSocialPlatform,
  operation: string,
): HostedToolUsage {
  return {
    provider: platform,
    operation,
    costUsdMicros: SUPADATA_UNIVERSAL_OPERATION_COST_USD_MICROS[operation] ?? 1_000,
    rawUsage: { estimated: true, provider: "supadata", operation },
  };
}

async function runApifyActorSync(
  request: SocialProviderRequest,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<unknown[]> {
  const body = await apifyPost(
    `/acts/${apifyActorPath(request.actorId)}/run-sync-get-dataset-items`,
    request.input,
    env,
    signal,
    request.operation,
    { clean: "true", format: "json", limit: String(request.limit) },
  );
  if (!Array.isArray(body)) {
    throw new Error(`Apify ${request.operation} returned an unexpected dataset shape.`);
  }
  return body.slice(0, request.limit);
}

async function startApifyRun(
  request: SocialProviderRequest,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<string> {
  const body = await apifyPost(
    `/acts/${apifyActorPath(request.actorId)}/runs`,
    request.input,
    env,
    signal,
    request.operation,
  );
  if (!isRecord(body) || !isRecord(body.data)) {
    throw new Error(`Apify ${request.operation} returned an unexpected response shape.`);
  }
  const runId = readOptionalString(body.data, "id");
  if (!runId) {
    throw new Error(`Apify ${request.operation} did not return a run id.`);
  }
  return runId;
}

async function apifyPost(
  path: string,
  input: Record<string, unknown>,
  env: RunnerEnv,
  signal: AbortSignal,
  operation: string,
  params: Record<string, string | undefined> = {},
) {
  const response = await fetch(apifyUrl(path, env, params), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  const body = await readProviderJsonResponse(response, "Apify", operation);
  if (!response.ok) {
    const message = providerErrorMessage(body) ?? response.statusText;
    throw new Error(`Apify ${operation} failed (${response.status}): ${message}`);
  }
  return body;
}

async function apifyGet(
  path: string,
  env: RunnerEnv,
  signal: AbortSignal,
  operation: string,
  params: Record<string, string | undefined> = {},
) {
  const response = await fetch(apifyUrl(path, env, params), {
    headers: { Accept: "application/json" },
    signal,
  });
  const body = await readProviderJsonResponse(response, "Apify", operation);
  if (!response.ok) {
    const message = providerErrorMessage(body) ?? response.statusText;
    throw new Error(`Apify ${operation} failed (${response.status}): ${message}`);
  }
  return body;
}

function apifyUrl(path: string, env: RunnerEnv, params: Record<string, string | undefined> = {}) {
  const token = requireApifyApiToken(env);
  const url = new URL(`https://api.apify.com/v2${path}`);
  url.searchParams.set("token", token);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url;
}

function apifyActorPath(actorId: string) {
  return encodeURIComponent(actorId.replace("/", "~"));
}

function requireApifyApiToken(env: RunnerEnv) {
  if (!env.apifyApiToken) {
    throw new MissingEnvError(
      "APIFY_API_TOKEN",
      "APIFY_API_TOKEN is required for social scraping.",
    );
  }
  return env.apifyApiToken;
}

function normalizeSocialOutput(request: SocialProviderRequest, items: unknown[]) {
  const fetchedAt = new Date().toISOString();
  const base = {
    sourceProvider: "apify",
    sourceUrl: request.sourceUrl,
    fetchedAt,
  };

  if (request.operation === "get_profile") {
    return {
      ...base,
      profile: normalizeSocialProfile(request.platform, items[0], base),
    };
  }

  if (request.operation === "list_profile_posts") {
    const nestedPosts = items.flatMap((item) => readNestedSocialPosts(item));
    const sourceItems = nestedPosts.length > 0 ? nestedPosts : items;
    return {
      ...base,
      posts: sourceItems
        .flatMap((item) => {
          const post = normalizeSocialPost(request.platform, item, base);
          return post ? [post] : [];
        })
        .slice(0, request.limit),
    };
  }

  if (request.operation === "get_post") {
    return {
      ...base,
      post: normalizeSocialPost(request.platform, items[0], base),
    };
  }

  if (request.operation === "get_comments") {
    return {
      ...base,
      comments: items
        .flatMap((item) => {
          const comment = normalizeSocialComment(request.platform, item, base);
          return comment ? [comment] : [];
        })
        .slice(0, request.limit),
    };
  }

  if (request.operation === "search_profiles") {
    return {
      ...base,
      query: request.query,
      profiles: items
        .flatMap((item) => {
          const profile = normalizeSocialProfile(request.platform, item, base);
          return profile ? [profile] : [];
        })
        .slice(0, request.limit),
    };
  }

  return {
    ...base,
    query: request.query,
    posts: items
      .flatMap((item) => {
        const post = normalizeSocialPost(request.platform, item, base);
        return post ? [post] : [];
      })
      .slice(0, request.limit),
  };
}

function normalizeSocialProfile(
  platform: SocialPlatform,
  value: unknown,
  source: { sourceProvider: string; sourceUrl?: string | undefined; fetchedAt: string },
) {
  if (!isRecord(value)) return undefined;
  const username =
    readFirstString(value, ["username", "userName", "uniqueId", "handle"]) ??
    readFirstString(asRecord(value.authorMeta), ["name"]) ??
    readUsernameFromUrl(readFirstString(value, ["url", "profile_url", "profileUrl"]), platform);
  if (!username) return undefined;

  const profileUrl =
    readFirstString(value, ["url", "profile_url", "profileUrl"]) ??
    (platform === "instagram" ? instagramProfileUrl(username) : tiktokProfileUrl(username));
  const bioLinks = readUrlArray(value.bio_links) ?? readUrlArray(value.bioLinks);
  const externalUrl = readFirstString(value, ["external_url", "externalUrl", "website", "bioLink"]);

  return omitUndefined({
    platform,
    id: stringifyId(readFirstValue(value, ["id", "fbid", "eimu_id", "secUid", "sec_uid"])),
    username,
    displayName: readFirstString(value, [
      "full_name",
      "fullName",
      "displayName",
      "nickname",
      "name",
    ]),
    url: profileUrl,
    bio:
      truncate(
        readFirstString(value, ["biography", "bio", "signature", "description"]) ?? "",
        2000,
      ) || undefined,
    verified: readFirstBoolean(value, ["is_verified", "isVerified", "verified"]),
    avatarUrl: readFirstString(value, [
      "profile_pic_url_hd",
      "profile_pic_url",
      "profilePicUrlHD",
      "profilePicUrl",
      "avatarMedium",
      "avatarThumb",
      "avatarUrl",
    ]),
    externalUrls: nonEmptyArray([...(externalUrl ? [externalUrl] : []), ...(bioLinks ?? [])]),
    stats: omitUndefined({
      followers: readFirstNumber(value, ["followers", "followersCount", "followerCount", "fans"]),
      following: readFirstNumber(value, ["following", "followingCount", "followingsCount"]),
      posts: readFirstNumber(value, ["post_count", "postCount", "postsCount", "videoCount"]),
      likes: readFirstNumber(value, ["heart", "heartCount", "likesCount", "totalLikes"]),
    }),
    sourceProvider: source.sourceProvider,
    sourceUrl: source.sourceUrl ?? profileUrl,
    fetchedAt: source.fetchedAt,
  });
}

function normalizeSocialPost(
  platform: SocialPlatform,
  value: unknown,
  source: { sourceProvider: string; sourceUrl?: string | undefined; fetchedAt: string },
) {
  if (!isRecord(value)) return undefined;
  const url =
    readFirstString(value, ["url", "webVideoUrl", "videoUrl", "postUrl"]) ??
    (platform === "instagram" && readFirstString(value, ["shortCode", "shortcode"])
      ? `https://www.instagram.com/p/${readFirstString(value, ["shortCode", "shortcode"])}/`
      : undefined);
  const id = stringifyId(readFirstValue(value, ["id", "shortCode", "shortcode", "awemeId"]));
  if (!id && !url) return undefined;

  const caption =
    readFirstString(value, ["caption", "description", "text", "title"]) ??
    readFirstString(asRecord(value.authorMeta), ["signature"]);
  const hashtags = mergeUniqueStrings(
    readStringList(value.hashtags),
    caption ? Array.from(caption.matchAll(/#([\p{L}\p{N}_]+)/gu), (match) => match[1] ?? "") : [],
  );
  const mentions = mergeUniqueStrings(
    readStringList(value.mentions),
    caption ? Array.from(caption.matchAll(/@([\p{L}\p{N}_.]+)/gu), (match) => match[1] ?? "") : [],
  );

  return omitUndefined({
    platform,
    id,
    url,
    type: normalizeSocialPostType(readFirstString(value, ["type", "productType", "mediaType"])),
    caption: caption ? truncate(caption, 4000) : undefined,
    author: normalizeSocialAuthor(platform, value),
    createdAt: normalizeSocialTimestamp(
      readFirstValue(value, [
        "createdAt",
        "timestamp",
        "taken_at_timestamp",
        "takenAtTimestamp",
        "createTime",
        "createTimeISO",
      ]),
    ),
    stats: omitUndefined({
      views: readFirstNumber(value, ["playCount", "viewCount", "videoViewCount"]),
      likes: readFirstNumber(value, ["likesCount", "likeCount", "diggCount"]),
      comments: readFirstNumber(value, ["commentsCount", "commentCount"]),
      shares: readFirstNumber(value, ["sharesCount", "shareCount"]),
      saves: readFirstNumber(value, ["saveCount", "collectCount"]),
    }),
    media: omitUndefined({
      thumbnailUrl: readFirstString(value, [
        "displayUrl",
        "thumbnailUrl",
        "coverUrl",
        "videoMeta.coverUrl",
      ]),
      videoUrl: readFirstString(value, ["videoUrl", "webVideoUrl"]),
      durationSeconds: readFirstNumber(value, ["duration", "videoMeta.duration"]),
    }),
    hashtags: nonEmptyArray(hashtags),
    mentions: nonEmptyArray(mentions),
    sourceProvider: source.sourceProvider,
    sourceUrl: source.sourceUrl ?? url,
    fetchedAt: source.fetchedAt,
  });
}

function normalizeSocialComment(
  platform: SocialPlatform,
  value: unknown,
  source: { sourceProvider: string; sourceUrl?: string | undefined; fetchedAt: string },
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringifyId(readFirstValue(value, ["id", "cid", "commentId"]));
  const text = readFirstString(value, ["text", "comment", "content"]);
  if (!id && !text) return undefined;
  const replies = Array.isArray(value.replies)
    ? value.replies.flatMap((reply) => {
        const normalized = normalizeSocialComment(platform, reply, source);
        return normalized ? [normalized] : [];
      })
    : undefined;

  return omitUndefined({
    id,
    text: text ? truncate(text, 2000) : undefined,
    createdAt: normalizeSocialTimestamp(
      readFirstValue(value, ["created_at", "createdAt", "createTime"]),
    ),
    author: normalizeSocialAuthor(platform, value),
    stats: omitUndefined({
      likes: readFirstNumber(value, ["likesCount", "likeCount", "diggCount"]),
      replies: readFirstNumber(value, ["repliesCount", "replyCount"]),
    }),
    replies: nonEmptyArray(replies ?? []),
    sourceProvider: source.sourceProvider,
    sourceUrl: source.sourceUrl,
    fetchedAt: source.fetchedAt,
  });
}

function normalizeSocialAuthor(platform: SocialPlatform, value: Record<string, unknown>) {
  const owner = asRecord(value.owner);
  const author = asRecord(value.author);
  const authorMeta = asRecord(value.authorMeta);
  const source =
    Object.keys(owner).length > 0
      ? owner
      : Object.keys(author).length > 0
        ? author
        : Object.keys(authorMeta).length > 0
          ? authorMeta
          : value;
  const username =
    readFirstString(source, ["username", "userName", "name", "uniqueId"]) ??
    readFirstString(value, ["ownerUsername", "authorUsername"]);
  return omitUndefined({
    id: stringifyId(readFirstValue(source, ["id", "secUid", "sec_uid"])),
    username,
    displayName: readFirstString(source, ["full_name", "fullName", "displayName", "nickname"]),
    url: username
      ? platform === "instagram"
        ? instagramProfileUrl(username)
        : tiktokProfileUrl(username)
      : undefined,
    verified: readFirstBoolean(source, ["is_verified", "isVerified", "verified"]),
    avatarUrl: readFirstString(source, [
      "profile_pic_url",
      "profilePicUrl",
      "avatarUrl",
      "avatarMedium",
      "avatarThumb",
    ]),
  });
}

function readNestedSocialPosts(value: unknown) {
  if (!isRecord(value)) return [];
  const candidates = [
    value.latest_posts,
    value.latestPosts,
    value.posts,
    value.videos,
    value.items,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function readSocialLimit(record: Record<string, unknown>, operation: SocialOperation) {
  const fallback =
    operation === "get_comments"
      ? 25
      : operation === "search_profiles" || operation === "search"
        ? 10
        : 12;
  const limit = readBoundedOptionalInteger(record, "limit", 1, 50) ?? fallback;
  return operation === "get_profile" || operation === "get_post" ? 1 : limit;
}

function readSocialHandle(
  record: Record<string, unknown>,
  key: string,
  label: string,
  platform: SocialPlatform,
) {
  const raw = readString(record, key).trim();
  if (!raw) throw new Error(`${label} username must not be empty.`);
  const username = readUsernameFromUrl(raw, platform) ?? raw.replace(/^@+/, "").replace(/\/+$/, "");
  if (!/^[A-Za-z0-9._]{1,100}$/.test(username)) {
    throw new Error(`${label} username must be a username, @handle, or profile URL.`);
  }
  return username;
}

function readSocialQuery(record: Record<string, unknown>) {
  const query = readString(record, "query").trim();
  if (!query) throw new Error("Social search query must not be empty.");
  return query;
}

function readSocialUrl(
  record: Record<string, unknown>,
  key: string,
  label: string,
  predicate: (url: URL) => boolean,
) {
  const raw = readString(record, key).trim();
  if (!raw) throw new Error(`${label} URL must not be empty.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} URL must be an absolute URL.`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !predicate(url)) {
    throw new Error(`${label} URL must be a public direct media URL.`);
  }
  return url.toString();
}

function isInstagramMediaUrl(url: URL) {
  const host = url.hostname.toLowerCase();
  if (!(host === "instagram.com" || host.endsWith(".instagram.com"))) return false;
  return /^\/(p|reel|tv)\//i.test(url.pathname);
}

function isTikTokVideoUrl(url: URL) {
  const host = url.hostname.toLowerCase();
  if (!(host === "tiktok.com" || host.endsWith(".tiktok.com"))) return false;
  return /\/video\/\d+/i.test(url.pathname);
}

function instagramProfileUrl(username: string) {
  return `https://www.instagram.com/${username.replace(/^@+/, "")}/`;
}

function tiktokProfileUrl(username: string) {
  return `https://www.tiktok.com/@${username.replace(/^@+/, "")}`;
}

function readUsernameFromUrl(value: string | undefined, platform: SocialPlatform) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!isSocialProfileHost(url, platform)) return undefined;
    const segment = url.pathname.split("/").filter(Boolean)[0];
    return segment?.replace(/^@+/, "") || undefined;
  } catch {
    return undefined;
  }
}

function isSocialProfileHost(url: URL, platform: SocialPlatform) {
  const host = url.hostname.toLowerCase();
  if (platform === "instagram") {
    return host === "instagram.com" || host.endsWith(".instagram.com");
  }
  return host === "tiktok.com" || host.endsWith(".tiktok.com");
}

function encodeSocialJobId(job: SocialJobPayload, env: RunnerEnv) {
  const body = Buffer.from(JSON.stringify(job), "utf8").toString("base64url");
  return `${body}.${signSocialJobId(body, env)}`;
}

function decodeSocialJobId(jobId: string, env: RunnerEnv): SocialJobPayload {
  if (!jobId) throw new Error("social_get_job jobId must not be empty.");
  try {
    const [body, signature] = jobId.split(".");
    if (!body || !signature || !safeEqual(signature, signSocialJobId(body, env))) {
      throw new Error("invalid social job signature");
    }
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    if (!isRecord(decoded)) throw new Error("not a record");
    const provider = readOptionalString(decoded, "provider");
    const platform = readOptionalEnum(decoded, "platform", ["instagram", "tiktok"] as const);
    const operation = readOptionalEnum(decoded, "operation", [
      "get_profile",
      "list_profile_posts",
      "get_post",
      "get_comments",
      "search_profiles",
      "search",
    ] as const);
    const runId = readOptionalString(decoded, "runId");
    const limit = readBoundedOptionalInteger(decoded, "limit", 1, 50);
    if (provider !== "apify" || !platform || !operation || !runId || !limit) {
      throw new Error("invalid social job payload");
    }
    return {
      provider,
      platform,
      operation,
      runId,
      limit,
      sourceUrl: readOptionalString(decoded, "sourceUrl"),
      query: readOptionalString(decoded, "query"),
    };
  } catch {
    throw new Error("social_get_job jobId is invalid.");
  }
}

function readSocialJobPlatformForContext(jobId: string): SocialPlatform | undefined {
  const [body] = jobId.split(".");
  if (!body) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    if (!isRecord(decoded)) return undefined;
    return readOptionalEnum(decoded, "platform", ["instagram", "tiktok"] as const);
  } catch {
    return undefined;
  }
}

function signSocialJobId(body: string, env: RunnerEnv) {
  return createHmac("sha256", env.streamTokenSecret).update(body).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function apifyUsage(
  platform: SocialPlatform,
  operation: SocialOperation | "poll_job",
  request?: SocialProviderRequest,
  extra: Record<string, unknown> = {},
): HostedToolUsage {
  return {
    provider: platform,
    operation,
    costUsdMicros: APIFY_OPERATION_COST_USD_MICROS[operation] ?? 1_000,
    rawUsage: omitUndefined({
      estimated: true,
      provider: "apify",
      actorId: request?.actorId,
      operation,
      ...extra,
    }),
  };
}

function normalizeYoutubeSearchResult(value: unknown) {
  const record = asRecord(value);
  const channel = isRecord(record.channel)
    ? omitUndefined({
        id: readOptionalString(record.channel, "id"),
        name: readOptionalString(record.channel, "name"),
      })
    : undefined;
  return omitUndefined({
    type: readOptionalString(record, "type"),
    id: readOptionalString(record, "id"),
    title: readOptionalString(record, "title"),
    description: readOptionalString(record, "description"),
    thumbnail: readOptionalString(record, "thumbnail"),
    duration: readOptionalNumber(record, "duration"),
    viewCount: readOptionalNumber(record, "viewCount"),
    uploadDate: readOptionalString(record, "uploadDate"),
    subscriberCount: readOptionalNumber(record, "subscriberCount"),
    videoCount: readOptionalNumber(record, "videoCount"),
    channel,
  });
}

function normalizeYoutubeVideo(value: unknown) {
  const record = asRecord(value);
  const channel = isRecord(record.channel)
    ? omitUndefined({
        id: readOptionalString(record.channel, "id"),
        name: readOptionalString(record.channel, "name"),
      })
    : undefined;
  return omitUndefined({
    id: readOptionalString(record, "id"),
    title: readOptionalString(record, "title"),
    description: readOptionalString(record, "description"),
    duration: readOptionalNumber(record, "duration"),
    thumbnail: readOptionalString(record, "thumbnail"),
    uploadDate: readOptionalString(record, "uploadDate"),
    viewCount: readOptionalNumber(record, "viewCount"),
    likeCount: readOptionalNumber(record, "likeCount"),
    tags: nonEmptyArray(readOptionalStringArray(record, "tags")),
    transcriptLanguages: nonEmptyArray(readOptionalStringArray(record, "transcriptLanguages")),
    channel,
  });
}

function normalizeYoutubeChannel(value: unknown) {
  const record = asRecord(value);
  return omitUndefined({
    id: readOptionalString(record, "id"),
    name: readOptionalString(record, "name"),
    description: readOptionalString(record, "description"),
    subscriberCount: readOptionalNumber(record, "subscriberCount"),
    videoCount: readOptionalNumber(record, "videoCount"),
    viewCount: readOptionalNumber(record, "viewCount"),
    thumbnail: readOptionalString(record, "thumbnail"),
    banner: readOptionalString(record, "banner"),
  });
}

function normalizeSupadataMetadata(value: unknown) {
  const record = asRecord(value);
  return omitUndefined({
    platform: readOptionalString(record, "platform"),
    type: readOptionalString(record, "type"),
    id: readOptionalString(record, "id"),
    url: readOptionalString(record, "url"),
    title: readOptionalString(record, "title"),
    description: readOptionalString(record, "description"),
    author: normalizeSupadataAuthor(record.author),
    stats: normalizeSupadataStats(record.stats),
    media: readOptionalObject(record, "media"),
    tags: nonEmptyArray(readOptionalStringArray(record, "tags")),
    createdAt: readOptionalString(record, "createdAt"),
    additionalData: readOptionalObject(record, "additionalData"),
  });
}

function normalizeSupadataAuthor(value: unknown) {
  if (!isRecord(value)) return undefined;
  return omitUndefined({
    displayName: readOptionalString(value, "displayName"),
    username: readOptionalString(value, "username"),
    avatarUrl: readOptionalString(value, "avatarUrl"),
    verified: readOptionalBoolean(value, "verified"),
  });
}

function normalizeSupadataStats(value: unknown) {
  if (!isRecord(value)) return undefined;
  return omitUndefined({
    views: readOptionalNumber(value, "views"),
    likes: readOptionalNumber(value, "likes"),
    comments: readOptionalNumber(value, "comments"),
    shares: readOptionalNumber(value, "shares"),
  });
}

function normalizeSupadataTranscript(record: Record<string, unknown>) {
  const jobId = readOptionalString(record, "jobId");
  if (jobId) {
    return { status: "processing", jobId };
  }

  const status = readOptionalString(record, "status");
  const availableLangs = readOptionalStringArray(record, "availableLangs");
  return omitUndefined({
    status,
    content: record.content,
    lang: readOptionalString(record, "lang"),
    availableLangs: availableLangs.length > 0 ? availableLangs : undefined,
    error: readOptionalObject(record, "error"),
  });
}

function getYoutubeFailureContext(operation: string, args: unknown, error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const context: Record<string, unknown> = {
    hosted_provider: "youtube",
    hosted_operation: operation,
    tool_error_stage: "unknown",
    tool_error_code: "hosted_tool_failed",
  };

  if (message.includes("SUPADATA_API_KEY")) {
    return {
      ...context,
      tool_error_stage: "configuration",
      tool_error_code: "youtube_missing_api_key",
    };
  }

  if (
    message.startsWith("YouTube") &&
    (message.includes("requires") ||
      message.includes("accepts either") ||
      message.includes("must not be empty"))
  ) {
    return {
      ...context,
      tool_error_stage: "request_validation",
      tool_error_code: "youtube_invalid_request",
    };
  }

  if (message.startsWith("YouTube") && message.includes("failed (")) {
    const status = readHttpStatusFromMessage(message);
    return {
      ...context,
      tool_error_stage: "provider_response",
      tool_error_code:
        status.provider_status === 404
          ? "youtube_not_found"
          : status.provider_status === 429
            ? "youtube_rate_limited"
            : "youtube_http_error",
      ...status,
    };
  }

  if (message.includes("unexpected response shape") || message.includes("non-JSON response")) {
    return {
      ...context,
      tool_error_stage: "provider_response",
      tool_error_code: "youtube_malformed_response",
    };
  }

  return context;
}

function getSupadataSocialFailureContext(
  platform: SupadataSocialPlatform,
  operation: string,
  args: unknown,
  error: unknown,
) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const label = supadataPlatformLabel(platform);
  const context: Record<string, unknown> = {
    hosted_provider: platform,
    hosted_operation: operation,
    tool_error_stage: "unknown",
    tool_error_code: "hosted_tool_failed",
  };

  if (message.includes("SUPADATA_API_KEY")) {
    return {
      ...context,
      tool_error_stage: "configuration",
      tool_error_code: `${platform}_missing_api_key`,
    };
  }

  if (
    message.startsWith(label) &&
    (message.includes("requires") ||
      message.includes("accepts either") ||
      message.includes("must") ||
      message.includes("URL"))
  ) {
    return {
      ...context,
      tool_error_stage: "request_validation",
      tool_error_code: `${platform}_invalid_request`,
    };
  }

  if (operation === "get_metadata" && !readOptionalString(asRecord(args), "url")?.trim()) {
    return {
      ...context,
      tool_error_stage: "request_validation",
      tool_error_code: `${platform}_invalid_request`,
    };
  }

  if (message.startsWith(label) && message.includes("failed (")) {
    const status = readHttpStatusFromMessage(message);
    return {
      ...context,
      tool_error_stage: "provider_response",
      tool_error_code:
        status.provider_status === 404
          ? `${platform}_not_found`
          : status.provider_status === 429
            ? `${platform}_rate_limited`
            : `${platform}_http_error`,
      ...status,
    };
  }

  if (message.includes("unexpected response shape") || message.includes("non-JSON response")) {
    return {
      ...context,
      tool_error_stage: "provider_response",
      tool_error_code: `${platform}_malformed_response`,
    };
  }

  return context;
}

function getSocialFailureContext(
  platform: SocialPlatform,
  operation: SocialOperation | "poll_job",
  _args: unknown,
  error: unknown,
) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const context: Record<string, unknown> = {
    hosted_provider: platform,
    hosted_operation: operation,
    social_provider: "apify",
    tool_error_stage: "unknown",
    tool_error_code: "hosted_tool_failed",
  };

  if (message.includes("APIFY_API_TOKEN")) {
    return {
      ...context,
      tool_error_stage: "configuration",
      tool_error_code: `${platform}_missing_apify_api_token`,
    };
  }

  if (
    message.includes("username") ||
    message.includes("URL") ||
    message.includes("query") ||
    message.includes("not supported")
  ) {
    return {
      ...context,
      tool_error_stage: "request_validation",
      tool_error_code: `${platform}_invalid_request`,
    };
  }

  if (message.startsWith("Apify") && message.includes("failed (")) {
    const status = readHttpStatusFromMessage(message);
    return {
      ...context,
      tool_error_stage: "provider_response",
      tool_error_code:
        status.provider_status === 404
          ? `${platform}_not_found`
          : status.provider_status === 429
            ? `${platform}_rate_limited`
            : `${platform}_http_error`,
      ...status,
    };
  }

  if (message.includes("unexpected") || message.includes("non-JSON response")) {
    return {
      ...context,
      tool_error_stage: "provider_response",
      tool_error_code: `${platform}_malformed_response`,
    };
  }

  return context;
}

function getSocialJobFailureContext(args: unknown, error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const platform =
    readSocialJobPlatformForContext(readOptionalString(asRecord(args), "jobId") ?? "") ??
    "instagram";
  if (message.includes("jobId")) {
    return {
      hosted_provider: platform,
      hosted_operation: "poll_job",
      social_provider: "apify",
      tool_error_stage: "request_validation",
      tool_error_code: "social_invalid_job_id",
    };
  }
  return getSocialFailureContext(platform, "poll_job", args, error);
}

function assertSupadataPlatformUrl(platform: SupadataSocialPlatform, rawUrl: string) {
  if (!rawUrl) {
    throw new Error(`${supadataPlatformLabel(platform)} URL must not be empty.`);
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${supadataPlatformLabel(platform)} URL must be an absolute URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${supadataPlatformLabel(platform)} URL must use http or https.`);
  }

  const host = url.hostname.toLowerCase();
  const valid =
    platform === "tiktok"
      ? host === "tiktok.com" || host.endsWith(".tiktok.com")
      : host === "instagram.com" ||
        host.endsWith(".instagram.com") ||
        host === "instagr.am" ||
        host.endsWith(".instagr.am");
  if (!valid) {
    throw new Error(
      `${supadataPlatformLabel(platform)} URL must be a public ${supadataPlatformLabel(platform)} URL.`,
    );
  }
  assertSupadataMediaUrl(platform, url);
}

function supadataPlatformLabel(platform: SupadataSocialPlatform) {
  return platform === "tiktok" ? "TikTok" : "Instagram";
}

function assertSupadataMediaUrl(platform: SupadataSocialPlatform, url: URL) {
  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (platform === "tiktok") {
    const firstSegment = segments[0];
    const isProfileUrl =
      firstSegment?.startsWith("@") && (segments.length === 1 || segments[1] !== "video");
    if (isProfileUrl) {
      throw new Error(
        "TikTok URL must be a direct video URL. TikTok profile handles and profile URLs are not supported by the Supadata integration.",
      );
    }
    return;
  }

  const isInstagramProfileUrl =
    segments.length === 1 ||
    (segments.length >= 2 && ["reels", "tagged"].includes(segments[1]?.toLowerCase() ?? ""));
  if (isInstagramProfileUrl) {
    throw new Error(
      "Instagram URL must be a direct post, reel, or video URL. Instagram profile handles and profile URLs are not supported by the Supadata integration.",
    );
  }
}

async function fetchXUserByUsername(username: string, token: string, signal: AbortSignal) {
  const body = await fetchXJson(
    xApiUrl(`/users/by/username/${encodeURIComponent(username)}`, {
      "user.fields": X_USER_FIELDS,
    }),
    token,
    signal,
    "get_profile",
  );
  if (!isRecord(body) || !isRecord(body.data)) {
    throw new Error("X get_profile returned an unexpected response shape.");
  }
  const user = normalizeXUser(body.data);
  if (!user?.id) {
    throw new Error("X get_profile returned an unexpected response shape.");
  }
  return user;
}

async function fetchXJson(url: URL, bearerToken: string, signal: AbortSignal, operation: string) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept: "application/json",
    },
    signal,
  });
  const body = await readProviderJsonResponse(response, "X", operation);
  if (!response.ok) {
    const message = providerErrorMessage(body) ?? response.statusText;
    throw new Error(`X ${operation} failed (${response.status}): ${message}`);
  }
  return body;
}

async function fetchXJsonWithArchiveAccessContext(
  url: URL,
  bearerToken: string,
  signal: AbortSignal,
  operation: string,
  mode: "recent" | "all",
) {
  try {
    return await fetchXJson(url, bearerToken, signal, operation);
  } catch (error) {
    if (
      mode === "all" &&
      error instanceof Error &&
      error.message.startsWith(`X ${operation} failed (403)`)
    ) {
      throw new Error(
        `${error.message} mode="all" uses X full-archive search and requires elevated API access. Retry with mode="recent" unless older posts are required and the token has that access.`,
      );
    }
    throw error;
  }
}

async function readProviderJsonResponse(response: Response, provider: string, operation: string) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${provider} ${operation} returned non-JSON response (${response.status}).`);
  }
}

function providerErrorMessage(body: unknown) {
  if (!isRecord(body)) return undefined;
  if (typeof body.detail === "string") return body.detail;
  if (typeof body.title === "string") return body.title;
  if (Array.isArray(body.errors)) {
    const first = body.errors.find(isRecord);
    if (typeof first?.detail === "string") return first.detail;
    if (typeof first?.message === "string") return first.message;
    if (typeof first?.title === "string") return first.title;
  }
  if (Array.isArray(body.error) && typeof body.error[0] === "string") return body.error[0];
  if (typeof body.error === "string") return body.error;
  return undefined;
}

function normalizeXPostCollection(body: unknown) {
  if (!isRecord(body)) {
    throw new Error("X posts returned an unexpected response shape.");
  }
  const data = Array.isArray(body.data) ? body.data : isRecord(body.data) ? [body.data] : [];
  const includes = isRecord(body.includes) ? body.includes : {};
  const includedUsers = Array.isArray(includes.users)
    ? includes.users.flatMap((user) => {
        const normalized = normalizeXUser(user);
        return normalized ? [normalized] : [];
      })
    : [];
  const usersById = new Map(includedUsers.map((user) => [user.id, user]));
  const posts = data.flatMap((post) => {
    const normalized = normalizeXPost(post, usersById);
    return normalized ? [normalized] : [];
  });
  const meta = normalizeXMeta(body.meta);
  const nextToken = isRecord(body.meta) ? readOptionalString(body.meta, "next_token") : undefined;

  return {
    posts,
    users: includedUsers,
    meta,
    nextToken,
    usageCounts: {
      posts: posts.length,
      users: includedUsers.length,
      trends: 0,
    },
  };
}

function normalizeXPost(value: unknown, usersById: Map<string, NormalizedXUser>) {
  if (!isRecord(value)) return null;
  const post = value as XPost;
  if (!post.id || !post.text) return null;
  const author = post.author_id ? usersById.get(post.author_id) : undefined;
  return omitUndefined({
    id: post.id,
    url: author?.username ? `https://x.com/${author.username}/status/${post.id}` : undefined,
    text: truncate(post.text, 4000),
    createdAt: post.created_at,
    author: author
      ? {
          id: author.id,
          username: author.username,
          name: author.name,
          verified: author.verified,
          isIdentityVerified: author.isIdentityVerified,
        }
      : post.author_id
        ? { id: post.author_id }
        : undefined,
    metrics: normalizeMetricObject(post.public_metrics),
    conversationId: post.conversation_id,
    inReplyToUserId: post.in_reply_to_user_id,
    referencedPosts: Array.isArray(post.referenced_tweets)
      ? post.referenced_tweets.flatMap((reference) =>
          reference.id && reference.type ? [{ type: reference.type, id: reference.id }] : [],
        )
      : undefined,
  });
}

function normalizeXUser(value: unknown): NormalizedXUser | null {
  if (!isRecord(value)) return null;
  const user = value as XUser;
  if (!user.id || !user.username) return null;
  return omitUndefined({
    id: user.id,
    username: user.username,
    name: user.name,
    description: user.description ? truncate(user.description, 1000) : undefined,
    location: user.location,
    createdAt: user.created_at,
    profileImageUrl: user.profile_image_url,
    profileBannerUrl: user.profile_banner_url,
    protected: typeof user.protected === "boolean" ? user.protected : undefined,
    verified: typeof user.verified === "boolean" ? user.verified : undefined,
    isIdentityVerified:
      typeof user.is_identity_verified === "boolean" ? user.is_identity_verified : undefined,
    metrics: normalizeMetricObject(user.public_metrics),
    url: `https://x.com/${user.username}`,
  });
}

function normalizeXTrend(value: unknown) {
  const record = asRecord(value);
  const name =
    readOptionalString(record, "trend_name") ??
    readOptionalString(record, "name") ??
    readOptionalString(record, "query");
  return omitUndefined({
    name,
    postCount:
      readOptionalNumber(record, "tweet_count") ?? readOptionalNumber(record, "post_count"),
    url: name ? `https://x.com/search?q=${encodeURIComponent(name)}&src=trend_click` : undefined,
  });
}

function normalizeMetricObject(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  return omitUndefined({
    retweetCount: readOptionalNumber(value, "retweet_count"),
    replyCount: readOptionalNumber(value, "reply_count"),
    likeCount: readOptionalNumber(value, "like_count"),
    quoteCount: readOptionalNumber(value, "quote_count"),
    bookmarkCount: readOptionalNumber(value, "bookmark_count"),
    impressionCount: readOptionalNumber(value, "impression_count"),
    followersCount: readOptionalNumber(value, "followers_count"),
    followingCount: readOptionalNumber(value, "following_count"),
    postCount: readOptionalNumber(value, "tweet_count"),
    listedCount: readOptionalNumber(value, "listed_count"),
  });
}

function normalizeXMeta(value: unknown) {
  if (!isRecord(value)) return undefined;
  return omitUndefined({
    resultCount: readOptionalNumber(value, "result_count"),
    newestId: readOptionalString(value, "newest_id"),
    oldestId: readOptionalString(value, "oldest_id"),
  });
}

function mergeXUsers(...groups: NormalizedXUser[][]) {
  const users = new Map<string, NormalizedXUser>();
  for (const group of groups) {
    for (const user of group) {
      users.set(user.id, user);
    }
  }
  return Array.from(users.values());
}

function xUsage(
  operation: string,
  counts: { posts: number; users: number; trends: number },
): HostedToolUsage {
  return {
    provider: "x",
    operation,
    costUsdMicros:
      counts.posts * X_POST_READ_COST_USD_MICROS +
      counts.users * X_USER_READ_COST_USD_MICROS +
      counts.trends * X_TREND_READ_COST_USD_MICROS,
    rawUsage: {
      estimated: true,
      postsRead: counts.posts,
      usersRead: counts.users,
      trendsRead: counts.trends,
      unitCostsUsdMicros: {
        postRead: X_POST_READ_COST_USD_MICROS,
        userRead: X_USER_READ_COST_USD_MICROS,
        trendRead: X_TREND_READ_COST_USD_MICROS,
      },
    },
  };
}

function buildWebFetchRequest(args: unknown) {
  const record = asRecord(args);
  const rawUrl = readString(record, "url").trim();
  if (!rawUrl) throw new Error("web_fetch url must not be empty.");

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("web_fetch url must be a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web_fetch only supports http and https URLs.");
  }

  return {
    url,
    maxCharacters: Math.min(
      Math.max(Math.floor(readOptionalNumber(record, "maxCharacters") ?? 12_000), 1000),
      20_000,
    ),
    includeLinks: readOptionalBoolean(record, "includeLinks") ?? true,
  };
}

async function readJsonResponse(response: Response, operation: string) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Exa ${operation} returned non-JSON response (${response.status}).`);
  }
}

function normalizeExaResult(
  value: unknown,
  options: {
    includeText?: boolean;
    textMaxCharacters?: number;
    includeExtras?: boolean;
    includeSubpages?: boolean;
  } = {},
): NormalizedExaResult {
  const record = asRecord(value);
  return omitUndefined({
    id: readOptionalString(record, "id"),
    title: readOptionalString(record, "title"),
    url: readOptionalString(record, "url"),
    publishedDate: readOptionalString(record, "publishedDate"),
    author: readOptionalString(record, "author"),
    image: readOptionalString(record, "image"),
    favicon: readOptionalString(record, "favicon"),
    highlights: nonEmptyArray(
      readOptionalStringArray(record, "highlights").map((highlight) => truncate(highlight, 1000)),
    ),
    summary: truncate(readOptionalString(record, "summary") ?? "", 1500) || undefined,
    text:
      options.includeText && typeof record.text === "string"
        ? truncate(record.text, options.textMaxCharacters ?? 12_000)
        : undefined,
    extras:
      options.includeExtras && isRecord(record.extras)
        ? normalizeExaExtras(record.extras)
        : undefined,
    subpages:
      options.includeSubpages && Array.isArray(record.subpages)
        ? record.subpages.map((subpage) => normalizeExaResult(subpage))
        : undefined,
  });
}

function normalizeExaContentStatus(value: unknown) {
  const record = asRecord(value);
  const error = record.error;
  return omitUndefined({
    id: readOptionalString(record, "id"),
    url: readOptionalString(record, "url"),
    status: readOptionalString(record, "status"),
    error:
      typeof error === "string"
        ? error
        : isRecord(error)
          ? omitUndefined({
              tag: readOptionalString(error, "tag"),
              httpStatusCode:
                typeof error.httpStatusCode === "number" ? error.httpStatusCode : undefined,
            })
          : undefined,
  });
}

function normalizeExaExtras(value: Record<string, unknown>) {
  return omitUndefined({
    links: Array.isArray(value.links)
      ? value.links.flatMap((link) => (typeof link === "string" ? [link] : [])).slice(0, 50)
      : undefined,
  });
}

function extractHtmlPage(html: string, baseUrl: string) {
  const title = extractTagText(html, "title");
  const description = extractMetaContent(html, ["description", "og:description"]);

  return {
    title: title ? truncate(title, 300) : undefined,
    description: description ? truncate(description, 500) : undefined,
    text: htmlToReadableText(html),
    links: extractLinks(html, baseUrl),
  };
}

function extractTextPage(text: string) {
  return {
    title: undefined,
    description: undefined,
    text: normalizeWhitespace(text),
    links: [] as Array<{ text: string; url: string }>,
  };
}

function looksLikeHtml(text: string) {
  return /<(html|head|body|title|main|article|section|p|a)\b/i.test(text.slice(0, 5000));
}

function extractTagText(html: string, tagName: string) {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(`<${escapedTagName}\\b[^>]*>([\\s\\S]*?)</${escapedTagName}>`, "i"),
  );
  return match ? normalizeWhitespace(decodeHtmlEntities(stripTags(match[1] ?? ""))) : undefined;
}

function extractMetaContent(html: string, names: string[]) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const name = (attrs.name ?? attrs.property ?? "").toLowerCase();
    const content = attrs.content;
    if (content && names.includes(name)) {
      return normalizeWhitespace(decodeHtmlEntities(content));
    }
  }
  return undefined;
}

function extractLinks(html: string, baseUrl: string) {
  const links: Array<{ text: string; url: string }> = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = parseAttributes(match[1] ?? "");
    if (!attrs.href) continue;

    const url = toAbsoluteHttpUrl(attrs.href, baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const label = normalizeWhitespace(decodeHtmlEntities(stripTags(match[2] ?? "")));
    links.push({
      text: truncate(label || url, 200),
      url,
    });
    if (links.length >= 100) break;
  }

  return links;
}

function toAbsoluteHttpUrl(rawHref: string, baseUrl: string) {
  const href = decodeHtmlEntities(rawHref).trim();
  if (!href || href.startsWith("#")) return undefined;

  try {
    const url = new URL(href, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function htmlToReadableText(html: string) {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const withoutHidden = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|template)\b[\s\S]*?<\/\1>/gi, " ");
  const withBreaks = withoutHidden
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(
      /<\/(p|div|li|tr|td|th|h[1-6]|section|article|header|footer|nav|main|aside|blockquote|pre)>/gi,
      "\n",
    );

  return normalizeWhitespace(decodeHtmlEntities(stripTags(withBreaks)));
}

function stripTags(value: string) {
  return value.replace(/<[^>]+>/g, " ");
}

function parseAttributes(tag: string) {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([^\s"'<>/=]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const name = match[1]?.toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? "";
    if (name) attrs[name] = decodeHtmlEntities(value);
  }
  return attrs;
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (_entity, raw: string) => {
      if (raw.startsWith("#x")) {
        const codePoint = Number.parseInt(raw.slice(2), 16);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
      }
      if (raw.startsWith("#")) {
        const codePoint = Number.parseInt(raw.slice(1), 10);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
      }

      return (
        {
          amp: "&",
          apos: "'",
          gt: ">",
          lt: "<",
          nbsp: " ",
          quot: '"',
        }[raw.toLowerCase()] ?? `&${raw};`
      );
    })
    .replace(/\u00a0/g, " ");
}

function normalizeWhitespace(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readCostDollars(value: unknown) {
  if (!isRecord(value)) return 0;
  const total = value.total;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Tool argument ${key} must be a string.`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readOptionalNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readBoundedOptionalInteger(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
) {
  const value = readOptionalNumber(record, key);
  if (value === undefined) return undefined;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function readOptionalObject(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readOptionalStringArray(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
}

function nonEmptyArray<T>(value: T[]) {
  return value.length > 0 ? value : undefined;
}

function readOptionalEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
) {
  const value = record[key];
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : undefined;
}

function readFirstValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = readPathValue(record, key);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function readFirstString(record: Record<string, unknown>, keys: string[]) {
  const value = readFirstValue(record, keys);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readFirstNumber(record: Record<string, unknown>, keys: string[]) {
  const value = readFirstValue(record, keys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readFirstBoolean(record: Record<string, unknown>, keys: string[]) {
  const value = readFirstValue(record, keys);
  return typeof value === "boolean" ? value : undefined;
}

function readPathValue(record: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = record;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function stringifyId(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function readStringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim().replace(/^#/, "")];
    if (isRecord(item)) {
      const label = readFirstString(item, ["name", "tag", "title"]);
      return label ? [label.replace(/^#/, "")] : [];
    }
    return [];
  });
}

function readUrlArray(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return nonEmptyArray(
    value.flatMap((item) => {
      if (typeof item === "string" && item.trim()) return [item.trim()];
      if (isRecord(item)) {
        const url = readFirstString(item, ["url", "link", "lynx_url"]);
        return url ? [url] : [];
      }
      return [];
    }),
  );
}

function mergeUniqueStrings(...groups: string[][]) {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const group of groups) {
    for (const value of group) {
      const normalized = value.trim().replace(/^[@#]/, "");
      const key = normalized.toLowerCase();
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      merged.push(normalized);
    }
  }
  return merged;
}

function normalizeSocialPostType(value: string | undefined) {
  const normalized = value?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("video") || normalized.includes("reel")) return "video";
  if (normalized.includes("carousel") || normalized.includes("sidecar")) return "carousel";
  if (normalized.includes("image") || normalized.includes("photo")) return "image";
  return normalized;
}

function normalizeSocialTimestamp(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    if (/^\d+$/.test(value)) return normalizeSocialTimestamp(Number(value));
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const millis = value > 10_000_000_000 ? value : value * 1000;
  return new Date(millis).toISOString();
}

function omitUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

function assertHttpUrl(rawUrl: string, label: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${label} must contain valid absolute URLs.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} only supports http and https URLs.`);
  }
}

function isLinkedInDomain(value: string) {
  const domain = value.trim().toLowerCase().replace(/^\*\./, "").split("/")[0] ?? "";
  return domain === "linkedin.com" || domain.endsWith(".linkedin.com");
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3)}...`;
}
