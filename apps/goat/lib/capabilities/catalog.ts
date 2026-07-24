import type { GoatManagedCapabilitySource } from "@opencompany/db/goat-schema";
import type { JSONSchema7 } from "ai";
import { GoatActionInvalidParamsError } from "@/lib/actions/types";

export type ManagedCapabilityExecutionMode = "sync" | "async";
export type ManagedCapabilityInputLocation = "body" | "queryParams" | "pathParams";

export type ManagedCapabilityMappedInput = {
  providerInput: Record<string, unknown>;
  resultLimit: number;
  canonicalLinks: string[];
};

export type ManagedCapabilityActionSpec = {
  id: string;
  source: GoatManagedCapabilitySource;
  description: string;
  params: JSONSchema7;
  provider: "tikhub" | "apify" | "pdl" | "semrush";
  endpoint: string;
  priceType: "PER_CALL" | "PER_RESULT";
  executionMode: ManagedCapabilityExecutionMode;
  inputLocation?: ManagedCapabilityInputLocation;
  mapInput: (params: Record<string, unknown>) => ManagedCapabilityMappedInput;
};

export const MANAGED_CAPABILITY_SOURCE_DETAILS: Record<
  GoatManagedCapabilitySource,
  { label: string; description: string }
> = {
  x: {
    label: "X",
    description: "Search public posts, profiles, threads, and replies on X.",
  },
  linkedin: {
    label: "LinkedIn",
    description:
      "Metered research of public LinkedIn people, companies, posts, and comments through a managed provider; this does not connect to the user's LinkedIn account.",
  },
  youtube: {
    label: "YouTube",
    description: "Search public videos, Shorts, channels, transcripts, and comments.",
  },
  instagram: {
    label: "Instagram",
    description: "Research public Instagram profiles, posts, Reels, hashtags, and comments.",
  },
  tiktok: {
    label: "TikTok",
    description: "Search public TikTok creators, videos, comments, hashtags, and trends.",
  },
  lead: {
    label: "Prospecting",
    description:
      "Find targeted professional prospects and enrich contact details through reviewed managed providers.",
  },
  seo: {
    label: "SEO",
    description:
      "Research search visibility, ranking keywords, top pages, competitors, and backlinks with Semrush.",
  },
};

const LIMIT_SCHEMA = {
  type: "integer",
  minimum: 1,
  description: "Maximum number of content items returned.",
} as const;
const CURSOR_SCHEMA = {
  type: "string",
  maxLength: 2_000,
  description: "Exact pagination cursor from the previous result.",
} as const;
const SEARCH_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", minLength: 1, maxLength: 300 },
    cursor: CURSOR_SCHEMA,
    limit: LIMIT_SCHEMA,
  },
  required: ["query"],
} as const satisfies JSONSchema7;
const PROFILE_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    profile: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "A public profile URL, username, or platform identifier.",
    },
  },
  required: ["profile"],
} as const satisfies JSONSchema7;
const PROFILE_LIST_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    profile: PROFILE_PARAMS.properties.profile,
    cursor: CURSOR_SCHEMA,
    limit: LIMIT_SCHEMA,
  },
  required: ["profile"],
} as const satisfies JSONSchema7;
const YOUTUBE_CHANNEL_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    profile: {
      type: "string",
      minLength: 22,
      maxLength: 1_000,
      description:
        "A YouTube channel id beginning with UC, or a canonical https://www.youtube.com/channel/UC... URL. When chaining from youtube.search_channels, pass payload.channels[].channel_id; handles and /@handle URLs are not accepted.",
    },
  },
  required: ["profile"],
} as const satisfies JSONSchema7;
const YOUTUBE_CHANNEL_LIST_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    profile: YOUTUBE_CHANNEL_PARAMS.properties.profile,
    cursor: CURSOR_SCHEMA,
    limit: LIMIT_SCHEMA,
  },
  required: ["profile"],
} as const satisfies JSONSchema7;
const URL_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: { type: "string", format: "uri", maxLength: 1_000 },
  },
  required: ["url"],
} as const satisfies JSONSchema7;
const URL_LIMIT_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: URL_PARAMS.properties.url,
    limit: LIMIT_SCHEMA,
  },
  required: ["url"],
} as const satisfies JSONSchema7;
const VIDEO_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    video: {
      type: "string",
      minLength: 1,
      maxLength: 1_000,
      description: "A public video URL or platform video identifier.",
    },
  },
  required: ["video"],
} as const satisfies JSONSchema7;
const VIDEO_LIST_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    video: VIDEO_PARAMS.properties.video,
    cursor: CURSOR_SCHEMA,
    limit: LIMIT_SCHEMA,
  },
  required: ["video"],
} as const satisfies JSONSchema7;
const CONTENT_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: {
      type: "string",
      minLength: 1,
      maxLength: 1_000,
      description: "A public content URL or platform content identifier.",
    },
  },
  required: ["url"],
} as const satisfies JSONSchema7;
const CONTENT_LIST_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: CONTENT_PARAMS.properties.url,
    cursor: CURSOR_SCHEMA,
    limit: LIMIT_SCHEMA,
  },
  required: ["url"],
} as const satisfies JSONSchema7;

const TIKHUB = "tikhub" as const;
const SEMRUSH = "semrush" as const;
const PDL_PROSPECT_JOB_LEVELS = [
  "cxo",
  "owner",
  "vp",
  "director",
  "partner",
  "senior",
  "manager",
  "entry",
  "training",
  "unpaid",
] as const;
const PDL_PROSPECT_DATA_INCLUDE = [
  "id",
  "full_name",
  "job_title",
  "job_title_levels",
  "job_company_name",
  "job_company_website",
  "job_company_size",
  "job_company_employee_count",
  "job_company_industry",
  "job_company_industry_v2",
  "job_company_linkedin_url",
  "job_company_location_name",
  "location_name",
  "linkedin_url",
  "work_email",
].join(",");
const SEO_DOMAIN_SCHEMA = {
  type: "string",
  minLength: 4,
  maxLength: 1_000,
  description: "A public website domain or HTTPS URL, such as example.com.",
} as const;
const SEO_COUNTRY_SCHEMA = {
  type: "string",
  pattern: "^[A-Z]{2}$",
  description:
    "Two-letter Semrush regional database code, such as US, UK, CA, DE, or AU. Defaults to US.",
} as const;
const SEO_LIMIT_SCHEMA = {
  ...LIMIT_SCHEMA,
  maximum: 10,
  description: "Maximum number of SEO rows returned, from 1 to 10.",
} as const;

