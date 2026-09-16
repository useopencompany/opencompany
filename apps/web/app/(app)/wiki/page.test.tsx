import { beforeEach, describe, expect, it, vi } from "vitest";
import WikiIndexPage from "./page";

const listHeadlessWikisMock = vi.hoisted(() => vi.fn());
// Resolving the reader is what activates their workspace; the API refuses a wiki read before that.
const currentUserMock = vi.hoisted(() => vi.fn(async () => ({ user: {}, workspace: {} })));
const redirectMock = vi.hoisted(() =>
  vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
);
const notFoundMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("notFound");
  }),
);

vi.mock("next/navigation", () => ({ redirect: redirectMock, notFound: notFoundMock }));
vi.mock("@/lib/headless-knowledge-server", () => ({
  listHeadlessWikis: listHeadlessWikisMock,
}));
vi.mock("@/lib/auth", () => ({ currentUser: currentUserMock }));

function wiki(slug: string, isDefault: boolean) {
  return { id: `goat_wiki_${slug}`, name: slug, slug, isDefault };
}

describe("/wiki", () => {
  beforeEach(() => {
    listHeadlessWikisMock.mockReset();
    currentUserMock.mockClear();
    redirectMock.mockClear();
    notFoundMock.mockClear();
  });

  it("redirects to the workspace's default wiki", async () => {
    listHeadlessWikisMock.mockResolvedValue([wiki("company", true), wiki("handbook", false)]);

    await expect(WikiIndexPage()).rejects.toThrow("redirect:/wiki/company");
  });

  it("falls back to the first reachable wiki when none is marked default", async () => {
    // A member who can only reach a restricted wiki still needs somewhere to land.
    listHeadlessWikisMock.mockResolvedValue([wiki("board", false)]);

    await expect(WikiIndexPage()).rejects.toThrow("redirect:/wiki/board");
  });

  it("404s when the reader can reach no wiki at all", async () => {
    listHeadlessWikisMock.mockResolvedValue([]);

    await expect(WikiIndexPage()).rejects.toThrow("notFound");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("activates the reader's workspace before asking for wikis", async () => {
    // Without this the API is asked for wikis with no workspace selected and refuses, which 404s
    // the one URL the sidebar and Slack settings point at.
    const order: string[] = [];
    currentUserMock.mockImplementation(async () => {
      order.push("currentUser");
      return { user: {}, workspace: {} };
    });
    listHeadlessWikisMock.mockImplementation(async () => {
      order.push("listWikis");
      return [wiki("company", true)];
    });

    await expect(WikiIndexPage()).rejects.toThrow("redirect:/wiki/company");
    expect(order).toEqual(["currentUser", "listWikis"]);
  });
});
