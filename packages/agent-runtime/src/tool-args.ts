// Deterministic validation + safe coercion for deferred-tool arguments.
//
// Deferred tools are dispatched through a generic meta-tool (`use_tool` / `{server}__use_tool`)
// whose `arguments` field is an open object, so the provider's structured/grammar-constrained
// decoding never sees the inner schema. That removes the safety net smaller models lean on. These
// two pure helpers restore a deterministic gate at the dispatcher: validate the args against the
// resolved tool's JSON Schema, and try a handful of lossless coercions for the most common model
// mistakes before surfacing an error (or escalating to a model-based repair).
//
// Scope is deliberately limited to the high-frequency failure classes: recursive `required`,
// `type` (incl. nested objects + array item types), `enum`, and `const`. Exotic keywords
// (`oneOf`/`anyOf`, `patternProperties`, `format`, `$ref`) are intentionally skipped — on arbitrary
// remote MCP schemas a strict validator risks *false rejections* (draft mismatch, unknown format)
// that would block an otherwise-valid call. The tool body / MCP server stays the backstop for those.

// Walk no deeper than this. Tool schemas are shallow in practice; the cap only guards against
// pathological or self-referential schemas and never trims a realistic argument object.
const MAX_VALIDATION_DEPTH = 8;

export type ToolArgErrorKind =
  | "not_object"
  | "missing_required"
  | "wrong_type"
  | "bad_enum"
  | "unexpected_prop";

export type ToolArgError = {
  // JSON-ish path to the offending value: "" at the root, "filters.status", "items[2]".
  path: string;
  kind: ToolArgErrorKind;
  // Human-readable, model-facing message. Root-level messages match the historical phrasing
  // (e.g. `missing required "query"`) so existing recoverable-error copy stays stable.
  message: string;
  expected?: string;
};

// One stable label per failure class for telemetry aggregation (distinct from the per-error path).
export type ToolArgFailureClass =
  | "not_object"
  | "missing_required"
  | "wrong_type"
  | "bad_enum"
  | "unexpected_prop";

// How a deferred-tool call's arguments were resolved before dispatch. Attached to the
// tool.completed / tool.failed runtime event so we can measure, per surface, how often coercion
// covers the problem and whether the model-based repair earns its place. This is the dial for
// tuning the pipeline later — without it we can't tell if repair fires on nothing.
export type ToolArgResolution = {
  surface: "builtin" | "mcp";
  outcome: "valid" | "coerced" | "repaired" | "repair_failed" | "errored";
  // Distinct failure classes seen in the *initial* validation (empty when args were already valid).
  failureClasses?: ToolArgFailureClass[];
  // Notes for any coercions applied by coerceToolArgs (e.g. "coerced \"count\" to number").
  coercions?: string[];
  // The repair model id, present only when the repair layer ran.
  repairModel?: string;
};

// Collapse a validation error list to its distinct, stable failure classes for telemetry.
export function toFailureClasses(errors: ToolArgError[]): ToolArgFailureClass[] {
  const seen = new Set<ToolArgFailureClass>();
  for (const error of errors) seen.add(error.kind);
  return [...seen];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type SchemaRecord = Record<string, unknown>;

function asSchema(schema: unknown): SchemaRecord | undefined {
  return isRecord(schema) ? schema : undefined;
}

function schemaType(schema: SchemaRecord): string | undefined {
  // Only a single string `type` is honored; array/union types are treated as unconstrained to
  // avoid over-rejecting (same conservative stance as the skipped composition keywords).
  return typeof schema.type === "string" ? schema.type : undefined;
}

function quotePath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function matchesJsonType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
    case "integer":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      // Arrays are their own JSON type; an "object"-typed field must not accept one.
      return isRecord(value);
    default:
      // Unknown/unsupported type keyword — don't second-guess it.
      return true;
  }
}

// Phrase the wrong-type message. At the root we keep the legacy `"<key>" must be a <type>` form;
// nested errors carry the dotted path so the model can locate the field.
function typeLabel(expected: string): string {
  return expected === "integer" ? "integer" : expected;
}

export function validateToolArgs(schema: unknown, args: unknown): ToolArgError[] {
  const errors: ToolArgError[] = [];
  validateNode(asSchema(schema), args, "", errors, 0);
  return errors;
}

function validateNode(
  schema: SchemaRecord | undefined,
  value: unknown,
  path: string,
  errors: ToolArgError[],
  depth: number,
): void {
  if (!schema || depth > MAX_VALIDATION_DEPTH) return;

  // `const` and `enum` are checked first: they fully pin the value, so a type check would be
  // redundant (and `const`/`enum` may legitimately allow several JSON types).
  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    if (!deepEqual(value, schema.const)) {
      errors.push({
        path,
        kind: "bad_enum",
        message: `${fieldLabel(path)} must equal ${JSON.stringify(schema.const)}`,
        expected: JSON.stringify(schema.const),
      });
    }
    return;
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((allowed) => deepEqual(value, allowed))) {
      errors.push({
        path,
        kind: "bad_enum",
        message: `${fieldLabel(path)} must be one of: ${schema.enum
          .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
          .join(", ")}`,
        expected: schema.enum.map((entry) => String(entry)).join(", "),
      });
    }
    return;
  }

  const type = schemaType(schema);

  if (type === "object" || (!type && isRecord(schema.properties))) {
    validateObject(schema, value, path, errors, depth);
    return;
  }

  if (type === "array") {
    if (!Array.isArray(value)) {
      pushTypeError(errors, path, "array");
      return;
    }
    const itemSchema = asSchema(schema.items);
    if (itemSchema) {
      value.forEach((item, index) => {
        validateNode(itemSchema, item, `${path}[${index}]`, errors, depth + 1);
      });
    }
    return;
  }

  if (type && !matchesJsonType(value, type)) {
    pushTypeError(errors, path, type);
  }
}

