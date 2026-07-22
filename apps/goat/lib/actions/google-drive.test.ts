import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbRows: [] as unknown[],
  googleApiCall: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => mocks.dbRows,
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/integrations/google-access-token", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/integrations/google-access-token")>();
  return { ...original, googleApiCall: mocks.googleApiCall };
});

import { resolveGoogleDriveActions } from "@/lib/actions/google-drive";
import { GoatActionAuthError, type GoatActionExecuteContext } from "@/lib/actions/types";
import { GoogleAccessAuthError } from "@/lib/integrations/google-access-token";

const CONTEXT: GoatActionExecuteContext = {
  userWorkosId: "user_1",
  signal: new AbortController().signal,
  currentDate: new Date("2026-07-22T00:00:00.000Z"),
};

function connectedRow(email = "louis@example.com") {
  return {
    integrationId: `gint_drive_${email}`,
    accountEmail: email,
    accountName: "Louis",
    status: "connected",
  };
}

function findSearchAction(catalog: Awaited<ReturnType<typeof resolveGoogleDriveActions>>) {
  const action = catalog?.actions.find((entry) => entry.id === "google_drive.search_files");
  if (!action) throw new Error("missing google_drive.search_files action");
  return action;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveGoogleDriveActions", () => {
  it("is absent without a currently connected Google Drive account", async () => {
    mocks.dbRows = [];
    expect(await resolveGoogleDriveActions("user_1")).toBeNull();

    mocks.dbRows = [{ ...connectedRow(), status: "needs_reauth" }];
    expect(await resolveGoogleDriveActions("user_1")).toBeNull();

    mocks.dbRows = [{ ...connectedRow(), status: "disconnected" }];
    expect(await resolveGoogleDriveActions("user_1")).toBeNull();
  });

  it("registers a strict read-only descriptor for connected accounts", async () => {
    mocks.dbRows = [connectedRow()];
    const catalog = await resolveGoogleDriveActions("user_1");
    const action = findSearchAction(catalog);

    expect(catalog).toMatchObject({
      id: "google_drive",
      label: "Google Drive (louis@example.com)",
    });
    expect(action).toMatchObject({
      id: "google_drive.search_files",
      provider: "google_drive",
      params: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 200 },
          limit: { type: "integer", minimum: 1, maximum: 25 },
        },
      },
    });
    expect(action.id).not.toMatch(/create|update|delete|write/);
    expect(mocks.googleApiCall).not.toHaveBeenCalled();
  });
});

