import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { CLOUD_CODING_ENGINE_CONFIG, shellQuote } from "@opencompany/agent-runtime";
import { createLogger } from "@opencompany/observability";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import type { RunnerEnv } from "./env";
import {
  discoverGoatCodingWorkspacePreviewPorts,
  type GoatCodingWorkspaceSession,
  isAllowedPreviewPort,
  loadGoatCodingWorkspaceSession,
} from "./goat-coding-workspace-runtime";
import {
  createGoatCodingWorkspacePreviewCapability,
  verifyGoatCodingWorkspacePreviewCapability,
  verifyGoatCodingWorkspaceTicket,
} from "./goat-coding-workspace-runtime-auth";
import {
  createGoatDictationWebSocketServer,
  GOAT_DICTATION_PATH,
} from "./goat-dictation-transport";
import {
  armSandboxIdleTimeout,
  connectSandbox,
  keepSandboxActive,
  type SandboxHandle,
} from "./sandbox";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-coding-workspace",
});
const RUNTIME_PATH = "/goat/runtime";
const RUNTIME_PROTOCOL = "goat-coding-workspace-v1";
const TICKET_PROTOCOL_PREFIX = "goat-ticket.";
const TMUX_SESSION = "goat-coding-workspace";
const HEARTBEAT_INTERVAL_MS = 60_000;
const PREVIEW_UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;
const PREVIEW_SESSION_CACHE_MS = 5_000;
const MAX_PREVIEW_SESSION_CACHE_ENTRIES = 256;
const MAX_PENDING_PREVIEW_WEBSOCKET_BYTES = 256 * 1_024;
const MAX_PENDING_TERMINAL_INPUT_BYTES = 256 * 1_024;
const runtimeToolInstalls = new Map<string, Promise<void>>();

type PreviewTarget = {
  session: GoatCodingWorkspaceSession;
  sandbox: SandboxHandle;
  upstreamHost: string;
  port: number;
};

type RunnerServerFactory = (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  options: Record<string, unknown>,
) => http.Server;

export function createGoatCodingWorkspaceTransport(env: RunnerEnv) {
  const runtimeWebSockets = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1_024,
    handleProtocols(protocols) {
      return protocols.has(RUNTIME_PROTOCOL) ? RUNTIME_PROTOCOL : false;
    },
  });
  const previewWebSockets = new WebSocketServer({ noServer: true });
  const dictationWebSockets = createGoatDictationWebSocketServer(env);
  const previewCache = new Map<string, { expiresAt: number; target: Promise<PreviewTarget> }>();
  let closePromise: Promise<void> | null = null;

  const close = () => {
    closePromise ??= (async () => {
      previewCache.clear();
      for (const webSocket of runtimeWebSockets.clients) webSocket.terminate();
      for (const webSocket of previewWebSockets.clients) webSocket.terminate();
      for (const webSocket of dictationWebSockets.webSocketServer.clients) webSocket.terminate();
      await Promise.all([
        closeWebSocketServer(runtimeWebSockets),
        closeWebSocketServer(previewWebSockets),
        closeWebSocketServer(dictationWebSockets.webSocketServer),
      ]);
    })();
    return closePromise;
  };

  const serverFactory: RunnerServerFactory = (handler) => {
    const server = http.createServer((request, response) => {
      if (isPreviewRequest(request, env.previewBaseDomain)) {
        void proxyPreviewHttp(request, response, env, previewCache);
        return;
      }
      handler(request, response);
    });

    server.on("upgrade", (request, socket, head) => {
      if (isPreviewRequest(request, env.previewBaseDomain)) {
        void proxyPreviewWebSocket(request, socket, head, env, previewWebSockets, previewCache);
        return;
      }

      const path = request.url?.split("?", 1)[0];
      if (path === GOAT_DICTATION_PATH) {
        dictationWebSockets.accept(request, socket, head);
        return;
      }

      if (path !== RUNTIME_PATH) {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }
      void acceptRuntimeWebSocket(request, socket, head, env, runtimeWebSockets);
    });

    server.on("close", () => {
      void close();
    });
    return server;
  };

  return { serverFactory, close };
}