export const MANAGED_CAPABILITY_ACTIONS: readonly ManagedCapabilityActionSpec[] = [
  {
    id: "x.search_posts",
    source: "x",
    description: "Search public X posts by keyword using Top, Latest, or Media ranking.",
    params: {
      ...SEARCH_PARAMS,
      properties: {
        ...SEARCH_PARAMS.properties,
        sort: { type: "string", enum: ["top", "latest", "media"] },
      },
    },
    provider: TIKHUB,
    endpoint: "/api/v1/twitter/web/fetch_search_timeline",
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["query", "sort", "cursor", "limit"]);
      return {
        providerInput: compact({
          keyword: requiredText(params, "query", 300),
          search_type: enumParam(params, "sort", ["top", "latest", "media"], "top", {
            top: "Top",
            latest: "Latest",
            media: "Media",
          }),
          cursor: cursorParam(params),
        }),
        resultLimit: limitParam(params, 20, 20),
        canonicalLinks: [],
      };
    },
  },
  profileAction({
    id: "x.get_profile",
    source: "x",
    description: "Get one public X profile.",
    endpoint: "/api/v1/twitter/web/fetch_user_profile",
    platform: "x",
  }),
  profileListAction({
    id: "x.list_profile_posts",
    source: "x",
    description: "List recent public posts from an X profile.",
    endpoint: "/api/v1/twitter/web/fetch_user_post_tweet",
    platform: "x",
    defaultLimit: 20,
  }),
  idAction({
    id: "x.get_post",
    source: "x",
    description: "Get one public X post by URL or post id.",
    endpoint: "/api/v1/twitter/web/fetch_tweet_detail",
    field: "tweet_id",
    platform: "x_post",
  }),
  idListAction({
    id: "x.list_replies",
    source: "x",
    description: "List public replies to an X post.",
    endpoint: "/api/v1/twitter/web/fetch_post_comments",
    field: "tweet_id",
    platform: "x_post",
    cursorField: "cursor",
    defaultLimit: 20,
    maxLimit: 20,
  }),
  {
    id: "linkedin.search_posts",
    source: "linkedin",
    description: "Search public LinkedIn posts by keyword.",
    params: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: SEARCH_PARAMS.properties.query,
        limit: SEARCH_PARAMS.properties.limit,
        page: { type: "integer", minimum: 1, maximum: 20 },
        sort: { type: "string", enum: ["relevant", "recent"] },
      },
      required: ["query"],
    },
    provider: TIKHUB,
    endpoint: "/api/v1/linkedin/web/search_posts",
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["query", "page", "sort", "limit"]);
      return {
        providerInput: compact({
          keyword: requiredText(params, "query", 300),
          page: integerParam(params, "page", 1, 20, 1),
          sort_by: enumParam(params, "sort", ["relevant", "recent"], undefined, {
            relevant: "relevance",
            recent: "date_posted",
          }),
        }),
        resultLimit: limitParam(params, 10, 10),
        canonicalLinks: [],
      };
    },
  },
  linkedInUrlAction(
    "linkedin.get_person_profile",
    "Get one public LinkedIn person profile.",
    "/api/v1/linkedin/web_v2/get_user_profile",
    "person",
  ),
  linkedInUrlAction(
    "linkedin.get_company",
    "Get one public LinkedIn company profile.",
    "/api/v1/linkedin/web_v2/get_company_profile",
    "company",
  ),
  linkedInUrlListAction(
    "linkedin.list_person_posts",
    "List recent posts shown on a public LinkedIn person profile.",
    "/api/v1/linkedin/web_v2/get_user_posts",
    "person",
  ),
  linkedInUrlListAction(
    "linkedin.list_company_posts",
    "List recent posts shown on a public LinkedIn company profile.",
    "/api/v1/linkedin/web_v2/get_company_posts",
    "company",
  ),
  linkedInUrlAction(
    "linkedin.get_post",
    "Get one public LinkedIn post or article.",
    "/api/v1/linkedin/web_v2/get_post_detail",
    "post",
  ),
  {
    id: "linkedin.list_comments",
    source: "linkedin",
    description: "List public comments on a LinkedIn post.",
    params: URL_LIMIT_PARAMS,
    provider: TIKHUB,
    endpoint: "/api/v1/linkedin/web/get_post_comments",
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["url", "limit"]);
      const url = linkedinUrl(requiredText(params, "url", 1_000), "post");
      return {
        providerInput: { post_id: linkedInPostId(url) },
        resultLimit: limitParam(params, 20, 20),
        canonicalLinks: [url],
      };
    },
  },
  {
    id: "youtube.search",
    source: "youtube",
    description: "Search public YouTube videos, channels, Shorts, and playlists.",
    params: {
      ...SEARCH_PARAMS,
      properties: {
        ...SEARCH_PARAMS.properties,
        type: { type: "string", enum: ["video", "channel", "playlist", "movie"] },
        uploadDate: {
          type: "string",
          enum: ["last_hour", "today", "this_week", "this_month", "this_year"],
        },
        duration: { type: "string", enum: ["short", "medium", "long"] },
        sort: { type: "string", enum: ["relevance", "upload_date", "view_count", "rating"] },
      },
    },
    provider: TIKHUB,
    endpoint: "/api/v1/youtube/web_v2/get_general_search_v2",
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, [
        "query",
        "cursor",
        "limit",
        "type",
        "uploadDate",
        "duration",
        "sort",
      ]);
      return {
        providerInput: compact({
          keyword: optionalText(params, "cursor", 2_000)
            ? undefined
            : requiredText(params, "query", 300),
          continuation_token: cursorParam(params),
          type: enumParam(params, "type", ["video", "channel", "playlist", "movie"], undefined),
          upload_date: enumParam(
            params,
            "uploadDate",
            ["last_hour", "today", "this_week", "this_month", "this_year"],
            undefined,
          ),
          duration: enumParam(params, "duration", ["short", "medium", "long"], undefined),
          sort_by: enumParam(
            params,
            "sort",
            ["relevance", "upload_date", "view_count", "rating"],
            undefined,
          ),
        }),
        resultLimit: limitParam(params, 10, 10),
        canonicalLinks: [],
      };
    },
  },
  youtubeSearchAction(
    "youtube.search_shorts",
    "Search public YouTube Shorts.",
    "/api/v1/youtube/web_v2/get_shorts_search_v2",
  ),
  youtubeSearchAction(
    "youtube.search_channels",
    "Search public YouTube channels. To call a YouTube channel action next, pass the selected payload.channels[].channel_id as its profile parameter.",
    "/api/v1/youtube/web_v2/search_channels",
  ),
  youtubeVideoAction(
    "youtube.get_video",
    "Get details for one public YouTube video.",
    "/api/v1/youtube/web_v2/get_video_info_v2",
  ),
  youtubeVideoAction(
    "youtube.get_transcript",
    "Get available captions or transcript for one public YouTube video.",
    "/api/v1/youtube/web_v2/get_video_captions",
  ),
  youtubeVideoListAction(
    "youtube.list_comments",
    "List public comments on a YouTube video.",
    "/api/v1/youtube/web_v2/get_video_comments",
    20,
  ),
  youtubeChannelAction(
    "youtube.get_channel",
    "Get one public YouTube channel from its UC... channel id or canonical /channel/UC... URL.",
    "/api/v1/youtube/web/get_channel_info",
    false,
  ),
  youtubeChannelAction(
    "youtube.list_channel_videos",
    "List public videos from a YouTube UC... channel id or canonical /channel/UC... URL.",
    "/api/v1/youtube/web_v2/get_channel_videos",
    true,
  ),
  youtubeChannelAction(
    "youtube.list_channel_shorts",
    "List public Shorts from a YouTube UC... channel id or canonical /channel/UC... URL.",
    "/api/v1/youtube/web_v2/get_channel_shorts",
    true,
  ),
  instagramSearchAction(
    "instagram.search",
    "Search public Instagram users, hashtags, places, posts, and Reels.",
    "/api/v1/instagram/v2/general_search",
  ),
  instagramSearchAction(
    "instagram.search_reels",
    "Search public Instagram Reels.",
    "/api/v1/instagram/v2/search_reels",
  ),
  instagramProfileAction(
    "instagram.get_profile",
    "Get one public Instagram profile.",
    "/api/v1/instagram/v2/fetch_user_info",
    false,
  ),
  instagramProfileAction(
    "instagram.list_posts",
    "List public posts from an Instagram profile.",
    "/api/v1/instagram/v2/fetch_user_posts",
    true,
  ),
  instagramProfileAction(
    "instagram.list_reels",
    "List public Reels from an Instagram profile.",
    "/api/v1/instagram/v2/fetch_user_reels",
    true,
  ),
  instagramPostAction(
    "instagram.get_post",
    "Get one public Instagram post or Reel.",
    "/api/v1/instagram/v2/fetch_post_info",
    false,
  ),
  instagramPostAction(
    "instagram.list_comments",
    "List public comments on an Instagram post or Reel.",
    "/api/v1/instagram/v2/fetch_post_comments",
    true,
  ),
  {
    id: "instagram.list_hashtag_posts",
    source: "instagram",
    description: "List top, recent, or Reel posts for a public Instagram hashtag.",
    params: {
      ...SEARCH_PARAMS,
      properties: {
        ...SEARCH_PARAMS.properties,
        feed: { type: "string", enum: ["top", "recent", "reels"] },
      },
    },
    provider: TIKHUB,
    endpoint: "/api/v1/instagram/v2/fetch_hashtag_posts",
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["query", "feed", "cursor", "limit"]);
      return {
        providerInput: compact({
          keyword: requiredText(params, "query", 100).replace(/^#/, ""),
          feed_type: enumParam(params, "feed", ["top", "recent", "reels"], "top"),
          pagination_token: cursorParam(params),
        }),
        resultLimit: limitParam(params, 12, 12),
        canonicalLinks: [],
      };
    },
  },
  tiktokSearchAction(
    "tiktok.search_videos",
    "Search public TikTok videos.",
    "/api/v1/tiktok/app/v3/fetch_video_search_result",
    true,
  ),
  tiktokSearchAction(
    "tiktok.search_creators",
    "Search public TikTok creators.",
    "/api/v1/tiktok/app/v3/fetch_user_search_result",
  ),
  tiktokSearchAction(
    "tiktok.search_hashtags",
    "Search public TikTok hashtags.",
    "/api/v1/tiktok/app/v3/fetch_hashtag_search_result",
  ),
  {
    id: "tiktok.get_profile",
    source: "tiktok",
    description: "Get one public TikTok creator profile.",
    params: PROFILE_PARAMS,
    provider: TIKHUB,
    endpoint: "/api/v1/tiktok/web/fetch_user_profile",
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["profile"]);
      const identity = parseProfileIdentity(requiredText(params, "profile", 500), "tiktok");
      return {
        providerInput: { uniqueId: identity.id },
        resultLimit: 1,
        canonicalLinks: [identity.url],
      };
    },
  },
  {
    id: "tiktok.list_user_videos",
    source: "tiktok",
    description: "List public videos from a TikTok creator.",
    params: PROFILE_LIST_PARAMS,
    provider: TIKHUB,
    endpoint: "/api/v1/tiktok/app/v3/fetch_user_post_videos_v3",
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["profile", "cursor", "limit"]);
      const identity = parseProfileIdentity(requiredText(params, "profile", 500), "tiktok");
      const limit = limitParam(params, 12, 12);
      return {
        providerInput: compact({
          unique_id: identity.id,
          max_cursor: cursorParam(params),
          count: limit,
        }),
        resultLimit: limit,
        canonicalLinks: [identity.url],
      };
    },
  },
  idAction({
    id: "tiktok.get_video",
    source: "tiktok",
    description: "Get one public TikTok video.",
    endpoint: "/api/v1/tiktok/web/fetch_post_detail_v2",
    field: "itemId",
    platform: "tiktok_video",
  }),
  idListAction({
    id: "tiktok.list_comments",
    source: "tiktok",
    description: "List public comments on a TikTok video.",
    endpoint: "/api/v1/tiktok/web/fetch_post_comment",
    field: "aweme_id",
    platform: "tiktok_video",
    cursorField: "cursor",
    countField: "count",
    defaultLimit: 20,
    maxLimit: 20,
  }),
  noInputAction(
    "tiktok.get_search_trends",
    "tiktok",
    "Get current public TikTok search trends.",
    "/api/v1/tiktok/web/fetch_trending_searchwords",
    12,
  ),
  {
    id: "tiktok.get_hashtag_trends",
    source: "tiktok",
    description: "Get current public TikTok hashtag trends for a country.",
    params: {
      type: "object",
      additionalProperties: false,
      properties: {
        country: {
          type: "string",
          pattern: "^[A-Z]{2}$",
          description: "ISO 3166-1 alpha-2 country code, such as US or DE.",
        },
        limit: LIMIT_SCHEMA,
      },
    },
    provider: TIKHUB,
    endpoint: "/api/v1/tiktok/ads/get_trends_hashtag_list",
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["country", "limit"]);
      const country = optionalText(params, "country", 2);
      if (country && !/^[A-Z]{2}$/.test(country)) {
        throw new GoatActionInvalidParamsError('"country" must be a two-letter uppercase code.');
      }
      const limit = limitParam(params, 12, 12);
      return {
        providerInput: compact({ country_code: country, limit }),
        resultLimit: limit,
        canonicalLinks: [],
      };
    },
  },
  {
    id: "lead.get_linkedin_contact",
    source: "lead",
    description: "Get provider-available public contact information for one LinkedIn person.",
    params: URL_PARAMS,
    provider: TIKHUB,
    endpoint: "/api/v1/linkedin/web/get_user_contact",
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["url"]);
      const url = linkedinUrl(requiredText(params, "url", 1_000), "person");
      return {
        providerInput: { username: linkedInSlug(url, "in") },
        resultLimit: 1,
        canonicalLinks: [url],
      };
    },
  },
  {
    id: "lead.enrich_person",
    source: "lead",
    description: "Enrich one person from an email, phone, LinkedIn URL, or full name plus company.",
    params: {
      type: "object",
      additionalProperties: false,
      properties: {
        email: { type: "string", format: "email", maxLength: 320 },
        phone: { type: "string", minLength: 7, maxLength: 40 },
        linkedinUrl: { type: "string", format: "uri", maxLength: 1_000 },
        name: { type: "string", minLength: 1, maxLength: 200 },
        company: { type: "string", minLength: 1, maxLength: 200 },
      },
      anyOf: [
        { required: ["email"] },
        { required: ["phone"] },
        { required: ["linkedinUrl"] },
        { required: ["name", "company"] },
      ],
    },
    provider: "pdl",
    endpoint: "/v5/person/enrich",
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["email", "phone", "linkedinUrl", "name", "company"]);
      const email = optionalText(params, "email", 320);
      const phone = optionalText(params, "phone", 40);
      const profile = optionalText(params, "linkedinUrl", 1_000);
      const name = optionalText(params, "name", 200);
      const company = optionalText(params, "company", 200);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new GoatActionInvalidParamsError('"email" is not a valid email address.');
      }
      const canonicalLinks = profile ? [linkedinUrl(profile, "person")] : [];
      if (!email && !phone && !profile && !(name && company)) {
        throw new GoatActionInvalidParamsError(
          "Provide email, phone, linkedinUrl, or both name and company.",
        );
      }
      return {
        providerInput: compact({
          email,
          phone,
          profile: profile ? canonicalLinks[0] : undefined,
          name,
          company,
          include_if_matched: true,
        }),
        resultLimit: 1,
        canonicalLinks,
      };
    },
  },
  {
    id: "lead.search_prospects",
    source: "lead",
    description:
      "Find targeted professional prospects by current title or seniority, person or company location, company industry, and company employee count. Filters are ANDed across fields and ORed within each list. For titles, include common variants such as CTO and chief technology officer. Company industries use provider taxonomy such as computer software.",
    params: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobTitles: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: { type: "string", minLength: 1, maxLength: 100 },
          description:
            "Current job-title phrases. Include common variants, for example CTO and chief technology officer.",
        },
        jobLevels: {
          type: "array",
          minItems: 1,
          maxItems: PDL_PROSPECT_JOB_LEVELS.length,
          uniqueItems: true,
          items: { type: "string", enum: [...PDL_PROSPECT_JOB_LEVELS] },
          description:
            "Normalized current seniority levels. CTO, CEO, CIO, and other chief officers are cxo.",
        },
        personLocations: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: { type: "string", minLength: 1, maxLength: 100 },
          description:
            "Where the people are located, as cities, regions, or countries. Use companyLocations for company headquarters.",
        },
        companyLocations: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: { type: "string", minLength: 1, maxLength: 100 },
          description: "Current company headquarters cities, regions, or countries.",
        },
        companyIndustries: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: { type: "string", minLength: 1, maxLength: 100 },
          description:
            "Provider-canonical current company industries, such as computer software, information technology and services, or internet.",
        },
        minCompanyEmployees: {
          type: "integer",
          minimum: 0,
          maximum: 10_000_000,
          description: "Inclusive minimum current company employee count.",
        },
        maxCompanyEmployees: {
          type: "integer",
          minimum: 0,
          maximum: 10_000_000,
          description:
            "Inclusive maximum current company employee count. For fewer than 5 employees, pass 4.",
        },
        requireWorkEmail: {
          type: "boolean",
          description: "Return only prospects with a provider-available work email.",
        },
        cursor: {
          ...CURSOR_SCHEMA,
          description:
            "Exact scroll_token from the previous result. Repeat the same filters when paginating.",
        },
        limit: {
          ...LIMIT_SCHEMA,
          maximum: 10,
          description:
            "Maximum prospects returned and billed for this call, from 1 to 10. Defaults to 5.",
        },
      },
      anyOf: [
        { required: ["jobTitles"] },
        { required: ["jobLevels"] },
        { required: ["personLocations"] },
        { required: ["companyLocations"] },
        { required: ["companyIndustries"] },
        { required: ["minCompanyEmployees"] },
        { required: ["maxCompanyEmployees"] },
      ],
    },
    provider: "pdl",
    endpoint: "/v5/person/search",
    priceType: "PER_RESULT",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, [
        "jobTitles",
        "jobLevels",
        "personLocations",
        "companyLocations",
        "companyIndustries",
        "minCompanyEmployees",
        "maxCompanyEmployees",
        "requireWorkEmail",
        "cursor",
        "limit",
      ]);
      const jobTitles = lowercaseTextListParam(params, "jobTitles", 10, 100);
      const jobLevels = enumListParam(
        params,
        "jobLevels",
        PDL_PROSPECT_JOB_LEVELS,
        PDL_PROSPECT_JOB_LEVELS.length,
      );
      const personLocations = lowercaseTextListParam(params, "personLocations", 10, 100);
      const companyLocations = lowercaseTextListParam(params, "companyLocations", 10, 100);
      const companyIndustries = lowercaseTextListParam(params, "companyIndustries", 10, 100);
      const minCompanyEmployees = optionalIntegerParam(
        params,
        "minCompanyEmployees",
        0,
        10_000_000,
      );
      const maxCompanyEmployees = optionalIntegerParam(
        params,
        "maxCompanyEmployees",
        0,
        10_000_000,
      );
      if (
        minCompanyEmployees !== undefined &&
        maxCompanyEmployees !== undefined &&
        minCompanyEmployees > maxCompanyEmployees
      ) {
        throw new GoatActionInvalidParamsError(
          '"minCompanyEmployees" cannot exceed "maxCompanyEmployees".',
        );
      }

      const must: Record<string, unknown>[] = [];
      if (jobTitles.length > 0) {
        must.push(
          pdlAnyOf(
            jobTitles.map((title) => ({
              match_phrase: { "job_title.text": title },
            })),
          ),
        );
      }
      if (jobLevels.length > 0) {
        must.push({ terms: { job_title_levels: jobLevels } });
      }
      if (personLocations.length > 0) {
        must.push(
          pdlLocationFilter(personLocations, [
            "location_locality",
            "location_region",
            "location_country",
          ]),
        );
      }
      if (companyLocations.length > 0) {
        must.push(
          pdlLocationFilter(companyLocations, [
            "job_company_location_locality",
            "job_company_location_region",
            "job_company_location_country",
          ]),
        );
      }
      if (companyIndustries.length > 0) {
        must.push(
          pdlAnyOf(
            companyIndustries.flatMap((industry) => [
              { term: { job_company_industry: industry } },
              { term: { job_company_industry_v2: industry } },
            ]),
          ),
        );
      }
      if (minCompanyEmployees !== undefined || maxCompanyEmployees !== undefined) {
        must.push({
          range: {
            job_company_employee_count: compact({
              gte: minCompanyEmployees,
              lte: maxCompanyEmployees,
            }),
          },
        });
      }
      if (must.length === 0) {
        throw new GoatActionInvalidParamsError(
          "Provide at least one title, seniority, location, industry, or employee-count filter.",
        );
      }
      if (optionalBooleanParam(params, "requireWorkEmail") === true) {
        must.push({ exists: { field: "work_email" } });
      }

      const limit = limitParam(params, 5, 10);
      return {
        providerInput: compact({
          query: { bool: { must } },
          size: limit,
          scroll_token: cursorParam(params),
          titlecase: true,
          data_include: PDL_PROSPECT_DATA_INCLUDE,
        }),
        resultLimit: limit,
        canonicalLinks: [],
      };
    },
  },
  {
    id: "lead.search_people_by_name",
    source: "lead",
    description:
      "Search for up to five LinkedIn profiles by name, including provider-available email data.",
    params: {
      type: "object",
      additionalProperties: false,
      properties: {
        firstName: { type: "string", minLength: 1, maxLength: 100 },
        lastName: { type: "string", minLength: 1, maxLength: 100 },
        companyUrl: { type: "string", format: "uri", maxLength: 1_000 },
        location: { type: "string", minLength: 1, maxLength: 150 },
        limit: { ...LIMIT_SCHEMA, maximum: 5 },
      },
      required: ["firstName", "lastName"],
    },
    provider: "apify",
    endpoint: "/harvestapi/linkedin-profile-search-by-name",
    priceType: "PER_RESULT",
    executionMode: "async",
    mapInput: (raw) => {
      const params = checkedParams(raw, [
        "firstName",
        "lastName",
        "companyUrl",
        "location",
        "limit",
      ]);
      const companyUrl = optionalText(params, "companyUrl", 1_000);
      const location = optionalText(params, "location", 150);
      const limit = limitParam(params, 5, 5);
      return {
        providerInput: compact({
          profileScraperMode: "Full + email search",
          firstName: requiredText(params, "firstName", 100),
          lastName: requiredText(params, "lastName", 100),
          strictSearch: true,
          maxItems: limit,
          currentCompanies: companyUrl ? [linkedinUrl(companyUrl, "company")] : undefined,
          locations: location ? [location] : undefined,
        }),
        resultLimit: limit,
        canonicalLinks: companyUrl ? [linkedinUrl(companyUrl, "company")] : [],
      };
    },
  },
  {
    id: "lead.list_company_employees",
    source: "lead",
    description:
      "List up to ten LinkedIn company employees, including provider-available email data.",
    params: {
      type: "object",
      additionalProperties: false,
      properties: {
        companyUrl: { type: "string", format: "uri", maxLength: 1_000 },
        query: { type: "string", minLength: 1, maxLength: 300 },
        location: { type: "string", minLength: 1, maxLength: 150 },
        limit: { ...LIMIT_SCHEMA, maximum: 10 },
      },
      required: ["companyUrl"],
    },
    provider: "apify",
    endpoint: "/harvestapi/linkedin-company-employees",
    priceType: "PER_RESULT",
    executionMode: "async",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["companyUrl", "query", "location", "limit"]);
      const companyUrl = linkedinUrl(requiredText(params, "companyUrl", 1_000), "company");
      const location = optionalText(params, "location", 150);
      const limit = limitParam(params, 10, 10);
      return {
        providerInput: compact({
          profileScraperMode: "Full + email search ($12 per 1k)",
          companies: [companyUrl],
          searchQuery: optionalText(params, "query", 300),
          locations: location ? [location] : undefined,
          maxItems: limit,
        }),
        resultLimit: limit,
        canonicalLinks: [companyUrl],
      };
    },
  },
  seoDomainOverviewAction({
    id: "seo.get_domain_overview",
    description:
      "Get a Semrush SEO baseline for one domain, including organic keywords, estimated organic traffic, and traffic value in one country.",
    endpoint: "/domain_rank",
  }),
  seoDomainListAction({
    id: "seo.list_ranking_keywords",
    description:
      "List a domain's leading Google organic keywords, positions, landing pages, search volumes, and estimated traffic in one country.",
    endpoint: "/domain_organic",
    priceType: "PER_RESULT",
  }),
  seoDomainListAction({
    id: "seo.list_top_pages",
    description:
      "List a domain's top pages in Google organic search, including ranking-keyword counts and estimated traffic in one country.",
    endpoint: "/domain_organic_pages",
    priceType: "PER_RESULT",
  }),
  seoDomainListAction({
    id: "seo.list_organic_competitors",
    description:
      "List a domain's closest Google organic-search competitors and their shared-keyword and traffic metrics in one country.",
    endpoint: "/domain_organic_organic",
    priceType: "PER_RESULT",
  }),
  {
    id: "seo.get_keyword_metrics",
    source: "seo",
    description:
      "Get Semrush search volume, keyword difficulty, CPC, competition, and result-count metrics for one keyword in one country.",
    params: {
      type: "object",
      additionalProperties: false,
      properties: {
        keyword: { type: "string", minLength: 1, maxLength: 200 },
        country: SEO_COUNTRY_SCHEMA,
      },
      required: ["keyword"],
    },
    provider: SEMRUSH,
    endpoint: "/keyword_metrics",
    priceType: "PER_CALL",
    executionMode: "sync",
    inputLocation: "queryParams",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["keyword", "country"]);
      return {
        providerInput: {
          keyword: requiredText(params, "keyword", 200),
          country: seoCountry(params),
        },
        resultLimit: 1,
        canonicalLinks: [],
      };
    },
  },
  {
    id: "seo.get_backlink_overview",
    source: "seo",
    description:
      "Get a Semrush summary of one domain's backlink profile, including authority, backlink, and referring-domain counts.",
    params: {
      type: "object",
      additionalProperties: false,
      properties: { domain: SEO_DOMAIN_SCHEMA },
      required: ["domain"],
    },
    provider: SEMRUSH,
    endpoint: "/backlinks_overview",
    priceType: "PER_CALL",
    executionMode: "sync",
    inputLocation: "queryParams",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["domain"]);
      const domain = seoDomain(params);
      return {
        providerInput: {
          url: domain,
          scope: "ROOT_DOMAIN",
        },
        resultLimit: 1,
        canonicalLinks: [seoHomepage(domain)],
      };
    },
  },
];

