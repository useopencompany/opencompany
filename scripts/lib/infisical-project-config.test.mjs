import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectConfigUrl = new URL("../../.infisical.json", import.meta.url);

test("the repository selects the Infisical project without local initialization", async () => {
  const config = JSON.parse(await readFile(projectConfigUrl, "utf8"));

  assert.match(config.workspaceId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
  assert.equal(config.defaultEnvironment, "");
  assert.equal(config.gitBranchToEnvironmentMapping, null);
});
