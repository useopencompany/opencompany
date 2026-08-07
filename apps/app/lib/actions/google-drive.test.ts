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
vi.mock("@opencompany/core/integrations/google-access-token", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@opencompany/core/integrations/google-access-token")>();
  return { ...original, googleApiCall: mocks.googleApiCall };
});

import { resolveGoogleDriveActions } from "@opencompany/core/actions/google-drive";
import {
  ActionAuthError,
  type ActionExecuteContext,
  ActionPermissionError,
} from "@opencompany/core/actions/types";
import { GoogleAccessAuthError } from "@opencompany/core/integrations/google-access-token";

const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const DOCS_WRITE_SCOPE = "https://www.googleapis.com/auth/documents";
const SHEETS_WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const CONTEXT: ActionExecuteContext = {
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
    scopes: [DRIVE_READ_SCOPE, DOCS_WRITE_SCOPE, SHEETS_WRITE_SCOPE],
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
      "google_drive.get_spreadsheet_values",
      "google_drive.create_document",
      "google_drive.replace_document_text",
      "google_drive.update_spreadsheet_values",
      "google_drive.append_spreadsheet_values",
    ]);
    expect(findAction(catalog, "google_drive.search_files")).toMatchObject({
      capability: "read",
      permissionMode: "on",
      params: { required: ["query"] },
    });
    expect(findAction(catalog, "google_drive.create_document")).toMatchObject({
      capability: "write",
      permissionMode: "ask",
      permission: {
        provider: "google_drive",
        capabilityId: "write",
        label: "Edit Docs & Sheets",
        integrationIds: ["gint_drive_louis@example.com"],
      },
      params: { required: ["title"] },
    });
    expect(findAction(catalog, "google_drive.replace_document_text")).toMatchObject({
      capability: "write",
      permissionMode: "ask",
      permission: {
        provider: "google_drive",
        capabilityId: "write",
        label: "Edit Docs & Sheets",
        integrationIds: ["gint_drive_louis@example.com"],
      },
      params: { required: ["file_id", "find", "replace"] },
    });
    expect(findAction(catalog, "google_drive.update_spreadsheet_values")).toMatchObject({
      capability: "write",
      permissionMode: "ask",
      permission: {
        provider: "google_drive",
        capabilityId: "write",
        label: "Edit Docs & Sheets",
        integrationIds: ["gint_drive_louis@example.com"],
      },
      params: { required: ["file_id", "range", "values"] },
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
      "google_drive.get_spreadsheet_values",
    ]);
  });

  it("advertises only spreadsheet writes when the account has Sheets write scope", async () => {
    mocks.dbRows = [
      connectedRow("louis@example.com", {
        scopes: [DRIVE_READ_SCOPE, SHEETS_WRITE_SCOPE],
        capabilityModes: { read: "off", write: "on" },
      }),
    ];
    const catalog = await resolveGoogleDriveActions("user_1");

    expect(catalog?.actions.map((action) => action.id)).toEqual([
      "google_drive.update_spreadsheet_values",
      "google_drive.append_spreadsheet_values",
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
      "google_drive.get_spreadsheet_values",
    ]);

    mocks.dbRows = [
      connectedRow("louis@example.com", { capabilityModes: { read: "off", write: "on" } }),
    ];
    catalog = await resolveGoogleDriveActions("user_1");
    expect(catalog?.actions.map((action) => action.id)).toEqual([
      "google_drive.create_document",
      "google_drive.replace_document_text",
      "google_drive.update_spreadsheet_values",
      "google_drive.append_spreadsheet_values",
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

describe("google_drive.get_spreadsheet_values", () => {
  it("reads a spreadsheet range and returns a durable source", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({
      spreadsheetId: "sheet_1",
      range: "KPI!A1:C3",
      majorDimension: "ROWS",
      values: [
        ["Metric", "Week", "Value"],
        ["Revenue", "2026-W30", 12345],
        ["Active", "2026-W30", true],
      ],
    });
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.get_spreadsheet_values",
    );

    const result = (await action.execute(
      {
        file_id: "sheet_1",
        range: "KPI!A1:C3",
        value_render_option: "UNFORMATTED_VALUE",
      },
      CONTEXT,
    )) as { spreadsheet: Record<string, unknown> };

    expect(mocks.googleApiCall).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: "gint_drive_louis@example.com",
        provider: "google_drive",
      }),
      "GET",
      expect.any(URL),
      { signal: CONTEXT.signal },
    );
    const url = mocks.googleApiCall.mock.calls[0]?.[2] as URL;
    expect(url.toString()).toContain(
      "sheets.googleapis.com/v4/spreadsheets/sheet_1/values/KPI!A1%3AC3",
    );
    expect(url.searchParams.get("valueRenderOption")).toBe("UNFORMATTED_VALUE");
    expect(result.spreadsheet).toMatchObject({
      id: "sheet_1",
      mimeType: "application/vnd.google-apps.spreadsheet",
      sourceRef: "google-drive:file:sheet_1",
      url: "https://docs.google.com/spreadsheets/d/sheet_1/edit",
      range: "KPI!A1:C3",
      majorDimension: "ROWS",
      values: [
        ["Metric", "Week", "Value"],
        ["Revenue", "2026-W30", 12345],
        ["Active", "2026-W30", true],
      ],
      truncated: false,
    });
  });

  it("defaults to a bounded first-sheet range and rejects malformed read input", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({ spreadsheetId: "sheet_1", values: [] });
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.get_spreadsheet_values",
    );

    await action.execute({ file_id: "sheet_1" }, CONTEXT);
    const url = mocks.googleApiCall.mock.calls[0]?.[2] as URL;
    expect(url.pathname).toBe("/v4/spreadsheets/sheet_1/values/A1%3AZ100");

    mocks.googleApiCall.mockClear();
    await expect(
      action.execute({ file_id: "sheet_1", major_dimension: "DIAGONAL" }, CONTEXT),
    ).rejects.toThrow('"major_dimension" must be one of');
    await expect(
      action.execute({ file_id: "sheet_1", range: "x".repeat(501) }, CONTEXT),
    ).rejects.toThrow('"range" must be at most 500 characters');
    await expect(action.execute({ file_id: "sheet_1", extra: true }, CONTEXT)).rejects.toThrow(
      'Unknown parameter: "extra"',
    );
    expect(mocks.googleApiCall).not.toHaveBeenCalled();
  });
});