export function managedCapabilityActionsForSource(source: GoatManagedCapabilitySource) {
  return MANAGED_CAPABILITY_ACTIONS.filter((action) => action.source === source);
}

// Stable, non-sensitive probes used by the opt-in inspect-only contract check.
// They exercise every adapter without calling the paid run API.
export function managedCapabilityContractProbeParams(id: string): Record<string, unknown> {
  if (id === "seo.get_keyword_metrics") {
    return { keyword: "artificial intelligence", country: "US" };
  }
  if (id === "seo.get_backlink_overview") {
    return { domain: "openai.com" };
  }
  if (id.startsWith("seo.")) {
    return { domain: "openai.com", country: "US" };
  }
  if (id === "lead.search_people_by_name") {
    return { firstName: "Ada", lastName: "Lovelace" };
  }
  if (id === "lead.search_prospects") {
    return {
      jobTitles: ["chief technology officer"],
      companyLocations: ["berlin"],
      companyIndustries: ["computer software"],
      maxCompanyEmployees: 4,
    };
  }
  if (id === "linkedin.search_posts") {
    return { query: "openai", sort: "relevant" };
  }
  if (id.endsWith(".search") || id.includes(".search_") || id === "x.search_posts") {
    return { query: "openai" };
  }
  if (id === "instagram.list_hashtag_posts") return { query: "#ai" };
  if (id === "tiktok.get_search_trends") return {};
  if (id === "tiktok.get_hashtag_trends") return { country: "US" };
  if (id === "lead.enrich_person") return { email: "ada@example.com" };
  if (id === "lead.get_linkedin_contact") {
    return { url: "https://www.linkedin.com/in/ada-lovelace" };
  }
  if (id === "lead.list_company_employees") {
    return { companyUrl: "https://www.linkedin.com/company/openai" };
  }
  if (id.startsWith("linkedin.")) {
    if (id.includes("company")) {
      return { url: "https://www.linkedin.com/company/openai" };
    }
    if (id === "linkedin.get_post" || id === "linkedin.list_comments") {
      return {
        url: "https://www.linkedin.com/posts/openai_example-7244804629786419202",
      };
    }
    return { url: "https://www.linkedin.com/in/ada-lovelace" };
  }
  if (id.startsWith("youtube.")) {
    if (id.includes("channel")) {
      return {
        profile: "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw",
      };
    }
    return { video: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };
  }
  if (id.startsWith("instagram.")) {
    if (id.includes("profile") || id.includes("posts") || id.includes("reels")) {
      return { profile: "openai" };
    }
    return { url: "https://www.instagram.com/p/ABC123/" };
  }
  if (id.startsWith("tiktok.")) {
    if (id.includes("profile") || id.includes("user_videos")) {
      return { profile: "openai" };
    }
    return { url: "https://www.tiktok.com/@openai/video/123456789" };
  }
  if (id.startsWith("x.")) {
    if (id.includes("profile")) return { profile: "openai" };
    return { url: "https://x.com/openai/status/123456789" };
  }
  throw new Error(`No contract probe is defined for ${id}.`);
}

