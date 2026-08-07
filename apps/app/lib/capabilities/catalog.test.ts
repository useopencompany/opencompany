import { ActionInvalidParamsError } from "@opencompany/core/actions/types";
import { describe, expect, it } from "vitest";
import {
  MANAGED_CAPABILITY_ACTIONS,
  MANAGED_CAPABILITY_SOURCE_DETAILS,
  managedCapabilityContractProbeParams,
} from "@/lib/capabilities/catalog";
import { MAX_CAPABILITY_PAYLOAD_STRING_CHARS } from "@/lib/capabilities/sanitize";

describe("managed capability catalog", () => {
  it("contains only the reviewed fixed action and endpoint allowlist", () => {
    expect(MANAGED_CAPABILITY_ACTIONS).toHaveLength(52);
    expect(new Set(MANAGED_CAPABILITY_ACTIONS.map((action) => action.id)).size).toBe(52);
    expect(
      Object.fromEntries(
        MANAGED_CAPABILITY_ACTIONS.map((action) => [
          action.id,
          `${action.provider}:${action.endpoint}`,
        ]),
      ),
    ).toMatchObject({
      "x.search_posts": "tikhub:/api/v1/twitter/web/fetch_search_timeline",
      "x.search_profiles": "tikhub:/api/v1/twitter/web/fetch_search_timeline",
      "x.list_followers": "tikhub:/api/v1/twitter/web/fetch_user_followers",
      "linkedin.get_person_profile": "tikhub:/api/v1/linkedin/web_v2/get_user_profile",
      "youtube.get_transcript": "apify:/starvibe/youtube-video-transcript",
      "youtube.find_in_transcript": "apify:/starvibe/youtube-video-transcript",
      "instagram.search_reels": "tikhub:/api/v1/instagram/v2/search_reels",
      "tiktok.get_search_trends": "tikhub:/api/v1/tiktok/web/fetch_trending_searchwords",
      "lead.find_person_email": "pdl:/v5/person/enrich",
      "lead.search_prospects": "pdl:/v5/person/search",
      "lead.search_people_by_name": "apify:/harvestapi/linkedin-profile-search-by-name",
      "lead.list_company_employees": "apify:/harvestapi/linkedin-company-employees",
      "seo.get_domain_overview": "semrush:/domain_rank",
      "seo.list_ranking_keywords": "semrush:/domain_organic",
      "seo.list_top_pages": "semrush:/domain_organic_pages",
      "seo.list_organic_competitors": "semrush:/domain_organic_organic",
      "seo.get_keyword_metrics": "semrush:/keyword_metrics",
      "seo.get_backlink_overview": "semrush:/backlinks_overview",
    });
    expect(MANAGED_CAPABILITY_SOURCE_DETAILS.lead.description).toMatch(
      /look up work emails for known prospects/i,
    );
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
      ).toThrow(ActionInvalidParamsError);
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

  it("normalizes canonical public links and excludes private or mutating actions", () => {
    expect(
      action("x.get_post").mapInput({
        url: "https://twitter.com/openai/status/123456789?utm_source=test",
      }).canonicalLinks,
    ).toEqual(["https://x.com/openai/status/123456789"]);
    expect(MANAGED_CAPABILITY_ACTIONS.map((entry) => entry.id).join(" ")).not.toMatch(
      /following|post_|message|engage/i,
    );
  });

  it("maps only reviewed pagination shapes and rejects malformed cursors", () => {
    expect(
      action("x.search_posts").mapInput({ query: "openai", cursor: "next-x" }).providerInput,
    ).toMatchObject({ cursor: "next-x" });
    expect(
      action("x.search_profiles").mapInput({
        query: "AI founder",
        cursor: "next-people",
        limit: 10,
      }),
    ).toEqual({
      providerInput: {
        keyword: "AI founder",
        search_type: "People",
        cursor: "next-people",
      },
      resultLimit: 10,
      canonicalLinks: [],
    });
    expect(
      action("x.list_followers").mapInput({
        profile: "https://twitter.com/openai",
        cursor: "next-followers",
        limit: 10,
      }),
    ).toEqual({
      providerInput: {
        screen_name: "openai",
        cursor: "next-followers",
      },
      resultLimit: 10,
      canonicalLinks: ["https://x.com/openai"],
    });
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

  it("maps structured prospect filters to a bounded PDL person search", () => {
    expect(
      action("lead.search_prospects").mapInput({
        jobTitles: ["CTO", "Chief Technology Officer", "CTO"],
        jobLevels: ["cxo"],
        companyLocations: ["Berlin"],
        companyIndustries: ["Computer Software"],
        maxCompanyEmployees: 4,
        requireWorkEmail: true,
        cursor: "104$14.278746",
        limit: 7,
      }),
    ).toEqual({
      providerInput: {
        query: {
          bool: {
            must: [
              {
                bool: {
                  should: [
                    { match_phrase: { "job_title.text": "cto" } },
                    { match_phrase: { "job_title.text": "chief technology officer" } },
                  ],
                  minimum_should_match: 1,
                },
              },
              { terms: { job_title_levels: ["cxo"] } },
              {
                bool: {
                  should: [
                    { term: { job_company_location_locality: "berlin" } },
                    { term: { job_company_location_region: "berlin" } },
                    { term: { job_company_location_country: "berlin" } },
                  ],
                  minimum_should_match: 1,
                },
              },
              {
                bool: {
                  should: [
                    { term: { job_company_industry: "computer software" } },
                    { term: { job_company_industry_v2: "computer software" } },
                  ],
                  minimum_should_match: 1,
                },
              },
              { range: { job_company_employee_count: { lte: 4 } } },
              { exists: { field: "work_email" } },
            ],
          },
        },
        size: 7,
        scroll_token: "104$14.278746",
        titlecase: true,
        data_include: expect.stringContaining("work_email"),
      },
      resultLimit: 7,
      canonicalLinks: [],
    });
  });

  it("maps a known prospect to a confidence-gated work-email lookup", () => {
    const findPersonEmail = action("lead.find_person_email");
    expect(findPersonEmail.description).toMatch(/known prospect's work email/i);
    expect(findPersonEmail.description).toMatch(/do not run a broader prospect search/i);
    expect(
      findPersonEmail.mapInput({
        name: "Ada Lovelace",
        company: "Analytical Engines",
        location: "London",
      }),
    ).toEqual({
      providerInput: {
        name: "Ada Lovelace",
        company: "Analytical Engines",
        location: "London",
        min_likelihood: 6,
        required: "work_email",
        titlecase: true,
        data_include: expect.stringContaining("work_email"),
      },
      resultLimit: 1,
      canonicalLinks: [],
    });
    expect(
      findPersonEmail.mapInput({
        linkedinUrl: "https://linkedin.com/in/ada-lovelace?trk=public",
      }),
    ).toMatchObject({
      providerInput: {
        profile: "https://www.linkedin.com/in/ada-lovelace",
        min_likelihood: 6,
        required: "work_email",
      },
      canonicalLinks: ["https://www.linkedin.com/in/ada-lovelace"],
    });
    expect(() => findPersonEmail.mapInput({ name: "Ada Lovelace" })).toThrow(
      /name with company or location/i,
    );
    expect(() =>
      findPersonEmail.mapInput({
        name: "Ada",
        company: "Analytical Engines",
      }),
    ).toThrow(/first and last name/i);
    expect(() =>
      findPersonEmail.mapInput({
        linkedinUrl: "https://example.com/ada",
      }),
    ).toThrow(/not allowed/i);
  });

  it("rejects unbounded or contradictory prospect searches", () => {
    const searchProspects = action("lead.search_prospects");
    expect(() => searchProspects.mapInput({ requireWorkEmail: true })).toThrow(
      /at least one title, seniority, location, industry, or employee-count filter/i,
    );
    expect(() =>
      searchProspects.mapInput({
        companyLocations: ["Berlin"],
        minCompanyEmployees: 10,
        maxCompanyEmployees: 4,
      }),
    ).toThrow(/cannot exceed/i);
    expect(() =>
      searchProspects.mapInput({
        jobLevels: ["executive"],
      }),
    ).toThrow(/jobLevels.*one of/i);
    expect(() =>
      searchProspects.mapInput({
        jobTitles: ["CTO"],
        limit: 11,
      }),
    ).toThrow(/1 to 10/i);
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

  it("maps full transcripts and transcript searches to the reviewed Apify actor", () => {
    const fullTranscript = action("youtube.get_transcript");
    const transcriptSearch = action("youtube.find_in_transcript");
    expect(fullTranscript).toMatchObject({
      provider: "apify",
      priceType: "PER_RESULT",
      executionMode: "async",
      inputLocation: "body",
      maxActionResultChars: 256_000,
    });
    expect(
      fullTranscript.mapInput({
        video: "dQw4w9WgXcQ",
        language: "en",
      }),
    ).toEqual({
      providerInput: {
        youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        language: "en",
      },
      resultLimit: 1,
      payloadArrayLimit: 20,
      payloadStringLimit: MAX_CAPABILITY_PAYLOAD_STRING_CHARS,
      discoverPayloadLinks: false,
      canonicalLinks: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    });
    expect(transcriptSearch).toMatchObject({
      provider: "apify",
      priceType: "PER_RESULT",
      executionMode: "async",
      inputLocation: "body",
    });
    expect(
      transcriptSearch.mapInput({
        video: "https://youtu.be/dQw4w9WgXcQ",
        query: "sponsor read",
        language: "en",
        contextSeconds: 45,
        maxMatches: 2,
      }),
    ).toEqual({
      providerInput: {
        youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        language: "en",
      },
      resultLimit: 1,
      payloadArrayLimit: 20,
      canonicalLinks: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    });
    expect(fullTranscript.description).toContain("complete plain-text transcript");
    expect(fullTranscript.description).toContain("youtube.find_in_transcript");
    expect(() =>
      fullTranscript.mapInput({
        video: "dQw4w9WgXcQ",
        language: "EN",
      }),
    ).toThrow(/lowercase two-letter/i);
    expect(() =>
      transcriptSearch.mapInput({
        video: "dQw4w9WgXcQ",
        query: "...",
      }),
    ).toThrow(/letter or number/i);
    expect(() =>
      transcriptSearch.mapInput({
        video: "dQw4w9WgXcQ",
        query: "sponsor",
        language: "EN",
      }),
    ).toThrow(/lowercase two-letter/i);
  });

  it("normalizes SEO targets and maps only the bounded Semrush inputs", () => {
    expect(
      MANAGED_CAPABILITY_ACTIONS.filter((entry) => entry.source === "seo").map(
        (entry) => entry.inputLocation,
      ),
    ).toEqual(Array(6).fill("queryParams"));
    expect(
      action("seo.list_ranking_keywords").mapInput({
        domain: "https://www.OpenAI.com/research/?utm_source=test",
        country: "UK",
        limit: 7,
      }),
    ).toEqual({
      providerInput: {
        domain: "openai.com",
        database: "uk",
        display_limit: 7,
      },
      resultLimit: 7,
      canonicalLinks: ["https://openai.com/"],
    });
    expect(
      action("seo.get_keyword_metrics").mapInput({
        keyword: "AI agents",
        country: "GB",
      }).providerInput,
    ).toEqual({ keyword: "AI agents", country: "UK" });
    expect(
      action("seo.get_keyword_metrics").mapInput({
        keyword: "AI agents",
      }).providerInput,
    ).toEqual({ keyword: "AI agents", country: "US" });
    expect(
      action("seo.get_backlink_overview").mapInput({
        domain: "openai.com",
      }).providerInput,
    ).toEqual({ url: "openai.com", scope: "ROOT_DOMAIN" });
  });

  it("rejects private, malformed, and oversized SEO requests", () => {
    expect(() =>
      action("seo.get_domain_overview").mapInput({ domain: "https://localhost" }),
    ).toThrow(/public domain/i);
    expect(() =>
      action("seo.get_domain_overview").mapInput({
        domain: "https://127.0.0.1",
      }),
    ).toThrow(/public domain/i);
    expect(() =>
      action("seo.list_top_pages").mapInput({
        domain: "openai.com",
        country: "us",
      }),
    ).toThrow(/two-letter uppercase/i);
    expect(() =>
      action("seo.list_organic_competitors").mapInput({
        domain: "openai.com",
        limit: 11,
      }),
    ).toThrow(/1 to 10/i);
  });
});

function action(id: string) {
  const value = MANAGED_CAPABILITY_ACTIONS.find((entry) => entry.id === id);
  if (!value) throw new Error(`Missing action ${id}`);
  return value;
}

function maxResultLimit(id: string) {
  if (id === "lead.search_people_by_name") return 5;
  if (id === "lead.search_prospects") return 10;
  if (id === "lead.list_company_employees") return 10;
  if (id.endsWith("comments") || id.endsWith("replies")) return 20;
  if (id.startsWith("x.")) return 20;
  if (id.startsWith("instagram.") || id.startsWith("tiktok.")) return 12;
  return 10;
}
