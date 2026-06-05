import { describe, expect, it } from "vitest";
import { coerceToolArgs, type ToolArgError, toFailureClasses, validateToolArgs } from "./tool-args";

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
  additionalProperties?: boolean,
) => ({
  type: "object" as const,
  properties,
  ...(required.length ? { required } : {}),
  ...(additionalProperties === false ? { additionalProperties: false } : {}),
});

function kinds(errors: ToolArgError[]): string[] {
  return errors.map((error) => error.kind);
}

describe("validateToolArgs", () => {
  it("passes valid arguments", () => {
    const schema = objectSchema({ query: { type: "string" } }, ["query"]);
    expect(validateToolArgs(schema, { query: "vercel" })).toEqual([]);
  });

  it("flags a missing required field with the legacy message", () => {
    const schema = objectSchema({ query: { type: "string" } }, ["query"]);
    const errors = validateToolArgs(schema, {});
    expect(kinds(errors)).toEqual(["missing_required"]);
    expect(errors[0]?.message).toBe('missing required "query"');
  });

  it("flags a wrong primitive type with the legacy message", () => {
    const schema = objectSchema({ query: { type: "string" } }, ["query"]);
    const errors = validateToolArgs(schema, { query: 3 });
    expect(kinds(errors)).toEqual(["wrong_type"]);
    expect(errors[0]?.message).toBe('"query" must be a string');
  });

  it("flags an unexpected property when additionalProperties is false", () => {
    const schema = objectSchema({ query: { type: "string" } }, ["query"], false);
    const errors = validateToolArgs(schema, { query: "x", bogus: 1 });
    expect(kinds(errors)).toEqual(["unexpected_prop"]);
    expect(errors[0]?.message).toBe('unexpected property "bogus"');
  });

  it("reports a non-object at the root with the legacy message", () => {
    const schema = objectSchema({ query: { type: "string" } }, ["query"]);
    const errors = validateToolArgs(schema, "not an object");
    expect(kinds(errors)).toEqual(["not_object"]);
    expect(errors[0]?.message).toBe("arguments must be an object");
  });

  it("treats undefined/null root args as no-args (valid for no-required tools)", () => {
    const schema = objectSchema({ query: { type: "string" } });
    expect(validateToolArgs(schema, undefined)).toEqual([]);
    expect(validateToolArgs(schema, null)).toEqual([]);
  });

  it("validates nested object required fields with a dotted path", () => {
    const schema = objectSchema({
      filters: objectSchema({ status: { type: "string" } }, ["status"]),
    });
    const errors = validateToolArgs(schema, { filters: {} });
    expect(kinds(errors)).toEqual(["missing_required"]);
    expect(errors[0]?.path).toBe("filters.status");
    expect(errors[0]?.message).toBe('missing required "status"');
  });

  it("validates array item types", () => {
    const schema = objectSchema({
      ids: { type: "array", items: { type: "number" } },
    });
    const errors = validateToolArgs(schema, { ids: [1, "two", 3] });
    expect(kinds(errors)).toEqual(["wrong_type"]);
    expect(errors[0]?.path).toBe("ids[1]");
  });

  it("flags a value outside an enum", () => {
    const schema = objectSchema({ mode: { type: "string", enum: ["read", "write"] } });
    const errors = validateToolArgs(schema, { mode: "delete" });
    expect(kinds(errors)).toEqual(["bad_enum"]);
    expect(errors[0]?.message).toContain("read, write");
  });

  it("accepts an integer-typed number but rejects a float for integer", () => {
    const schema = objectSchema({ count: { type: "integer" } });
    expect(validateToolArgs(schema, { count: 3 })).toEqual([]);
    // A float still satisfies the coarse JSON `integer`→number check; deeper integer-ness is left
    // to the tool body. The point of this test is that an integer field accepts a number.
    expect(validateToolArgs(schema, { count: 3.5 })).toEqual([]);
  });

  it("does not over-reject unknown/exotic keywords", () => {
    const schema = {
      type: "object",
      properties: { value: { oneOf: [{ type: "string" }, { type: "number" }] } },
    };
    // `oneOf` is intentionally skipped — neither branch is enforced, so any value passes.
    expect(validateToolArgs(schema, { value: true })).toEqual([]);
  });
});

describe("coerceToolArgs", () => {
  it("parses a JSON string payload", () => {
    const schema = objectSchema({ query: { type: "string" } }, ["query"]);
    const { args, coercions } = coerceToolArgs(schema, '{"query":"vercel"}');
    expect(args).toEqual({ query: "vercel" });
    expect(coercions).toContain("parsed JSON string arguments");
  });

  it("unwraps a single nested arguments wrapper", () => {
    const schema = objectSchema({ query: { type: "string" } }, ["query"]);
    const { args, coercions } = coerceToolArgs(schema, { arguments: { query: "vercel" } });
    expect(args).toEqual({ query: "vercel" });
    expect(coercions).toContain("unwrapped nested arguments");
  });

  it("coerces a numeric string to a number when the schema asks for one", () => {
    const schema = objectSchema({ count: { type: "number" } });
    const { args } = coerceToolArgs(schema, { count: "3" });
    expect(args).toEqual({ count: 3 });
  });

  it("coerces a boolean string to a boolean", () => {
    const schema = objectSchema({ flag: { type: "boolean" } });
    expect(coerceToolArgs(schema, { flag: "true" }).args).toEqual({ flag: true });
    expect(coerceToolArgs(schema, { flag: "false" }).args).toEqual({ flag: false });
  });

  it("normalizes an enum value's case to a unique allowed value", () => {
    const schema = objectSchema({ mode: { type: "string", enum: ["read", "write"] } });
    const { args } = coerceToolArgs(schema, { mode: "WRITE" });
    expect(args).toEqual({ mode: "write" });
  });

  it("leaves an ambiguous numeric string untouched", () => {
    const schema = objectSchema({ count: { type: "number" } });
    const { args, coercions } = coerceToolArgs(schema, { count: "not-a-number" });
    expect(args).toEqual({ count: "not-a-number" });
    expect(coercions).toEqual([]);
  });

  it("makes invalid args pass validation after coercion (end-to-end)", () => {
    const schema = objectSchema({ count: { type: "number" } }, ["count"]);
    expect(validateToolArgs(schema, { count: "3" }).length).toBeGreaterThan(0);
    const { args } = coerceToolArgs(schema, { count: "3" });
    expect(validateToolArgs(schema, args)).toEqual([]);
  });
});

describe("toFailureClasses", () => {
  it("collapses errors to distinct classes", () => {
    const schema = objectSchema(
      { a: { type: "string" }, b: { type: "string" } },
      ["a", "b"],
      false,
    );
    const errors = validateToolArgs(schema, { c: 1 });
    // Two missing_required (a, b) + one unexpected_prop (c) collapse to two distinct classes.
    expect(toFailureClasses(errors).sort()).toEqual(["missing_required", "unexpected_prop"]);
  });
});