function profileAction(input: {
  id: string;
  source: GoatManagedCapabilitySource;
  description: string;
  endpoint: string;
  platform: "x";
}): ManagedCapabilityActionSpec {
  return {
    ...input,
    params: PROFILE_PARAMS,
    provider: TIKHUB,
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["profile"]);
      const identity = parseProfileIdentity(requiredText(params, "profile", 500), input.platform);
      return {
        providerInput: { screen_name: identity.id },
        resultLimit: 1,
        canonicalLinks: [identity.url],
      };
    },
  };
}

function profileListAction(input: {
  id: string;
  source: GoatManagedCapabilitySource;
  description: string;
  endpoint: string;
  platform: "x";
  defaultLimit: number;
}): ManagedCapabilityActionSpec {
  return {
    ...input,
    params: PROFILE_LIST_PARAMS,
    provider: TIKHUB,
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["profile", "cursor", "limit"]);
      const identity = parseProfileIdentity(requiredText(params, "profile", 500), input.platform);
      return {
        providerInput: compact({ screen_name: identity.id, cursor: cursorParam(params) }),
        resultLimit: limitParam(params, input.defaultLimit, input.defaultLimit),
        canonicalLinks: [identity.url],
      };
    },
  };
}

function idAction(input: {
  id: string;
  source: GoatManagedCapabilitySource;
  description: string;
  endpoint: string;
  field: string;
  platform: "x_post" | "tiktok_video";
}): ManagedCapabilityActionSpec {
  return {
    ...input,
    params: CONTENT_PARAMS,
    provider: TIKHUB,
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["url"]);
      const identity = parseContentIdentity(requiredText(params, "url", 1_000), input.platform);
      return {
        providerInput: { [input.field]: identity.id },
        resultLimit: 1,
        canonicalLinks: [identity.url],
      };
    },
  };
}

