import { describe, expect, it } from "vitest";
import {
  compareGoatBrainFolderPaths,
  defaultGoatBrainFolderManifestEntries,
  goatBrainFolderSourceForPath,
  normalizeGoatBrainFolderEntries,
  parseGoatBrainFolderManifest,
} from "./folders";

describe("Goat Brain folder taxonomy", () => {
  it("orders the hard and adjustable defaults in the designed root order", () => {
    expect(defaultGoatBrainFolderManifestEntries().map((entry) => entry.path)).toEqual([
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
    expect(goatBrainFolderSourceForPath("inbox")).toBe("system");
    expect(goatBrainFolderSourceForPath("people")).toBe("system");
    expect(goatBrainFolderSourceForPath("companies")).toBe("system");
    expect(goatBrainFolderSourceForPath("evidence")).toBe("system");
    expect(goatBrainFolderSourceForPath("thoughts")).toBe("custom");
    expect(goatBrainFolderSourceForPath("research")).toBe("custom");
    expect(goatBrainFolderSourceForPath("people/acme")).toBe("custom");
  });

  it("does not recreate adjustable defaults when a manifest exists", () => {
    const entries = parseGoatBrainFolderManifest(
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
      normalizeGoatBrainFolderEntries([
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
        compareGoatBrainFolderPaths,
      ),
    ).toEqual(["inbox/todo", "projects/app", "people/ada", "evidence/chat"]);
  });
});
