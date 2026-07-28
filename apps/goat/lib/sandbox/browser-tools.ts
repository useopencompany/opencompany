import {
  asRecord,
  type BrowserToolName,
  buildBrowserToolArgv,
  createBrowserObservationBudget,
  modelFacingBrowserOutput,
  readHttpUrl,
  readOptionalString,
} from "@opencompany/browser-tools";
import { createLogger } from "@opencompany/observability";
import { put } from "@vercel/blob";
import {
  goatChatScreenshotBlobPath,
  goatChatScreenshotFilename,
  goatChatScreenshotUrl,
} from "@/lib/chat-screenshot-storage";
import type { BrowserToolOutput } from "@/lib/chat-ui";
import {
  GOAT_CHAT_SANDBOX_ACTION_POLICY_PATH,
  GOAT_CHAT_SANDBOX_AGENT_BROWSER_BIN,
  GOAT_CHAT_SANDBOX_SCREENSHOT_DIR,
  type GoatChatSandbox,
  getGoatChatSandbox,
  goatChatSandboxName,
  runSandboxCommand,
  sandboxBrowserEnvironment,
} from "./chat-sandbox";

const BROWSER_COMMAND_TIMEOUT_MS = 120_000;
const logger = createLogger({
  service: "opencompany-goat",
  runtime: "goat-chat-browser",
});
const AUTO_SNAPSHOT_TOOLS = new Set<BrowserToolName>([
  "browser_open",
  "browser_click",
  "browser_fill",
  "browser_find",
]);

export type ChatBrowserSandboxUsage = {
  sandboxId: string;
  sandboxName: string;
  startedAt: Date;
  endedAt: Date;
  activeMs: number;
  rawMetrics: Record<string, unknown>;
};

export type ChatBrowserToolSession = {
  execute(input: { name: BrowserToolName; args: unknown }): Promise<BrowserToolOutput>;
  getUsage(): ChatBrowserSandboxUsage | null;
};

export function createChatBrowserToolSession(input: {
  chatSessionId: string;
  userWorkosId: string;
  signal: AbortSignal;
}): ChatBrowserToolSession {
  const browserSessionId = goatChatSandboxName(input.chatSessionId);
  const budget = createBrowserObservationBudget();
  let sandboxPromise: Promise<GoatChatSandbox> | null = null;
  let sandbox: GoatChatSandbox | null = null;
  let startedAt: Date | null = null;
  let commandCount = 0;
  let queue = Promise.resolve();

  const getSandbox = () => {
    startedAt ??= new Date();
    sandboxPromise ??= getGoatChatSandbox({
      chatSessionId: input.chatSessionId,
      signal: input.signal,
    }).then((value) => {
      sandbox = value;
      return value;
    });
    return sandboxPromise;
  };

  const execute = (toolInput: { name: BrowserToolName; args: unknown }) => {
    const pending = queue.then(
      () => executeBrowserTool(toolInput),
      () => executeBrowserTool(toolInput),
    );
    queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  const executeBrowserTool = async ({
    name,
    args,
  }: {
    name: BrowserToolName;
    args: unknown;
  }): Promise<BrowserToolOutput> => {
    const activeSandbox = await getSandbox();
    const screenshotFilename =
      name === "browser_screenshot" ? goatChatScreenshotFilename() : undefined;
    const screenshotPath = screenshotFilename
      ? `${GOAT_CHAT_SANDBOX_SCREENSHOT_DIR}/${screenshotFilename}`
      : undefined;
    const commandOutput = await executeBrowserCommand(activeSandbox, {
      name,
      args,
      browserSessionId,
      ...(screenshotPath ? { screenshotPath } : {}),
      signal: input.signal,
      onCommand: () => {
        commandCount += 1;
      },
    });

    const modelOutput = modelFacingBrowserOutput({
      name,
      output: commandOutput,
      budget,
    }) as BrowserToolOutput;
    if (!commandOutput.ok) return modelOutput;

    if (name === "browser_screenshot" && screenshotFilename && screenshotPath) {
      try {
        const bytes = await activeSandbox.readFileToBuffer(
          { path: screenshotPath },
          { signal: input.signal },
        );
        if (!bytes) {
          return {
            ...modelOutput,
            ok: false,
            error: "The browser created no screenshot file.",
          };
        }
        await put(
          goatChatScreenshotBlobPath({
            userWorkosId: input.userWorkosId,
            chatSessionId: input.chatSessionId,
            filename: screenshotFilename,
          }),
          bytes,
          {
            access: "private",
            addRandomSuffix: false,
            contentType: "image/png",
          },
        );
        return {
          ...modelOutput,
          screenshotUrl: goatChatScreenshotUrl({
            chatSessionId: input.chatSessionId,
            filename: screenshotFilename,
          }),
        };
      } catch (error) {
        if (input.signal.aborted) throw error;
        logger.warn("Goat chat browser screenshot storage failed", {
          event: "goat.chat_browser_screenshot_storage_failed",
          chat_session_id: input.chatSessionId,
          error,
        });
        return {
          ...modelOutput,
          ok: false,
          error: "The screenshot was captured but could not be stored.",
        };
      }
    }

    if (AUTO_SNAPSHOT_TOOLS.has(name)) {
      const snapshotOutput = await executeBrowserCommand(activeSandbox, {
        name: "browser_snapshot",
        args: {},
        browserSessionId,
        signal: input.signal,
        onCommand: () => {
          commandCount += 1;
        },
      });
      const modelSnapshot = modelFacingBrowserOutput({
        name: "browser_snapshot",
        output: snapshotOutput,
        budget,
      });
      return {
        ...modelOutput,
        snapshot: modelSnapshot,
      };
    }

    return modelOutput;
  };

  return {
    execute,
    getUsage: () => {
      if (!sandbox || !startedAt) return null;
      const endedAt = new Date();
      const session = sandbox.currentSession();
      return {
        sandboxId: session.sessionId,
        sandboxName: sandbox.name,
        startedAt,
        endedAt,
        activeMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
        rawMetrics: {
          commandCount,
          runtime: sandbox.runtime,
          image: sandbox.image,
          region: sandbox.region,
          vcpus: sandbox.vcpus,
          memoryMib: sandbox.memory,
          sessionStatus: sandbox.status,
          totalEgressBytes: sandbox.totalEgressBytes,
          totalIngressBytes: sandbox.totalIngressBytes,
          totalActiveCpuDurationMs: sandbox.totalActiveCpuDurationMs,
          totalDurationMs: sandbox.totalDurationMs,
          browserObservation: {
            cumulativeOutputChars: budget.cumulativeOutputChars,
            largestOutputChars: budget.largestOutputChars,
            snapshotCount: budget.snapshotCount,
          },
        },
      };
    },
  };
}

async function executeBrowserCommand(
  sandbox: GoatChatSandbox,
  input: {
    name: BrowserToolName;
    args: unknown;
    browserSessionId: string;
    screenshotPath?: string;
    signal: AbortSignal;
    onCommand: () => void;
  },
): Promise<BrowserToolOutput> {
  if (input.name === "browser_read") {
    return executeBrowserRead(sandbox, input);
  }
  const argv = buildBrowserToolArgv({
    name: input.name,
    args: input.args,
    sessionId: input.browserSessionId,
    actionPolicyPath: GOAT_CHAT_SANDBOX_ACTION_POLICY_PATH,
    ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {}),
  });
  return runBrowserArgv(sandbox, input.name, argv, input.signal, input.onCommand);
}

