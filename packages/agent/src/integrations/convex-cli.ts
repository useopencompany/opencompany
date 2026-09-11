import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  type ConvexToolName,
  convexToolAllowedInProduction,
  parseConvexDeployKey,
} from "./convex-policy";

const require = createRequire(import.meta.url);
const CLI_PATH = join(dirname(require.resolve("convex/package.json")), "bin/main.js");
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
let activeProcesses = 0;

export async function discoverConvexCli() {
  return ListToolsResultSchema.parse(
    await runProcess(null, () => ({ method: "tools/list", params: {} })),
  );
}

export async function runConvexCli(input: {
  apiKey: string;
  tool: Exclude<ConvexToolName, "status">;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}) {
  const deployment = parseConvexDeployKey(input.apiKey);
  if (!deployment) throw new Error("Invalid Convex deployment key.");
  if (deployment.type === "prod" && !convexToolAllowedInProduction(input.tool)) {
    throw new Error("Production deployments support schema and function inspection only.");
  }
  if (Object.hasOwn(input.args, "deploymentSelector") || Object.hasOwn(input.args, "projectDir")) {
    throw new Error("Convex tools use the connected deployment only.");
  }
  return CallToolResultSchema.parse(
    await runProcess(
      input.apiKey,
      (projectDir) => {
        // Never decode or forward a caller's selector: it embeds filesystem paths and deployment choices.
        const kind = deployment.type === "prod" ? "prod" : "unspecified";
        const selector = `${kind}:${Buffer.from(JSON.stringify({ projectDir, deployment: { kind } })).toString("base64")}`;
        return {
          method: "tools/call",
          params: { name: input.tool, arguments: { ...input.args, deploymentSelector: selector } },
        };
      },
      input.signal,
    ),
  );
}

async function runProcess(
  apiKey: string | null,
  operation: (directory: string) => { method: string; params: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<unknown> {
  if (activeProcesses >= 4) throw new Error("Convex is busy. Try again shortly.");
  signal?.throwIfAborted();
  activeProcesses++;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "opencompany-convex-"));
    await mkdir(join(directory, "convex"));
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ dependencies: { convex: "1.45.0" } }),
      { mode: 0o600 },
    );
    const result = await new Promise<unknown>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          CLI_PATH,
          "mcp",
          "start",
          "--project-dir",
          directory!,
          "--disable-tools",
          "status,insights",
        ],
        {
          cwd: directory,
          // Deliberately exclude application secrets, global Convex login, and user-controlled CLI options.
          env: {
            HOME: directory!,
            PATH: "/usr/local/bin:/usr/bin:/bin",
            LANG: "C.UTF-8",
            CI: "1",
            NODE_ENV: "production",
            ...(apiKey ? { CONVEX_DEPLOY_KEY: apiKey } : {}),
          },
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
      let settled = false;
      let received = 0;
      let buffer = "";
      let response: unknown;
      let failure: Error | undefined;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        failure = error;
        response = value;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        child.kill("SIGKILL");
      };
      const abort = () => finish(new Error("Convex request cancelled."));
      const timer = setTimeout(() => finish(new Error("Convex request timed out.")), TIMEOUT_MS);
      signal?.addEventListener("abort", abort, { once: true });
      const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
      child.on("error", () => finish(new Error("Convex MCP could not start.")));
      child.stdin.on("error", () => finish(new Error("Convex MCP connection closed.")));
      child.on("close", () => {
        if (!settled) finish(new Error("Convex MCP exited before completing the request."));
        if (failure) reject(failure);
        else resolve(response);
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        received += Buffer.byteLength(chunk);
        if (received > MAX_OUTPUT_BYTES)
          return finish(new Error("Convex response exceeded the size limit. Narrow the request."));
        buffer += chunk;
        let newline: number;
        while (!settled && (newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const rpc = JSON.parse(line);
            if (rpc.error) return finish(new Error("Convex MCP rejected the request."));
            if (rpc.id === 1) {
              send({ jsonrpc: "2.0", method: "notifications/initialized" });
              send({ jsonrpc: "2.0", id: 2, ...operation(directory!) });
            } else if (rpc.id === 2) finish(undefined, rpc.result);
          } catch {
            finish(new Error("Convex MCP returned an invalid response."));
          }
        }
      });
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "opencompany", version: "1.0.0" },
        },
      });
      if (signal?.aborted) abort();
    });
    // Error text and even query output may contain credentials. Never return the connected key.
    if (!apiKey) return result;
    const redacted = JSON.stringify(result).split(apiKey).join("[redacted]");
    return JSON.parse(redacted.split(apiKey.split("|")[1]!).join("[redacted]"));
  } finally {
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } finally {
      activeProcesses--;
    }
  }
}