async function acceptRuntimeWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  env: RunnerEnv,
  webSocketServer: WebSocketServer,
) {
  const origin = request.headers.origin;
  if (!isGoatCodingWorkspaceOriginAllowed(origin, env.allowedOrigins)) {
    logRuntimeReject("origin_denied", { origin: origin ?? null });
    rejectUpgrade(socket, 403, "Forbidden");
    return;
  }

  const protocols = readProtocols(request.headers["sec-websocket-protocol"]);
  const encodedTicket = protocols
    .find((protocol) => protocol.startsWith(TICKET_PROTOCOL_PREFIX))
    ?.slice(TICKET_PROTOCOL_PREFIX.length);
  const ticket = encodedTicket
    ? verifyGoatCodingWorkspaceTicket({ ticket: encodedTicket, secret: env.streamTokenSecret })
    : null;
  if (!ticket || !protocols.includes(RUNTIME_PROTOCOL)) {
    logRuntimeReject("ticket_invalid", { has_ticket: Boolean(encodedTicket) });
    rejectUpgrade(socket, 401, "Unauthorized");
    return;
  }

  const session = await loadGoatCodingWorkspaceSession({
    codingSessionId: ticket.codingSessionId,
    userWorkosId: ticket.userWorkosId,
  }).catch((error) => {
    logRuntimeReject("session_load_failed", { coding_session_id: ticket.codingSessionId, error });
    return null;
  });
  if (!session) {
    logRuntimeReject("session_unavailable", { coding_session_id: ticket.codingSessionId });
    closeUpgradeWithError(webSocketServer, request, socket, head, 4404, "Workspace unavailable.");
    return;
  }

  const sandbox = await connectSandbox({ sandboxId: session.sandboxId }).catch((error) => {
    logRuntimeReject("sandbox_connect_failed", { sandbox_id: session.sandboxId, error });
    return null;
  });
  if (!sandbox) {
    logRuntimeReject("sandbox_unavailable", { sandbox_id: session.sandboxId });
    closeUpgradeWithError(webSocketServer, request, socket, head, 4410, "Workspace was deleted.");
    return;
  }
  try {
    await ensureRuntimeTools(sandbox);
  } catch (error) {
    logRuntimeReject("runtime_tools_unavailable", { sandbox_id: session.sandboxId, error });
    closeUpgradeWithError(
      webSocketServer,
      request,
      socket,
      head,
      4503,
      "Workspace tools are unavailable.",
    );
    return;
  }

  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit("connection", webSocket, request);
    attachRuntimeConnection(webSocket, sandbox, session, env);
  });
}

function logRuntimeReject(reason: string, context: Record<string, unknown>) {
  logger.warn("Rejected coding workspace runtime connection", {
    event: "opencompany.goat_coding_workspace_runtime_rejected",
    reject_reason: reason,
    ...context,
  });
}

// Bun's node:http never flushes raw bytes written to the upgrade socket, so a plain HTTP
// rejection (rejectUpgrade) reaches browsers as an empty close and surfaces as an opaque
// proxy 500. Once the client is known to speak the runtime protocol, complete the
// handshake and close with an application code + reason the browser can read. Raw
// rejection stays only for pre-handshake failures (bad origin/ticket), where completing
// a handshake would be wrong.
function closeUpgradeWithError(
  webSocketServer: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  code: number,
  reason: string,
) {
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocket.close(code, reason);
  });
}

