#!/usr/bin/env bun
import { hostname } from "node:os";
import { createInterface } from "node:readline";
import { configPath, loadConfig } from "./config";
import { startDaemon } from "./daemon";
import { runPairing } from "./pair";
import { loadSettings, saveSettings, settingsPath } from "./settings";

const HELP = `oc-bridge — lets OpenCompany cloud agents act on this machine, on your terms.

Usage: oc-bridge <command>

Commands:
  pair [--url <web-url>] [--name <device-name>]
        Pair this machine with your workspace. --url defaults to
        $OPENCOMPANY_URL or http://localhost:3000; --name to the hostname.
  start
        Connect to the runner and serve requests (the daemon).
  status
        Show pairing state and permission rule counts.
  trust
        Toggle allow-everything mode (deny rules still apply).
  help
        Show this message.
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "pair": {
      const flags = parseFlags(rest, ["url", "name"]);
      await runPairing({
        apiUrl: flags.url ?? process.env.OPENCOMPANY_URL ?? "http://localhost:3000",
        deviceName: flags.name ?? hostname(),
      });
      return;
    }
    case "start":
      await startDaemon();
      return;
    case "status":
      printStatus();
      return;
    case "trust":
      await toggleTrust();
      return;
    case "help":
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

function parseFlags(argv: string[], known: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const arg = argv[i] ?? "";
    const name = arg.startsWith("--") ? arg.slice(2) : null;
    if (name === null || !known.includes(name)) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Flag --${name} needs a value.`);
    }
    flags[name] = value;
  }
  return flags;
}

function printStatus(): void {
  let config = null;
  try {
    config = loadConfig();
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
  }

  if (config) {
    console.log(`Paired:    yes (${configPath()})`);
    console.log(`Device:    ${config.deviceName} (${config.deviceId})`);
    console.log(`Workspace: ${config.workspaceId}`);
    console.log(`Runner:    ${config.runnerUrl}`);
  } else {
    console.log(`Paired:    no — run \`oc-bridge pair\` (expected config at ${configPath()})`);
  }

  const settings = loadSettings();
  console.log(`Mode:      ${settings.mode}`);
  console.log(
    `Rules:     ${settings.allow.length} allow, ${settings.deny.length} deny (${settingsPath()})`,
  );
}

async function toggleTrust(): Promise<void> {
  const settings = loadSettings();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string) => new Promise<string>((resolve) => rl.question(question, resolve));

  try {
    if (settings.mode === "allow-everything") {
      const answer = (await ask("allow-everything mode is ON. Disable it? (y/n) "))
        .trim()
        .toLowerCase();
      if (answer === "y" || answer === "yes") {
        settings.mode = "ask";
        saveSettings(settings);
        console.log("Mode set to ask — agents will ask before acting.");
      } else {
        console.log("Unchanged.");
      }
      return;
    }

    console.log("This lets cloud agents run ANY command and touch ANY file on this machine");
    console.log("without asking. Deny rules still apply.");
    // Deliberately high-friction: enabling full trust requires typing the phrase.
    const answer = (await ask('Type "allow everything" to enable: ')).trim();
    if (answer === "allow everything") {
      settings.mode = "allow-everything";
      saveSettings(settings);
      console.log("Mode set to allow-everything.");
    } else {
      console.log("Unchanged.");
    }
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[oc-bridge] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
