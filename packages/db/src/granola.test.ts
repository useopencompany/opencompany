import { describe, expect, it } from "vitest";
import { granolaNoteFolderScope, granolaWorkflowEventDeliveryId } from "./granola";

describe("granolaNoteFolderScope", () => {
  const tree = new Map<string, string | null>([
    ["fol_acme", "fol_customers"],
    ["fol_customers", "fol_external"],
    ["fol_external", null],
    ["fol_internal", null],
  ]);

  it("covers a filtered folder's descendants the way Granola's own folder query does", () => {
    expect(
      granolaNoteFolderScope(
        { folder_membership: [{ id: "fol_acme", parent_folder_id: "fol_customers" }] },
        tree,
      ),
    ).toEqual(["fol_acme", "fol_customers", "fol_external"]);
  });

  it("collects every folder a note was filed in", () => {
    expect(
      granolaNoteFolderScope(
        {
          folder_membership: [
            { id: "fol_acme", parent_folder_id: "fol_customers" },
            { id: "fol_internal", parent_folder_id: null },
          ],
        },
        tree,
      ),
    ).toEqual(["fol_acme", "fol_customers", "fol_external", "fol_internal"]);
  });

  it("keeps the membership entry's own parent when the folder list missed it", () => {
    expect(
      granolaNoteFolderScope(
        { folder_membership: [{ id: "fol_new", parent_folder_id: "fol_customers" }] },
        new Map(),
      ),
    ).toEqual(["fol_new", "fol_customers"]);
  });

  it("returns nothing for a note that belongs to no folder", () => {
    expect(granolaNoteFolderScope({}, tree)).toEqual([]);
    expect(granolaNoteFolderScope({ folder_membership: "not-an-array" }, tree)).toEqual([]);
  });

  it("stops walking a folder tree that points back at itself", () => {
    expect(
      granolaNoteFolderScope(
        { folder_membership: [{ id: "fol_a", parent_folder_id: "fol_b" }] },
        new Map([
          ["fol_a", "fol_b"],
          ["fol_b", "fol_a"],
        ]),
      ),
    ).toEqual(["fol_a", "fol_b"]);
  });
});

describe("granolaWorkflowEventDeliveryId", () => {
  it("keys on the note id so a re-polled note is a duplicate, not a second run", () => {
    expect(granolaWorkflowEventDeliveryId("note_1")).toBe("note:note_1");
  });
});