describe("google_drive.create_document", () => {
  it("creates a Google Doc with initial text and returns its durable source", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall
      .mockResolvedValueOnce({
        documentId: "doc_new",
        title: "Q3 plan",
      })
      .mockResolvedValueOnce({
        documentId: "doc_new",
        writeControl: { requiredRevisionId: "rev_1" },
      });
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.create_document",
    );

    const result = await action.execute(
      { title: "Q3 plan", text: "Launch on Monday.\nOwner: Ada" },
      CONTEXT,
    );

    expect(mocks.googleApiCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        integrationId: "gint_drive_louis@example.com",
        provider: "google_drive",
      }),
      "POST",
      new URL("https://docs.googleapis.com/v1/documents"),
      {
        signal: CONTEXT.signal,
        body: { title: "Q3 plan" },
      },
    );
    expect(mocks.googleApiCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        integrationId: "gint_drive_louis@example.com",
        provider: "google_drive",
      }),
      "POST",
      new URL("https://docs.googleapis.com/v1/documents/doc_new:batchUpdate"),
      {
        signal: CONTEXT.signal,
        body: {
          requests: [
            {
              insertText: {
                endOfSegmentLocation: {},
                text: "Launch on Monday.\nOwner: Ada",
              },
            },
          ],
        },
      },
    );
    expect(result).toMatchObject({
      account: "louis@example.com",
      integrationId: "gint_drive_louis@example.com",
      document: {
        id: "doc_new",
        title: "Q3 plan",
        mimeType: "application/vnd.google-apps.document",
        sourceRef: "google-drive:file:doc_new",
        url: "https://docs.google.com/document/d/doc_new/edit",
        initialTextAdded: true,
        revisionId: "rev_1",
      },
    });
  });

  it("creates a blank Google Doc in one request when no text is provided", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({
      documentId: "doc_blank",
      title: "Blank plan",
    });
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.create_document",
    );

    const result = await action.execute({ title: "Blank plan" }, CONTEXT);

    expect(mocks.googleApiCall).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      document: {
        id: "doc_blank",
        title: "Blank plan",
      },
    });
    expect(result).not.toHaveProperty("document.initialTextAdded");
  });

  it("returns the created document and a warning if its initial text cannot be added", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall
      .mockResolvedValueOnce({
        documentId: "doc_partial",
        title: "Partial plan",
      })
      .mockRejectedValueOnce(new Error("Google API request failed with 429."));
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.create_document",
    );

    const result = await action.execute(
      { title: "Partial plan", text: "This could not be inserted." },
      CONTEXT,
    );

    expect(result).toMatchObject({
      document: {
        id: "doc_partial",
        initialTextAdded: false,
        url: "https://docs.google.com/document/d/doc_partial/edit",
      },
      warning: expect.stringContaining(
        "The document was created, but its initial text could not be added.",
      ),
    });
    expect(result).toMatchObject({
      warning: expect.stringContaining("Google API request failed with 429."),
    });
  });

  it("rejects malformed document input before calling Google", async () => {
    mocks.dbRows = [connectedRow()];
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.create_document",
    );

    await expect(action.execute({}, CONTEXT)).rejects.toThrow('"title" is required');
    await expect(action.execute({ title: "x".repeat(301) }, CONTEXT)).rejects.toThrow(
      '"title" must be at most 300 characters',
    );
    await expect(action.execute({ title: "Plan", text: 42 }, CONTEXT)).rejects.toThrow(
      '"text" must be a string',
    );
    await expect(
      action.execute({ title: "Plan", text: "x".repeat(100_001) }, CONTEXT),
    ).rejects.toThrow('"text" must be at most 100000 characters');
    await expect(action.execute({ title: "Plan", extra: true }, CONTEXT)).rejects.toThrow(
      'Unknown parameter: "extra"',
    );
    expect(mocks.googleApiCall).not.toHaveBeenCalled();
  });

  it("re-checks OAuth scope and permission mode immediately before creating", async () => {
    mocks.dbRows = [connectedRow()];
    let action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.create_document",
    );
    mocks.dbRows = [connectedRow("louis@example.com", { scopes: [DRIVE_READ_SCOPE] })];

    await expect(action.execute({ title: "Plan" }, CONTEXT)).rejects.toMatchObject({
      name: "ActionAuthError",
      code: "auth_expired",
      provider: "google_drive",
      message: expect.stringContaining("enable editing Google Docs"),
    } satisfies Partial<ActionAuthError>);

    mocks.dbRows = [connectedRow()];
    action = findAction(await resolveGoogleDriveActions("user_1"), "google_drive.create_document");
    mocks.dbRows = [connectedRow("louis@example.com", { capabilityModes: { write: "off" } })];

    await expect(action.execute({ title: "Plan" }, CONTEXT)).rejects.toBeInstanceOf(
      ActionPermissionError,
    );
    expect(mocks.googleApiCall).not.toHaveBeenCalled();
  });

  it("requires and routes an explicit account when several can create Docs", async () => {
    mocks.dbRows = [connectedRow("a@example.com"), connectedRow("b@example.com")];
    mocks.googleApiCall.mockResolvedValue({
      documentId: "doc_b",
      title: "Plan",
    });
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.create_document",
    );

    expect(action.params.required).toEqual(["title", "account"]);
    await expect(action.execute({ title: "Plan" }, CONTEXT)).rejects.toThrow(
      "Multiple Google Drive accounts",
    );
    await action.execute({ title: "Plan", account: "b@example.com" }, CONTEXT);

    expect(mocks.googleApiCall).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "gint_drive_b@example.com" }),
      "POST",
      new URL("https://docs.googleapis.com/v1/documents"),
      {
        signal: CONTEXT.signal,
        body: { title: "Plan" },
      },
    );
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
      name: "ActionAuthError",
      code: "auth_expired",
      provider: "google_drive",
      message: expect.stringContaining("enable editing Google Docs"),
    } satisfies Partial<ActionAuthError>);

    mocks.dbRows = [connectedRow()];
    action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.replace_document_text",
    );
    mocks.dbRows = [connectedRow("louis@example.com", { capabilityModes: { write: "off" } })];

    await expect(
      action.execute({ file_id: "doc_1", find: "Q3", replace: "Q4" }, CONTEXT),
    ).rejects.toBeInstanceOf(ActionPermissionError);
    expect(mocks.googleApiCall).not.toHaveBeenCalled();
  });
});