function idListAction(input: {
  id: string;
  source: GoatManagedCapabilitySource;
  description: string;
  endpoint: string;
  field: string;
  platform: "x_post" | "tiktok_video";
  cursorField: string;
  countField?: string;
  defaultLimit: number;
  maxLimit: number;
}): ManagedCapabilityActionSpec {
  return {
    ...input,
    params: CONTENT_LIST_PARAMS,
    provider: TIKHUB,
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["url", "cursor", "limit"]);
      const identity = parseContentIdentity(requiredText(params, "url", 1_000), input.platform);
      const limit = limitParam(params, input.defaultLimit, input.maxLimit);
      return {
        providerInput: compact({
          [input.field]: identity.id,
          [input.cursorField]: cursorParam(params),
          ...(input.countField ? { [input.countField]: limit } : {}),
        }),
        resultLimit: limit,
        canonicalLinks: [identity.url],
      };
    },
  };
}

function linkedInUrlAction(
  id: string,
  description: string,
  endpoint: string,
  kind: "person" | "company" | "post",
): ManagedCapabilityActionSpec {
  return {
    id,
    source: "linkedin",
    description,
    params: URL_PARAMS,
    provider: TIKHUB,
    endpoint,
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["url"]);
      const url = linkedinUrl(requiredText(params, "url", 1_000), kind);
      return { providerInput: { url }, resultLimit: 1, canonicalLinks: [url] };
    },
  };
}

