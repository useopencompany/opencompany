import { describe, expect, it } from "vitest";
import {
  GOOGLE_DOCS_WRITE_SCOPE,
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_READ_SCOPE,
  GOOGLE_SHEETS_WRITE_SCOPE,
  googleDriveMcpScopesSatisfied,
  hasGoogleDocsWriteScope,
  hasGoogleDriveWriteScope,
  hasGoogleSheetsWriteScope,
} from "./google-drive-scopes";

describe("Google Drive OAuth scope capabilities", () => {
  it("requires both Docs and Sheets grants for the fully upgraded Drive write scope", () => {
    expect(hasGoogleDriveWriteScope([GOOGLE_DRIVE_READ_SCOPE])).toBe(false);
    expect(hasGoogleDriveWriteScope([GOOGLE_DOCS_WRITE_SCOPE])).toBe(false);
    expect(hasGoogleDriveWriteScope([GOOGLE_SHEETS_WRITE_SCOPE])).toBe(false);
    expect(hasGoogleDriveWriteScope([GOOGLE_DOCS_WRITE_SCOPE, GOOGLE_SHEETS_WRITE_SCOPE])).toBe(
      true,
    );
    expect(hasGoogleDriveWriteScope(["https://www.googleapis.com/auth/drive"])).toBe(true);
  });

  it("keeps per-API write checks separate for action advertisement", () => {
    expect(hasGoogleDocsWriteScope([GOOGLE_DOCS_WRITE_SCOPE])).toBe(true);
    expect(hasGoogleDocsWriteScope([GOOGLE_SHEETS_WRITE_SCOPE])).toBe(false);
    expect(hasGoogleSheetsWriteScope([GOOGLE_SHEETS_WRITE_SCOPE])).toBe(true);
    expect(hasGoogleSheetsWriteScope([GOOGLE_DOCS_WRITE_SCOPE])).toBe(false);
  });

  it("keeps the official Drive plugin connected without the Sheets grant", () => {
    expect(googleDriveMcpScopesSatisfied([GOOGLE_DRIVE_READ_SCOPE, GOOGLE_DRIVE_FILE_SCOPE])).toBe(
      false,
    );
    // An account connected before the Sheets tools shipped keeps every other Drive tool. Only the
    // spreadsheet tools wait on the extra grant, so no unattended task loses access it already had.
    const beforeSheetsTools = [
      GOOGLE_DRIVE_READ_SCOPE,
      GOOGLE_DRIVE_FILE_SCOPE,
      GOOGLE_DOCS_WRITE_SCOPE,
    ];
    expect(googleDriveMcpScopesSatisfied(beforeSheetsTools)).toBe(true);
    expect(hasGoogleSheetsWriteScope(beforeSheetsTools)).toBe(false);
    expect(googleDriveMcpScopesSatisfied([...beforeSheetsTools, GOOGLE_SHEETS_WRITE_SCOPE])).toBe(
      true,
    );
  });
});
