import { argv, exit } from "node:process";
import { killPortListeners, normalizePort } from "./lib/port-kill.mjs";

const port = argv[2] || "3000";

try {
  normalizePort(port);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exit(1);
}

try {
  const result = await killPortListeners(port);
  if (result.pids.length === 0) {
    console.log(`No listener found on port ${result.port}.`);
    exit(0);
  }
  const forced =
    result.forcedPids.length > 0 ? ` Force-killed ${result.forcedPids.join(", ")}.` : "";
  console.log(`Stopped PID ${result.pids.join(", ")} on port ${result.port}.${forced}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exit(1);
}