describe("google_drive.search_files", () => {
  it("searches all accessible Drive files and shapes untrusted results", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({
      nextPageToken: "more-results",
      files: [
        {
          id: "file_1",
          name: `Roadmap ${"x".repeat(400)}`,
          mimeType: "application/vnd.google-apps.document",
          modifiedTime: "2026-07-20T12:00:00.000Z",
          driveId: "drive_1",
          webViewLink: "https://docs.google.com/document/d/file_1/edit",
          ignoredSensitiveField: "must not escape",
        },
        {
          id: "file_2",
          name: "Injected link",
          mimeType: "text/plain",
          webViewLink: "https://evil.example/phish",
        },
        { id: "invalid_without_name", mimeType: "text/plain" },
        "not-an-object",
      ],
    });

    const action = findSearchAction(await resolveGoogleDriveActions("user_1"));
    const result = (await action.execute({ query: "Q3 roadmap", limit: 5 }, CONTEXT)) as {
      account: string;
      query: string;
      files: Array<Record<string, unknown>>;
      moreAvailable: boolean;
    };

    expect(mocks.googleApiCall).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google_drive", integrationId: expect.any(String) }),
      "GET",
      expect.any(URL),
      { signal: CONTEXT.signal },
    );
    const url = mocks.googleApiCall.mock.calls[0]?.[2] as URL;
    expect(url.searchParams.get("pageSize")).toBe("5");
    expect(url.searchParams.get("q")).toBe("trashed = false and fullText contains 'Q3 roadmap'");
    expect(url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
    expect(result).toMatchObject({
      account: "louis@example.com",
      query: "Q3 roadmap",
      moreAvailable: true,
    });
    expect(result.files).toHaveLength(2);
    expect(result.files[0]?.name).toHaveLength(301);
    expect(result.files[0]).not.toHaveProperty("ignoredSensitiveField");
    expect(result.files[1]).not.toHaveProperty("webViewLink");
  });

  it("escapes Drive query literals", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({ files: [] });
    const action = findSearchAction(await resolveGoogleDriveActions("user_1"));

    await action.execute({ query: "team's \\ plan" }, CONTEXT);

    const url = mocks.googleApiCall.mock.calls[0]?.[2] as URL;
    expect(url.searchParams.get("q")).toBe(
      "trashed = false and fullText contains 'team\\'s \\\\ plan'",
    );
  });

  it("caps an unexpectedly large provider response at the requested limit", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({
      files: Array.from({ length: 10 }, (_, index) => ({
        id: `file_${index}`,
        name: `File ${index}`,
        mimeType: "text/plain",
      })),
    });
    const action = findSearchAction(await resolveGoogleDriveActions("user_1"));

    const result = (await action.execute({ query: "file", limit: 3 }, CONTEXT)) as {
      files: unknown[];
      moreAvailable: boolean;
    };

    expect(result.files).toHaveLength(3);
    expect(result.moreAvailable).toBe(true);
  });

  it("rejects required, invalid, out-of-range, and unknown parameters before the API call", async () => {
    mocks.dbRows = [connectedRow()];
    const action = findSearchAction(await resolveGoogleDriveActions("user_1"));

    await expect(action.execute({}, CONTEXT)).rejects.toThrow('"query" is required');
    await expect(action.execute({ query: "x", limit: "many" }, CONTEXT)).rejects.toThrow(
      '"limit" must be a number',
    );
    await expect(action.execute({ query: "x", limit: 26 }, CONTEXT)).rejects.toThrow(
      '"limit" must be an integer from 1 to 25',
    );
    await expect(action.execute({ query: "x", extra: true }, CONTEXT)).rejects.toThrow(
      'Unknown parameter: "extra"',
    );
    await expect(action.execute({ query: "x".repeat(201) }, CONTEXT)).rejects.toThrow(
      '"query" must be at most 200 characters',
    );
    expect(mocks.googleApiCall).not.toHaveBeenCalled();
  });

  it.each([
    "missing credentials",
    "expired credentials",
  ])("maps %s to the structured reconnect error", async (message) => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockRejectedValue(new GoogleAccessAuthError(message));
    const action = findSearchAction(await resolveGoogleDriveActions("user_1"));

    await expect(action.execute({ query: "roadmap" }, CONTEXT)).rejects.toMatchObject({
      name: "GoatActionAuthError",
      code: "auth_expired",
      provider: "google_drive",
      message: expect.stringContaining("Settings → Integrations"),
    } satisfies Partial<GoatActionAuthError>);
  });

  it("surfaces provider API failures", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockRejectedValue(new Error("Google API request failed with 503."));
    const action = findSearchAction(await resolveGoogleDriveActions("user_1"));

    await expect(action.execute({ query: "roadmap" }, CONTEXT)).rejects.toThrow(
      "Google API request failed with 503.",
    );
  });

  it("requires an explicit account when multiple Drive accounts are connected", async () => {
    mocks.dbRows = [connectedRow("a@example.com"), connectedRow("b@example.com")];
    mocks.googleApiCall.mockResolvedValue({ files: [] });
    const catalog = await resolveGoogleDriveActions("user_1");
    const action = findSearchAction(catalog);

    expect(action.params.required).toEqual(["query", "account"]);
    await expect(action.execute({ query: "roadmap" }, CONTEXT)).rejects.toThrow(
      "Multiple Google Drive accounts",
    );
    await expect(
      action.execute({ query: "roadmap", account: "missing@example.com" }, CONTEXT),
    ).rejects.toThrow("No connected Google Drive account");
    await expect(
      action.execute({ query: "roadmap", account: "a".repeat(201) }, CONTEXT),
    ).rejects.toThrow('"account" must be at most 200 characters');
    await action.execute({ query: "roadmap", account: "b@example.com" }, CONTEXT);

    expect(mocks.googleApiCall).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "gint_drive_b@example.com" }),
      "GET",
      expect.any(URL),
      { signal: CONTEXT.signal },
    );
  });
});
