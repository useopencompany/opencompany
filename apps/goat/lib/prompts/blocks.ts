// The main-chat system prompt is composed of named XML-ish blocks so each
// concern (identity, runtime context, behavior, integrations, soul) stays a
// separately-owned, testable unit.
export function promptBlock(name: string, lines: readonly string[]) {
  return [`<${name}>`, ...lines, `</${name}>`].join("\n");
}
