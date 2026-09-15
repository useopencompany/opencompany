import assert from "node:assert/strict";
import test from "node:test";
import { isValidDesktopAuthSecret, resolveLocalDesktopAuthSecret } from "./desktop-auth-env.mjs";

const validKey = Buffer.alloc(32, 1).toString("base64");

test("generates a valid local key for missing, placeholder, and malformed values", () => {
  for (const value of [
    undefined,
    "",
    "replace-with-base64-encoded-32-byte-key",
    "invalid",
    Buffer.alloc(16).toString("base64"),
  ]) {
    assert.equal(isValidDesktopAuthSecret(value), false);
    assert.equal(isValidDesktopAuthSecret(resolveLocalDesktopAuthSecret(value)), true);
  }
});

test("preserves valid keys across setup reruns", () => {
  assert.equal(resolveLocalDesktopAuthSecret(validKey), validKey);
  const generated = resolveLocalDesktopAuthSecret();
  assert.equal(resolveLocalDesktopAuthSecret(generated), generated);
});

test("respects a valid personal override and rejects an invalid override without exposing it", () => {
  assert.equal(resolveLocalDesktopAuthSecret(undefined, validKey), validKey);
  assert.throws(
    () => resolveLocalDesktopAuthSecret(validKey, "invalid-personal-secret"),
    (error) =>
      error.message.includes(".env.override.local") &&
      !error.message.includes("invalid-personal-secret"),
  );
});

test("matches runtime validation for invalid characters, padding, and surrounding whitespace", () => {
  assert.equal(isValidDesktopAuthSecret(`${validKey}!`), false);
  assert.equal(
    resolveLocalDesktopAuthSecret(validKey.replace(/=$/, "")),
    validKey.replace(/=$/, ""),
  );
  assert.equal(isValidDesktopAuthSecret(` ${validKey}\n`), true);
});
