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
// Share of memory still free once dockerd and Chromium are resident. Taking it from
// MemAvailable rather than the tier total puts every size under the same pressure and
// keeps the holder from being OOM-killed before it can be snapshotted.
const MEMORY_OCCUPANCY = fraction(process.env.SOAK_MEMORY_OCCUPANCY, 0.85);
// Mirrors apps/runner/src/sandbox.ts: the same probe command and connect budget the
// runner applies when it resumes a paused session.
const PROBE_COMMAND = "true";
const PROBE_TIMEOUT_MS = 15_000;
const CONNECT_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;
const HOLD_PROCESS_TAG = "opencompany-soak-hold";
const CHROMIUM_PROCESS_TAG = "opencompany-soak-chromium";

const requested = process.argv.slice(2).filter(isSandboxSize);
const sizes: SandboxSize[] =
  requested.length > 0 ? requested : (Object.keys(SANDBOX_SIZE_SPECS) as SandboxSize[]);

const results: SoakResult[] = [];
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

type SoakResult = { size: SandboxSize; cycles: number; failure: string | null };

async function soakSize(size: SandboxSize): Promise<SoakResult> {
  const spec = SANDBOX_SIZE_SPECS[size];
  const alias = codexToolboxTemplateAlias(size);
  console.log(`\n${size}: ${alias} — ${CYCLES} cycles at ${spec.memoryMB} MB`);

  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.create(alias, {
      timeoutMs: SANDBOX_TIMEOUT_MS,
      lifecycle: { onTimeout: "pause", autoResume: true },
    });
  } catch (error) {
    return { size, cycles: 0, failure: `could not spawn ${alias}: ${errorText(error)}` };
  }

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

    const heldMb = await startMemoryPressure(sandbox);
    console.log(`  holding ${heldMb} MB plus a headless Chromium`);

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
      // Both loads must survive the memory-snapshot restore. If the kernel reaped
      // either one, the guest answering afterwards says nothing about a loaded pause.
      const missing = await missingLoads(sandbox);
      if (missing.length > 0) {
        return {
          size,
          cycles,
          failure: `cycle ${cycle} restored without ${missing.join(" and ")}`,
        };
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

// Fills the sandbox with what a real coding session has resident when its idle
// timeout pauses it: touched anonymous memory plus a headless Chromium. Returns the
// megabytes actually pinned so the run reports the pressure it really applied.
async function startMemoryPressure(sandbox: Sandbox) {
  // Playwright is installed globally in the template. CommonJS is deliberate: Node
  // resolves NODE_PATH for `require` but ignores it for ESM `import`.
  await sandbox.files.write(
    `/home/user/${CHROMIUM_PROCESS_TAG}.cjs`,
    [
      "const { chromium } = require('playwright');",
      "chromium.launch({ headless: true }).then(async (browser) => {",
      "  const page = await browser.newPage();",
      "  await page.setContent('<h1>opencompany soak</h1>');",
      "  setInterval(() => { void page.title(); }, 30_000);",
      "});",
    ].join("\n"),
  );
  await sandbox.commands.run(
    `NODE_PATH=/usr/local/lib/node_modules nohup node /home/user/${CHROMIUM_PROCESS_TAG}.cjs > /tmp/${CHROMIUM_PROCESS_TAG}.log 2>&1 &`,
    { background: true },
  );
  // Chromium has to be resident before the free-memory reading, or the holder would
  // claim memory the browser still needs and the kernel would reap one of them.
  await waitForChromium(sandbox);

  const holdMb = await availableMemoryShareMb(sandbox);
  await sandbox.files.write(
    `/home/user/${HOLD_PROCESS_TAG}.cjs`,
    [
      "const mb = Number(process.argv[2]);",
      "const blocks = [];",
      "for (let index = 0; index < mb; index += 1) {",
      "  const block = Buffer.allocUnsafe(1024 * 1024);",
      // Touch every page so the memory is really resident, not just reserved.
      "  block.fill(index % 251);",
      "  blocks.push(block);",
      "}",
      "setInterval(() => blocks[0].fill(1), 30_000);",
    ].join("\n"),
  );
  await sandbox.commands.run(
    `nohup node /home/user/${HOLD_PROCESS_TAG}.cjs ${holdMb} > /tmp/${HOLD_PROCESS_TAG}.log 2>&1 &`,
    { background: true },
  );
  await waitForResidentLoads(sandbox, holdMb);
  return holdMb;
}

async function availableMemoryShareMb(sandbox: Sandbox) {
  const result = await sandbox.commands.run("awk '/MemAvailable/ {print $2}' /proc/meminfo", {
    timeoutMs: PROBE_TIMEOUT_MS,
    requestTimeoutMs: PROBE_TIMEOUT_MS,
  });
  const availableKb = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isInteger(availableKb) || availableKb <= 0) {
    throw new Error("Could not read MemAvailable from the sandbox.");
  }
  return Math.floor((availableKb / 1024) * MEMORY_OCCUPANCY);
}

// The bracket keeps pgrep's own shell command line from matching the pattern, which
// would make every liveness check trivially true.
function bracketPattern(tag: string) {
  return `[${tag[0]}]${tag.slice(1)}`;
}

async function runningProcessCount(sandbox: Sandbox, tag: string) {
  const result = await sandbox.commands.run(`pgrep -c -f "${bracketPattern(tag)}" || true`, {
    timeoutMs: PROBE_TIMEOUT_MS,
    requestTimeoutMs: PROBE_TIMEOUT_MS,
  });
  return Number.parseInt(result.stdout.trim(), 10) || 0;
}

async function missingLoads(sandbox: Sandbox) {
  const missing: string[] = [];
  if ((await runningProcessCount(sandbox, HOLD_PROCESS_TAG)) < 1) missing.push("the memory holder");
  if ((await runningProcessCount(sandbox, CHROMIUM_PROCESS_TAG)) < 1) missing.push("Chromium");
  return missing;
}

async function waitForChromium(sandbox: Sandbox) {
  await waitFor(
    async () => (await runningProcessCount(sandbox, CHROMIUM_PROCESS_TAG)) > 0,
    `Chromium never started; see /tmp/${CHROMIUM_PROCESS_TAG}.log in the sandbox.`,
  );
}

// Waits until the holder has actually faulted its pages in. Process liveness alone
// would pass the moment node starts, long before the guest is under real pressure.
async function waitForResidentLoads(sandbox: Sandbox, holdMb: number) {
  const requiredRssKb = holdMb * 1024 * 0.8;
  await waitFor(
    async () => {
      const missing = await missingLoads(sandbox);
      if (missing.length > 0) return false;
      return (await holderResidentKb(sandbox)) >= requiredRssKb;
    },
    `The memory holder never reached ${Math.round(holdMb * 0.8)} MB resident; see /tmp/${HOLD_PROCESS_TAG}.log in the sandbox.`,
  );
}

async function holderResidentKb(sandbox: Sandbox) {
  const result = await sandbox.commands.run(
    `pgrep -f "${bracketPattern(HOLD_PROCESS_TAG)}" | xargs -r ps -o rss= -p | sort -n | tail -1`,
    { timeoutMs: PROBE_TIMEOUT_MS, requestTimeoutMs: PROBE_TIMEOUT_MS },
  );
  return Number.parseInt(result.stdout.trim(), 10) || 0;
}

async function waitFor(condition: () => Promise<boolean>, failureMessage: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(failureMessage);
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
