import { describe, expect, it } from "vitest";
import { GoatActionInvalidParamsError } from "@/lib/actions/types";
import {
  MANAGED_CAPABILITY_ACTIONS,
  managedCapabilityContractProbeParams,
} from "@/lib/capabilities/catalog";

describe("managed capability catalog", () => {
  it("contains only the reviewed fixed action and endpoint allowlist", () => {
    expect(MANAGED_CAPABILITY_ACTIONS).toHaveLength(42);
    expect(new Set(MANAGED_CAPABILITY_ACTIONS.map((action) => action.id)).size).toBe(42);
    expect(
      Object.fromEntries(
        MANAGED_CAPABILITY_ACTIONS.map((action) => [
          action.id,
          `${action.provider}:${action.endpoint}`,
        ]),
      ),
    ).toMatchObject({
      "x.search_posts": "tikhub:/api/v1/twitter/web/fetch_search_timeline",
      "linkedin.get_person_profile": "tikhub:/api/v1/linkedin/web_v2/get_user_profile",
      "youtube.get_transcript": "tikhub:/api/v1/youtube/web_v2/get_video_captions",
      "instagram.search_reels": "tikhub:/api/v1/instagram/v2/search_reels",
      "tiktok.get_search_trends": "tikhub:/api/v1/tiktok/web/fetch_trending_searchwords",
      "lead.enrich_person": "pdl:/v5/person/enrich",
      "lead.search_people_by_name": "apify:/harvestapi/linkedin-profile-search-by-name",
      "lead.list_company_employees": "apify:/harvestapi/linkedin-company-employees",
    });
  });

  it("validates and maps every adapter while enforcing the product caps", () => {
    for (const action of MANAGED_CAPABILITY_ACTIONS) {
      const mapped = action.mapInput(managedCapabilityContractProbeParams(action.id));
      expect(mapped.providerInput).toBeTypeOf("object");
      expect(mapped.resultLimit).toBeGreaterThan(0);
      expect(mapped.resultLimit).toBeLessThanOrEqual(maxResultLimit(action.id));
      expect(() =>
        action.mapInput({
          ...managedCapabilityContractProbeParams(action.id),
          arbitraryProviderField: "blocked",
        }),
      ).toThrow(GoatActionInvalidParamsError);
    }
  });

  it("rejects cross-platform and non-public URL shapes", () => {
    expect(() =>
      action("x.get_post").mapInput({ url: "https://example.com/openai/status/1" }),
    ).toThrow(/not allowed/i);
    expect(() =>
      action("linkedin.get_person_profile").mapInput({
        url: "https://linkedin.com/company/openai",
      }),
    ).toThrow(/person/i);
    expect(() =>
      action("youtube.get_video").mapInput({
        video: "https://youtube.com/channel/UC123",
      }),
    ).toThrow(/content URL or identifier/i);
    expect(() =>
      action("instagram.get_post").mapInput({
        url: "http://instagram.com/p/ABC123/",
      }),
    ).toThrow(/HTTPS/i);
    expect(() =>
      action("tiktok.get_video").mapInput({
        url: "https://tiktok.com/@openai",
      }),
    ).toThrow(/content URL or identifier/i);
  });

  it("normalizes canonical public links and never accepts follower exports", () => {
    expect(
      action("x.get_post").mapInput({
        url: "https://twitter.com/openai/status/123456789?utm_source=test",
      }).canonicalLinks,
    ).toEqual(["https://x.com/openai/status/123456789"]);
    expect(MANAGED_CAPABILITY_ACTIONS.map((entry) => entry.id).join(" ")).not.toMatch(
      /followers|following|post_|message|engage/i,
    );
  });

  it("maps only reviewed pagination shapes and rejects malformed cursors", () => {
    expect(
      action("x.search_posts").mapInput({ query: "openai", cursor: "next-x" }).providerInput,
    ).toMatchObject({ cursor: "next-x" });
    expect(
      action("youtube.search").mapInput({
        query: "openai",
        cursor: "next-youtube",
      }).providerInput,
    ).toEqual({ continuation_token: "next-youtube" });
    expect(
      action("instagram.list_posts").mapInput({
        profile: "openai",
        cursor: "next-instagram",
      }).providerInput,
    ).toMatchObject({ pagination_token: "next-instagram" });
    expect(
      action("tiktok.search_videos").mapInput({
        query: "openai",
        cursor: "12",
      }).providerInput,
    ).toMatchObject({ offset: 12, region: "US" });
    expect(
      action("tiktok.search_creators").mapInput({
        query: "openai",
      }).providerInput,
    ).toEqual({ keyword: "openai", offset: 0, count: 12 });
    expect(() =>
      action("tiktok.search_videos").mapInput({
        query: "openai",
        cursor: "opaque-cursor",
      }),
    ).toThrow(/numeric offset/i);
    expect(
      (action("linkedin.list_person_posts").params.properties as Record<string, unknown>).cursor,
    ).toBeUndefined();
  });

  it("maps live provider-specific identifiers and reviewed enum values", () => {
    expect(
      action("linkedin.search_posts").mapInput({
        query: "founding CTO",
        sort: "recent",
      }).providerInput,
    ).toEqual({
      keyword: "founding CTO",
      page: 1,
      sort_by: "date_posted",
    });
    expect(
      action("linkedin.search_posts").mapInput({
        query: "founding CTO",
        sort: "relevant",
      }).providerInput,
    ).toEqual({
      keyword: "founding CTO",
      page: 1,
      sort_by: "relevance",
    });
    expect(
      (action("linkedin.search_posts").params.properties as Record<string, unknown>).cursor,
    ).toBeUndefined();
    expect(
      action("linkedin.list_comments").mapInput({
        url: "https://www.linkedin.com/feed/update/urn:li:activity:7244804629786419202",
      }).providerInput,
    ).toEqual({ post_id: "7244804629786419202" });
    expect(
      action("tiktok.get_video").mapInput({
        url: "https://www.tiktok.com/@openai/video/7331234567890123456",
      }).providerInput,
    ).toEqual({ itemId: "7331234567890123456" });
    expect(
      action("lead.list_company_employees").mapInput({
        companyUrl: "https://www.linkedin.com/company/openai",
      }).providerInput,
    ).toMatchObject({
      profileScraperMode: "Full + email search ($12 per 1k)",
    });
  });

  it("makes the YouTube channel-search handoff explicit and directly usable", () => {
    const channelId = `UC${"a".repeat(22)}`;
    const searchResult = {
      channels: [{ channel_id: channelId, channel_url: "https://www.youtube.com/@openai" }],
    };
    const searchChannels = action("youtube.search_channels");
    const listChannelVideos = action("youtube.list_channel_videos");
    const profileSchema = (
      listChannelVideos.params.properties as Record<string, { description?: string }>
    ).profile;

    expect(searchChannels.description).toContain("payload.channels[].channel_id");
    expect(profileSchema?.description).toContain("payload.channels[].channel_id");
    expect(profileSchema?.description).toContain("handles and /@handle URLs are not accepted");
    expect(
      listChannelVideos.mapInput({
        profile: searchResult.channels[0]!.channel_id,
        limit: 5,
      }),
    ).toMatchObject({
      providerInput: { channel_id: channelId },
      resultLimit: 5,
      canonicalLinks: [`https://www.youtube.com/channel/${channelId}`],
    });
  });
});

function action(id: string) {
  const value = MANAGED_CAPABILITY_ACTIONS.find((entry) => entry.id === id);
  if (!value) throw new Error(`Missing action ${id}`);
  return value;
}

function maxResultLimit(id: string) {
  if (id === "lead.search_people_by_name") return 5;
  if (id === "lead.list_company_employees") return 10;
  if (id.endsWith("comments") || id.endsWith("replies")) return 20;
  if (id.startsWith("x.")) return 20;
  if (id.startsWith("instagram.") || id.startsWith("tiktok.")) return 12;
  return 10;
}
