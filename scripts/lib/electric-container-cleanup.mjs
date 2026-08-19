import { spawnSync } from "node:child_process";

export const ELECTRIC_CONTAINER_LABEL = "dev.opencompany.service";
export const ELECTRIC_CONTAINER_LABEL_VALUE = "electric";

const LEGACY_ELECTRIC_CONTAINER_NAME = /^opencompany-electric(?:-\d+)?$/u;

export function electricContainerNamesFromDockerList(output) {
  const names = new Set();

  for (const line of output.split("\n")) {
    const [name, serviceLabel = ""] = line.trim().split("\t");
    if (!name) continue;
    if (
      serviceLabel === ELECTRIC_CONTAINER_LABEL_VALUE ||
      LEGACY_ELECTRIC_CONTAINER_NAME.test(name)
    ) {
      names.add(name);
    }
  }

  return [...names].sort();
}

export function cleanupOutdatedElectricContainers({ spawn = spawnSync } = {}) {
  const listed = spawn(
    "docker",
    ["ps", "-a", "--format", `{{.Names}}\t{{.Label \"${ELECTRIC_CONTAINER_LABEL}\"}}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 },
  );

  if (listed.error?.code === "ENOENT" || listed.status !== 0) {
    return { status: "unavailable", containers: [] };
  }

  const containers = electricContainerNamesFromDockerList(listed.stdout ?? "");
  if (containers.length === 0) return { status: "empty", containers };

  const removed = spawn("docker", ["rm", "-f", ...containers], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });

  if (removed.status !== 0) {
    return {
      status: "failed",
      containers,
      reason:
        removed.stderr?.trim() ||
        removed.error?.message ||
        `docker rm exited with ${removed.status}`,
    };
  }

  return { status: "removed", containers };
}