function validateObject(
  schema: SchemaRecord,
  value: unknown,
  path: string,
  errors: ToolArgError[],
  depth: number,
): void {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter(isString) : [];

  if (!isRecord(value)) {
    // A non-object only matters when the tool expects fields. `undefined`/`null` at the root is
    // treated as "no arguments" so a no-arg tool still validates cleanly.
    if (
      (required.length > 0 || Object.keys(properties).length > 0) &&
      value !== undefined &&
      value !== null
    ) {
      errors.push({
        path,
        kind: "not_object",
        message: path ? `${fieldLabel(path)} must be an object` : "arguments must be an object",
        expected: "object",
      });
    }
    return;
  }

  for (const name of required) {
    if (value[name] === undefined) {
      errors.push({
        path: quotePath(path, name),
        kind: "missing_required",
        message: `missing required "${name}"`,
        expected: "required",
      });
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push({
          path: quotePath(path, key),
          kind: "unexpected_prop",
          message: `unexpected property "${key}"`,
        });
      }
    }
  }

  for (const [key, propValue] of Object.entries(value)) {
    if (propValue === undefined) continue;
    const propSchema = asSchema(properties[key]);
    if (!propSchema) continue;
    validateNode(propSchema, propValue, quotePath(path, key), errors, depth + 1);
  }
}

function pushTypeError(errors: ToolArgError[], path: string, expected: string): void {
  errors.push({
    path,
    kind: "wrong_type",
    message: `${fieldLabel(path)} must be a ${typeLabel(expected)}`,
    expected,
  });
}

// Root values have no key, so messages fall back to the generic "value". Named fields keep the
// historical quoted form (`"query"`), preserving existing model-facing copy and tests.
function fieldLabel(path: string): string {
  if (!path) return "value";
  const leaf = path.split(".").pop() ?? path;
  return `"${leaf}"`;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

export type CoerceToolArgsResult = {
  args: unknown;
  // One short note per applied coercion, surfaced in telemetry. Empty when nothing was changed.
  coercions: string[];
};

// Attempt lossless, intent-preserving fixes for the mistakes smaller models make most often, then
// let the caller re-validate. Nothing here invents data: every transform is reversible in meaning
// (parse a stringified payload, unwrap an extra nesting level, narrow a numeric/boolean string,
// normalize an enum's case). Anything requiring intent (a missing required value, a renamed field)
// is deliberately left to the model-based repair layer.
export function coerceToolArgs(schema: unknown, args: unknown): CoerceToolArgsResult {
  const coercions: string[] = [];
  let current = args;

  // 1. `arguments` arrived as a JSON string (the model double-encoded the payload).
  if (typeof current === "string") {
    const trimmed = current.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        current = JSON.parse(trimmed);
        coercions.push("parsed JSON string arguments");
      } catch {
        // Leave it as a string; validation will report the real mismatch.
      }
    }
  }

  const objectSchema = asSchema(schema);

  // 2. Double-nesting: `{ arguments: {...} }` wrapping the real payload. Only unwrap when the
  //    outer object is *just* that wrapper and the inner value looks like the intended args.
  if (
    isRecord(current) &&
    isRecord(current.arguments) &&
    Object.keys(current).length === 1 &&
    objectSchema
  ) {
    current = current.arguments;
    coercions.push("unwrapped nested arguments");
  }

  // 3. Per-property scalar coercions, driven by the schema's declared types. Only unambiguous
  //    string→number / string→boolean conversions are applied.
  if (isRecord(current) && objectSchema && isRecord(objectSchema.properties)) {
    const properties = objectSchema.properties;
    const next: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(current)) {
      const propSchema = asSchema(properties[key]);
      if (!propSchema) continue;
      const coerced = coerceScalar(value, propSchema);
      if (coerced.changed) {
        next[key] = coerced.value;
        coercions.push(coerced.note.replace("{key}", key));
      }
    }
    current = next;
  }

  return { args: current, coercions };
}

type ScalarCoercion = { changed: boolean; value: unknown; note: string };

const NO_COERCION: ScalarCoercion = { changed: false, value: undefined, note: "" };

function coerceScalar(value: unknown, propSchema: SchemaRecord): ScalarCoercion {
  // Enum near-miss: a single case-insensitive / whitespace match to an allowed value.
  if (Array.isArray(propSchema.enum) && typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    const matches = propSchema.enum.filter(
      (allowed) => typeof allowed === "string" && allowed.toLowerCase() === normalized,
    );
    if (matches.length === 1 && matches[0] !== value) {
      return { changed: true, value: matches[0], note: `normalized enum "{key}"` };
    }
    return NO_COERCION;
  }

  const type = schemaType(propSchema);
  if (typeof value !== "string") return NO_COERCION;
  const trimmed = value.trim();

  if ((type === "number" || type === "integer") && trimmed !== "") {
    const num = Number(trimmed);
    if (Number.isFinite(num) && (type === "number" || Number.isInteger(num))) {
      return { changed: true, value: num, note: `coerced "{key}" to ${type}` };
    }
  }

  if (type === "boolean") {
    if (trimmed === "true")
      return { changed: true, value: true, note: `coerced "{key}" to boolean` };
    if (trimmed === "false")
      return { changed: true, value: false, note: `coerced "{key}" to boolean` };
  }

  return NO_COERCION;
}
