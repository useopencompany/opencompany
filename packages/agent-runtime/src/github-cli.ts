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
