import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, expect, it, vi } from "vitest";
import { loadBotIdentityPrompt } from "./bot-context";

const query = vi.hoisted(() => ({ where: vi.fn(), limit: vi.fn() }));
vi.mock("./db", () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: query.where }) }) }),
}));
beforeEach(() => {
  query.where.mockReturnValue({ limit: query.limit });
  query.limit.mockReset();
});
it("reads the current identity through the runner database scoped to the conversation owner", async () => {
  query.limit.mockResolvedValueOnce([{ name: "Research", description: "Find customers" }]);
  expect(await loadBotIdentityPrompt("conversation_1", "user_1")).toContain('"name":"Research"');
  const condition = new PgDialect().sqlToQuery(query.where.mock.calls.at(-1)![0]);
  expect(condition.params).toEqual(["conversation_1", "user_1"]);
  query.limit.mockResolvedValueOnce([{ name: "Research", description: "Find competitors" }]);
  expect(await loadBotIdentityPrompt("conversation_1", "user_1")).toContain("Find competitors");
});
it("keeps ordinary chats unchanged and surfaces storage failures", async () => {
  query.limit.mockResolvedValueOnce([{ name: null, description: null }]);
  expect(await loadBotIdentityPrompt("conversation_1", "user_1")).toBe("");
  query.limit.mockRejectedValueOnce(new Error("Database unavailable"));
  await expect(loadBotIdentityPrompt("conversation_1", "user_1")).rejects.toThrow(
    "Database unavailable",
  );
});
