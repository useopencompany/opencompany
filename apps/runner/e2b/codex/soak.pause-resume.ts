import "dotenv/config";
import { SANDBOX_SIZE_SPECS, type SandboxSize } from "@opencompany/core/sandbox-sizes";
import { Sandbox } from "e2b";
import { codexToolboxTemplateAlias } from "./template";

// Release gate for every offered sandbox size.
//
// A sandbox paused close to its memory ceiling can produce a snapshot whose guest
// never answers envd after restore (prod incident 2026-09-08/09). The 16 GiB
// allocation used to be the mitigation; once a workspace can pick a smaller machine,
// each size has to be shown to survive the same pause/resume cycle under realistic
// pressure before it is offered.
//
// Usage:
//   E2B_API_KEY=e2b_... bun apps/runner/e2b/codex/soak.pause-resume.ts [size...]
//   SOAK_CYCLES=5 SOAK_MEMORY_OCCUPANCY=0.85 bun apps/runner/e2b/codex/soak.pause-resume.ts
//
// Run it after `build.prod.ts` and before pointing the runner env at the aliases.

const CYCLES = positiveInteger(process.env.SOAK_CYCLES, 5);
// Fraction of the tier's RAM held resident when the snapshot is taken. The failure
// mode only appears near the ceiling, so the default sits where real sessions hurt.
const MEMORY_OCCUPANCY = fraction(process.env.SOAK_MEMORY_OCCUPANCY, 0.85);
// Mirrors apps/runner/src/sandbox.ts: the same probe command and restore/reboot
// budgets the runner applies after connect.
const PROBE_COMMAND = "true";
const PROBE_TIMEOUT_MS = 15_000;
const CONNECT_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;

const requested = process.argv.slice(2).filter(isSandboxSize);
const sizes: SandboxSize[] =
  requested.length > 0 ? requested : (Object.keys(SANDBOX_SIZE_SPECS) as SandboxSize[]);

const results: { size: SandboxSize; cycles: number; failure: string | null }[] = [];
for (const size of sizes) {
  results.push(await soakSize(size));
}

let failed = false;
for (const result of results) {
  if (result.failure) {
    failed = true;
    console.error(`FAIL ${result.size}: ${result.failure} (after ${result.cycles} clean cycles)`);
  } else {
    console.log(`PASS ${result.size}: ${result.cycles}/${CYCLES} pause/resume cycles`);
  }
}
if (failed) process.exit(1);

async function soakSize(size: SandboxSize) {
  const spec = SANDBOX_SIZE_SPECS[size];
  const alias = codexToolboxTemplateAlias(size);
  const holdMb = Math.floor(spec.memoryMB * MEMORY_OCCUPANCY);
  console.log(
    `\n${size}: ${alias} — ${CYCLES} cycles holding ~${holdMb} MB of ${spec.memoryMB} MB`,
  );

  let sandbox = await Sandbox.create(alias, {
    timeoutMs: SANDBOX_TIMEOUT_MS,
    lifecycle: { onTimeout: "pause", autoResume: true },
  });
  let cycles = 0;
  try {
    const info = await sandbox.getInfo();
    if (info.cpuCount !== spec.cpuCount || info.memoryMB !== spec.memoryMB) {
      return {
        size,
        cycles,
        failure: `template reports ${info.cpuCount} vCPU / ${info.memoryMB} MB, expected ${spec.cpuCount} / ${spec.memoryMB}`,
      };
    }

    await startMemoryPressure(sandbox, holdMb);

    for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
      await Sandbox.pause(sandbox.sandboxId);
      sandbox = await Sandbox.connect(sandbox.sandboxId, {
        timeoutMs: SANDBOX_TIMEOUT_MS,
        requestTimeoutMs: CONNECT_REQUEST_TIMEOUT_MS,
      });
      await sandbox.commands.run(PROBE_COMMAND, {
        timeoutMs: PROBE_TIMEOUT_MS,
        requestTimeoutMs: PROBE_TIMEOUT_MS,
      });
      // The processes holding memory must survive a memory-snapshot restore; if they
      // are gone, the cycle proved nothing about a loaded guest.
      const held = await sandbox.commands.run("pgrep -c -f opencompany-soak-hold || true", {
        timeoutMs: PROBE_TIMEOUT_MS,
        requestTimeoutMs: PROBE_TIMEOUT_MS,
      });
      if (Number.parseInt(held.stdout.trim(), 10) < 1) {
        return { size, cycles, failure: `cycle ${cycle} restored without the memory holder` };
      }
      cycles = cycle;
      console.log(`  cycle ${cycle}: resumed and responsive`);
    }
    return { size, cycles, failure: null };
  } catch (error) {
    return { size, cycles, failure: errorText(error) };
  } finally {
    await Sandbox.kill(sandbox.sandboxId).catch(() => undefined);
  }
}

// Holds `holdMb` of touched anonymous memory plus a headless Chromium, the two
// things a real coding session has resident when its idle timeout pauses it.
async function startMemoryPressure(sandbox: Sandbox, holdMb: number) {
  await sandbox.files.write(
    "/home/user/opencompany-soak-hold.mjs",
    [
      "const mb = Number(process.argv[2]);",
      "const blocks = [];",
      "for (let index = 0; index < mb; index += 1) {",
      "  const block = Buffer.allocUnsafe(1024 * 1024);",
      "  block.fill(index % 251);",
      "  blocks.push(block);",
      "}",
      "process.stdout.write(`held ${blocks.length} MB\\n`);",
      "setInterval(() => blocks[0].fill(1), 30_000);",
    ].join("\n"),
  );
  await sandbox.commands.run(
    `nohup node /home/user/opencompany-soak-hold.mjs ${holdMb} > /tmp/opencompany-soak-hold.log 2>&1 &`,
    { background: true },
  );
  // Playwright is installed globally in the template, so the holder script resolves it
  // through the global module path rather than a per-sandbox install.
  await sandbox.files.write(
    "/home/user/opencompany-soak-chromium.mjs",
    [
      "import { chromium } from 'playwright';",
      "const browser = await chromium.launch({ headless: true });",
      "const page = await browser.newPage();",
      "await page.setContent('<h1>opencompany soak</h1>');",
      "setInterval(() => page.title(), 30_000);",
    ].join("\n"),
  );
  await sandbox.commands.run(
    "NODE_PATH=/usr/local/lib/node_modules nohup node /home/user/opencompany-soak-chromium.mjs > /tmp/opencompany-soak-chromium.log 2>&1 &",
    { background: true },
  );
  // Give both processes time to reach their resident size before the first pause.
  await sandbox.commands.run("sleep 30", { timeoutMs: 60_000, requestTimeoutMs: 60_000 });
}

function isSandboxSize(value: string): value is SandboxSize {
  return value in SANDBOX_SIZE_SPECS;
}

function positiveInteger(raw: string | undefined, fallback: number) {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function fraction(raw: string | undefined, fallback: number) {
  const value = Number.parseFloat(raw ?? "");
  return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

function errorText(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
