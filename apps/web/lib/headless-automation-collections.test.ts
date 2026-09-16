import { createCollection } from "@tanstack/react-db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getHeadlessWorkflows } from "./headless-automation-collections";

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

    expect(first).toBe(second);
    expect(createCollection).toHaveBeenCalledTimes(1);
    expect((first as unknown as TestCollection).options).toMatchObject({
      id: "headless-workflows:v1:workspace_catalog",
      shapeOptions: { url: "https://api.example.test/v1/read-models/workflows-v1" },
    });
  });

  it("creates one collection per actor scope", () => {
    const workspaceOne = getHeadlessWorkflows("workspace_1");
    const workspaceTwo = getHeadlessWorkflows("workspace_2");

    expect(workspaceOne).not.toBe(workspaceTwo);
    expect((workspaceTwo as unknown as TestCollection).options.id).toBe(
      "headless-workflows:v1:workspace_2",
    );
  });
});