export function attachRuntimeConnection(
  webSocket: WebSocket,
  sandbox: SandboxHandle,
  session: GoatCodingWorkspaceSession,
  env: RunnerEnv,
  restoreTimeout: typeof restoreSandboxTimeout = restoreSandboxTimeout,
) {
  const workDirectory = CLOUD_CODING_ENGINE_CONFIG[session.engine].workDirectory;
  let terminalPid: number | null = null;
  let terminalHandle: Awaited<ReturnType<SandboxHandle["pty"]["create"]>> | null = null;
  let disposed = false;
  let operation = Promise.resolve();

  // Terminal input bypasses the control-operation queue: keystrokes must never wait
  // behind a port scan or preview lookup. While one sendInput RPC is in flight,
  // further keystrokes coalesce into a single follow-up call, so a typing burst costs
  // at most two sandbox round-trips instead of one per key.
  let pendingInput: Buffer[] = [];
  let pendingInputBytes = 0;
  let inputInFlight = false;
  const flushTerminalInput = () => {
    if (inputInFlight || disposed || terminalPid === null || pendingInput.length === 0) return;
    const pid = terminalPid;
    const data = Buffer.concat(pendingInput);
    pendingInput = [];
    pendingInputBytes = 0;
    inputInFlight = true;
    sandbox.pty
      .sendInput(pid, data)
      .catch(() => {
        sendControl({ type: "error", scope: "terminal", message: "Terminal input failed." });
      })
      .finally(() => {
        inputInFlight = false;
        flushTerminalInput();
      });
  };
  const enqueueTerminalInput = (data: Buffer) => {
    if (disposed || pendingInputBytes + data.byteLength > MAX_PENDING_TERMINAL_INPUT_BYTES) return;
    pendingInput.push(data);
    pendingInputBytes += data.byteLength;
    flushTerminalInput();
  };

  const sendControl = (message: Record<string, unknown>) => {
    if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(message));
  };
  const sendTerminal = (data: Uint8Array | string) => {
    if (webSocket.readyState !== WebSocket.OPEN) return;
    webSocket.send(typeof data === "string" ? Buffer.from(data) : data, { binary: true });
  };

  sendControl({ type: "status", status: "ready" });
  let heartbeatReceived = true;
  webSocket.on("pong", () => {
    heartbeatReceived = true;
  });
  const heartbeat = setInterval(() => {
    if (!heartbeatReceived) {
      webSocket.terminate();
      return;
    }
    heartbeatReceived = false;
    webSocket.ping();
    void keepSandboxActive(sandbox).catch(() => {
      sendControl({ type: "status", status: "disconnected" });
    });
  }, HEARTBEAT_INTERVAL_MS);

  const attachTerminal = async (cols: number, rows: number) => {
    const scrollback = await sandbox.commands
      .run(`tmux capture-pane -p -S -1000 -t ${TMUX_SESSION} 2>/dev/null || true`, {
        user: "user",
        timeoutMs: 10_000,
      })
      .then((result) => result.stdout)
      .catch(() => "");
    if (scrollback) sendTerminal(`${scrollback.replace(/\n?$/, "\n")}\r\n`);

    if (terminalPid !== null) {
      await sandbox.pty.resize(terminalPid, { cols, rows });
      sendControl({ type: "terminal.attached" });
      return;
    }

    await sandbox.commands.run(`mkdir -p ${shellQuote(workDirectory)}`, {
      user: "user",
      timeoutMs: 10_000,
    });
    terminalHandle = await sandbox.pty.create({
      cols,
      rows,
      cwd: workDirectory,
      user: "user",
      timeoutMs: 24 * 60 * 60_000,
      onData: sendTerminal,
    });
    terminalPid = terminalHandle.pid;
    await sandbox.pty.sendInput(
      terminalPid,
      Buffer.from(`exec tmux new-session -A -s ${TMUX_SESSION}\r`),
    );
    sendControl({ type: "terminal.attached" });
    // Deliver anything typed while the PTY was still starting.
    flushTerminalInput();
  };

  const refreshPorts = async () => {
    const ports = await discoverGoatCodingWorkspacePreviewPorts(sandbox, { workDirectory });
    sendControl({ type: "ports", ports });
  };

  const openPreview = async (port: number) => {
    if (!env.previewBaseDomain) {
      throw new Error("Preview is not configured on this runner.");
    }
    if (!isAllowedPreviewPort(port)) throw new Error("That preview port is reserved or invalid.");
    const ports = await discoverGoatCodingWorkspacePreviewPorts(sandbox, { workDirectory });
    if (!ports.some((candidate) => candidate.port === port)) {
      throw new Error(`Nothing is listening on port ${port}.`);
    }
    const signed = createGoatCodingWorkspacePreviewCapability({
      codingSessionId: session.id,
      port,
      secret: env.streamTokenSecret,
    });
    sendControl({
      type: "preview",
      port,
      url: previewUrl(signed.capability, env.previewBaseDomain, env.previewProtocol),
      expiresAt: signed.expiresAt,
    });
  };

  webSocket.on("message", (raw, isBinary) => {
    if (isBinary) {
      enqueueTerminalInput(copyWebSocketData(raw));
      return;
    }

    let message: RuntimeControlMessage;
    try {
      message = JSON.parse(raw.toString()) as RuntimeControlMessage;
    } catch {
      sendControl({ type: "error", message: "Invalid runtime control message." });
      return;
    }

    operation = operation
      .then(async () => {
        if (disposed) return;
        if (message.type === "terminal.attach") {
          await attachTerminal(clampDimension(message.cols, 80), clampDimension(message.rows, 24));
        } else if (message.type === "terminal.resize" && terminalPid !== null) {
          await sandbox.pty.resize(terminalPid, {
            cols: clampDimension(message.cols, 80),
            rows: clampDimension(message.rows, 24),
          });
        } else if (message.type === "ports.refresh") {
          await refreshPorts();
        } else if (message.type === "preview.open") {
          await openPreview(Number(message.port));
        } else if (message.type === "ping") {
          sendControl({ type: "pong" });
        }
      })
      .catch((error) => {
        sendControl({
          type: "error",
          message: error instanceof Error ? error.message : "Runtime request failed.",
        });
      });
  });

  webSocket.on("close", () => {
    disposed = true;
    pendingInput = [];
    pendingInputBytes = 0;
    clearInterval(heartbeat);
    void terminalHandle?.kill().catch(() => {});
    void restoreTimeout(session.id, sandbox, env.goatCodexChatIdleTimeoutMs).catch((error) => {
      logger.warn("Failed to restore coding workspace idle timeout", {
        event: "opencompany.goat_coding_workspace_idle_restore_failed",
        error,
      });
    });
  });
}

