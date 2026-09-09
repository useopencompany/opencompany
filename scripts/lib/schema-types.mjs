import ts from "typescript";

// Preserve runtime schema expressions while removing compile-time annotations.
export function eraseSchemaTypes(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText;
}
