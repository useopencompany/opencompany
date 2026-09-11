import { afterEach, describe, expect, it } from "vitest";
import {
  archiveReviewItemOptimistically,
  clearOptimisticReviewArchives,
  getOptimisticReviewArchives,
  reconcileOptimisticReviewArchives,
  restoreOptimisticReviewArchive,
} from "@/lib/optimistic-review-archive";

describe("optimistic review archives", () => {
  afterEach(() => {
    clearOptimisticReviewArchives();
  });

  it("hides the item as soon as the archive is requested", () => {
    expect(archiveReviewItemOptimistically("conversation_1")).toBe(true);

    expect(getOptimisticReviewArchives().has("conversation_1")).toBe(true);
  });

  // The row leaves on the click, so a second command can only come from a double click that beat
  // the re-render. One archive per conversation is what the read model expects.
  it("refuses a second archive for the same conversation", () => {
    archiveReviewItemOptimistically("conversation_1");

    expect(archiveReviewItemOptimistically("conversation_1")).toBe(false);
  });

  it("puts the item back when the archive fails", () => {
    archiveReviewItemOptimistically("conversation_1");

    restoreOptimisticReviewArchive("conversation_1");

    expect(getOptimisticReviewArchives().has("conversation_1")).toBe(false);
  });

  // Once the projection reports the row archived, the local hint has nothing left to hide: keeping
  // it would suppress the conversation if it were ever restored.
  it("drops the hint once the projection reports the row archived", () => {
    archiveReviewItemOptimistically("conversation_1");
    archiveReviewItemOptimistically("conversation_2");

    reconcileOptimisticReviewArchives(["conversation_1"]);

    expect([...getOptimisticReviewArchives()]).toEqual(["conversation_2"]);
  });

  it("keeps the hint while the projection still reports the row live", () => {
    archiveReviewItemOptimistically("conversation_1");

    reconcileOptimisticReviewArchives([]);

    expect(getOptimisticReviewArchives().has("conversation_1")).toBe(true);
  });
});