type RuntimeControlMessage =
  | { type: "terminal.attach" | "terminal.resize"; cols?: number; rows?: number }
  | { type: "ports.refresh" | "ping" }
  | { type: "preview.open"; port?: number };

async function proxyPreviewHttp(
  request: IncomingMessage,
  response: ServerResponse,
  env: RunnerEnv,
  cache: Map<string, { expiresAt: number; target: Promise<PreviewTarget> }>,
) {
  try {
    const capability = previewCapabilityFromRequest(request, env.previewBaseDomain);
    if (!capability) {
      sendPlainResponse(response, 404, "Preview not found.");
      return;
    }
    const target = await resolvePreviewTarget(capability, env, cache);
    const requestHeaders = upstreamRequestHeaders(request.headers, request.headers.host ?? "");
    const upstream = https.request(
      {
        hostname: target.upstreamHost,
        method: request.method,
        path: request.url,
        headers: {
          ...requestHeaders,
          ...trafficAccessHeaders(target.sandbox.trafficAccessToken),
        },
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          rewritePreviewResponseHeaders(
            upstreamResponse.headers,
            target.upstreamHost,
            request.headers.host ?? "",
            env.allowedOrigins,
            forwardedProtocol(request),
            target.port,
          ),
        );
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent)
        sendPlainResponse(response, 502, "The preview server is unavailable.");
      else response.destroy();
    });
    request.pipe(upstream);
  } catch (error) {
    logger.warn("Preview proxy request failed", {
      event: "opencompany.goat_coding_workspace_preview_proxy_failed",
      error,
    });
    if (!response.headersSent)
      sendPlainResponse(response, 502, "The preview server is unavailable.");
    else response.destroy();
  }
}

