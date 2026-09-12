import { beforeEach, describe, expect, it, vi } from "vitest";
import WikiPage from "./page";

const listHeadlessWikisMock = vi.hoisted(() => vi.fn());
const listHeadlessWikiPagesMock = vi.hoisted(() => vi.fn());
const currentUserMock = vi.hoisted(() => vi.fn());
const notFoundMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("notFound");
  }),
);

vi.mock("next/navigation", () => ({ notFound: notFoundMock }));
vi.mock("@/lib/headless-knowledge-server", () => ({
  listHeadlessWikis: listHeadlessWikisMock,
  listHeadlessWikiPages: listHeadlessWikiPagesMock,
}));
vi.mock("@/lib/auth", () => ({ currentUser: currentUserMock }));
vi.mock("@/components/WikiView", () => ({ WikiView: () => null }));

function wiki(slug: string, isDefault: boolean) {
  return { id: `goat_wiki_${slug}`, name: slug, slug, isDefault };
}

function page(path: string) {
  return {
    id: `goat_wiki_page_${path}`,
    slug: path,
    path,
    title: path,
    nodeType: "page" as const,
    kind: "other" as const,
    body: "",
  };
}

describe("/wiki/[wikiSlug]/[[...path]]", () => {
  beforeEach(() => {
    listHeadlessWikisMock.mockReset();
    listHeadlessWikiPagesMock.mockReset();
    listHeadlessWikiPagesMock.mockResolvedValue([]);
    notFoundMock.mockClear();
    currentUserMock.mockResolvedValue({
      user: { workosUserId: "user_1" },
      workspace: { id: "goat_ws_1" },
    });
  });

  it("opens the wiki named by the slug", async () => {
    listHeadlessWikisMock.mockResolvedValue([wiki("company", true), wiki("handbook", false)]);
    listHeadlessWikiPagesMock.mockResolvedValue([page("onboarding")]);

    const rendered = await WikiPage({
      params: Promise.resolve({ wikiSlug: "handbook", path: ["onboarding"] }),
    });

    expect(rendered.props).toMatchObject({
      wikiId: "goat_wiki_handbook",
      wikiSlug: "handbook",
      initialPath: "onboarding",
    });
    expect(listHeadlessWikiPagesMock).toHaveBeenCalledWith("goat_wiki_handbook");
  });

  it("404s an unknown slug instead of falling back to the default wiki", async () => {
    listHeadlessWikisMock.mockResolvedValue([wiki("company", true)]);

    await expect(WikiPage({ params: Promise.resolve({ wikiSlug: "handbook" }) })).rejects.toThrow(
      "notFound",
    );
  });

  it("404s a wiki the reader cannot reach", async () => {
    // listHeadlessWikis returns only reachable wikis, so a restricted one the reader is not a
    // member of is simply absent -- indistinguishable from an unknown slug, by design.
    listHeadlessWikisMock.mockResolvedValue([wiki("company", true)]);

    await expect(WikiPage({ params: Promise.resolve({ wikiSlug: "board" }) })).rejects.toThrow(
      "notFound",
    );
  });

  it("404s a page path that does not exist in the wiki", async () => {
    listHeadlessWikisMock.mockResolvedValue([wiki("company", true)]);
    listHeadlessWikiPagesMock.mockResolvedValue([page("onboarding")]);

    await expect(
      WikiPage({ params: Promise.resolve({ wikiSlug: "company", path: ["missing"] }) }),
    ).rejects.toThrow("notFound");
  });

  it("decodes an escaped slug and page path", async () => {
    listHeadlessWikisMock.mockResolvedValue([wiki("launch pad", false)]);
    listHeadlessWikiPagesMock.mockResolvedValue([page("q3 plan")]);

    const rendered = await WikiPage({
      params: Promise.resolve({ wikiSlug: "launch%20pad", path: ["q3%20plan"] }),
    });

    expect(rendered.props).toMatchObject({ wikiSlug: "launch pad", initialPath: "q3 plan" });
  });
});
