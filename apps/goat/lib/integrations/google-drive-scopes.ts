export const GOAT_GOOGLE_DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const GOAT_GOOGLE_DOCS_WRITE_SCOPE = "https://www.googleapis.com/auth/documents";

const GOOGLE_DRIVE_WRITE_SCOPES = new Set([
  GOAT_GOOGLE_DOCS_WRITE_SCOPE,
  "https://www.googleapis.com/auth/drive",
]);

export function hasGoatGoogleDriveWriteScope(scopes: readonly string[]) {
  return scopes.some((scope) => GOOGLE_DRIVE_WRITE_SCOPES.has(scope));
}
