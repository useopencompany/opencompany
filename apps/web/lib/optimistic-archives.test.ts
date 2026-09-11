import { afterEach, describe, expect, it } from "vitest";
import {
  archiveConversationOptimistically,
  clearOptimisticArchives,
  getOptimisticArchives,
  reconcileOptimisticArchives,
  restoreOptimisticArchive,
} from "@/lib/optimistic-archives";

describe("optimistic review archives", () => {
  afterEach(() => {
    clearOptimisticArchives();
  });

  it("hides the item as soon as the archive is requested", () => {
    expect(archiveConversationOptimistically("conversation_1")).toBe(true);

    expect(getOptimisticArchives().has("conversation_1")).toBe(true);
  });

  // The row leaves on the click, so a second command can only come from a double click that beat
  // the re-render. One archive per conversation is what the read model expects.
  it("refuses a second archive for the same conversation", () => {
    archiveConversationOptimistically("conversation_1");

    expect(archiveConversationOptimistically("conversation_1")).toBe(false);
  });

  it("puts the item back when the archive fails", () => {
    archiveConversationOptimistically("conversation_1");

    restoreOptimisticArchive("conversation_1");

    expect(getOptimisticArchives().has("conversation_1")).toBe(false);
  });

  // Once the projection reports the row archived, the local hint has nothing left to hide: keeping
  // it would suppress the conversation if it were ever restored.
  it("drops the hint once the projection reports the row archived", () => {
    archiveConversationOptimistically("conversation_1");
    archiveConversationOptimistically("conversation_2");

    reconcileOptimisticArchives(["conversation_1"]);

    expect([...getOptimisticArchives()]).toEqual(["conversation_2"]);
  });

  it("keeps the hint while the projection still reports the row live", () => {
    archiveConversationOptimistically("conversation_1");

    reconcileOptimisticArchives([]);

    expect(getOptimisticArchives().has("conversation_1")).toBe(true);
  });
});
