import { describe, expect, test } from "vitest";
import { type ArtifactFile, computeArtifactIntegrity } from "./artifact-integrity";

const enc = new TextEncoder();

function file(path: string, content: string, executable = false): ArtifactFile {
  return { path, content: enc.encode(content), executable };
}

describe("computeArtifactIntegrity", () => {
  test("returns a sha256 hex digest", async () => {
    const integrity = await computeArtifactIntegrity([file("SKILL.md", "hi")]);
    expect(integrity).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("is independent of input order", async () => {
    const a = [file("a.txt", "1"), file("b.txt", "2"), file("SKILL.md", "s")];
    const b = [file("SKILL.md", "s"), file("b.txt", "2"), file("a.txt", "1")];
    expect(await computeArtifactIntegrity(a)).toBe(await computeArtifactIntegrity(b));
  });

  test("changes when the executable bit changes", async () => {
    const off = await computeArtifactIntegrity([file("run.sh", "#!/bin/sh", false)]);
    const on = await computeArtifactIntegrity([file("run.sh", "#!/bin/sh", true)]);
    expect(off).not.toBe(on);
  });

  test("changes when content changes", async () => {
    const one = await computeArtifactIntegrity([file("SKILL.md", "a")]);
    const two = await computeArtifactIntegrity([file("SKILL.md", "b")]);
    expect(one).not.toBe(two);
  });

  test("changes when a path changes", async () => {
    const one = await computeArtifactIntegrity([file("a.md", "x")]);
    const two = await computeArtifactIntegrity([file("b.md", "x")]);
    expect(one).not.toBe(two);
  });

  test("distinguishes files that differ only at the path/content boundary", async () => {
    // Length delimiters make ("ab", "c") and ("a", "bc") produce different digests even though a
    // naive separator-free concatenation would collide.
    const first = await computeArtifactIntegrity([file("ab", "c")]);
    const second = await computeArtifactIntegrity([file("a", "bc")]);
    expect(first).not.toBe(second);
  });

  test("commits to raw bytes, including NUL and non-UTF-8 sequences", async () => {
    const binary: ArtifactFile = {
      path: "logo.bin",
      content: Uint8Array.from([0x00, 0xff, 0x00]),
      executable: false,
    };
    const integrity = await computeArtifactIntegrity([binary]);
    expect(integrity).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
