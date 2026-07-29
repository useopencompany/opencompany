import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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
  assert.equal((await getJson(proxy.port, "/goat/runtime")).target, "runner");
  assert.equal((await getJson(proxy.port, "/broker/openai/v1/responses")).target, "runner");
  assert.equal(
    (await getJson(proxy.port, "/", { host: "signed.preview.localhost" })).target,
    "runner",
  );
});

test("Goat dev proxy survives an HTTP client disconnect", async (t) => {
  const app = await startStreamingServer();
  const runner = await startJsonServer("runner");
  const proxy = await startGoatDevProxy({ appPort: app.port, runnerPort: runner.port });

  t.after(async () => {
    await proxy.close();
    await app.close();
    await runner.close();
  });

  const response = await requestStream(proxy.port);
  await once(response, "data");
  response.destroy();
  await once(response, "close");
  await delay(25);

  assert.equal((await getJson(proxy.port, "/health")).target, "streaming-app");
});

test("Goat dev proxy survives an upgraded client disconnect", async (t) => {
  const app = await startUpgradeServer();
  const runner = await startJsonServer("runner");
  const proxy = await startGoatDevProxy({ appPort: app.port, runnerPort: runner.port });

  t.after(async () => {
    await proxy.close();
    await app.close();
    await runner.close();
  });

  const client = connect(Number(proxy.port), "127.0.0.1");
  client.on("error", () => {});
  await once(client, "connect");
  client.write(
    "GET /_next/webpack-hmr HTTP/1.1\r\n" +
      "Host: localhost\r\n" +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n\r\n",
  );
  await once(client, "data");
  client.destroy();
  await once(client, "close");
  await delay(25);

  assert.equal((await getJson(proxy.port, "/health")).target, "upgrade-app");
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

async function startStreamingServer() {
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ target: "streaming-app" }));
      return;
    }

    response.writeHead(200, { "content-type": "text/plain" });
    const interval = setInterval(() => response.write("chunk\n"), 5);
    response.once("close", () => clearInterval(interval));
  });
  return listen(server);
}

async function startUpgradeServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ target: "upgrade-app" }));
  });
  server.on("upgrade", (_request, socket) => {
    socket.on("error", () => {});
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n\r\n");
    const interval = setInterval(() => socket.write("tick"), 5);
    socket.once("close", () => clearInterval(interval));
  });
  return listen(server);
}

async function listen(server) {
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

function requestStream(port) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${port}/stream`, resolve);
    request.once("error", reject);
    request.end();
  });
}

async function getJson(port, path, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          assert.equal(response.statusCode, 200);
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("error", reject);
    request.end();
  });
}
