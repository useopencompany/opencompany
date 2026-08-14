import { describe, expect, it } from "vitest";
import { parseBrainWorkerAdmission } from "./worker-admission";

describe("parseBrainWorkerAdmission", () => {
  it.each([
    "brain_import",
    "brain_ingest",
    "google_drive_sync",
  ])("accepts the %s worker hint", (worker) => {
    expect(parseBrainWorkerAdmission(JSON.stringify({ worker }))).toBe(worker);
  });

  it.each([
    "not json",
    "{}",
    JSON.stringify({ worker: "codex_chat" }),
    JSON.stringify({ worker: 1 }),
  ])("rejects an invalid or unrelated payload", (payload) => {
    expect(parseBrainWorkerAdmission(payload)).toBeNull();
  });
});
