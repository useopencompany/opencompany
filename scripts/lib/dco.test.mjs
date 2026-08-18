import assert from "node:assert/strict";
import test from "node:test";

import { hasValidDcoSignoff, unsignedCommits } from "./dco.mjs";

test("accepts a syntactically valid DCO trailer", () => {
  assert.equal(
    hasValidDcoSignoff("fix: preserve state\n\nSigned-off-by: Alex Example <alex@example.com>"),
    true,
  );
  assert.equal(
    hasValidDcoSignoff(
      "fix: preserve state\n\nsigned-off-by: Bot <123+bot@users.noreply.github.com>",
    ),
    true,
  );
});

test("rejects missing and malformed signoffs", () => {
  assert.equal(hasValidDcoSignoff("fix: preserve state"), false);
  assert.equal(hasValidDcoSignoff("Signed-off-by: Alex Example"), false);
  assert.equal(hasValidDcoSignoff("Signed-off-by: <alex@example.com>"), false);
  assert.equal(
    hasValidDcoSignoff(
      "Signed-off-by: Alex Example <alex@example.com>\n\nThis is body text, not a trailer block.",
    ),
    false,
  );
});

test("returns only unsigned commits", () => {
  assert.deepEqual(
    unsignedCommits([
      { sha: "a", message: "change\n\nSigned-off-by: A Person <a@example.com>" },
      { sha: "b", message: "unsigned change" },
    ]),
    [{ sha: "b", message: "unsigned change" }],
  );
});
