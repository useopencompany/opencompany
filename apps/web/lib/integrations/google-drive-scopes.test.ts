import { describe, expect, it } from "vitest";
import {
  GOAT_GOOGLE_DOCS_WRITE_SCOPE,
  GOAT_GOOGLE_DRIVE_READ_SCOPE,
  GOAT_GOOGLE_SHEETS_WRITE_SCOPE,
  hasGoatGoogleDocsWriteScope,
  hasGoatGoogleDriveWriteScope,
  hasGoatGoogleSheetsWriteScope,
} from "./google-drive-scopes";

describe("Google Drive OAuth scope capabilities", () => {
  it("requires both Docs and Sheets grants for the fully upgraded Drive write scope", () => {
    expect(hasGoatGoogleDriveWriteScope([GOAT_GOOGLE_DRIVE_READ_SCOPE])).toBe(false);
    expect(hasGoatGoogleDriveWriteScope([GOAT_GOOGLE_DOCS_WRITE_SCOPE])).toBe(false);
    expect(hasGoatGoogleDriveWriteScope([GOAT_GOOGLE_SHEETS_WRITE_SCOPE])).toBe(false);
    expect(
      hasGoatGoogleDriveWriteScope([GOAT_GOOGLE_DOCS_WRITE_SCOPE, GOAT_GOOGLE_SHEETS_WRITE_SCOPE]),
    ).toBe(true);
    expect(hasGoatGoogleDriveWriteScope(["https://www.googleapis.com/auth/drive"])).toBe(true);
  });

  it("keeps per-API write checks separate for action advertisement", () => {
    expect(hasGoatGoogleDocsWriteScope([GOAT_GOOGLE_DOCS_WRITE_SCOPE])).toBe(true);
    expect(hasGoatGoogleDocsWriteScope([GOAT_GOOGLE_SHEETS_WRITE_SCOPE])).toBe(false);
    expect(hasGoatGoogleSheetsWriteScope([GOAT_GOOGLE_SHEETS_WRITE_SCOPE])).toBe(true);
    expect(hasGoatGoogleSheetsWriteScope([GOAT_GOOGLE_DOCS_WRITE_SCOPE])).toBe(false);
  });
});
