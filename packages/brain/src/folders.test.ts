import { describe, expect, it } from "vitest";
import {
  brainFolderSourceForPath,
  compareBrainFolderPaths,
  defaultBrainFolderManifestEntries,
  normalizeBrainFolderEntries,
  parseBrainFolderManifest,
} from "./folders";

describe("Goat Brain folder taxonomy", () => {
  it("orders the hard and adjustable defaults in the designed root order", () => {
    expect(defaultBrainFolderManifestEntries().map((entry) => entry.path)).toEqual([
      "inbox",
      "thoughts",
      "projects",
      "meetings",
      "research",
      "decisions",
      "concepts",
      "people",
      "companies",
      "evidence",
    ]);
  });

  it("marks only hard roots as system folders", () => {
    expect(brainFolderSourceForPath("inbox")).toBe("system");
    expect(brainFolderSourceForPath("people")).toBe("system");
    expect(brainFolderSourceForPath("companies")).toBe("system");
    expect(brainFolderSourceForPath("evidence")).toBe("system");
    expect(brainFolderSourceForPath("thoughts")).toBe("custom");
    expect(brainFolderSourceForPath("research")).toBe("custom");
    // Workflows/skills are no longer Brain folders (extracted to their own tables).
    expect(brainFolderSourceForPath("skills")).toBe("custom");
    expect(brainFolderSourceForPath("workflows")).toBe("custom");
    expect(brainFolderSourceForPath("people/acme")).toBe("custom");
  });

  it("does not recreate adjustable defaults when a manifest exists", () => {
    const entries = parseBrainFolderManifest(
      JSON.stringify({
        schemaVersion: "goat.brain.folders.v1",
        folders: [{ path: "partners", source: "custom" }],
      }),
    );

    expect(entries.map((entry) => entry.path)).toEqual([
      "inbox",
      "partners",
      "people",
      "companies",
      "evidence",
    ]);
    expect(entries.map((entry) => entry.path)).not.toContain("projects");
  });

  it("normalizes source values and sorts custom roots before people and companies", () => {
    expect(
      normalizeBrainFolderEntries([
        { path: "people", source: "custom" },
        { path: "research", source: "system" },
        { path: "zeta", source: "custom" },
        { path: "alpha", source: "custom" },
      ]),
    ).toEqual([
      { path: "inbox", source: "system" },
      { path: "research", source: "custom" },
      { path: "alpha", source: "custom" },
      { path: "zeta", source: "custom" },
      { path: "people", source: "system" },
      { path: "companies", source: "system" },
      { path: "evidence", source: "system" },
    ]);
  });

  it("compares nested paths within their ordered roots", () => {
    expect(
      ["people/ada", "projects/app", "evidence/chat", "inbox/todo"].toSorted(
        compareBrainFolderPaths,
      ),
    ).toEqual(["inbox/todo", "projects/app", "people/ada", "evidence/chat"]);
  });
});
