export function hasGhApiRequestBody(argv: string[]) {
  return argv.some((arg) => {
    return (
      // gh is a pflag CLI, so shorthand flags accept attached values: `-ftitle=x` and
      // `-f=title=x` are valid body fields, not just the bare `-f value` form. Match
      // by prefix so the attached forms can't classify as a body-less read.
      arg.startsWith("-f") ||
      arg.startsWith("-F") ||
      arg === "--field" ||
      arg === "--raw-field" ||
      arg === "--input" ||
      arg.startsWith("--field=") ||
      arg.startsWith("--raw-field=") ||
      arg.startsWith("--input=")
    );
  });
}

export function readGhApiMethod(argv: string[], startIndex = 0): string | undefined {
  for (let index = startIndex; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--method" || arg === "--request" || arg === "-X") {
      const value = argv[index + 1];
      return value ? value.toUpperCase() : "DELETE";
    }
    if (arg.startsWith("--method=")) {
      return arg.slice("--method=".length).toUpperCase();
    }
    if (arg.startsWith("--request=")) {
      return arg.slice("--request=".length).toUpperCase();
    }
    // pflag shorthand with an attached value: `-XDELETE` / `-X=DELETE`. Without this,
    // the attached forms fall through to "no method" and a destructive call can be
    // classified as read. An empty attached value (`-X=`) is unparseable -> "DELETE"
    // so it lands in the stricter write/admin buckets at call sites.
    if (arg.startsWith("-X")) {
      const attached = arg.slice(2);
      const value = attached.startsWith("=") ? attached.slice(1) : attached;
      return value ? value.toUpperCase() : "DELETE";
    }
  }
  return undefined;
}

// Splits a `gh <args>`-style string into argv tokens with POSIX-ish quoting rules
// (single/double quotes, backslash escapes). Returns null for a non-string or a
// string with an unterminated quote/escape. Also reused by the runner's memory
// tool, which accepts the same quoted-argv wire format.
export function parseGitHubCliArgs(args: unknown): string[] | null {
  if (typeof args !== "string") return null;

  const argv: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of args) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        argv.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping || quote) return null;
  if (current) argv.push(current);
  return argv;
}
