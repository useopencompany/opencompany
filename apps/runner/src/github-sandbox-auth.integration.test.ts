import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";

const credentials = vi.hoisted(() => ({
  load: vi.fn(),
  rotate: vi.fn(),
  claim: vi.fn(async () => true),
}));
vi.mock("@opencompany/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@opencompany/db/integrations", () => ({
  GITHUB_USER_INTEGRATION_EXTERNAL_ID: "github_user",
  loadIntegrationCredential: credentials.load,
  rotateIntegrationCredential: credentials.rotate,
  claimIntegrationCredentialRefresh: credentials.claim,
  releaseIntegrationCredentialRefresh: vi.fn(),
  markIntegrationStatus: vi.fn(),
}));

import { getGitHubUserAccessToken } from "@opencompany/agent/integrations/github-user";
import { registerGitHubBrokerRoutes } from "./github-broker";
import { createGitHubSandboxCapability, prepareGitHubSandboxAuth } from "./github-sandbox-auth";
import type { SandboxHandle } from "./sandbox";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function execute(
  bin: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; input?: Buffer } = {},
) {
  return new Promise<{ stdout: string; stderr: string; code: number; raw: Buffer }>(
    (resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: options.cwd,
        env: { PATH: process.env.PATH, HOME: tmpdir(), ...options.env },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (b) => out.push(b));
      child.stderr.on("data", (b) => err.push(b));
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({
          stdout: Buffer.concat(out).toString(),
          stderr: Buffer.concat(err).toString(),
          code: code ?? -1,
          raw: Buffer.concat(out),
        }),
      );
      child.stdin.end(options.input);
    },
  );
}
async function success(bin: string, args: string[], options: Parameters<typeof execute>[2] = {}) {
  const result = await execute(bin, args, options);
  expect(result.stderr, `${bin} ${args.join(" ")} exited ${result.code}`).not.toContain(
    "Traceback",
  );
  expect(result.code, result.stderr).toBe(0);
  return result;
}

