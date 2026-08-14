import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitFeedback } from "./actions";

vi.mock("next/headers", () => ({ headers: vi.fn() }));

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function stubApi(response: () => Response) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init));
      return response();
    }),
  );
  return requests;
}

describe("submitFeedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GOAT_API_ORIGIN", "https://api.example.test");
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        Cookie: "wos-session=sealed",
        Origin: "https://my.opencompany.chat",
      }) as never,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("posts the trimmed report to the feedback command with actor credentials", async () => {
    const requests = stubApi(() =>
      Response.json({
        data: { submitted: true },
        meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
      }),
    );

    await expect(
      submitFeedback(null, form({ kind: "bug", message: "  The board drops columns.  " })),
    ).resolves.toEqual({ ok: true });

    const request = requests[0] as Request;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/v1/feedback");
    await expect(request.json()).resolves.toEqual({
      kind: "bug",
      message: "The board drops columns.",
    });
    expect(request.headers.get("cookie")).toBe("wos-session=sealed");
    expect(request.headers.get("origin")).toBe("https://my.opencompany.chat");
  });

  it("defaults unknown kinds to feedback", async () => {
    const requests = stubApi(() =>
      Response.json({
        data: { submitted: true },
        meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
      }),
    );

    await submitFeedback(null, form({ kind: "rant", message: "Needs dark mode charts." }));
    await expect((requests[0] as Request).json()).resolves.toMatchObject({ kind: "feedback" });
  });

  it("validates message length locally with the original copy", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(submitFeedback(null, form({ kind: "bug", message: "no" }))).resolves.toEqual({
      ok: false,
      error: "Enter a bit more detail.",
    });
    await expect(
      submitFeedback(null, form({ kind: "bug", message: "x".repeat(4_001) })),
    ).resolves.toEqual({ ok: false, error: "Keep feedback under 4,000 characters." });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces the API's delivery error message", async () => {
    stubApi(() =>
      Response.json(
        {
          error: {
            code: "unavailable",
            message: "Linear did not create an issue.",
            requestId: "request_1",
            retryable: true,
          },
          meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
        },
        { status: 503 },
      ),
    );

    await expect(
      submitFeedback(null, form({ kind: "idea", message: "Add a weekly digest." })),
    ).resolves.toEqual({ ok: false, error: "Linear did not create an issue." });
  });
});
