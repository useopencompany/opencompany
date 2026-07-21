import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  slackResolve: vi.fn(),
  linearResolve: vi.fn(),
  youtubeResolve: vi.fn(),
  attioResolve: vi.fn(),
}));

vi.mock("@/lib/capabilities/slack", () => ({
  slackCapability: {
    id: "slack",
    workerModel: "openai/gpt-5.4-mini",
    resolve: mocks.slackResolve,
  },
}));
vi.mock("@/lib/capabilities/linear", () => ({
  linearCapability: {
    id: "linear",
    workerModel: "openai/gpt-5.4-mini",
    resolve: mocks.linearResolve,
  },
}));
vi.mock("@/lib/capabilities/youtube-transcript", () => ({
  youtubeTranscriptCapability: {
    id: "youtube_transcript",
    workerModel: "openai/gpt-5.4-mini",
    resolve: mocks.youtubeResolve,
  },
}));
vi.mock("@/lib/capabilities/attio", () => ({
  attioCapability: {
    id: "attio",
    workerModel: "openai/gpt-5.4-mini",
    resolve: mocks.attioResolve,
  },
}));

import {
  isGoatChatCapabilitiesKilled,
  resolveGoatCapabilityUniverse,
} from "@/lib/capabilities/registry";

const RESOLVED = {
  operations: ["read"] as const,
  indexLine: "x — CAN read. CANNOT write.",
  recipeLines: ["recipe"],
  createTools: async () => ({ tools: {} }),
};

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.GOAT_CHAT_CAPABILITIES_KILL_SWITCH;
});

describe("resolveGoatCapabilityUniverse", () => {
  it("returns only available capabilities with id and worker model attached", async () => {
    mocks.slackResolve.mockResolvedValue(RESOLVED);
    mocks.linearResolve.mockResolvedValue(null);
    mocks.youtubeResolve.mockResolvedValue(RESOLVED);
    mocks.attioResolve.mockResolvedValue(null);

    const universe = await resolveGoatCapabilityUniverse("user_1");
    expect(universe.map((capability) => capability.id)).toEqual(["slack", "youtube_transcript"]);
    expect(universe[0]?.workerModel).toBe("openai/gpt-5.4-mini");
    expect(universe[0]?.indexLine).toBe(RESOLVED.indexLine);
  });

  it("treats resolver failures as unavailable instead of failing the turn", async () => {
    mocks.slackResolve.mockRejectedValue(new Error("db down"));
    mocks.linearResolve.mockResolvedValue(RESOLVED);
    mocks.youtubeResolve.mockResolvedValue(null);
    mocks.attioResolve.mockResolvedValue(null);

    const universe = await resolveGoatCapabilityUniverse("user_1");
    expect(universe.map((capability) => capability.id)).toEqual(["linear"]);
  });

  it("returns an empty universe when nothing is connected", async () => {
    mocks.slackResolve.mockResolvedValue(null);
    mocks.linearResolve.mockResolvedValue(null);
    mocks.youtubeResolve.mockResolvedValue(null);
    mocks.attioResolve.mockResolvedValue(null);

    expect(await resolveGoatCapabilityUniverse("user_1")).toEqual([]);
  });
});

describe("isGoatChatCapabilitiesKilled", () => {
  it("is off unless the env var is exactly 'true'", () => {
    expect(isGoatChatCapabilitiesKilled()).toBe(false);
    process.env.GOAT_CHAT_CAPABILITIES_KILL_SWITCH = "1";
    expect(isGoatChatCapabilitiesKilled()).toBe(false);
    process.env.GOAT_CHAT_CAPABILITIES_KILL_SWITCH = "true";
    expect(isGoatChatCapabilitiesKilled()).toBe(true);
  });
});
