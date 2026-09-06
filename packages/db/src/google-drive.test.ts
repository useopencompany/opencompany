import { describe, expect, it } from "vitest";
import {
  claimNextGoogleDriveFile,
  claimNextGoogleDriveSyncCursor,
  readGoogleDriveAllFiles,
  readGoogleDriveResources,
} from "./google-drive";

describe("Google Drive source configuration", () => {
  it("sanitizes resources, timestamps, corpus keys, and duplicate ids", () => {
    expect(
      readGoogleDriveResources({
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
      readGoogleDriveAllFiles({
        allFiles: { selectedAt: "2026-07-13T08:00:00Z" },
      }),
    ).toEqual({ selectedAt: "2026-07-13T08:00:00.000Z" });

    expect(readGoogleDriveAllFiles({ allFiles: { selectedAt: "not-a-date" } })).toBeNull();
  });
});

describe("Google Drive claims", () => {
  it("normalizes timestamps returned as strings by raw database drivers", async () => {
    const firstObservedAt = "2026-09-06T15:00:00.000Z";
    const lastObservedAt = "2026-09-06T16:00:00.000Z";
    const file = await claimNextGoogleDriveFile({
      leaseId: "file_lease",
      leaseOwner: "worker",
      leaseExpiresAt: new Date("2026-09-06T17:00:00.000Z"),
      now: new Date("2026-09-06T16:30:00.000Z"),
      db: {
        execute: async () => ({
          rows: [{ id: "file_state", firstObservedAt, lastObservedAt }],
        }),
      },
    });

    expect(file?.firstObservedAt).toEqual(new Date(firstObservedAt));
    expect(file?.lastObservedAt).toEqual(new Date(lastObservedAt));

    const wakeRequestedAt = "2026-09-06T16:15:00.000Z";
    const cursor = await claimNextGoogleDriveSyncCursor({
      leaseId: "cursor_lease",
      leaseOwner: "worker",
      leaseExpiresAt: new Date("2026-09-06T17:00:00.000Z"),
      reconcileBefore: new Date("2026-09-06T16:00:00.000Z"),
      now: new Date("2026-09-06T16:30:00.000Z"),
      db: {
        execute: async () => ({
          rows: [{ id: "cursor", wakeRequestedAt, lastPolledAt: null }],
        }),
      },
    });

    expect(cursor?.wakeRequestedAt).toEqual(new Date(wakeRequestedAt));
    expect(cursor?.lastPolledAt).toBeNull();
  });
});
