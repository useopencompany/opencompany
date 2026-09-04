export const GOOGLE_DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_DOCS_WRITE_SCOPE = "https://www.googleapis.com/auth/documents";
export const GOOGLE_SHEETS_WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const GOOGLE_DRIVE_FULL_SCOPE = "https://www.googleapis.com/auth/drive";

export const GOOGLE_DRIVE_MCP_RECONNECT_REASON =
  "Reconnect Google Drive to enable plugin file access and Google Docs editing.";

const GOOGLE_DOCS_WRITE_SCOPES = new Set([GOOGLE_DOCS_WRITE_SCOPE, GOOGLE_DRIVE_FULL_SCOPE]);

const GOOGLE_SHEETS_WRITE_SCOPES = new Set([GOOGLE_SHEETS_WRITE_SCOPE, GOOGLE_DRIVE_FULL_SCOPE]);

export function googleDriveMcpScopesSatisfied(scopes: readonly string[]) {
  const granted = new Set(scopes);
  return (
    (granted.has(GOOGLE_DRIVE_READ_SCOPE) || granted.has(GOOGLE_DRIVE_FULL_SCOPE)) &&
    (granted.has(GOOGLE_DRIVE_FILE_SCOPE) || granted.has(GOOGLE_DRIVE_FULL_SCOPE)) &&
    hasGoogleDocsWriteScope(scopes)
  );
}

export function hasGoogleDocsWriteScope(scopes: readonly string[]) {
  return scopes.some((scope) => GOOGLE_DOCS_WRITE_SCOPES.has(scope));
}

export function hasGoogleSheetsWriteScope(scopes: readonly string[]) {
  return scopes.some((scope) => GOOGLE_SHEETS_WRITE_SCOPES.has(scope));
}

export function hasGoogleDriveWriteScope(scopes: readonly string[]) {
  return hasGoogleDocsWriteScope(scopes) && hasGoogleSheetsWriteScope(scopes);
}
