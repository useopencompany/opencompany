export const GOAT_GOOGLE_DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const GOAT_GOOGLE_DOCS_WRITE_SCOPE = "https://www.googleapis.com/auth/documents";
export const GOAT_GOOGLE_SHEETS_WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const GOOGLE_DOCS_WRITE_SCOPES = new Set([
  GOAT_GOOGLE_DOCS_WRITE_SCOPE,
  "https://www.googleapis.com/auth/drive",
]);

const GOOGLE_SHEETS_WRITE_SCOPES = new Set([
  GOAT_GOOGLE_SHEETS_WRITE_SCOPE,
  "https://www.googleapis.com/auth/drive",
]);

export function hasGoogleDocsWriteScope(scopes: readonly string[]) {
  return scopes.some((scope) => GOOGLE_DOCS_WRITE_SCOPES.has(scope));
}

export function hasGoogleSheetsWriteScope(scopes: readonly string[]) {
  return scopes.some((scope) => GOOGLE_SHEETS_WRITE_SCOPES.has(scope));
}

export function hasGoogleDriveWriteScope(scopes: readonly string[]) {
  return hasGoogleDocsWriteScope(scopes) && hasGoogleSheetsWriteScope(scopes);
}