async function executeBrowserRead(
  sandbox: GoatChatSandbox,
  input: {
    args: unknown;
    browserSessionId: string;
    signal: AbortSignal;
    onCommand: () => void;
  },
) {
  const record = asRecord(input.args);
  const url = readOptionalString(record, "url");
  if (url) {
    const openArgv = buildBrowserToolArgv({
      name: "browser_open",
      args: { url: readHttpUrl(record, "url", "browser_read url") },
      sessionId: input.browserSessionId,
      actionPolicyPath: GOAT_CHAT_SANDBOX_ACTION_POLICY_PATH,
    });
    const opened = await runBrowserArgv(
      sandbox,
      "browser_read",
      openArgv,
      input.signal,
      input.onCommand,
    );
    if (!opened.ok) return opened;
  }

  const readArgv = buildBrowserToolArgv({
    name: "browser_read",
    args: input.args,
    sessionId: input.browserSessionId,
    actionPolicyPath: GOAT_CHAT_SANDBOX_ACTION_POLICY_PATH,
  });
  const output = await runBrowserArgv(
    sandbox,
    "browser_read",
    readArgv,
    input.signal,
    input.onCommand,
  );
  if (!output.ok || typeof output.output !== "string") return output;
  const filter = readOptionalString(record, "filter");
  if (!filter) return output;
  return {
    ...output,
    output: output.output
      .split("\n")
      .filter((line) => line.toLowerCase().includes(filter.toLowerCase()))
      .join("\n"),
  };
}

async function runBrowserArgv(
  sandbox: GoatChatSandbox,
  name: BrowserToolName,
  argv: string[],
  signal: AbortSignal,
  onCommand: () => void,
): Promise<BrowserToolOutput> {
  onCommand();
  const command = await runSandboxCommand(sandbox, {
    cmd: sandbox.image ? "agent-browser" : GOAT_CHAT_SANDBOX_AGENT_BROWSER_BIN,
    args: argv,
    signal,
    timeoutMs: BROWSER_COMMAND_TIMEOUT_MS,
    env: sandboxBrowserEnvironment(),
  });
  return {
    ok: command.ok,
    command: name,
    ...(command.stdout ? { output: command.stdout } : {}),
    ...(command.stderr ? { stderr: command.stderr } : {}),
    ...(command.error ? { error: command.error } : {}),
  };
}