it("keeps real gh pagination and git clone/fetch/push working across shared-token rotation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-broker-integration-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  await success("git", ["init", "--bare", join(root, "source/repo.git")]);
  await success("git", [
    "--git-dir",
    join(root, "source/repo.git"),
    "config",
    "http.receivepack",
    "true",
  ]);
  const connection = { userWorkosId: "synthetic", integrationId: "synthetic_integration" };
  let accepted = "ghu_synthetic_0";
  let generation = 0;
  let stored = {
    payload: {
      access_token: accepted,
      refresh_token: "ghr_synthetic",
      token_type: "bearer",
      refresh_token_expires_at: new Date(Date.now() + 86400000).toISOString(),
      github_user_id: "42",
      github_login: "synthetic",
      github_installation_id: "123",
    } as Record<string, unknown>,
    expiresAt: new Date(Date.now() + 28800000),
    lastRotatedAt: new Date(0),
  };
  credentials.load.mockImplementation(async () => stored);
  credentials.rotate.mockImplementation(async (input) => {
    stored = { payload: input.payload, expiresAt: input.expiresAt, lastRotatedAt: input.now };
    return { id: "credential" };
  });
  vi.stubEnv("GITHUB_USER_APP_CLIENT_ID", "synthetic_client");
  vi.stubEnv("GITHUB_USER_APP_CLIENT_SECRET", "synthetic_secret");
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) === "https://github.com/login/oauth/access_token") {
      accepted = `ghu_synthetic_${++generation}`;
      return Response.json({
        access_token: accepted,
        refresh_token: "ghr_synthetic",
        token_type: "bearer",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
      });
    }
    return realFetch(url, init);
  });
  let mutations = 0;
  let rejected = 0;
  let active = true;
  const seenHeaders: Record<string, string | undefined>[] = [];
  const upstream = createServer(async (req, res) => {
    const auth = req.headers.authorization;
    const basic = "Basic " + Buffer.from(`x-access-token:${accepted}`).toString("base64");
    if (auth !== `Bearer ${accepted}` && auth !== basic) {
      rejected++;
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"message":"Bad credentials"}');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, "http://local");
    if (url.pathname === "/source/redirect.git/info/refs") {
      res.writeHead(301, { location: "/source/repo.git/info/refs" + url.search });
      res.end();
      return;
    }
    if (url.pathname.startsWith("/source/repo.git/")) {
      const cgi = await execute("git", ["http-backend"], {
        env: {
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method!,
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(body.length),
          REMOTE_USER: "synthetic",
          HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
          SERVER_PROTOCOL: "HTTP/1.1",
        },
        input: body,
      });
      const boundary = cgi.raw.indexOf("\r\n\r\n");
      if (boundary < 0) {
        res.writeHead(500);
        res.end(cgi.stderr);
        return;
      }
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of cgi.raw.subarray(0, boundary).toString().split("\r\n")) {
        const i = line.indexOf(":");
        const key = line.slice(0, i);
        const value = line.slice(i + 1).trim();
        if (key.toLowerCase() === "status") status = Number(value.slice(0, 3));
        else headers[key] = value;
      }
      res.writeHead(status, headers);
      res.end(cgi.raw.subarray(boundary + 4));
      return;
    }
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/repos/source/repo/issues" && req.method === "GET") {
      if (!url.searchParams.has("page")) {
        res.setHeader(
          "Link",
          '<https://api.github.com/repos/source/repo/issues?per_page=1&page=2>; rel="next"',
        );
        res.end('[{"number":1}]');
      } else res.end('[{"number":2}]');
    } else if (url.pathname === "/repos/source/repo/issues" && req.method === "POST") {
      mutations++;
      res.writeHead(201);
      res.end('{"number":3}');
    } else if (url.pathname === "/graphql" && body.toString().includes("UserCurrent")) {
      res.end(JSON.stringify({ data: { viewer: { login: "synthetic" } } }));
    } else if (url.pathname === "/graphql") {
      res.end(
        JSON.stringify({
          data: {
            repository: {
              name: "repo",
              nameWithOwner: "source/repo",
              url: "https://github.com/source/repo",
              defaultBranchRef: { name: "main" },
            },
          },
        }),
      );
    } else res.end('{"login":"synthetic","id":42}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const upstreamPort = (upstream.address() as { port: number }).port;
  let rotateNext = false;
  let rotatePageTwo = true;
  const app = Fastify();
  cleanups.push(() => app.close());
  registerGitHubBrokerRoutes(app, {
    secret: "synthetic-secret",
    dependencies: {
      authorize: async () => (active ? ({ actorId: connection.userWorkosId } as never) : null),
      loadIntegration: async () => ({ id: connection.integrationId, status: "connected" }) as never,
      fetch: async (url, init) => {
        const target = new URL(String(url));
        const headers = new Headers(init?.headers);
        seenHeaders.push({
          authorization: headers.get("authorization") ?? undefined,
          ticket: headers.get("x-opencompany-github-ticket") ?? undefined,
        });
        if (rotateNext || (rotatePageTwo && target.searchParams.get("page") === "2")) {
          rotateNext = false;
          rotatePageTwo = false;
          await getGitHubUserAccessToken(connection, { forceRefresh: true });
        }
        return realFetch(`http://127.0.0.1:${upstreamPort}${target.pathname}${target.search}`, {
          ...init,
          headers,
        });
      },
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const children = new Map<number, ChildProcess>();
  const sandbox = {
    files: {
      write: async (files: { path: string; data: string }[]) => {
        for (const file of files) await writeFile(file.path, file.data, { mode: 0o600 });
      },
    },
    commands: {
      run: async (cmd: string, options: { background?: boolean }) => {
        if (options.background) {
          const child = spawn("bash", ["-c", cmd], {
            env: { PATH: process.env.PATH, HOME: root },
            stdio: "ignore",
          });
          children.set(child.pid!, child);
          return { pid: child.pid };
        }
        const result = await execute("bash", ["-c", cmd]);
        if (result.code) throw new Error(result.stderr);
        return result;
      },
      kill: async (pid: number) => {
        const child = children.get(pid);
        if (!child) return false;
        child.kill();
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
        children.delete(pid);
        return true;
      },
    },
  } as unknown as SandboxHandle;
  const capability = createGitHubSandboxCapability({
    sessionId: "session",
    turnId: "turn",
    attemptId: "attempt",
    leaseId: "lease",
    secret: "synthetic-secret",
    timeoutMs: 60000,
  });
  cleanups.push(async () => {
    for (const child of children.values()) child.kill();
    await rm(capability.root, { recursive: true, force: true });
  });
  const auth = await prepareGitHubSandboxAuth({
    sandbox,
    brokerUrl: `http://127.0.0.1:${port}`,
    capability,
    identity: { gitAuthorName: "Synthetic", gitAuthorEmail: "synthetic@example.invalid" },
  });
  cleanups.push(auth.dispose);
  const env = { ...auth.env, GIT_TERMINAL_PROMPT: "0" };
  expect(JSON.stringify(env)).not.toContain("ghu_synthetic");
  expect(await readFile(join(capability.root, "config.json"), "utf8")).not.toContain(
    "ghu_synthetic",
  );

  await success("gh", ["auth", "status"], { env });
  const pages = await success("gh", ["api", "--paginate", "repos/source/repo/issues?per_page=1"], {
    env,
  });
  expect(pages.stdout).toContain('"number":1');
  expect(pages.stdout).toContain('"number":2');
  expect(generation).toBe(1);
  expect(rejected).toBe(1);
  rotateNext = true;
  await success(
    "gh",
    ["api", "--method", "POST", "repos/source/repo/issues", "-f", "title=Synthetic"],
    { env },
  );
  expect(mutations).toBe(1);
  expect(generation).toBe(2);
  expect(rejected).toBe(2);

  await success("git", ["ls-remote", "https://github.com/source/redirect.git"], { env });
  const checkout = join(root, "checkout");
  await success("git", ["clone", "https://github.com/source/repo.git", checkout], { env });
  await success("git", ["checkout", "-b", "main"], { env, cwd: checkout });
  await writeFile(join(checkout, "file.txt"), "first\n");
  await success("git", ["add", "file.txt"], { env, cwd: checkout });
  await success("git", ["commit", "-m", "Synthetic commit"], { env, cwd: checkout });
  rotateNext = true;
  await success("git", ["-c", "http.postBuffer=1", "push", "-u", "origin", "main"], {
    env,
    cwd: checkout,
  });
  expect(generation).toBe(3);
  await getGitHubUserAccessToken(connection, { forceRefresh: true });
  await success("git", ["fetch", "origin"], { env, cwd: checkout });
  await success("gh", ["repo", "view", "--json", "name"], { env, cwd: checkout });
  expect(
    (
      await success("git", ["config", "--get", "remote.origin.url"], { env, cwd: checkout })
    ).stdout.trim(),
  ).toBe("https://github.com/source/repo.git");
  expect(seenHeaders.every((h) => h.ticket === undefined)).toBe(true);
  active = false;
  const denied = await execute("gh", ["api", "user"], { env });
  expect(denied.code).not.toBe(0);
  expect(denied.stderr).toContain("403");
  const noLocalAuth = await realFetch(
    `http://127.0.0.1:${JSON.parse(await readFile(join(capability.root, "ready.json"), "utf8")).port}/git/source/repo.git/info/refs?service=git-upload-pack`,
  );
  expect(noLocalAuth.status).toBe(401);
}, 30000);
