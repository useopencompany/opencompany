import { afterEach, describe, expect, it, vi } from "vitest";
import { FathomApiTimeoutError, listFathomMeetings } from "./fathom-api";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Fathom API client", () => {
  it("passes the poll window and requests inline meeting content", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ items: [], next_cursor: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listFathomMeetings({
      apiKey: "fathom_test",
      createdAfter: "2026-07-16T09:00:00.000Z",
      createdBefore: "2026-07-16T10:00:00.000Z",
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("created_after")).toBe("2026-07-16T09:00:00.000Z");
    expect(url.searchParams.get("created_before")).toBe("2026-07-16T10:00:00.000Z");
    expect(url.searchParams.get("include_transcript")).toBe("true");
    expect(url.searchParams.get("include_summary")).toBe("true");
    expect(url.searchParams.get("include_action_items")).toBe("true");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get("X-Api-Key")).toBe("fathom_test");
  });

  it("keeps integer recording ids as stable string identities", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          items: [
            {
              recording_id: 123456,
              meeting_title: "Weekly sync",
              created_at: "2026-07-16T09:30:00Z",
            },
            { title: "missing recording id" },
          ],
          next_cursor: "cursor_2",
        }),
      ),
    );

    const page = await listFathomMeetings({ apiKey: "fathom_test" });
    expect(page.meetings).toHaveLength(1);
    expect(page.meetings[0]?.recordingId).toBe("123456");
    expect(page.meetings[0]?.title).toBe("Weekly sync");
    expect(page.nextCursor).toBe("cursor_2");
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

    const request = listFathomMeetings({ apiKey: "fathom_test", timeoutMs: 25 });
    const assertion = expect(request).rejects.toBeInstanceOf(FathomApiTimeoutError);
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

    const request = listFathomMeetings({
      apiKey: "fathom_test",
      signal: abort.signal,
      timeoutMs: 10_000,
    });
    abort.abort(cancellation);

    await expect(request).rejects.toBe(cancellation);
  });
});
