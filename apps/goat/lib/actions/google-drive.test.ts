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
          limit: async () => mocks.dbRows,
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
import {
  GoatActionAuthError,
  type GoatActionExecuteContext,
  GoatActionPermissionError,
} from "@/lib/actions/types";
import { GoogleAccessAuthError } from "@/lib/integrations/google-access-token";

const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const DOCS_WRITE_SCOPE = "https://www.googleapis.com/auth/documents";

const CONTEXT: GoatActionExecuteContext = {
  userWorkosId: "user_1",
  signal: new AbortController().signal,
  currentDate: new Date("2026-07-22T00:00:00.000Z"),
  userTimezone: "UTC",
};

function connectedRow(
  email = "louis@example.com",
  overrides: Partial<{
    integrationId: string;
    accountEmail: string | null;
    accountName: string | null;
    status: string;
    scopes: string[];
    capabilityModes: Record<string, unknown>;
  }> = {},
) {
  return {
    integrationId: `gint_drive_${email}`,
    accountEmail: email,
    accountName: "Louis",
    status: "connected",
    scopes: [DRIVE_READ_SCOPE, DOCS_WRITE_SCOPE],
    capabilityModes: {},
    ...overrides,
  };
}

function findAction(catalog: Awaited<ReturnType<typeof resolveGoogleDriveActions>>, id: string) {
  const action = catalog?.actions.find((entry) => entry.id === id);
  if (!action) throw new Error(`missing ${id} action`);
  return action;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveGoogleDriveActions", () => {
  it("is absent without a currently connected Google Drive account", async () => {
    mocks.dbRows = [];
    expect(await resolveGoogleDriveActions("user_1")).toBeNull();

    mocks.dbRows = [connectedRow("louis@example.com", { status: "needs_reauth" })];
    expect(await resolveGoogleDriveActions("user_1")).toBeNull();

    mocks.dbRows = [connectedRow("louis@example.com", { status: "disconnected" })];
    expect(await resolveGoogleDriveActions("user_1")).toBeNull();
  });

  it("exposes founder-friendly reads and an ask-before-edit action", async () => {
    mocks.dbRows = [connectedRow()];
    const catalog = await resolveGoogleDriveActions("user_1");

    expect(catalog).toMatchObject({
      id: "google_drive",
      label: "Google Drive (louis@example.com)",
    });
    expect(catalog?.actions.map((action) => action.id)).toEqual([
      "google_drive.search_files",
      "google_drive.get_document",
      "google_drive.replace_document_text",
    ]);
    expect(findAction(catalog, "google_drive.search_files")).toMatchObject({
      capability: "read",
      permissionMode: "on",
      params: { required: ["query"] },
    });
    expect(findAction(catalog, "google_drive.replace_document_text")).toMatchObject({
      capability: "write",
      permissionMode: "ask",
      permission: {
        provider: "google_drive",
        capabilityId: "write",
        label: "Edit Google Docs",
        integrationIds: ["gint_drive_louis@example.com"],
      },
      params: { required: ["file_id", "find", "replace"] },
    });
    expect(mocks.googleApiCall).not.toHaveBeenCalled();
  });

  it("keeps existing read-only OAuth connections useful until editing is enabled", async () => {
    mocks.dbRows = [
      connectedRow("louis@example.com", {
        scopes: [DRIVE_READ_SCOPE, "https://www.googleapis.com/auth/drive.file"],
      }),
    ];
    const catalog = await resolveGoogleDriveActions("user_1");

    expect(catalog?.actions.map((action) => action.id)).toEqual([
      "google_drive.search_files",
      "google_drive.get_document",
    ]);
  });

  it("honors per-account read and write modes", async () => {
    mocks.dbRows = [
      connectedRow("louis@example.com", {
        capabilityModes: { read: "ask", write: "off" },
      }),
    ];
    let catalog = await resolveGoogleDriveActions("user_1");
    expect(findAction(catalog, "google_drive.get_document")).toMatchObject({
      permissionMode: "ask",
      permission: {
        provider: "google_drive",
        capabilityId: "read",
        label: "Find & read files",
        integrationIds: ["gint_drive_louis@example.com"],
      },
    });

    mocks.dbRows = [connectedRow("louis@example.com", { capabilityModes: { write: "on" } })];
    catalog = await resolveGoogleDriveActions("user_1");
    expect(findAction(catalog, "google_drive.replace_document_text").permissionMode).toBe("on");

    mocks.dbRows = [connectedRow("louis@example.com", { capabilityModes: { write: "off" } })];
    catalog = await resolveGoogleDriveActions("user_1");
    expect(catalog?.actions.map((action) => action.id)).toEqual([
      "google_drive.search_files",
      "google_drive.get_document",
    ]);

    mocks.dbRows = [
      connectedRow("louis@example.com", { capabilityModes: { read: "off", write: "on" } }),
    ];
    catalog = await resolveGoogleDriveActions("user_1");
    expect(catalog?.actions.map((action) => action.id)).toEqual([
      "google_drive.replace_document_text",
    ]);

    mocks.dbRows = [
      connectedRow("louis@example.com", { capabilityModes: { read: "off", write: "off" } }),
    ];
    expect(await resolveGoogleDriveActions("user_1")).toBeNull();
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
          capabilities: { canDownload: true },
          ignoredSensitiveField: "must not escape",
        },
        {
          id: "file_2",
          name: "Injected link",
          mimeType: "text/plain",
          webViewLink: "https://evil.example/phish",
          capabilities: { canDownload: false },
        },
        { id: "invalid_without_name", mimeType: "text/plain" },
        "not-an-object",
      ],
    });

    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.search_files",
    );
    const result = (await action.execute({ query: "Q3 roadmap", limit: 5 }, CONTEXT)) as {
      integrationId: string;
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
      integrationId: "gint_drive_louis@example.com",
      query: "Q3 roadmap",
      moreAvailable: true,
    });
    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toMatchObject({
      sourceRef: "google-drive:file:file_1",
      canDownload: true,
    });
    expect(result.files[0]?.name).toHaveLength(301);
    expect(result.files[0]).not.toHaveProperty("ignoredSensitiveField");
    expect(result.files[1]).toMatchObject({ canDownload: false });
    expect(result.files[1]).not.toHaveProperty("webViewLink");
  });

  it("escapes Drive query literals", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({ files: [] });
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.search_files",
    );

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
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.search_files",
    );

    const result = (await action.execute({ query: "file", limit: 3 }, CONTEXT)) as {
      files: unknown[];
      moreAvailable: boolean;
    };

    expect(result.files).toHaveLength(3);
    expect(result.moreAvailable).toBe(true);
  });

  it("rejects required, invalid, out-of-range, and unknown parameters before the API call", async () => {
    mocks.dbRows = [connectedRow()];
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.search_files",
    );

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
});