function linkedInUrlListAction(
  id: string,
  description: string,
  endpoint: string,
  kind: "person" | "company" | "post",
  defaultLimit = 10,
): ManagedCapabilityActionSpec {
  return {
    id,
    source: "linkedin",
    description,
    params: URL_LIMIT_PARAMS,
    provider: TIKHUB,
    endpoint,
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["url", "limit"]);
      const url = linkedinUrl(requiredText(params, "url", 1_000), kind);
      return {
        providerInput: { url },
        resultLimit: limitParam(params, defaultLimit, defaultLimit),
        canonicalLinks: [url],
      };
    },
  };
}

function youtubeSearchAction(
  id: string,
  description: string,
  endpoint: string,
): ManagedCapabilityActionSpec {
  return {
    id,
    source: "youtube",
    description,
    params: SEARCH_PARAMS,
    provider: TIKHUB,
    endpoint,
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["query", "cursor", "limit"]);
      return {
        providerInput: compact({
          keyword: optionalText(params, "cursor", 2_000)
            ? undefined
            : requiredText(params, "query", 300),
          continuation_token: cursorParam(params),
        }),
        resultLimit: limitParam(params, 10, 10),
        canonicalLinks: [],
      };
    },
  };
}

function youtubeVideoAction(
  id: string,
  description: string,
  endpoint: string,
): ManagedCapabilityActionSpec {
  return {
    id,
    source: "youtube",
    description,
    params: VIDEO_PARAMS,
    provider: TIKHUB,
    endpoint,
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["video"]);
      const video = parseContentIdentity(requiredText(params, "video", 1_000), "youtube_video");
      return {
        providerInput: { video_id: video.id },
        resultLimit: 1,
        canonicalLinks: [video.url],
      };
    },
  };
}

function youtubeVideoListAction(
  id: string,
  description: string,
  endpoint: string,
  defaultLimit: number,
): ManagedCapabilityActionSpec {
  return {
    id,
    source: "youtube",
    description,
    params: VIDEO_LIST_PARAMS,
    provider: TIKHUB,
    endpoint,
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["video", "cursor", "limit"]);
      const video = parseContentIdentity(requiredText(params, "video", 1_000), "youtube_video");
      return {
        providerInput: compact({
          video_id: video.id,
          continuation_token: cursorParam(params),
        }),
        resultLimit: limitParam(params, defaultLimit, defaultLimit),
        canonicalLinks: [video.url],
      };
    },
  };
}

function youtubeChannelAction(
  id: string,
  description: string,
  endpoint: string,
  list: boolean,
): ManagedCapabilityActionSpec {
  return {
    id,
    source: "youtube",
    description,
    params: list ? YOUTUBE_CHANNEL_LIST_PARAMS : YOUTUBE_CHANNEL_PARAMS,
    provider: TIKHUB,
    endpoint,
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, list ? ["profile", "cursor", "limit"] : ["profile"]);
      const channel = youtubeChannel(requiredText(params, "profile", 1_000));
      return {
        providerInput: compact({
          channel_id: channel.id,
          continuation_token: list ? cursorParam(params) : undefined,
        }),
        resultLimit: list ? limitParam(params, 10, 10) : 1,
        canonicalLinks: [channel.url],
      };
    },
  };
}

function instagramSearchAction(
  id: string,
  description: string,
  endpoint: string,
): ManagedCapabilityActionSpec {
  return {
    id,
    source: "instagram",
    description,
    params: SEARCH_PARAMS,
    provider: TIKHUB,
    endpoint,
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["query", "cursor", "limit"]);
      return {
        providerInput: compact({
          keyword: requiredText(params, "query", 300),
          pagination_token: cursorParam(params),
        }),
        resultLimit: limitParam(params, 12, 12),
        canonicalLinks: [],
      };
    },
  };
}

function instagramProfileAction(
  id: string,
  description: string,
  endpoint: string,
  list: boolean,
): ManagedCapabilityActionSpec {
  return {
    id,
    source: "instagram",
    description,
    params: list ? PROFILE_LIST_PARAMS : PROFILE_PARAMS,
    provider: TIKHUB,
    endpoint,
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, list ? ["profile", "cursor", "limit"] : ["profile"]);
      const profile = parseProfileIdentity(requiredText(params, "profile", 500), "instagram");
      return {
        providerInput: compact({
          username: profile.id,
          pagination_token: list ? cursorParam(params) : undefined,
        }),
        resultLimit: list ? limitParam(params, 12, 12) : 1,
        canonicalLinks: [profile.url],
      };
    },
  };
}

function instagramPostAction(
  id: string,
  description: string,
  endpoint: string,
  list: boolean,
): ManagedCapabilityActionSpec {
  return {
    id,
    source: "instagram",
    description,
    params: list ? CONTENT_LIST_PARAMS : CONTENT_PARAMS,
    provider: TIKHUB,
    endpoint,
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, list ? ["url", "cursor", "limit"] : ["url"]);
      const post = parseContentIdentity(requiredText(params, "url", 1_000), "instagram_post");
      return {
        providerInput: compact({
          code_or_url: post.id,
          ...(list ? { sort_by: "recent", pagination_token: cursorParam(params) } : {}),
        }),
        resultLimit: list ? limitParam(params, 20, 20) : 1,
        canonicalLinks: [post.url],
      };
    },
  };
}

