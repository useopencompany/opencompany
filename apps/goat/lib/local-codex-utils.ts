import { createHash } from "node:crypto";

export function extractLocalRepositoryPath(prompt: string) {
  const normalizedPrompt = prompt.replaceAll("\u00a0", " ");
  for (const quoted of quotedSegments(normalizedPrompt)) {
    const candidate = normalizeRepositoryPathCandidate(quoted) ?? firstAbsolutePathIn(quoted);
    if (candidate) return candidate;
  }
  return firstAbsolutePathIn(normalizedPrompt);
}

export function hashLocalBridgeToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function firstAbsolutePathIn(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    if (value.startsWith("file:///", index) && isPathBoundary(value[index - 1])) {
      const candidate = readUnquotedPath(value, index);
      const normalized = normalizeRepositoryPathCandidate(candidate);
      if (normalized) return normalized;
      continue;
    }
    if (value[index] !== "/" || !isPathBoundary(value[index - 1])) continue;
    const candidate = readUnquotedPath(value, index);
    const normalized = normalizeRepositoryPathCandidate(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function quotedSegments(value: string) {
  const segments: string[] = [];
  const pairs: Array<[string, string]> = [
    ["`", "`"],
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
  ];
  for (const [open, close] of pairs) {
    let start = value.indexOf(open);
    while (start !== -1) {
      const end = value.indexOf(close, start + open.length);
      if (end === -1) break;
      segments.push(value.slice(start + open.length, end));
      start = value.indexOf(open, end + close.length);
    }
  }
  return segments;
}

function readUnquotedPath(value: string, start: number) {
  let end = start;
  while (end < value.length) {
    const char = value[end];
    if (!char) break;
    if (char === "\\" && end + 1 < value.length) {
      end += 2;
      continue;
    }
    if (/\s/.test(char) || /[`"'“”‘’,;)\]}>]/.test(char)) break;
    end += 1;
  }
  return value.slice(start, end);
}

function normalizeRepositoryPathCandidate(value: string) {
  const trimmed = value.trim().replace(/[.,;:!?)\]}>]+$/g, "");
  if (!trimmed) return null;

  const path = trimmed.startsWith("file:///") ? fileUrlPath(trimmed) : trimmed;
  if (!path) return null;

  const unescaped = path.replace(/\\([ \t()[\]{}'"`,;:!?])/g, "$1").trim();
  return unescaped.startsWith("/") ? unescaped : null;
}

function fileUrlPath(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "file:" ? decodeURIComponent(url.pathname) : null;
  } catch {
    return null;
  }
}

function isPathBoundary(value: string | undefined) {
  return value === undefined || /\s|[([{:="'`“‘]/.test(value);
}