async function proxyPreviewWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  env: RunnerEnv,
  webSocketServer: WebSocketServer,
  cache: Map<string, { expiresAt: number; target: Promise<PreviewTarget> }>,
) {
  try {
    const capability = previewCapabilityFromRequest(request, env.previewBaseDomain);
    if (!capability) {
      rejectUpgrade(socket, 404, "Preview not found");
      return;
    }
    const target = await resolvePreviewTarget(capability, env, cache);
    const protocols = readProtocols(request.headers["sec-websocket-protocol"]);
    const upstream = new WebSocket(
      `wss://${target.upstreamHost}${request.url ?? "/"}`,
      protocols.length > 0 ? protocols : undefined,
      {
        headers: {
          ...upstreamRequestHeaders(request.headers, request.headers.host ?? ""),
          ...trafficAccessHeaders(target.sandbox.trafficAccessToken),
        },
      },
    );

    webSocketServer.handleUpgrade(request, socket, head, (downstream) => {
      let heartbeatReceived = true;
      let closed = false;
      let stopForwarding = () => {};
      let upstreamConnectTimeout: ReturnType<typeof setTimeout> | null = null;
      downstream.on("pong", () => {
        heartbeatReceived = true;
      });
      const heartbeat = setInterval(() => {
        if (!heartbeatReceived) {
          downstream.terminate();
          return;
        }
        heartbeatReceived = false;
        downstream.ping();
        void keepSandboxActive(target.sandbox).catch(() => downstream.close());
      }, HEARTBEAT_INTERVAL_MS);
      const close = () => {
        if (closed) return;
        closed = true;
        if (upstreamConnectTimeout) clearTimeout(upstreamConnectTimeout);
        clearInterval(heartbeat);
        if (
          upstream.readyState === WebSocket.OPEN ||
          upstream.readyState === WebSocket.CONNECTING
        ) {
          upstream.close();
        }
        if (downstream.readyState === WebSocket.OPEN) downstream.close();
        stopForwarding();
        void restoreSandboxTimeout(
          target.session.id,
          target.sandbox,
          env.goatCodexChatIdleTimeoutMs,
        ).catch(() => {});
      };

      upstreamConnectTimeout = setTimeout(close, PREVIEW_UPSTREAM_CONNECT_TIMEOUT_MS);
      upstream.once("open", () => {
        if (upstreamConnectTimeout) clearTimeout(upstreamConnectTimeout);
        upstreamConnectTimeout = null;
      });
      stopForwarding = forwardPreviewWebSocketMessages(downstream, upstream, close);
      upstream.on("message", (data, binary) => {
        if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
      });
      upstream.on("close", close);
      upstream.on("error", close);
      downstream.on("close", close);
      downstream.on("error", close);
    });
  } catch {
    rejectUpgrade(socket, 502, "Preview unavailable");
  }
}

async function resolvePreviewTarget(
  capability: string,
  env: RunnerEnv,
  cache: Map<string, { expiresAt: number; target: Promise<PreviewTarget> }>,
) {
  const verified = verifyGoatCodingWorkspacePreviewCapability({
    capability,
    secret: env.streamTokenSecret,
  });
  if (!verified || !isAllowedPreviewPort(verified.port))
    throw new Error("Invalid preview capability.");

  const cached = cache.get(capability);
  if (cached && cached.expiresAt > Date.now()) return cached.target;
  if (cached) cache.delete(capability);

  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size >= MAX_PREVIEW_SESSION_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }

  const target = (async () => {
    const session = await loadGoatCodingWorkspaceSession({
      codingSessionId: verified.codingSessionId,
    });
    if (!session) throw new Error("Preview session is closed.");
    const sandbox = await connectSandbox({ sandboxId: session.sandboxId });
    if (!sandbox) throw new Error("Preview sandbox was deleted.");
    return { session, sandbox, upstreamHost: sandbox.getHost(verified.port), port: verified.port };
  })();
  const entry = { expiresAt: Date.now() + PREVIEW_SESSION_CACHE_MS, target };
  cache.set(capability, entry);
  target.catch(() => {
    if (cache.get(capability) === entry) cache.delete(capability);
  });
  return target;
}