function tiktokSearchAction(
  id: string,
  description: string,
  endpoint: string,
  supportsRegion = false,
): ManagedCapabilityActionSpec {
  return {
    id,
    source: "tiktok",
    description,
    params: {
      ...SEARCH_PARAMS,
      properties: {
        ...SEARCH_PARAMS.properties,
        ...(supportsRegion
          ? {
              region: {
                type: "string",
                pattern: "^[A-Z]{2}$",
                description: "ISO 3166-1 alpha-2 country code.",
              },
            }
          : {}),
      },
    },
    provider: TIKHUB,
    endpoint,
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, [
        "query",
        "cursor",
        "limit",
        ...(supportsRegion ? ["region"] : []),
      ]);
      const limit = limitParam(params, 12, 12);
      const cursor = cursorParam(params);
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) {
        throw new GoatActionInvalidParamsError(
          '"cursor" must be the numeric offset returned by TikTok.',
        );
      }
      const region = supportsRegion ? (optionalText(params, "region", 2) ?? "US") : undefined;
      if (region !== undefined && !/^[A-Z]{2}$/.test(region)) {
        throw new GoatActionInvalidParamsError('"region" must be a two-letter uppercase code.');
      }
      return {
        providerInput: compact({
          keyword: requiredText(params, "query", 300),
          offset,
          count: limit,
          region,
        }),
        resultLimit: limit,
        canonicalLinks: [],
      };
    },
  };
}

function noInputAction(
  id: string,
  source: GoatManagedCapabilitySource,
  description: string,
  endpoint: string,
  defaultLimit: number,
): ManagedCapabilityActionSpec {
  return {
    id,
    source,
    description,
    params: {
      type: "object",
      additionalProperties: false,
      properties: { limit: LIMIT_SCHEMA },
    },
    provider: TIKHUB,
    endpoint,
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["limit"]);
      return {
        providerInput: {},
        resultLimit: limitParam(params, defaultLimit, defaultLimit),
        canonicalLinks: [],
      };
    },
  };
}

function seoDomainOverviewAction(input: {
  id: string;
  description: string;
  endpoint: string;
}): ManagedCapabilityActionSpec {
  return {
    id: input.id,
    source: "seo",
    description: input.description,
    params: {
      type: "object",
      additionalProperties: false,
      properties: {
        domain: SEO_DOMAIN_SCHEMA,
        country: SEO_COUNTRY_SCHEMA,
      },
      required: ["domain"],
    },
    provider: SEMRUSH,
    endpoint: input.endpoint,
    priceType: "PER_CALL",
    executionMode: "sync",
    inputLocation: "queryParams",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["domain", "country"]);
      const domain = seoDomain(params);
      return {
        providerInput: {
          domain,
          database: seoDatabase(params),
        },
        resultLimit: 1,
        canonicalLinks: [seoHomepage(domain)],
      };
    },
  };
}

function seoDomainListAction(input: {
  id: string;
  description: string;
  endpoint: string;
  priceType: "PER_RESULT";
}): ManagedCapabilityActionSpec {
  return {
    id: input.id,
    source: "seo",
    description: input.description,
    params: {
      type: "object",
      additionalProperties: false,
      properties: {
        domain: SEO_DOMAIN_SCHEMA,
        country: SEO_COUNTRY_SCHEMA,
        limit: SEO_LIMIT_SCHEMA,
      },
      required: ["domain"],
    },
    provider: SEMRUSH,
    endpoint: input.endpoint,
    priceType: input.priceType,
    executionMode: "sync",
    inputLocation: "queryParams",
    mapInput: (raw) => {
      const params = checkedParams(raw, ["domain", "country", "limit"]);
      const domain = seoDomain(params);
      const limit = limitParam(params, 10, 10);
      return {
        providerInput: {
          domain,
          database: seoDatabase(params),
          display_limit: limit,
        },
        resultLimit: limit,
        canonicalLinks: [seoHomepage(domain)],
      };
    },
  };
}

function checkedParams(raw: Record<string, unknown>, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(raw).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new GoatActionInvalidParamsError(
      `Unknown parameter${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
    );
  }
  return raw;
}

function requiredText(params: Record<string, unknown>, key: string, maxLength: number) {
  const value = optionalText(params, key, maxLength);
  if (!value) throw new GoatActionInvalidParamsError(`"${key}" is required.`);
  return value;
}

function optionalText(params: Record<string, unknown>, key: string, maxLength: number) {
  const value = params[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new GoatActionInvalidParamsError(`"${key}" must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) {
    throw new GoatActionInvalidParamsError(`"${key}" must be at most ${maxLength} characters.`);
  }
  return trimmed;
}

function cursorParam(params: Record<string, unknown>) {
  return optionalText(params, "cursor", 2_000);
}

function limitParam(params: Record<string, unknown>, defaultValue: number, maxValue: number) {
  const value = params.limit;
  if (value === undefined || value === null) return defaultValue;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maxValue) {
    throw new GoatActionInvalidParamsError(`"limit" must be an integer from 1 to ${maxValue}.`);
  }
  return value as number;
}

function integerParam(
  params: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  defaultValue: number,
) {
  const value = params[key];
  if (value === undefined || value === null) return defaultValue;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new GoatActionInvalidParamsError(`"${key}" must be an integer from ${min} to ${max}.`);
  }
  return value as number;
}

function optionalIntegerParam(
  params: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
) {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new GoatActionInvalidParamsError(`"${key}" must be an integer from ${min} to ${max}.`);
  }
  return value as number;
}

function optionalBooleanParam(params: Record<string, unknown>, key: string) {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new GoatActionInvalidParamsError(`"${key}" must be a boolean.`);
  }
  return value;
}

function lowercaseTextListParam(
  params: Record<string, unknown>,
  key: string,
  maxItems: number,
  maxItemLength: number,
) {
  const value = params[key];
  if (value === undefined || value === null) return [] as string[];
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) {
    throw new GoatActionInvalidParamsError(`"${key}" must contain from 1 to ${maxItems} strings.`);
  }
  const normalized = value.map((entry) => {
    if (typeof entry !== "string") {
      throw new GoatActionInvalidParamsError(`"${key}" must contain only strings.`);
    }
    const text = entry.trim().toLowerCase();
    if (!text || text.length > maxItemLength) {
      throw new GoatActionInvalidParamsError(
        `Each "${key}" value must be from 1 to ${maxItemLength} characters.`,
      );
    }
    return text;
  });
  return [...new Set(normalized)];
}

function enumListParam<T extends string>(
  params: Record<string, unknown>,
  key: string,
  values: readonly T[],
  maxItems: number,
) {
  const entries = lowercaseTextListParam(params, key, maxItems, 100);
  if (entries.some((entry) => !values.includes(entry as T))) {
    throw new GoatActionInvalidParamsError(`"${key}" values must be one of: ${values.join(", ")}.`);
  }
  return entries as T[];
}

function pdlAnyOf(queries: Record<string, unknown>[]) {
  return { bool: { should: queries, minimum_should_match: 1 } };
}

