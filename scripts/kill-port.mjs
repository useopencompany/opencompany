import { spawnSync } from "node:child_process";
import { argv, exit } from "node:process";

const port = argv[2] || "3000";

if (!/^\d+$/.test(port)) {
  console.error(`Invalid port: ${port}`);
  exit(1);
}

const lsof = spawnSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], {
  encoding: "utf8",
});

if (lsof.error) {
  console.error(lsof.error.message);
  exit(1);
}

if (lsof.status && lsof.status !== 1) {
  process.stderr.write(lsof.stderr);
  exit(lsof.status);
}

const pids = lsof.stdout
  .split(/\s+/)
  .map((pid) => pid.trim())
  .filter(Boolean);

if (pids.length === 0) {
  console.log(`No listener found on port ${port}.`);
  exit(0);
}

for (const pid of pids) {
  try {
    process.kill(Number(pid), "SIGTERM");
    console.log(`Stopped PID ${pid} on port ${port}.`);
  } catch (error) {
    console.error(`Failed to stop PID ${pid}: ${error instanceof Error ? error.message : error}`);
    exit(1);
  }
}