export function forwardPreviewWebSocketMessages(
  downstream: WebSocket,
  upstream: WebSocket,
  onOverflow: () => void,
  maxPendingBytes = MAX_PENDING_PREVIEW_WEBSOCKET_BYTES,
) {
  const pending: Array<{ data: Buffer; binary: boolean }> = [];
  let pendingBytes = 0;

  const onMessage = (data: RawData, binary: boolean) => {
    const copied = copyWebSocketData(data);
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(copied, { binary });
      return;
    }
    if (upstream.readyState !== WebSocket.CONNECTING) return;
    if (pendingBytes + copied.byteLength > maxPendingBytes) {
      onOverflow();
      return;
    }
    pending.push({ data: copied, binary });
    pendingBytes += copied.byteLength;
  };
  const flush = () => {
    if (upstream.readyState !== WebSocket.OPEN) return;
    for (const message of pending) {
      upstream.send(message.data, { binary: message.binary });
    }
    pending.length = 0;
    pendingBytes = 0;
  };

  downstream.on("message", onMessage);
  upstream.on("open", flush);
  return () => {
    downstream.off("message", onMessage);
    upstream.off("open", flush);
    pending.length = 0;
    pendingBytes = 0;
  };
}

function previewCapabilityFromRequest(request: IncomingMessage, baseDomain: string | undefined) {
  if (!baseDomain || !request.headers.host) return null;
  const host = hostnameFromAuthority(request.headers.host);
  const base = hostnameFromAuthority(baseDomain);
  const suffix = `.${base}`;
  if (!host.endsWith(suffix)) return null;
  const capability = host.slice(0, -suffix.length);
  return capability && !capability.includes(".") ? capability : null;
}

function isPreviewRequest(request: IncomingMessage, baseDomain: string | undefined) {
  return previewCapabilityFromRequest(request, baseDomain) !== null;
}

function previewUrl(
  capability: string,
  baseDomain: string,
  configuredProtocol: "http" | "https" | undefined,
) {
  const protocol = configuredProtocol ?? (baseDomain.includes("localhost") ? "http" : "https");
  return `${protocol}://${capability}.${baseDomain}`;
}

