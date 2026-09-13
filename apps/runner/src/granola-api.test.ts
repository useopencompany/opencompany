import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGranolaNote, GranolaApiTimeoutError, listGranolaNotes } from "./granola-api";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Granola API client", () => {
  it("can fetch a ready summary when its transcript is too large to return inline", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      new URL(String(input)).searchParams.has("include")
        ? Response.json({ error: { code: "TRANSCRIPT_TOO_LARGE" } }, { status: 413 })
        : Response.json({ id: "note_1", summary_markdown: "Meeting decisions", transcript: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchGranolaNote({ apiKey: "grn_test", noteId: "note_1", includeTranscript: false }),
    ).resolves.toMatchObject({ summary_markdown: "Meeting decisions" });
    // Existing import callers still request the transcript by default.
    await expect(fetchGranolaNote({ apiKey: "grn_test", noteId: "note_1" })).rejects.toMatchObject({
      status: 413,
    });
  });

  it("passes the bounded context-import creation window", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      Response.json({ notes: [], hasMore: false, cursor: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listGranolaNotes({
      apiKey: "grn_test",
      createdAfter: "2026-06-16T10:00:00.000Z",
      createdBefore: "2026-07-16T10:00:00.000Z",
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("created_after")).toBe("2026-06-16T10:00:00.000Z");
    expect(url.searchParams.get("created_before")).toBe("2026-07-16T10:00:00.000Z");
  });

  it("bounds every request with a deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    );

    const request = listGranolaNotes({ apiKey: "grn_test", timeoutMs: 25 });
    const assertion = expect(request).rejects.toBeInstanceOf(GranolaApiTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });

  it("preserves caller cancellation instead of reporting a timeout", async () => {
    const abort = new AbortController();
    const cancellation = new Error("caller canceled");
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    );

    const request = listGranolaNotes({
      apiKey: "grn_test",
      signal: abort.signal,
      timeoutMs: 10_000,
    });
    abort.abort(cancellation);

    await expect(request).rejects.toBe(cancellation);
  });
});
