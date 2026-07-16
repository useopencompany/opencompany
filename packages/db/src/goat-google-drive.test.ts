import { describe, expect, it } from "vitest";
import { readGoatGoogleDriveAllFiles, readGoatGoogleDriveResources } from "./goat-google-drive";

describe("Google Drive source configuration", () => {
  it("sanitizes resources, timestamps, corpus keys, and duplicate ids", () => {
    expect(
      readGoatGoogleDriveResources({
        resources: [
          {
            id: "file_1",
            name: "Plan",
            kind: "file",
            mimeType: "text/plain",
            driveId: null,
            corpusKey: "user",
            webViewLink: "https://drive.google.com/file/d/file_1/view",
            selectedAt: "2026-07-13T08:00:00Z",
          },
          {
            id: "file_1",
            name: "Duplicate",
            kind: "file",
            mimeType: "text/plain",
            corpusKey: "user",
            selectedAt: "2026-07-13T08:00:00Z",
          },
          {
            id: "folder_1",
            name: "Shared",
            kind: "folder",
            mimeType: "application/vnd.google-apps.folder",
            driveId: "drive_1",
            corpusKey: "drive:drive_1",
            selectedAt: "not-a-date",
          },
        ],
      }),
    ).toEqual([
      {
        id: "file_1",
        name: "Plan",
        kind: "file",
        mimeType: "text/plain",
        driveId: null,
        corpusKey: "user",
        webViewLink: "https://drive.google.com/file/d/file_1/view",
        selectedAt: "2026-07-13T08:00:00.000Z",
      },
    ]);
  });

  it("sanitizes all-files source timestamps", () => {
    expect(
      readGoatGoogleDriveAllFiles({
        allFiles: { selectedAt: "2026-07-13T08:00:00Z" },
      }),
    ).toEqual({ selectedAt: "2026-07-13T08:00:00.000Z" });

    expect(readGoatGoogleDriveAllFiles({ allFiles: { selectedAt: "not-a-date" } })).toBeNull();
  });
});
