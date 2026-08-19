import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  updateAutoModelRoutingAction,
  updateTaskViewModeAction,
  updateTimezoneAction,
} from "./user-preferences";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

const preferences = {
  timezone: "Europe/Berlin",
  taskSpawningEnabled: false,
  wikiEnabled: false,
  taskViewMode: "list",
  imessageEnabled: false,
  autoModelRoutingEnabled: true,
};

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

function okEnvelope() {
  return Response.json({
    data: preferences,
    meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
  });
}

describe("user preference API actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", "https://api.example.test");
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        Cookie: "wos-session=sealed",
        Authorization: "Bearer actor-token",
        Origin: "https://my.opencompany.chat",
      }) as never,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("forwards actor credentials on the preferences PATCH and revalidates the app", async () => {
    const requests = stubApi(okEnvelope);

    await expect(updateAutoModelRoutingAction(true)).resolves.toEqual({
      ok: true,
      enabled: true,
    });

    const request = requests[0] as Request;
    expect(request.method).toBe("PATCH");
    expect(new URL(request.url).pathname).toBe("/v1/me/preferences");
    await expect(request.json()).resolves.toEqual({ autoModelRoutingEnabled: true });
    expect(request.headers.get("cookie")).toBe("wos-session=sealed");
    expect(request.headers.get("authorization")).toBe("Bearer actor-token");
    expect(request.headers.get("origin")).toBe("https://my.opencompany.chat");
    expect(revalidatePath).toHaveBeenCalledWith("/");
    expect(revalidatePath).toHaveBeenCalledWith("/settings/preferences");
  });

  it("returns the API's normalized timezone", async () => {
    stubApi(okEnvelope);

    await expect(updateTimezoneAction("Europe/Berlin")).resolves.toEqual({
      ok: true,
      timezone: "Europe/Berlin",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("maps task view mode updates and degrades API failures to ok: false", async () => {
    const requests = stubApi(okEnvelope);
    await expect(updateTaskViewModeAction("list")).resolves.toEqual({
      ok: true,
      mode: "list",
    });
    await expect((requests[0] as Request).json()).resolves.toEqual({ taskViewMode: "list" });
    expect(revalidatePath).toHaveBeenCalledWith("/tasks");

    vi.mocked(revalidatePath).mockClear();
    stubApi(() =>
      Response.json(
        {
          error: {
            code: "invalid_request",
            message: "Request validation failed.",
            requestId: "request_1",
            retryable: false,
          },
          meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
        },
        { status: 400 },
      ),
    );
    await expect(updateTaskViewModeAction("kanban" as never)).resolves.toEqual({
      ok: false,
      mode: "kanban",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("throws the protocol error for failed toggle updates so callers can surface it", async () => {
    stubApi(() =>
      Response.json(
        {
          error: {
            code: "not_found",
            message: "The acting user's profile was not found.",
            requestId: "request_2",
            retryable: false,
          },
          meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
        },
        { status: 404 },
      ),
    );

    await expect(updateAutoModelRoutingAction(true)).rejects.toThrow(
      "The acting user's profile was not found. (request request_2)",
    );
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
