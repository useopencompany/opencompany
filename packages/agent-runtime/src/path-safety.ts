// Bounded path- and mode-safety helpers shared by the skill resolver and plugin parser.
//
// Every file we retain from a remote Git tree passes through here before its bytes are trusted.
// The rules are deliberately strict and total: a relative path must stay inside the selected root
// with no traversal, no `.git`, and no absolute/Windows form, and a Git blob mode must be a plain
// regular file (never a symlink or submodule). Anything else is rejected rather than sanitized.

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSafetyError";
  }
}

// Upper bound on a single retained relative path. Real skill/plugin files are far shorter; this is
// a hostile-input guard, not a format rule.
export const MAX_RELATIVE_PATH_LENGTH = 1024;

// Git object modes we care about. Git only ever stores these for tree entries.
const MODE_REGULAR_FILE = "100644";
const MODE_EXECUTABLE_FILE = "100755";
const MODE_SYMLINK = "120000";
const MODE_SUBMODULE = "160000"; // a.k.a. gitlink; appears with tree entry type "commit"

export function isSymlinkMode(mode: string): boolean {
  return mode === MODE_SYMLINK;
}

// A submodule shows up in the GitHub tree API as either mode 160000 or entry type "commit".
export function isSubmodule(mode: string, type: string): boolean {
  return mode === MODE_SUBMODULE || type === "commit";
}

// Classify a Git blob mode into its executable bit, rejecting anything that is not a plain file.
// Symlinks (120000) and submodules (160000) are rejected; unknown modes are rejected so a new
// object type can never be silently misclassified as a regular file.
export function executableBitForBlobMode(mode: string): boolean {
  if (mode === MODE_REGULAR_FILE) return false;
  if (mode === MODE_EXECUTABLE_FILE) return true;
  if (isSymlinkMode(mode)) {
    throw new PathSafetyError("Symlinks are not allowed.");
  }
  if (mode === MODE_SUBMODULE) {
    throw new PathSafetyError("Submodules are not allowed.");
  }
  throw new PathSafetyError(`Unsupported file mode ${mode}.`);
}

// Reject a relative path that could escape the selected root or reference dangerous locations.
// Throws PathSafetyError on: empty, over-length, control characters (incl. NUL), absolute (POSIX or
// Windows drive), backslashes, empty segments (leading/trailing/double slash), `.`/`..` traversal,
// and any `.git` segment. Because every `..` segment is rejected, no path can escape its root.
export function assertSafeRelativePath(path: string): void {
  if (path.length === 0) {
    throw new PathSafetyError("Empty path is not allowed.");
  }
  if (path.length > MAX_RELATIVE_PATH_LENGTH) {
    throw new PathSafetyError("Path is too long.");
  }
  for (let i = 0; i < path.length; i++) {
    if (path.charCodeAt(i) < 0x20) {
      throw new PathSafetyError("Path contains a control character.");
    }
  }
  if (path.startsWith("/")) {
    throw new PathSafetyError("Absolute paths are not allowed.");
  }
  if (path.includes("\\")) {
    throw new PathSafetyError("Backslashes are not allowed in paths.");
  }
  if (/^[A-Za-z]:/.test(path)) {
    throw new PathSafetyError("Windows drive paths are not allowed.");
  }
  for (const segment of path.split("/")) {
    if (segment === "") {
      throw new PathSafetyError("Path contains an empty segment.");
    }
    if (segment === "." || segment === "..") {
      throw new PathSafetyError("Path traversal is not allowed.");
    }
    if (segment === ".git") {
      throw new PathSafetyError("`.git` paths are not allowed.");
    }
  }
}

// Convenience predicate for callers that only want a boolean.
export function isSafeRelativePath(path: string): boolean {
  try {
    assertSafeRelativePath(path);
    return true;
  } catch {
    return false;
  }
}
