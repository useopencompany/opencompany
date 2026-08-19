import { createCollection } from "@tanstack/react-db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitHeadlessTaskScheduleTransaction,
  getHeadlessTaskSchedules,
  getHeadlessWorkflows,
} from "./headless-automation-collections";

vi.mock("@tanstack/electric-db-collection", () => ({
  electricCollectionOptions: vi.fn((options) => options),
}));

vi.mock("@tanstack/react-db", () => ({
  createCollection: vi.fn((options) => ({
    options,
    utils: { awaitTxId: vi.fn(async () => undefined) },
  })),
}));

vi.mock("./headless-chat-api", () => ({
  createHeadlessChatApiFetch: vi.fn(() => fetch),
  headlessChatApiBaseUrl: vi.fn(() => "https://api.example.test"),
}));

type TestCollection = {
  options: { id: string; shapeOptions: { url: string } };
  utils: { awaitTxId: ReturnType<typeof vi.fn> };
};

describe("headless automation collections", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses versioned API-owned shapes and caches collections by actor scope", () => {
    const first = getHeadlessWorkflows("workspace_catalog");
    const second = getHeadlessWorkflows("workspace_catalog");
    const schedules = getHeadlessTaskSchedules("workspace_catalog");

    expect(first).toBe(second);
    expect(createCollection).toHaveBeenCalledTimes(2);
    expect((first as unknown as TestCollection).options).toMatchObject({
      id: "headless-workflows:v1:workspace_catalog",
      shapeOptions: { url: "https://api.example.test/v1/read-models/workflows-v1" },
    });
    expect((schedules as unknown as TestCollection).options).toMatchObject({
      id: "headless-task-schedules:v1:workspace_catalog",
      shapeOptions: { url: "https://api.example.test/v1/read-models/task-schedules-v1" },
    });
  });

  it("rejects unsafe API transaction identifiers before waiting", async () => {
    const schedules = getHeadlessTaskSchedules("workspace_invalid_tx");

    await expect(
      awaitHeadlessTaskScheduleTransaction("9007199254740992", {
        scopeKey: "workspace_invalid_tx",
      }),
    ).rejects.toThrow("invalid Electric transaction identifier");
    expect(schedules.utils.awaitTxId).not.toHaveBeenCalled();
  });
});
