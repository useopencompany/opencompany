import { jsonSchema, tool } from "ai";
import type { GoatCapabilityDefinition } from "@/lib/capabilities/types";

const MAX_TRANSCRIPT_CHARS = 24_000;

export const youtubeTranscriptCapability: GoatCapabilityDefinition = {
  id: "youtube_transcript",
  sideEffect: "read",
  workerModel: "openai/gpt-5.4-mini",
  async resolve() {
    if (!process.env.SUPADATA_API_KEY?.trim()) return null;

    return {
      indexLine:
        "youtube_transcript — fetches the transcript of a public YouTube video given its URL or video id. CANNOT search YouTube, list videos, or access private videos.",
      recipeLines: [
        "Fetch the transcript once, then answer the request from it: quote or summarize only what was asked.",
        'Cite the video as an entity: type "youtube_video", id set to the video id or URL, url set to the video URL.',
      ],
      createTools: async (context) => ({
        tools: {
          youtube_get_transcript: tool({
            description: "Fetch the transcript of a public YouTube video.",
            inputSchema: jsonSchema<{ url?: string; videoId?: string; lang?: string }>({
              type: "object",
              additionalProperties: false,
              properties: {
                url: { type: "string", description: "Full YouTube video URL." },
                videoId: { type: "string", description: "YouTube video id (instead of url)." },
                lang: { type: "string", description: "Preferred transcript language code." },
              },
            }),
            execute: async (args) => {
              if (!args.url && !args.videoId) {
                throw new Error("youtube_get_transcript requires url or videoId.");
              }
              const endpoint = new URL("https://api.supadata.ai/v1/transcript");
              if (args.url) endpoint.searchParams.set("url", args.url);
              if (args.videoId) endpoint.searchParams.set("videoId", args.videoId);
              if (args.lang) endpoint.searchParams.set("lang", args.lang);
              endpoint.searchParams.set("text", "true");

              const response = await fetch(endpoint, {
                headers: {
                  "x-api-key": process.env.SUPADATA_API_KEY?.trim() ?? "",
                  Accept: "application/json",
                },
                signal: context.signal,
              });
              if (!response.ok) {
                throw new Error(`Transcript fetch failed with ${response.status}.`);
              }
              const body = (await response.json()) as { content?: unknown; lang?: unknown };
              const content = typeof body.content === "string" ? body.content : "";
              return {
                transcript:
                  content.length > MAX_TRANSCRIPT_CHARS
                    ? `${content.slice(0, MAX_TRANSCRIPT_CHARS)}… [truncated]`
                    : content,
                lang: typeof body.lang === "string" ? body.lang : undefined,
              };
            },
          }),
        },
      }),
    };
  },
};
