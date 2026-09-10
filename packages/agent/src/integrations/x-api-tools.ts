import { Buffer } from "node:buffer";
import * as z from "zod";
import type { CapabilityId } from "../actions/capabilities";
import { ActionInvalidParamsError } from "../actions/types";
import { type XAccessConnection, xAccountApiCall } from "./x-access-token";

const id = z.string().regex(/^[0-9]{1,19}$/);
const timestamp = z.iso.datetime({ offset: true });
const csv = z.string().trim().min(1).max(2_048);
const maxImageBytes = 5 * 1024 * 1024;

const createPost = z
  .strictObject({
    text: z.string().max(25_000).default(""),
    media_ids: z.array(id).min(1).max(4).optional(),
    reply_to_id: id.optional(),
    quote_tweet_id: id.optional(),
    poll: z
      .strictObject({
        options: z.array(z.string().trim().min(1).max(25)).min(2).max(4),
        duration_minutes: z.number().int().min(5).max(10_080),
      })
      .optional(),
    reply_settings: z.enum(["following", "mentionedUsers", "subscribers", "verified"]).optional(),
    made_with_ai: z.boolean().optional(),
    paid_partnership: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (!value.text.trim() && !value.media_ids?.length) {
      context.addIssue({ code: "custom", message: "Provide post text or uploaded media." });
    }
    if (value.poll && (value.media_ids || value.quote_tweet_id)) {
      context.addIssue({
        code: "custom",
        message: "A poll cannot be combined with media or a quote.",
      });
    }
    if (value.reply_to_id && value.quote_tweet_id) {
      context.addIssue({ code: "custom", message: "Choose either a reply or a quote." });
    }
  });

const recentSearch = z
  .strictObject({
    query: z.string().trim().min(1).max(4_096),
    max_results: z.number().int().min(10).max(100).optional(),
    next_token: csv.optional(),
    since_id: id.optional(),
    until_id: id.optional(),
    start_time: timestamp.optional(),
    end_time: timestamp.optional(),
    sort_order: z.enum(["recency", "relevancy"]).optional(),
    "post.fields": csv.optional(),
    expansions: csv.optional(),
    "user.fields": csv.optional(),
    "media.fields": csv.optional(),
  })
  .refine(validTimeRange, "start_time must precede end_time.");

const analytics = z
  .strictObject({
    ids: z.array(id).min(1).max(100),
    start_time: timestamp,
    end_time: timestamp,
    granularity: z.enum(["hourly", "daily", "weekly", "total"]).default("total"),
    "analytics.fields": csv.optional(),
  })
  .refine(validTimeRange, "start_time must precede end_time.");

function validTimeRange(value: { start_time?: string | undefined; end_time?: string | undefined }) {
  return (
    !value.start_time ||
    !value.end_time ||
    Date.parse(value.start_time) < Date.parse(value.end_time)
  );
}

type Tool = {
  name: string;
  description: string;
  capability: CapabilityId;
  scopes: readonly string[];
  schema: z.ZodType;
};

export const X_API_TOOLS: readonly Tool[] = [
  {
    name: "create_posts",
    description:
      "Publish one post to the connected X account, optionally with uploaded media, a poll, a quote, or a reply. Publishes immediately; never use for a draft request. Only publish when the user asks. Set image alt text before posting. X enforces account text limits and reply eligibility: self-serve replies require the original author to have mentioned the account or quoted its post. Do not blindly retry an interrupted publishing call; check the account's posts first.",
    capability: "write",
    scopes: ["tweet.read", "tweet.write", "users.read"],
    schema: createPost,
  },
  {
    name: "delete_posts",
    description:
      "Permanently delete one post owned by the connected X account. Requires the user's request to delete that post.",
    capability: "write",
    scopes: ["tweet.read", "tweet.write", "users.read"],
    schema: z.strictObject({ id }),
  },
  {
    name: "upload_image",
    description:
      "Upload a PNG or JPEG image (at most 5 MiB) to X without publishing it. Supply canonical base64 file content, without a data URL prefix. Returns an expiring media id for create_posts; use set_media_alt_text before publishing. The server cannot read files from the chat sandbox.",
    capability: "write",
    scopes: ["media.write"],
    schema: z.strictObject({
      media: z
        .string()
        .min(4)
        .max(4 * Math.ceil(maxImageBytes / 3)),
    }),
  },
  {
    name: "set_media_alt_text",
    description:
      "Set accessible alt text on an uploaded image before attaching it to a post. This does not publish a post.",
    capability: "write",
    scopes: ["media.write"],
    schema: z.strictObject({ media_id: id, alt_text: z.string().trim().min(1).max(1_000) }),
  },
  {
    name: "search_posts_recent",
    description:
      "Search X posts from the last seven days. Supports X query operators and pagination; pass the returned next_token to continue. API access and usage limits apply.",
    capability: "read",
    scopes: ["tweet.read", "users.read"],
    schema: recentSearch,
  },
  {
    name: "get_posts_analytics",
    description:
      "Read time-based analytics for up to 100 posts accessible to the connected account. Specify an explicit time range. Metrics depend on X account access; missing metrics are not zero.",
    capability: "query",
    scopes: ["tweet.read", "users.read"],
    schema: analytics,
  },
];