function hostnameFromAuthority(authority: string) {
  try {
    return new URL(`http://${authority}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function readProtocols(header: string | string[] | undefined) {
  const value = Array.isArray(header) ? header.join(",") : (header ?? "");
  return value
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

function copyWebSocketData(data: RawData) {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  return Buffer.from(data);
}

function clampDimension(value: number | undefined, fallback: number) {
  return Number.isInteger(value) ? Math.min(500, Math.max(2, Number(value))) : fallback;
}

function upstreamRequestHeaders(headers: IncomingHttpHeaders, forwardedHost: string) {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (
      value === undefined ||
      [
        "host",
        "connection",
        "upgrade",
        "keep-alive",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
      ].includes(lowerName) ||
      lowerName.startsWith("sec-websocket-")
    ) {
      continue;
    }
    result[name] = value;
  }
  result["x-forwarded-host"] = forwardedHost;
  result["x-forwarded-proto"] = forwardedHost.includes("localhost") ? "http" : "https";
  return result;
}

export function rewritePreviewResponseHeaders(
  headers: IncomingHttpHeaders,
  upstreamHost: string,
  previewHost: string,
  allowedOrigins: string[],
  requestProtocol: "http" | "https" = previewHost.includes("localhost") ? "http" : "https",
  upstreamPort?: number,
) {
  const result: Record<string, string | string[]> = {};
  const previewProtocol = requestProtocol;
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "x-frame-options",
        "content-security-policy",
      ].includes(name)
    )
      continue;
    if (name === "location" && typeof value === "string") {
      result[name] = rewritePreviewLocation(
        value,
        upstreamHost,
        upstreamPort,
        previewHost,
        previewProtocol,
      );
    } else if (name === "set-cookie") {
      const cookies = Array.isArray(value) ? value : [value];
      result[name] = cookies.map((cookie) => cookie.replace(/;\s*Domain=[^;]*/gi, ""));
    } else {
      result[name] = value;
    }
  }

  const frameAncestors = allowedOrigins.length > 0 ? allowedOrigins.join(" ") : "'none'";
  const existingPolicy = headers["content-security-policy"];
  const preservedDirectives = (
    Array.isArray(existingPolicy) ? existingPolicy.join("; ") : (existingPolicy ?? "")
  )
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive && !directive.toLowerCase().startsWith("frame-ancestors "));
  result["content-security-policy"] = [
    ...preservedDirectives,
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
  result["referrer-policy"] = "no-referrer";
  return result;
}

function rewritePreviewLocation(
  value: string,
  upstreamHost: string,
  upstreamPort: number | undefined,
  previewHost: string,
  previewProtocol: "http" | "https",
) {
  try {
    const location = new URL(value);
    const isUpstream = location.hostname === upstreamHost;
    const isSelectedLoopback =
      upstreamPort !== undefined &&
      ["localhost", "127.0.0.1", "::1"].includes(location.hostname) &&
      Number(location.port || defaultPort(location.protocol)) === upstreamPort;
    if (!isUpstream && !isSelectedLoopback) return value;
    const previewAuthority = new URL(`${previewProtocol}://${previewHost}`);
    location.protocol = `${previewProtocol}:`;
    location.hostname = previewAuthority.hostname;
    location.port = previewAuthority.port;
    return location.toString();
  } catch {
    return value;
  }
}

function defaultPort(protocol: string) {
  if (protocol === "http:" || protocol === "ws:") return 80;
  if (protocol === "https:" || protocol === "wss:") return 443;
  return 0;
}

function forwardedProtocol(request: IncomingMessage): "http" | "https" {
  const value = request.headers["x-forwarded-proto"];
  const first = (Array.isArray(value) ? value[0] : value)?.split(",", 1)[0]?.trim();
  return first === "https" ? "https" : "http";
}

export function isGoatCodingWorkspaceOriginAllowed(
  origin: string | undefined,
  allowedOrigins: string[],
) {
  return Boolean(origin && allowedOrigins.includes(origin));
}

// E2B's edge proxy authenticates restricted public traffic (allowPublicTraffic: false)
// via the `e2b-traffic-access-token` header; `x-access-token` is envd's header and is
// kept only in case older edges accept it.
function trafficAccessHeaders(trafficAccessToken: string | undefined) {
  if (!trafficAccessToken) return {};
  return {
    "e2b-traffic-access-token": trafficAccessToken,
    "x-access-token": trafficAccessToken,
  };
}

function sendPlainResponse(response: ServerResponse, statusCode: number, message: string) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  response.end(message);
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string) {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n`,
  );
}

function closeWebSocketServer(server: WebSocketServer) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

// Fallback for sandboxes created from templates without tmux/ss baked in (the stock
// `codex` template ships neither). The opencompany-codex-toolbox template preinstalls
// both, making this a no-op check. apt-get requires root — the E2B SDK default command
// user is the unprivileged `user`, under which the install always fails.
export const RUNTIME_TOOLS_INSTALL_COMMAND = [
  "if ! command -v tmux >/dev/null 2>&1 || ! command -v ss >/dev/null 2>&1; then",
  "export DEBIAN_FRONTEND=noninteractive;",
  "apt-get update -qq && apt-get install -y -qq --no-install-recommends tmux iproute2;",
  "fi;",
  "command -v tmux >/dev/null && command -v ss >/dev/null",
].join(" ");

async function ensureRuntimeTools(sandbox: SandboxHandle) {
  const existing = runtimeToolInstalls.get(sandbox.sandboxId);
  if (existing) return existing;

  const install = sandbox.commands
    .run(RUNTIME_TOOLS_INSTALL_COMMAND, { user: "root", timeoutMs: 120_000 })
    .then(() => undefined);
  runtimeToolInstalls.set(sandbox.sandboxId, install);
  void install.then(
    () => {
      if (runtimeToolInstalls.get(sandbox.sandboxId) === install) {
        runtimeToolInstalls.delete(sandbox.sandboxId);
      }
    },
    () => {
      if (runtimeToolInstalls.get(sandbox.sandboxId) === install) {
        runtimeToolInstalls.delete(sandbox.sandboxId);
      }
    },
  );
  return install;
}

async function restoreSandboxTimeout(
  codingSessionId: string,
  sandbox: SandboxHandle,
  idleTimeoutMs: number,
) {
  const current = await loadGoatCodingWorkspaceSession({ codingSessionId });
  if (current && ["queued", "starting", "running"].includes(current.status)) {
    await keepSandboxActive(sandbox);
    return;
  }
  await armSandboxIdleTimeout(sandbox, idleTimeoutMs);
}
