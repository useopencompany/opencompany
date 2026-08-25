import { assertSafeRelativePath, PLUGIN_DATA_LIMITS } from "@opencompany/agent-runtime";

const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;

export const EMPTY_PLUGIN_DATA_ARCHIVE = new Uint8Array(TAR_END_BYTES);

export type PluginDataArchiveEntry = {
  path: string;
  type: "file" | "directory";
  sizeBytes: number;
};

export function validatePluginDataArchive(bytes: Uint8Array): PluginDataArchiveEntry[] {
  if (bytes.byteLength > PLUGIN_DATA_LIMITS.maxTotalBytes) {
    throw new Error("Plugin data archive exceeds the 32 MiB limit.");
  }
  if (bytes.byteLength < TAR_END_BYTES || bytes.byteLength % TAR_BLOCK_BYTES !== 0) {
    throw new Error("Plugin data archive is not a complete tar stream.");
  }

  const entries: PluginDataArchiveEntry[] = [];
  const paths = new Set<string>();
  let totalFileBytes = 0;
  let offset = 0;
  let zeroBlocks = 0;
  while (offset < bytes.byteLength) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      offset += TAR_BLOCK_BYTES;
      if (zeroBlocks >= 2) {
        if (!bytes.subarray(offset).every((byte) => byte === 0)) {
          throw new Error("Plugin data archive has content after its end marker.");
        }
        return entries;
      }
      continue;
    }
    if (zeroBlocks > 0) throw new Error("Plugin data archive has an invalid end marker.");
    validateHeaderChecksum(header);

    const name = tarText(header.subarray(0, 100), "path");
    const prefix = tarText(header.subarray(345, 500), "path prefix");
    const rawPath = prefix ? `${prefix}/${name}` : name;
    const path = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
    if (!path) throw new Error("Plugin data archive contains an empty path.");
    try {
      assertSafeRelativePath(path);
    } catch {
      throw new Error("Plugin data archive contains an unsafe path.");
    }
    if (paths.has(path)) throw new Error("Plugin data archive contains a duplicate path.");
    paths.add(path);

    const typeFlag = header[156] ?? 0;
    const sizeBytes = tarOctal(header.subarray(124, 136), "size");
    let type: PluginDataArchiveEntry["type"];
    if (typeFlag === 0 || typeFlag === 48) {
      type = "file";
      totalFileBytes += sizeBytes;
      if (totalFileBytes > PLUGIN_DATA_LIMITS.maxTotalBytes) {
        throw new Error("Plugin data archive expands beyond the 32 MiB limit.");
      }
    } else if (typeFlag === 53) {
      type = "directory";
      if (sizeBytes !== 0) throw new Error("Plugin data archive directory has content bytes.");
    } else {
      throw new Error("Plugin data archive contains a link or special device.");
    }
    if (header.subarray(157, 257).some((byte) => byte !== 0)) {
      throw new Error("Plugin data archive contains a link target.");
    }

    entries.push({ path, type, sizeBytes });
    const contentBytes = Math.ceil(sizeBytes / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    offset += TAR_BLOCK_BYTES + contentBytes;
    if (offset > bytes.byteLength) {
      throw new Error("Plugin data archive entry exceeds the tar stream.");
    }
  }
  throw new Error("Plugin data archive has no end marker.");
}

