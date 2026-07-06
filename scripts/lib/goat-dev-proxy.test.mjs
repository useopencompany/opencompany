import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { startGoatDevProxy } from "./goat-dev-proxy.mjs";

test("Goat dev proxy routes app traffic and runner callback traffic", async (t) => {
  const app = await startJsonServer("app");
  const runner = await startJsonServer("runner");
  const proxy = await startGoatDevProxy({ appPort: app.port, runnerPort: runner.port });

  t.after(async () => {
    await proxy.close();
    await app.close();
    await runner.close();
  });

  assert.equal((await getJson(proxy.port, "/tasks/TASK-15")).target, "app");
  assert.equal((await getJson(proxy.port, "/api/integrations/gmail/callback")).target, "app");
  assert.equal((await getJson(proxy.port, "/goat/tools/goat_task_123")).target, "runner");
  assert.equal((await getJson(proxy.port, "/broker/openai/v1/responses")).target, "runner");
});

async function startJsonServer(target) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        target,
        url: request.url,
        forwardedProto: request.headers["x-forwarded-proto"],
      }),
    );
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  assert(address && typeof address !== "string");

  return {
    port: String(address.port),
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

async function getJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  assert.equal(response.status, 200);
  return response.json();
}
