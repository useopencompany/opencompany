import { afterEach, describe, expect, it, vi } from "vitest";
import { listGranolaFolders } from "./granola";

afterEach(() => {
  vi.restoreAllMocks();
});

function respondWith(...pages: Array<{ status?: number; body: unknown }>) {
  const fetchMock = vi.fn(async () => {
    const page = pages.shift();
    if (!page) throw new Error("Unexpected extra Granola folders request.");
    return new Response(JSON.stringify(page.body), { status: page.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("listGranolaFolders", () => {
  it("follows the cursor and keeps each folder's parent", async () => {
    const fetchMock = respondWith(
      {
        body: {
          folders: [{ id: "fol_customers", name: "Customers", parent_folder_id: null }],
          hasMore: true,
          cursor: "cursor_2",
        },
      },
      {
        body: {
          folders: [{ id: "fol_acme", name: " Acme ", parent_folder_id: "fol_customers" }],
          hasMore: false,
          cursor: null,
        },
      },
    );

    await expect(listGranolaFolders({ apiKey: "grn_test" })).resolves.toEqual({
      ok: true,
      partial: false,
      folders: [
        { id: "fol_customers", name: "Customers", parentFolderId: null },
        { id: "fol_acme", name: "Acme", parentFolderId: "fol_customers" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String((fetchMock.mock.calls as unknown as unknown[][])[1]?.[0])).toContain(
      "cursor=cursor_2",
    );
  });

  it("reports a revoked key separately so callers can ask for a new one", async () => {
    respondWith({ status: 401, body: {} });
    await expect(listGranolaFolders({ apiKey: "grn_test" })).resolves.toMatchObject({
      ok: false,
      reason: "unauthorized",
    });
  });

  it("reports an upstream failure as unavailable rather than an empty folder list", async () => {
    respondWith({ status: 503, body: {} });
    await expect(listGranolaFolders({ apiKey: "grn_test" })).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });

  it("reports a repeated cursor as retryable rather than paging forever or claiming a full tree", async () => {
    const fetchMock = respondWith(
      { body: { folders: [], hasMore: true, cursor: "same" } },
      { body: { folders: [], hasMore: true, cursor: "same" } },
    );
    await expect(listGranolaFolders({ apiKey: "grn_test" })).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips entries without an id and falls back to the id when a name is blank", async () => {
    respondWith({
      body: {
        folders: [{ name: "No id" }, { id: "fol_1", name: "   ", parent_folder_id: 7 }],
        hasMore: false,
      },
    });
    await expect(listGranolaFolders({ apiKey: "grn_test" })).resolves.toEqual({
      ok: true,
      partial: false,
      folders: [{ id: "fol_1", name: "fol_1", parentFolderId: null }],
    });
  });

  it("rethrows a caller abort instead of blaming Granola", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(
      listGranolaFolders({ apiKey: "grn_test", signal: controller.signal }),
    ).rejects.toThrow();
  });
});
