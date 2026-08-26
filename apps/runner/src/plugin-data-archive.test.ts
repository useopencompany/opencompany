import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PLUGIN_DATA_LIMITS } from "@opencompany/agent-runtime";
import { describe, expect, it } from "vitest";
import {
  EMPTY_PLUGIN_DATA_ARCHIVE,
  PLUGIN_DATA_ARCHIVE_SCRIPT,
  PLUGIN_DATA_EXTRACT_SCRIPT,
  validatePluginDataArchive,
} from "./plugin-data-archive";

describe("validatePluginDataArchive", () => {
  it("accepts regular files and directories", () => {
    const archive = tar([
      { path: "cache/", type: "5" },
      { path: "cache/state.json", content: new TextEncoder().encode('{"ok":true}') },
    ]);

    expect(validatePluginDataArchive(archive)).toEqual([
      { path: "cache", type: "directory", sizeBytes: 0 },
      { path: "cache/state.json", type: "file", sizeBytes: 11 },
    ]);
    expect(validatePluginDataArchive(EMPTY_PLUGIN_DATA_ARCHIVE)).toEqual([]);
  });

  it.each([
    ["absolute paths", { path: "/private/key" }, /unsafe path/u],
    ["path traversal", { path: "cache/../private/key" }, /unsafe path/u],
    ["symbolic links", { path: "link", type: "2", linkname: "target" }, /link or special/u],
    ["hard links", { path: "link", type: "1", linkname: "target" }, /link or special/u],
    ["devices", { path: "device", type: "3" }, /link or special/u],
  ])("rejects %s", (_label, entry, expected) => {
    expect(() => validatePluginDataArchive(tar([entry]))).toThrow(expected);
  });

  it("rejects declared expansion and archive-size violations", () => {
    expect(() =>
      validatePluginDataArchive(
        tar([{ path: "huge.bin", declaredSize: PLUGIN_DATA_LIMITS.maxTotalBytes + 1 }]),
      ),
    ).toThrow(/expands beyond/u);
    expect(() =>
      validatePluginDataArchive(new Uint8Array(PLUGIN_DATA_LIMITS.maxTotalBytes + 512)),
    ).toThrow(/exceeds the 32 MiB limit/u);
  });

  it("creates and extracts regular data while rejecting links at both boundaries", () => {
    const temporaryRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "opencompany-data-")));
    const sourceRoot = path.join(temporaryRoot, "source");
    const restoredRoot = path.join(temporaryRoot, "restored");
    const archivePath = path.join(temporaryRoot, "data.tar");
    const archiveScript = path.join(temporaryRoot, "archive.py");
    const extractScript = path.join(temporaryRoot, "extract.py");
    mkdirSync(sourceRoot);
    mkdirSync(restoredRoot);
    writeFileSync(path.join(sourceRoot, "state.txt"), "durable value");
    writeFileSync(archiveScript, PLUGIN_DATA_ARCHIVE_SCRIPT);
    writeFileSync(extractScript, PLUGIN_DATA_EXTRACT_SCRIPT);
    try {
      execFileSync(
        "python3",
        [archiveScript, sourceRoot, archivePath, String(PLUGIN_DATA_LIMITS.maxTotalBytes)],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(validatePluginDataArchive(readFileSync(archivePath))).toEqual([
        { path: "state.txt", type: "file", sizeBytes: 13 },
      ]);
      execFileSync(
        "python3",
        [extractScript, archivePath, restoredRoot, String(PLUGIN_DATA_LIMITS.maxTotalBytes)],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(readFileSync(path.join(restoredRoot, "state.txt"), "utf8")).toBe("durable value");

      symlinkSync(path.join(sourceRoot, "state.txt"), path.join(sourceRoot, "linked.txt"));
      expect(() =>
        execFileSync(
          "python3",
          [archiveScript, sourceRoot, archivePath, String(PLUGIN_DATA_LIMITS.maxTotalBytes)],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      ).toThrow();
      const maliciousArchive = path.join(temporaryRoot, "malicious.tar");
      const maliciousRestoredRoot = path.join(temporaryRoot, "malicious-restored");
      mkdirSync(maliciousRestoredRoot);
      writeFileSync(maliciousArchive, tar([{ path: "linked", type: "2", linkname: "target" }]));
      expect(() =>
        execFileSync(
          "python3",
          [
            extractScript,
            maliciousArchive,
            maliciousRestoredRoot,
            String(PLUGIN_DATA_LIMITS.maxTotalBytes),
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      ).toThrow();
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

type TarEntry = {
  path: string;
  type?: string;
  content?: Uint8Array;
  declaredSize?: number;
  linkname?: string;
};

function tar(entries: TarEntry[]) {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const content = entry.content ?? new Uint8Array();
    const size = entry.declaredSize ?? content.byteLength;
    const header = new Uint8Array(512);
    writeText(header, 0, 100, entry.path);
    writeOctal(header, 100, 8, 0o700);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, size);
    writeOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    writeText(header, 156, 1, entry.type ?? "0");
    if (entry.linkname) writeText(header, 157, 100, entry.linkname);
    writeText(header, 257, 6, "ustar");
    writeText(header, 263, 2, "00");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeOctal(header, 148, 8, checksum);
    blocks.push(header);
    if (content.byteLength > 0) {
      const padded = new Uint8Array(Math.ceil(content.byteLength / 512) * 512);
      padded.set(content);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const size = blocks.reduce((sum, block) => sum + block.byteLength, 0);
  const archive = new Uint8Array(size);
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.byteLength;
  }
  return archive;
}

function writeText(target: Uint8Array, offset: number, length: number, value: string) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > length) throw new Error("test tar field overflow");
  target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number) {
  const encoded = value
    .toString(8)
    .padStart(length - 1, "0")
    .slice(-(length - 1));
  writeText(target, offset, length, `${encoded}\0`);
}
