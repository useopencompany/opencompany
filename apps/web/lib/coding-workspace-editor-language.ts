import type { Extension } from "@codemirror/state";

/**
 * Grammars are loaded on demand: a workspace file is usually one language, and loading
 * every grammar up front would dwarf the editor itself.
 */
type LanguageLoader = () => Promise<Extension>;

async function legacyMode<Name extends string>(
  load: () => Promise<Record<Name, unknown>>,
  name: Name,
): Promise<Extension> {
  const [{ StreamLanguage }, module] = await Promise.all([import("@codemirror/language"), load()]);
  // Legacy modes are CodeMirror 5 stream parsers; StreamLanguage adapts them to CM6.
  return StreamLanguage.define(module[name] as Parameters<typeof StreamLanguage.define>[0]);
}

const javascript =
  (options: { typescript?: boolean; jsx?: boolean } = {}): LanguageLoader =>
  async () =>
    (await import("@codemirror/lang-javascript")).javascript(options);

const LANGUAGE_BY_EXTENSION: Record<string, LanguageLoader | undefined> = {
  c: () => legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "c"),
  cc: () => legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "cpp"),
  cjs: javascript(),
  conf: () => legacyMode(() => import("@codemirror/legacy-modes/mode/properties"), "properties"),
  cpp: () => legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "cpp"),
  cs: () => legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "csharp"),
  css: async () => (await import("@codemirror/lang-css")).css(),
  diff: () => legacyMode(() => import("@codemirror/legacy-modes/mode/diff"), "diff"),
  dockerfile: () =>
    legacyMode(() => import("@codemirror/legacy-modes/mode/dockerfile"), "dockerFile"),
  go: () => legacyMode(() => import("@codemirror/legacy-modes/mode/go"), "go"),
  h: () => legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "c"),
  hpp: () => legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "cpp"),
  htm: async () => (await import("@codemirror/lang-html")).html(),
  html: async () => (await import("@codemirror/lang-html")).html(),
  ini: () => legacyMode(() => import("@codemirror/legacy-modes/mode/properties"), "properties"),
  java: () => legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "java"),
  js: javascript(),
  json: async () => (await import("@codemirror/lang-json")).json(),
  jsonc: async () => (await import("@codemirror/lang-json")).json(),
  jsx: javascript({ jsx: true }),
  kt: () => legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "kotlin"),
  less: async () => (await import("@codemirror/lang-css")).css(),
  lua: () => legacyMode(() => import("@codemirror/legacy-modes/mode/lua"), "lua"),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  md: async () => (await import("@codemirror/lang-markdown")).markdown(),
  mdx: async () => (await import("@codemirror/lang-markdown")).markdown(),
  mjs: javascript(),
  mts: javascript({ typescript: true }),
  patch: () => legacyMode(() => import("@codemirror/legacy-modes/mode/diff"), "diff"),
  properties: () =>
    legacyMode(() => import("@codemirror/legacy-modes/mode/properties"), "properties"),
  proto: () => legacyMode(() => import("@codemirror/legacy-modes/mode/protobuf"), "protobuf"),
  ps1: () => legacyMode(() => import("@codemirror/legacy-modes/mode/powershell"), "powerShell"),
  py: async () => (await import("@codemirror/lang-python")).python(),
  pyi: async () => (await import("@codemirror/lang-python")).python(),
  r: () => legacyMode(() => import("@codemirror/legacy-modes/mode/r"), "r"),
  rb: () => legacyMode(() => import("@codemirror/legacy-modes/mode/ruby"), "ruby"),
  rs: () => legacyMode(() => import("@codemirror/legacy-modes/mode/rust"), "rust"),
  scss: async () => (await import("@codemirror/lang-css")).css(),
  sh: () => legacyMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  sql: () => legacyMode(() => import("@codemirror/legacy-modes/mode/sql"), "standardSQL"),
  svelte: async () => (await import("@codemirror/lang-html")).html(),
  svg: () => legacyMode(() => import("@codemirror/legacy-modes/mode/xml"), "xml"),
  swift: () => legacyMode(() => import("@codemirror/legacy-modes/mode/swift"), "swift"),
  toml: () => legacyMode(() => import("@codemirror/legacy-modes/mode/toml"), "toml"),
  ts: javascript({ typescript: true }),
  tsx: javascript({ typescript: true, jsx: true }),
  vue: async () => (await import("@codemirror/lang-html")).html(),
  xml: () => legacyMode(() => import("@codemirror/legacy-modes/mode/xml"), "xml"),
  yaml: () => legacyMode(() => import("@codemirror/legacy-modes/mode/yaml"), "yaml"),
  yml: () => legacyMode(() => import("@codemirror/legacy-modes/mode/yaml"), "yaml"),
  zsh: () => legacyMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
};

const LANGUAGE_BY_FILENAME: Record<string, LanguageLoader | undefined> = {
  ".bashrc": LANGUAGE_BY_EXTENSION.sh,
  ".zshrc": LANGUAGE_BY_EXTENSION.sh,
  dockerfile: LANGUAGE_BY_EXTENSION.dockerfile,
  gemfile: LANGUAGE_BY_EXTENSION.rb,
  makefile: LANGUAGE_BY_EXTENSION.sh,
};

/** Resolves the grammar for a file, or null when no grammar is a better fit than none. */
export function editorLanguageLoader(fileName: string): LanguageLoader | null {
  const name = fileName.toLowerCase();
  const byName = LANGUAGE_BY_FILENAME[name];
  if (byName) return byName;
  // ".env.local" and "Dockerfile.api" carry their kind in the first segment, not the last.
  if (name.startsWith(".env")) return LANGUAGE_BY_EXTENSION.sh ?? null;
  if (name.startsWith("dockerfile.")) return LANGUAGE_BY_EXTENSION.dockerfile ?? null;
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return LANGUAGE_BY_EXTENSION[extension] ?? null;
}