describe("google_drive.update_spreadsheet_values", () => {
  it("updates a spreadsheet range and returns update counts", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({
      spreadsheetId: "sheet_1",
      updatedRange: "KPI!B2:C3",
      updatedRows: 2,
      updatedColumns: 2,
      updatedCells: 4,
    });
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.update_spreadsheet_values",
    );

    const result = await action.execute(
      {
        file_id: "sheet_1",
        range: "KPI!B2:C3",
        values: [
          ["Revenue", 12345],
          ["Runway", "9 months"],
        ],
        value_input_option: "USER_ENTERED",
      },
      CONTEXT,
    );

    expect(mocks.googleApiCall).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: "gint_drive_louis@example.com",
        provider: "google_drive",
      }),
      "PUT",
      expect.any(URL),
      {
        signal: CONTEXT.signal,
        body: {
          range: "KPI!B2:C3",
          majorDimension: "ROWS",
          values: [
            ["Revenue", 12345],
            ["Runway", "9 months"],
          ],
        },
      },
    );
    const url = mocks.googleApiCall.mock.calls[0]?.[2] as URL;
    expect(url.toString()).toContain(
      "sheets.googleapis.com/v4/spreadsheets/sheet_1/values/KPI!B2%3AC3",
    );
    expect(url.searchParams.get("valueInputOption")).toBe("USER_ENTERED");
    expect(result).toMatchObject({
      integrationId: "gint_drive_louis@example.com",
      spreadsheet: {
        id: "sheet_1",
        sourceRef: "google-drive:file:sheet_1",
        url: "https://docs.google.com/spreadsheets/d/sheet_1/edit",
        updatedRange: "KPI!B2:C3",
        updatedRows: 2,
        updatedColumns: 2,
        updatedCells: 4,
      },
    });
  });

  it("rejects malformed spreadsheet updates before calling Google", async () => {
    mocks.dbRows = [connectedRow()];
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.update_spreadsheet_values",
    );

    await expect(
      action.execute({ file_id: "sheet_1", range: "KPI!B2:C3" }, CONTEXT),
    ).rejects.toThrow('"values" is required');
    await expect(
      action.execute({ file_id: "sheet_1", range: "KPI!B2:C3", values: [[]] }, CONTEXT),
    ).rejects.toThrow('"values"[0] must be a non-empty array');
    await expect(
      action.execute(
        {
          file_id: "sheet_1",
          range: "KPI!B2:C3",
          values: [[Number.NaN]],
        },
        CONTEXT,
      ),
    ).rejects.toThrow('"values"[0][0] must be a finite number');
    await expect(
      action.execute(
        {
          file_id: "sheet_1",
          range: "KPI!B2:C3",
          values: [["x"]],
          value_input_option: "PARSED",
        },
        CONTEXT,
      ),
    ).rejects.toThrow('"value_input_option" must be one of');
    await expect(
      action.execute(
        {
          file_id: "sheet_1",
          range: "KPI!B2:C3",
          values: [["x"]],
          extra: true,
        },
        CONTEXT,
      ),
    ).rejects.toThrow('Unknown parameter: "extra"');
    expect(mocks.googleApiCall).not.toHaveBeenCalled();
  });

  it("re-checks Sheets OAuth scope and permission mode immediately before editing", async () => {
    mocks.dbRows = [connectedRow()];
    let action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.update_spreadsheet_values",
    );
    mocks.dbRows = [connectedRow("louis@example.com", { scopes: [DRIVE_READ_SCOPE] })];

    await expect(
      action.execute({ file_id: "sheet_1", range: "KPI!B2", values: [[123]] }, CONTEXT),
    ).rejects.toMatchObject({
      name: "ActionAuthError",
      code: "auth_expired",
      provider: "google_drive",
      message: expect.stringContaining("enable editing Google Sheets"),
    } satisfies Partial<ActionAuthError>);

    mocks.dbRows = [connectedRow()];
    action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.update_spreadsheet_values",
    );
    mocks.dbRows = [connectedRow("louis@example.com", { capabilityModes: { write: "off" } })];

    await expect(
      action.execute({ file_id: "sheet_1", range: "KPI!B2", values: [[123]] }, CONTEXT),
    ).rejects.toBeInstanceOf(ActionPermissionError);
    expect(mocks.googleApiCall).not.toHaveBeenCalled();
  });
});

