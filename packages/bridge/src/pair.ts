import { createHash, randomBytes } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import { configPath, saveConfig } from "./config";
import { appendAllowRule, settingsPath } from "./settings";

// Pairing: the device mints its own secret and only ever sends the hash. The web
// app shows the user a short code; once they confirm it in the browser, polling
// returns the device identity and the daemon can authenticate with the secret.

type PairingStartResponse = {
  requestId: string;
  code: string;
  expiresAt: string;
  pollIntervalMs: number;
  confirmUrl: string;
};

type PairingPollResponse =
  | { status: "pending" }
  | { status: "confirmed"; deviceId: string; workspaceId: string; runnerUrl: string }
  | { status: "expired" };

export async function runPairing(opts: { apiUrl: string; deviceName: string }): Promise<void> {
  const apiUrl = opts.apiUrl.replace(/\/+$/, "");
  const deviceSecret = `dvs_${randomBytes(32).toString("hex")}`;
  const secretHash = createHash("sha256").update(deviceSecret).digest("hex");

  const start = await postJson<PairingStartResponse>(`${apiUrl}/api/bridge/pairing/start`, {
    secretHash,
    deviceName: opts.deviceName,
    platform: process.platform,
  });

  console.log("");
  console.log(`  Pairing code:  ${start.code}`);
  console.log("");
  console.log(`  Confirm in your browser: ${start.confirmUrl}`);
  console.log("");

  const expiresAt = Date.parse(start.expiresAt);

  for (;;) {
    if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
      throw new Error("Pairing expired before it was confirmed. Run `oc-bridge pair` again.");
    }
    await sleep(start.pollIntervalMs);

    const poll = await postJson<PairingPollResponse>(`${apiUrl}/api/bridge/pairing/poll`, {
      requestId: start.requestId,
      secretHash,
    });
    if (poll.status === "pending") {
      continue;
    }
    if (poll.status === "expired") {
      throw new Error("Pairing request expired. Run `oc-bridge pair` again.");
    }

    saveConfig({
      deviceId: poll.deviceId,
      deviceSecret,
      workspaceId: poll.workspaceId,
      deviceName: opts.deviceName,
      apiUrl,
      runnerUrl: poll.runnerUrl,
    });
    console.log(`Paired as ${opts.deviceName} (${poll.deviceId}).`);
    console.log(`Device config written to ${configPath()}.`);
    break;
  }

  await collectInitialGrants();

  console.log("");
  console.log("Start with: oc-bridge start");
}

async function collectInitialGrants(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("");
    // The READ prompt is pre-filled with ~/Projects; clearing it skips the grant.
    const readFolder = (await ask(rl, "Folder agents may READ (empty to skip): ", "~/Projects")).trim();
    const writeFolder = (await ask(rl, "Folder agents may WRITE (empty to skip): ")).trim();

    const added: string[] = [];
    if (readFolder.length > 0) {
      added.push(`read(${stripTrailingSlash(readFolder)}/**)`);
    }
    if (writeFolder.length > 0) {
      added.push(`write(${stripTrailingSlash(writeFolder)}/**)`);
    }
    for (const rule of added) {
      appendAllowRule(rule);
    }

    console.log("");
    if (added.length > 0) {
      console.log(`Added to ${settingsPath()}:`);
      for (const rule of added) {
        console.log(`  allow ${rule}`);
      }
    } else {
      console.log("No initial grants — agents will ask before touching anything.");
    }
  } finally {
    rl.close();
  }
}

function ask(rl: Interface, question: string, prefill?: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
    if (prefill !== undefined) {
      rl.write(prefill);
    }
  });
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${url} failed with status ${response.status}.`);
  }
  return (await response.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