export function xApiToolDefinitions() {
  return X_API_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.schema, { io: "input" }),
    annotations: {
      readOnlyHint: tool.capability !== "write",
      destructiveHint: tool.name === "delete_posts",
      idempotentHint: tool.capability !== "write" || tool.name === "set_media_alt_text",
      openWorldHint: true,
    },
  }));
}

export async function executeXApiTool(input: {
  name: string;
  params: unknown;
  connection: XAccessConnection;
  signal?: AbortSignal | undefined;
  apiCall?: typeof xAccountApiCall;
}) {
  const tool = X_API_TOOLS.find((entry) => entry.name === input.name);
  if (!tool) throw new ActionInvalidParamsError("Unknown X API tool.");
  const parsed = tool.schema.safeParse(input.params);
  if (!parsed.success) {
    throw new ActionInvalidParamsError(z.prettifyError(parsed.error));
  }
  const value = parsed.data as Record<string, unknown>;
  let method = "GET";
  let path: string;
  let body: unknown;
  switch (input.name) {
    case "create_posts": {
      const { media_ids, reply_to_id, ...post } = createPost.parse(value);
      method = "POST";
      path = "/2/tweets";
      body = {
        ...post,
        ...(media_ids ? { media: { media_ids } } : {}),
        ...(reply_to_id ? { reply: { in_reply_to_tweet_id: reply_to_id } } : {}),
      };
      break;
    }
    case "delete_posts":
      method = "DELETE";
      path = `/2/tweets/${value.id}`;
      break;
    case "upload_image": {
      const media = value.media as string;
      const bytes = Buffer.from(media, "base64");
      if (bytes.length > maxImageBytes || bytes.toString("base64") !== media) {
        throw new ActionInvalidParamsError("Provide canonical base64 for an image at most 5 MiB.");
      }
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (!png && !jpeg)
        throw new ActionInvalidParamsError("Only PNG and JPEG images are supported.");
      method = "POST";
      path = "/2/media/upload";
      body = { media, media_category: "tweet_image" };
      break;
    }
    case "set_media_alt_text":
      method = "POST";
      path = "/2/media/metadata";
      body = { id: value.media_id, metadata: { alt_text: { text: value.alt_text } } };
      break;
    case "search_posts_recent":
      path = "/2/tweets/search/recent";
      break;
    case "get_posts_analytics":
      path = "/2/tweets/analytics";
      break;
    default:
      throw new ActionInvalidParamsError("Unknown X API tool.");
  }
  const url = new URL(path, "https://api.x.com");
  if (method === "GET") {
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined)
        url.searchParams.set(key, Array.isArray(entry) ? entry.join(",") : String(entry));
    }
  }
  const result = await (input.apiCall ?? xAccountApiCall)(input.connection, method, url, {
    ...(input.signal ? { signal: input.signal } : {}),
    ...(body !== undefined ? { body } : {}),
  });
  // Preserve X's partial read results and errors. For a mutation, missing confirmation must
  // never be presented as success or trigger an automatic repeat of the write.
  if (
    input.name === "create_posts" ||
    input.name === "upload_image" ||
    input.name === "set_media_alt_text"
  ) {
    const confirmed = z
      .object({ data: z.object({ id }).passthrough() })
      .passthrough()
      .safeParse(result);
    if (!confirmed.success)
      throw new Error("X did not confirm the created resource. Check the account before retrying.");
    if (input.name === "set_media_alt_text" && confirmed.data.data.id !== value.media_id) {
      throw new Error("X did not confirm metadata for the requested image.");
    }
    if (input.name === "create_posts") {
      return {
        ...confirmed.data,
        data: { ...confirmed.data.data, url: `https://x.com/i/status/${confirmed.data.data.id}` },
      };
    }
  }
  if (
    input.name === "delete_posts" &&
    !z.object({ data: z.object({ deleted: z.literal(true) }) }).safeParse(result).success
  ) {
    throw new Error("X did not confirm that the post was deleted.");
  }
  return result;
}