describe("google_drive.append_spreadsheet_values", () => {
  it("appends rows to a spreadsheet table range", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({
      spreadsheetId: "sheet_1",
      tableRange: "KPI!A1:C10",
      updates: {
        spreadsheetId: "sheet_1",
        updatedRange: "KPI!A11:C11",
        updatedRows: 1,
        updatedColumns: 3,
        updatedCells: 3,
      },
    });
    const action = findAction(
      await resolveGoogleDriveActions("user_1"),
      "google_drive.append_spreadsheet_values",
    );

    const result = await action.execute(
      {
        file_id: "sheet_1",
        range: "KPI!A1:C",
        values: [["Revenue", "2026-W31", 13000]],
        insert_data_option: "INSERT_ROWS",
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
          range: "KPI!A1:C",
          majorDimension: "ROWS",
          values: [["Revenue", "2026-W31", 13000]],
        },
      },
    );
    const url = mocks.googleApiCall.mock.calls[0]?.[2] as URL;
    expect(url.toString()).toContain(
      "sheets.googleapis.com/v4/spreadsheets/sheet_1/values/KPI!A1%3AC:append",
    );
    expect(url.searchParams.get("valueInputOption")).toBe("USER_ENTERED");
    expect(url.searchParams.get("insertDataOption")).toBe("INSERT_ROWS");
    expect(result).toMatchObject({
      spreadsheet: {
        id: "sheet_1",
        tableRange: "KPI!A1:C10",
        updatedRange: "KPI!A11:C11",
        updatedRows: 1,
        updatedColumns: 3,
        updatedCells: 3,
      },
    });
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
      name: "ActionAuthError",
      code: "auth_expired",
      provider: "google_drive",
      message: expect.stringContaining("Settings → Integrations"),
    } satisfies Partial<ActionAuthError>);
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
