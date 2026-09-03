import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { normalizePostgresText, stringifyPostgresJson } from "./postgres-json";

describe("stringifyPostgresJson", () => {
  const database = new PGlite();

  afterAll(async () => {
    await database.close();
  });

  it("produces jsonb-safe nested values and keys", async () => {
    const serialized = stringifyPostgresJson({
      "bad\ud800key": ["high\ud800", "low\udfff", "nul\0byte"],
    });

    await expect(database.query("SELECT $1::jsonb AS value", [serialized])).resolves.toMatchObject({
      rows: [{ value: { "bad�key": ["high�", "low�", "nul�byte"] } }],
    });
  });

  it("preserves valid Unicode and literal escape text", () => {
    const value = {
      emoji: "Company brain 🧠",
      literalNulEscape: "\\u0000",
      literalSurrogateEscape: "\\ud800",
    };

    expect(JSON.parse(stringifyPostgresJson(value))).toEqual(value);
  });

  it("normalizes strings written to PostgreSQL text columns", () => {
    expect(normalizePostgresText("high\ud800 low\udfff nul\0 valid 🧠")).toBe(
      "high� low� nul� valid 🧠",
    );
  });

  it("preserves JSON.stringify semantics before normalization", () => {
    const value = {
      date: new Date("2026-09-03T12:00:00.000Z"),
      omitted: undefined,
      nonFinite: Number.NaN,
      custom: { toJSON: () => "custom\ud800" },
    };

    expect(JSON.parse(stringifyPostgresJson(value))).toEqual({
      date: "2026-09-03T12:00:00.000Z",
      nonFinite: null,
      custom: "custom�",
    });
  });

  it("rejects top-level values that JSON.stringify cannot serialize", () => {
    expect(() => stringifyPostgresJson(undefined)).toThrow(
      "PostgreSQL JSON values must be JSON-serializable.",
    );
  });
});