function pdlLocationFilter(locations: string[], fields: string[]) {
  return pdlAnyOf(
    locations.flatMap((location) => fields.map((field) => ({ term: { [field]: location } }))),
  );
}

function seoDatabase(params: Record<string, unknown>) {
  const country = optionalText(params, "country", 2) ?? "US";
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new GoatActionInvalidParamsError('"country" must be a two-letter uppercase code.');
  }
  return country === "GB" ? "uk" : country.toLowerCase();
}

function seoCountry(params: Record<string, unknown>) {
  const country = optionalText(params, "country", 2) ?? "US";
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new GoatActionInvalidParamsError('"country" must be a two-letter uppercase code.');
  }
  return country === "GB" ? "UK" : country;
}

function seoDomain(params: Record<string, unknown>) {
  const value = requiredText(params, "domain", 1_000);
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new GoatActionInvalidParamsError('"domain" must be a valid public domain or HTTPS URL.');
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname === "localhost"
  ) {
    throw new GoatActionInvalidParamsError('"domain" must be a valid public domain or HTTPS URL.');
  }
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  const labels = hostname.split(".");
  if (
    hostname.length > 253 ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw new GoatActionInvalidParamsError('"domain" must be a valid public domain or HTTPS URL.');
  }
  return hostname;
}

function seoHomepage(domain: string) {
  return `https://${domain}/`;
}

function enumParam<T extends string>(
  params: Record<string, unknown>,
  key: string,
  values: readonly T[],
  defaultValue: T | undefined,
  map?: Partial<Record<T, string>>,
) {
  const value = params[key];
  if (value === undefined || value === null || value === "") {
    return defaultValue === undefined ? undefined : (map?.[defaultValue] ?? defaultValue);
  }
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new GoatActionInvalidParamsError(`"${key}" must be one of: ${values.join(", ")}.`);
  }
  return map?.[value as T] ?? value;
}

function parseProfileIdentity(value: string, platform: "x" | "instagram" | "tiktok") {
  let id = value.replace(/^@/, "");
  if (/^https?:\/\//i.test(value)) {
    const url = safeUrl(value);
    const allowedHosts =
      platform === "x"
        ? ["x.com", "twitter.com"]
        : platform === "instagram"
          ? ["instagram.com"]
          : ["tiktok.com"];
    assertHost(url, allowedHosts);
    const parts = url.pathname.split("/").filter(Boolean);
    id =
      platform === "tiktok"
        ? (parts.find((part) => part.startsWith("@")) ?? "").slice(1)
        : (parts[0] ?? "");
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) {
    throw new GoatActionInvalidParamsError("The profile URL or username is invalid.");
  }
  const url =
    platform === "x"
      ? `https://x.com/${id}`
      : platform === "instagram"
        ? `https://www.instagram.com/${id}/`
        : `https://www.tiktok.com/@${id}`;
  return { id, url };
}

function parseContentIdentity(
  value: string,
  platform: "x_post" | "youtube_video" | "instagram_post" | "tiktok_video",
) {
  let id = value;
  let canonicalContext: string | null = null;
  if (/^https?:\/\//i.test(value)) {
    const url = safeUrl(value);
    if (platform === "x_post") {
      assertHost(url, ["x.com", "twitter.com"]);
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
      canonicalContext = match?.[1] ?? null;
      id = match?.[2] ?? "";
    } else if (platform === "youtube_video") {
      assertHost(url, ["youtube.com", "youtu.be"]);
      id = url.hostname.toLowerCase().endsWith("youtu.be")
        ? (url.pathname.split("/").filter(Boolean)[0] ?? "")
        : (url.searchParams.get("v") ??
          url.pathname.match(/\/(?:shorts|live|embed)\/([A-Za-z0-9_-]+)/)?.[1] ??
          "");
    } else if (platform === "instagram_post") {
      assertHost(url, ["instagram.com"]);
      const match = url.pathname.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
      canonicalContext = match?.[1] ?? null;
      id = match?.[2] ?? "";
    } else {
      assertHost(url, ["tiktok.com"]);
      const match = url.pathname.match(/^\/@([^/]+)\/video\/(\d+)/);
      canonicalContext = match?.[1] ?? null;
      id = match?.[2] ?? "";
    }
  }
  const pattern =
    platform === "youtube_video"
      ? /^[A-Za-z0-9_-]{6,32}$/
      : platform === "instagram_post"
        ? /^[A-Za-z0-9_-]{5,64}$/
        : /^\d{5,30}$/;
  if (!pattern.test(id)) {
    throw new GoatActionInvalidParamsError("The content URL or identifier is invalid.");
  }
  const url =
    platform === "x_post"
      ? `https://x.com/${canonicalContext ?? "i"}/status/${id}`
      : platform === "youtube_video"
        ? `https://www.youtube.com/watch?v=${id}`
        : platform === "instagram_post"
          ? `https://www.instagram.com/${canonicalContext ?? "p"}/${id}/`
          : `https://www.tiktok.com/@${canonicalContext ?? "_"}/video/${id}`;
  return { id, url };
}

function linkedinUrl(value: string, kind: "person" | "company" | "post") {
  const url = safeUrl(value);
  assertHost(url, ["linkedin.com"]);
  const allowed =
    kind === "person"
      ? /^\/in\/[^/]+\/?$/
      : kind === "company"
        ? /^\/company\/[^/]+\/?$/
        : /^\/(?:posts|feed\/update|pulse)\/.+/;
  if (!allowed.test(url.pathname)) {
    throw new GoatActionInvalidParamsError(`Expected a LinkedIn ${kind} URL.`);
  }
  url.protocol = "https:";
  url.hostname = "www.linkedin.com";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function linkedInSlug(value: string, segment: "in" | "company") {
  const url = new URL(value);
  const parts = url.pathname.split("/").filter(Boolean);
  const index = parts.indexOf(segment);
  const slug = index >= 0 ? parts[index + 1] : undefined;
  if (!slug) throw new GoatActionInvalidParamsError("The LinkedIn URL is missing its slug.");
  return slug;
}

function linkedInPostId(value: string) {
  const url = new URL(value);
  const decodedPath = decodeURIComponent(url.pathname);
  const id =
    decodedPath.match(/urn:li:(?:activity|ugcPost|share):(\d+)/)?.[1] ??
    decodedPath.match(/-(\d{5,30})(?:\/)?$/)?.[1];
  if (!id) {
    throw new GoatActionInvalidParamsError(
      "The LinkedIn post URL must contain its numeric activity or post ID.",
    );
  }
  return id;
}

function youtubeChannel(value: string) {
  if (/^UC[A-Za-z0-9_-]{20,30}$/.test(value)) {
    return { id: value, url: `https://www.youtube.com/channel/${value}` };
  }
  const url = safeUrl(value);
  assertHost(url, ["youtube.com"]);
  const match = url.pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{20,30})\/?$/);
  if (!match?.[1]) {
    throw new GoatActionInvalidParamsError(
      "Use a YouTube channel ID or a /channel/UC... URL for this action.",
    );
  }
  return { id: match[1], url: `https://www.youtube.com/channel/${match[1]}` };
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("bad protocol");
    return url;
  } catch {
    throw new GoatActionInvalidParamsError("Expected a valid public HTTPS URL.");
  }
}

function assertHost(url: URL, allowedRoots: readonly string[]) {
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!allowedRoots.some((root) => hostname === root || hostname.endsWith(`.${root}`))) {
    throw new GoatActionInvalidParamsError(
      `URL host ${JSON.stringify(url.hostname)} is not allowed for this action.`,
    );
  }
}

function compact(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
