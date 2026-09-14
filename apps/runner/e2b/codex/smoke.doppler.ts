// Run against the pinned binary: bun apps/runner/e2b/codex/smoke.doppler.ts /path/to/doppler
// Uses a local provider fixture and synthetic values; no Doppler account is required.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseDopplerLogin } from "../../src/doppler-auth";
import { DOPPLER_CLI_VERSION } from "../../src/doppler-version";

const binary = resolve(process.argv[2] ?? "/usr/local/bin/doppler");
const root = await mkdtemp(join(tmpdir(), "doppler-smoke-"));
const config = join(root, "config");
const token = "dp.ct.synthetic_cli_test";
let polls = 0;
function respond(request: Request): Response {
  const url = new URL(request.url);
  if (url.pathname === "/v3/auth/cli/generate/2")
    return Response.json({
      code: "fixture_auth_code",
      polling_code: "fixture_poll",
      auth_url: "https://dashboard.doppler.com/workplace/auth/cli",
    });
  if (url.pathname === "/v3/auth/cli/authorize") {
    if (polls++ === 0) return Response.json({ error: "pending" }, { status: 409 });
    return Response.json({
      token,
      name: "Test developer",
      dashboard_url: "https://dashboard.doppler.com",
    });
  }
  if (request.headers.get("authorization") !== `Bearer ${token}`)
    return new Response(null, { status: 401 });
  if (url.pathname === "/v3/configs/config/secrets/download")
    return Response.json({
      DEMO_SERVICE: url.searchParams.get("project"),
      DEMO_CONFIG: url.searchParams.get("config"),
    });
  return new Response(null, { status: 404 });
}
const server = createServer(async (request, response) => {
  const result = respond(
    new Request(`http://127.0.0.1${request.url}`, {
      headers: { authorization: request.headers.authorization ?? "" },
    }),
  );
  response.writeHead(result.status, { "Content-Type": "application/json" });
  response.end(await result.text());
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const flags = [
  "--no-read-env",
  "--no-check-version",
  "--api-host",
  `http://127.0.0.1:${address.port}`,
  "--config-dir",
  config,
];
function run(args: string[], cwd = root, stdin = "") {
  return new Promise<string>((resolveOutput, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", () => reject(new Error("Could not run the Doppler fixture.")));
    child.on("exit", (code) =>
      code === 0
        ? resolveOutput(stdout)
        : reject(
            new Error(
              `Doppler fixture command failed (${code}): ${stderr.replaceAll(token, "[redacted]")}`,
            ),
          ),
    );
    child.stdin.end(stdin);
  });
}
try {
  assert.equal((await run(["--version"])).trim(), `v${DOPPLER_CLI_VERSION}`);
  const login = await run([...flags, "login", "--yes", "--no-copy", "--scope", "/"], root, "n\n");
  assert.equal(parseDopplerLogin(login)?.userCode, "fixture_auth_code");
  assert.equal(
    (await run([...flags, "configure", "get", "token", "--plain", "--scope", "/"])).trim(),
    token,
  );
  for (const worktree of ["first", "second"]) {
    const cwd = join(root, worktree);
    await mkdir(join(cwd, "backend"), { recursive: true });
    await mkdir(join(cwd, "frontend"));
    await writeFile(
      join(cwd, "doppler.yaml"),
      "setup:\n  - project: backend\n    config: dev_backend\n    path: backend/\n  - project: frontend\n    config: dev_frontend\n    path: frontend/\n",
    );
    await run([...flags, "setup", "--no-interactive"], cwd);
    for (const service of ["backend", "frontend"]) {
      await run(
        [
          ...flags,
          "run",
          "--",
          "node",
          "-e",
          `if(process.env.DEMO_SERVICE !== '${service}' || process.env.DEMO_CONFIG !== 'dev_${service}') process.exit(1)`,
        ],
        join(cwd, service),
      );
    }
  }
  // Restoring just the credential must retain each worktree's directory mapping.
  await run([...flags, "configure", "set", "token", "--scope", "/"], root, token);
  await run(
    [
      ...flags,
      "run",
      "--",
      "node",
      "-e",
      "if(process.env.DEMO_SERVICE !== 'backend') process.exit(1)",
    ],
    join(root, "first/backend"),
  );
  const persisted = await readFile(join(config, ".doppler.yaml"), "utf8");
  assert.ok(persisted.includes("first/backend") && persisted.includes("second/frontend"));
  console.log(
    "Doppler CLI smoke passed: headless login, credential restoration, two configs, and two worktrees.",
  );
} finally {
  server.closeAllConnections();
  server.close();
  await rm(root, { recursive: true, force: true });
}
