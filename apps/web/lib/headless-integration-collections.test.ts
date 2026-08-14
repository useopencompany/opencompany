import { createCollection } from "@tanstack/react-db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getHeadlessIntegrationAccounts } from "./headless-integration-collections";

vi.mock("@tanstack/electric-db-collection", () => ({
  electricCollectionOptions: vi.fn((options) => options),
}));

vi.mock("@tanstack/react-db", () => ({
  createCollection: vi.fn((options) => ({ options })),
}));

vi.mock("./headless-chat-api", () => ({
  createHeadlessChatApiFetch: vi.fn(() => fetch),
  headlessChatApiBaseUrl: vi.fn(() => "https://api.example.test"),
}));

describe("headless integration collections", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the versioned API-owned shape and caches it by actor scope", () => {
    const first = getHeadlessIntegrationAccounts("workspace_1");
    const second = getHeadlessIntegrationAccounts("workspace_1");

    expect(first).toBe(second);
    expect(createCollection).toHaveBeenCalledTimes(1);
    expect(
      (first as unknown as { options: { id: string; shapeOptions: { url: string } } }).options,
    ).toMatchObject({
      id: "headless-integration-accounts:v1:workspace_1",
      shapeOptions: {
        url: "https://api.example.test/v1/read-models/integration-accounts-v1",
      },
    });
  });
});
