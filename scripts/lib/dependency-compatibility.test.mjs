import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";

const rootRequire = createRequire(new URL("../../package.json", import.meta.url));
const desktopRequire = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const vercelRequire = createRequire(rootRequire.resolve("vercel/package.json"));

async function fixtureServer(t, body) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}/`;
}

test("desktop release tooling retains CommonJS package metadata lookup through patched Got", async (t) => {
  const cliRequire = createRequire(desktopRequire.resolve("@todesktop/cli/package.json"));
  const latestVersionRequire = createRequire(cliRequire.resolve("latest-version"));
  const packageJson = latestVersionRequire("package-json");
  const metadata = { name: "dependency-compatibility-fixture", version: "1.2.3" };
  const registryUrl = await fixtureServer(t, {
    "dist-tags": { latest: metadata.version },
    versions: { [metadata.version]: metadata },
  });

  assert.deepEqual(await packageJson(metadata.name, { registryUrl }), metadata);
});

test("Vercel's patched Undici supports the release CLI's CommonJS fetch API", async (t) => {
  const { fetch } = vercelRequire("undici");
  const url = await fixtureServer(t, { ready: true });

  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ready: true });
});

test("Vercel builders keep their distinct route-pattern APIs after security overrides", () => {
  const nodeRequire = createRequire(vercelRequire.resolve("@vercel/node/package.json"));
  const backendRequire = createRequire(vercelRequire.resolve("@vercel/backends/package.json"));
  const legacy = nodeRequire("path-to-regexp");
  const current = backendRequire("path-to-regexp");

  assert.ok(legacy.pathToRegexp("/api/:id") instanceof RegExp);
  assert.ok(current.pathToRegexp("/api/:id").regexp instanceof RegExp);
  assert.equal(legacy.match("/api/:id")("/api/example").params.id, "example");
  assert.equal(current.match("/api/:id")("/api/example").params.id, "example");
});