describe("google_drive.get_document", () => {
  it("reads text across Google Doc tabs and returns a revision-safe source", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({
      documentId: "doc_1",
      title: "Fundraising plan",
      revisionId: "rev_7",
      tabs: [
        {
          tabProperties: { title: "Narrative" },
          documentTab: {
            body: {
              content: [
                {
                  paragraph: {
                    elements: [{ textRun: { content: "Raise the seed round.\n", bold: true } }],
                  },
                },
              ],
            },
          },
          childTabs: [
            {
              tabProperties: { title: "Metrics" },
              documentTab: {
                body: {
                  content: [
                    {
                      table: {
                        tableRows: [
                          {
                            tableCells: [
                              {
                                content: [
                                  {
                                    paragraph: {
                                      elements: [{ textRun: { content: "ARR target: $1m" } }],
                                    },
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
    });
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.get_document",
    );

    const result = (await action.execute({ file_id: "doc_1" }, CONTEXT)) as {
      document: Record<string, unknown>;
    };

    const url = mocks.googleApiCall.mock.calls[0]?.[2] as URL;
    expect(url.toString()).toContain("docs.googleapis.com/v1/documents/doc_1");
    expect(url.searchParams.get("includeTabsContent")).toBe("true");
    expect(result.document).toMatchObject({
      id: "doc_1",
      title: "Fundraising plan",
      revisionId: "rev_7",
      sourceRef: "google-drive:file:doc_1",
      url: "https://docs.google.com/document/d/doc_1/edit",
      text: "## Narrative\nRaise the seed round.\n\n## Metrics\nARR target: $1m",
      truncated: false,
    });
  });

  it("caps document text returned to the model", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({
      documentId: "doc_large",
      title: "Large",
      body: {
        content: [
          {
            paragraph: {
              elements: [{ textRun: { content: "x".repeat(41_000) } }],
            },
          },
        ],
      },
    });
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.get_document",
    );

    const result = (await action.execute({ file_id: "doc_large" }, CONTEXT)) as {
      document: { text: string; truncated: boolean };
    };

    expect(result.document.text).toHaveLength(40_001);
    expect(result.document.text.endsWith("…")).toBe(true);
    expect(result.document.truncated).toBe(true);
  });
});

describe("google_drive.replace_document_text", () => {
  it("replaces exact text with a revision guard and returns the changed occurrence count", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({
      documentId: "doc_1",
      replies: [{ replaceAllText: { occurrencesChanged: 2 } }],
      writeControl: { requiredRevisionId: "rev_8" },
    });
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.replace_document_text",
    );

    const result = await action.execute(
      {
        file_id: "doc_1",
        find: "Q3",
        replace: "Q4",
        match_case: false,
        revision_id: "rev_7",
      },
      CONTEXT,
    );

    expect(mocks.googleApiCall).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: "gint_drive_louis@example.com",
        provider: "google_drive",
      }),
      "POST",
      expect.any(URL),
      {
        signal: CONTEXT.signal,
        body: {
          requests: [
            {
              replaceAllText: {
                containsText: { text: "Q3", matchCase: false },
                replaceText: "Q4",
              },
            },
          ],
          writeControl: { requiredRevisionId: "rev_7" },
        },
      },
    );
    expect(result).toMatchObject({
      integrationId: "gint_drive_louis@example.com",
      document: {
        id: "doc_1",
        sourceRef: "google-drive:file:doc_1",
        occurrencesChanged: 2,
        revisionId: "rev_8",
      },
    });
  });

  it("rejects malformed edits before calling Google", async () => {
    mocks.dbRows = [connectedRow()];
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.replace_document_text",
    );

    await expect(action.execute({ file_id: "doc_1", find: "Q3" }, CONTEXT)).rejects.toThrow(
      '"replace" is required',
    );
    await expect(
      action.execute({ file_id: "doc_1", find: "", replace: "Q4" }, CONTEXT),
    ).rejects.toThrow('"find" is required');
    await expect(
      action.execute({ file_id: "doc_1", find: "Q3", replace: "Q4", match_case: "yes" }, CONTEXT),
    ).rejects.toThrow('"match_case" must be a boolean');
    await expect(
      action.execute({ file_id: "doc_1", find: "Q3", replace: "Q4", extra: true }, CONTEXT),
    ).rejects.toThrow('Unknown parameter: "extra"');
    expect(mocks.googleApiCall).not.toHaveBeenCalled();
  });

  it("re-checks OAuth scope and permission mode immediately before editing", async () => {
    mocks.dbRows = [connectedRow()];
    let action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.replace_document_text",
    );
    mocks.dbRows = [connectedRow("louis@example.com", { scopes: [DRIVE_READ_SCOPE] })];

    await expect(
      action.execute({ file_id: "doc_1", find: "Q3", replace: "Q4" }, CONTEXT),
    ).rejects.toMatchObject({
      name: "GoatActionAuthError",
      code: "auth_expired",
      provider: "google_drive",
      message: expect.stringContaining("enable Google Docs editing"),
    } satisfies Partial<GoatActionAuthError>);

    mocks.dbRows = [connectedRow()];
    action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.replace_document_text",
    );
    mocks.dbRows = [connectedRow("louis@example.com", { capabilityModes: { write: "off" } })];

    await expect(
      action.execute({ file_id: "doc_1", find: "Q3", replace: "Q4" }, CONTEXT),
    ).rejects.toBeInstanceOf(GoatActionPermissionError);
    expect(mocks.googleApiCall).not.toHaveBeenCalled();
  });
});

describe("Google Drive account and auth handling", () => {
  it.each([
    "missing credentials",
    "expired credentials",
  ])("maps %s to the structured reconnect error", async (message) => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockRejectedValue(new GoogleAccessAuthError(message));
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.search_files",
    );

    await expect(action.execute({ query: "roadmap" }, CONTEXT)).rejects.toMatchObject({
      name: "GoatActionAuthError",
      code: "auth_expired",
      provider: "google_drive",
      message: expect.stringContaining("Settings → Integrations"),
    } satisfies Partial<GoatActionAuthError>);
  });

  it("surfaces provider API failures", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockRejectedValue(
      new Error("Google API request failed with 400: Invalid id value (invalid)."),
    );
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.search_files",
    );

    await expect(action.execute({ query: "roadmap" }, CONTEXT)).rejects.toThrow(
      "Google API request failed with 400: Invalid id value (invalid).",
    );
  });

  it("requires an explicit account when multiple Drive accounts are connected", async () => {
    mocks.dbRows = [connectedRow("a@example.com"), connectedRow("b@example.com")];
    mocks.googleApiCall.mockResolvedValue({ files: [] });
    const catalog = await resolveGoogleDriveActions("user_1");
    const action = findAction(catalog, "google_drive.search_files");

    expect(action.params.required).toEqual(["query", "account"]);
    await expect(action.execute({ query: "roadmap" }, CONTEXT)).rejects.toThrow(
      "Multiple Google Drive accounts",
    );
    await expect(
      action.execute({ query: "roadmap", account: "missing@example.com" }, CONTEXT),
    ).rejects.toThrow("No connected Google Drive account");
    await expect(
      action.execute({ query: "roadmap", account: "a".repeat(401) }, CONTEXT),
    ).rejects.toThrow('"account" must be at most 400 characters');
    await action.execute({ query: "roadmap", account: "b@example.com" }, CONTEXT);

    expect(mocks.googleApiCall).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "gint_drive_b@example.com" }),
      "GET",
      expect.any(URL),
      { signal: CONTEXT.signal },
    );
  });

  it("uses unique selectors when multiple accounts have the same label", async () => {
    mocks.dbRows = [
      connectedRow("first@example.com", {
        integrationId: "gint_drive_first",
        accountEmail: null,
        accountName: "Shared account",
      }),
      connectedRow("second@example.com", {
        integrationId: "gint_drive_second",
        accountEmail: null,
        accountName: "Shared account",
      }),
    ];
    mocks.googleApiCall.mockResolvedValue({ files: [] });
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.search_files",
    );

    expect(action.params.properties?.account).toMatchObject({
      maxLength: 400,
      description: expect.stringContaining("Shared account (gint_drive_second)"),
    });
    await expect(
      action.execute({ query: "roadmap", account: "Shared account" }, CONTEXT),
    ).rejects.toThrow("No connected Google Drive account");
    await action.execute(
      { query: "roadmap", account: "Shared account (gint_drive_second)" },
      CONTEXT,
    );

    expect(mocks.googleApiCall).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "gint_drive_second" }),
      "GET",
      expect.any(URL),
      { signal: CONTEXT.signal },
    );
  });
});
