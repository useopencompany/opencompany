// Called by: scripts/dev.mjs in Goat app mode.
// Purpose: expose the Goat app and runner callback routes through one local port.

import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";

const LOCAL_HOST = "127.0.0.1";
const RUNNER_PATH_PREFIXES = ["/broker/", "/goat/tools/"];
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export async function startGoatDevProxy({ appPort, runnerPort }) {
  const appTarget = { label: "Goat app", port: String(appPort) };
  const runnerTarget = { label: "runner", port: String(runnerPort) };

  const server = createServer((request, response) => {
    const target = targetForPath(request.url, { appTarget, runnerTarget });
    proxyHttpRequest({ request, response, target });
  });

  server.on("upgrade", (request, socket, head) => {
    const target = targetForPath(request.url, { appTarget, runnerTarget });
    proxyUpgradeRequest({ request, socket, head, target });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOCAL_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Goat dev proxy did not bind to a local port.");
  }

  return {
    port: String(address.port),
    routes: {
      app: `http://${LOCAL_HOST}:${appTarget.port}`,
      runner: `http://${LOCAL_HOST}:${runnerTarget.port}`,
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function targetForPath(rawUrl, { appTarget, runnerTarget }) {
  const pathname = safePathname(rawUrl);
  return RUNNER_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    ? runnerTarget
    : appTarget;
}

function proxyHttpRequest({ request, response, target }) {
  const proxyRequest = httpRequest(
    {
      hostname: LOCAL_HOST,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request),
    },
    (proxyResponse) => {
      response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.statusMessage, {
        ...proxyResponse.headers,
      });
      proxyResponse.pipe(response);
    },
  );

  proxyRequest.on("error", (error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end(`${target.label} dev server is not reachable on port ${target.port}.\n`);
  });

  request.pipe(proxyRequest);
}

function proxyUpgradeRequest({ request, socket, head, target }) {
  const upstream = connect(Number(target.port), LOCAL_HOST);

  upstream.on("connect", () => {
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      upstream.write(`${name}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`);
    }
    upstream.write("\r\n");
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on("error", () => {
    socket.destroy();
  });
}

function forwardedHeaders(request) {
  const headers = { ...request.headers };
  for (const header of HOP_BY_HOP_HEADERS) {
    delete headers[header];
  }

  const host = request.headers.host;
  if (host) {
    headers["x-forwarded-host"] = appendForwardedValue(headers["x-forwarded-host"], host);
  }
  headers["x-forwarded-proto"] = appendForwardedValue(
    headers["x-forwarded-proto"],
    request.headers["x-forwarded-proto"] ?? "https",
  );
  if (request.socket.remoteAddress) {
    headers["x-forwarded-for"] = appendForwardedValue(
      headers["x-forwarded-for"],
      request.socket.remoteAddress,
    );
  }

  return headers;
}

function appendForwardedValue(existing, value) {
  const next = Array.isArray(value) ? value.join(", ") : String(value);
  if (!existing) return next;
  return `${Array.isArray(existing) ? existing.join(", ") : existing}, ${next}`;
}

function safePathname(rawUrl) {
  try {
    return new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}
