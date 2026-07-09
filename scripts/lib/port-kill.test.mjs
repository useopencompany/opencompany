import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { findPortListeners, killPortListeners, normalizePort } from "./port-kill.mjs";

test("normalizePort rejects invalid ports", () => {
  assert.throws(() => normalizePort("abc"), /Invalid port/);
  assert.throws(() => normalizePort("0"), /Invalid port/);
  assert.throws(() => normalizePort("65536"), /Invalid port/);
  assert.equal(normalizePort("3002"), "3002");
});

test("killPortListeners stops a process listening on a port", async (t) => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
const { createServer } = require("node:http");
const server = createServer((_request, response) => response.end("ok"));
server.listen(0, "127.0.0.1", () => {
  console.log(server.address().port);
});
setInterval(() => {}, 1000);
`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  t.after(() => {
    if (!child.killed) child.kill("SIGKILL");
  });

  const port = await readFirstLine(child.stdout);
  assert.equal(findPortListeners(port).includes(String(child.pid)), true);

  const result = await killPortListeners(port);
  assert.equal(result.port, port);
  assert.deepEqual(result.pids, [String(child.pid)]);

  const [code, signal] = await once(child, "exit");
  assert.equal(code, null);
  assert.equal(signal, "SIGTERM");
  assert.deepEqual(findPortListeners(port), []);
});

async function readFirstLine(stream) {
  let buffered = "";
  for await (const chunk of stream) {
    buffered += String(chunk);
    const newline = buffered.indexOf("\n");
    if (newline !== -1) {
      return buffered.slice(0, newline).trim();
    }
  }
  throw new Error("Child process exited before printing a port.");
}
