import assert from "node:assert/strict";
import test from "node:test";
import { eraseSchemaTypes } from "./schema-types.mjs";

const schema = `
export type ToolName = "list_actions" | "use_action";
export const tools = pgTable("tools", {
  name: text("name").$type<ToolName>().notNull(),
});
export const status = pgEnum("status", ["pending", "done"]);
export const constraint = sql\`CHECK (name <> 'blocked')\`;
`;

test("type-only strings and inline column annotations do not change runtime DDL", () => {
  const changed = schema
    .replace('"list_actions" | "use_action"', '"list_actions" | "describe_actions" | "use_action"')
    .replace("$type<ToolName>()", '$type<ToolName | "another_tool">()');
  assert.equal(eraseSchemaTypes(changed), eraseSchemaTypes(schema));
});

test("type-only imports and declarations are erased", () => {
  assert.equal(
    eraseSchemaTypes(`import type { Extra } from "types";\n${schema}`),
    eraseSchemaTypes(schema),
  );
});

for (const [name, before, after] of [
  ["table", 'pgTable("tools"', 'pgTable("renamed_tools"'],
  ["column", 'text("name")', 'text("renamed_name")'],
  ["column type", 'text("name")', 'varchar("name")'],
  ["nullability", ".notNull()", '.default("unknown")'],
  ["enum values", '["pending", "done"]', '["pending", "done", "failed"]'],
  ["SQL constraint", "'blocked'", "'restricted'"],
]) {
  test(`${name} changes remain visible to the DDL guard`, () => {
    const changed = eraseSchemaTypes(schema.replace(before, after));
    assert.notEqual(changed, eraseSchemaTypes(schema));
    assert.ok(changed.includes(after));
  });
}