function validateHeaderChecksum(header: Uint8Array) {
  const declared = tarOctal(header.subarray(148, 156), "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  }
  if (actual !== declared) throw new Error("Plugin data archive header checksum is invalid.");
}

function tarOctal(bytes: Uint8Array, field: string) {
  if ((bytes[0] ?? 0) & 0x80) {
    throw new Error(`Plugin data archive ${field} uses an unsupported numeric encoding.`);
  }
  const value = new TextDecoder("ascii").decode(bytes).replaceAll("\0", "").trim();
  if (!/^[0-7]+$/u.test(value)) {
    throw new Error(`Plugin data archive ${field} is invalid.`);
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Plugin data archive ${field} is out of range.`);
  }
  return parsed;
}

function tarText(bytes: Uint8Array, field: string) {
  const end = bytes.indexOf(0);
  const content = end === -1 ? bytes : bytes.subarray(0, end);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`Plugin data archive ${field} is not UTF-8.`);
  }
}

export const PLUGIN_DATA_ARCHIVE_SCRIPT = String.raw`#!/usr/bin/python3
import os
import stat
import sys
import tarfile

data_root, output_path, raw_limit = sys.argv[1:]
limit = int(raw_limit)
if os.path.realpath(data_root) != data_root:
    raise SystemExit("Plugin data directory failed containment verification.")

projected = 1024

def tar_info(relative_path, file_stat, is_directory):
    info = tarfile.TarInfo(relative_path + ("/" if is_directory else ""))
    info.type = tarfile.DIRTYPE if is_directory else tarfile.REGTYPE
    info.mode = stat.S_IMODE(file_stat.st_mode)
    info.mtime = int(file_stat.st_mtime)
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.size = 0 if is_directory else file_stat.st_size
    return info

def walk(archive, directory_fd, prefix=""):
    global projected
    for name in sorted(os.listdir(directory_fd)):
        if not name or "/" in name or name in (".", ".."):
            raise RuntimeError("Plugin data contains an unsafe path.")
        relative_path = f"{prefix}/{name}" if prefix else name
        file_stat = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if stat.S_ISDIR(file_stat.st_mode):
            child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try:
                projected += 512
                if projected > limit:
                    raise RuntimeError("Plugin data archive exceeds the 32 MiB limit.")
                archive.addfile(tar_info(relative_path, file_stat, True))
                walk(archive, child_fd, relative_path)
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(file_stat.st_mode):
            file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try:
                opened_stat = os.fstat(file_fd)
                if (opened_stat.st_dev, opened_stat.st_ino) != (file_stat.st_dev, file_stat.st_ino):
                    raise RuntimeError("Plugin data changed during checkpoint.")
                padded = ((opened_stat.st_size + 511) // 512) * 512
                projected += 512 + padded
                if projected > limit:
                    raise RuntimeError("Plugin data archive exceeds the 32 MiB limit.")
                with os.fdopen(os.dup(file_fd), "rb") as content:
                    archive.addfile(tar_info(relative_path, opened_stat, False), content)
            finally:
                os.close(file_fd)
        else:
            raise RuntimeError("Plugin data contains a link or special device.")

root_fd = os.open(data_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    with tarfile.open(output_path, "w", format=tarfile.USTAR_FORMAT) as archive:
        walk(archive, root_fd)
finally:
    os.close(root_fd)

if os.path.getsize(output_path) > limit:
    os.unlink(output_path)
    raise SystemExit("Plugin data archive exceeds the 32 MiB limit.")
`;

export const PLUGIN_DATA_EXTRACT_SCRIPT = String.raw`#!/usr/bin/python3
import os
import shutil
import sys
import tarfile

archive_path, data_root, raw_limit = sys.argv[1:]
limit = int(raw_limit)
if os.path.realpath(data_root) != data_root:
    raise SystemExit("Plugin data directory failed containment verification.")

seen = set()
total = 0
with tarfile.open(archive_path, "r:") as archive:
    for member in archive:
        name = member.name[:-1] if member.name.endswith("/") else member.name
        if not name or name.startswith("/") or "\\" in name:
            raise RuntimeError("Plugin data archive contains an unsafe path.")
        parts = name.split("/")
        if any(part in ("", ".", "..") for part in parts) or name in seen:
            raise RuntimeError("Plugin data archive contains an unsafe or duplicate path.")
        seen.add(name)
        target = os.path.join(data_root, *parts)
        if os.path.commonpath((data_root, os.path.abspath(target))) != data_root:
            raise RuntimeError("Plugin data archive escapes its directory.")
        if member.isdir():
            os.makedirs(target, mode=member.mode & 0o777, exist_ok=False)
            continue
        if not member.isfile() or member.linkname:
            raise RuntimeError("Plugin data archive contains a link or special device.")
        total += member.size
        if total > limit:
            raise RuntimeError("Plugin data archive expands beyond the 32 MiB limit.")
        os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
        source = archive.extractfile(member)
        if source is None:
            raise RuntimeError("Plugin data archive file is unreadable.")
        with source, open(target, "xb") as output:
            shutil.copyfileobj(source, output, length=1024 * 1024)
        os.chmod(target, member.mode & 0o777)
`;
