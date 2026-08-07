import {
  asRecord,
  type BrowserToolName,
  buildBrowserToolArgv,
  createBrowserObservationBudget,
  modelFacingBrowserOutput,
  readHttpUrl,
  readOptionalString,
} from "@opencompany/browser-tools";
import type { BrowserToolOutput } from "@opencompany/core/chat-ui";
import { createLogger } from "@opencompany/observability";
import { put } from "@vercel/blob";
import {
  type BrowserProfileAgentSession,
  browserProfilesKilled,
  type ConnectedBrowserProfile,
} from "@/lib/browser-profiles";
import {
  chatScreenshotBlobPath,
  chatScreenshotFilename,
  chatScreenshotUrl,
} from "@/lib/chat-screenshot-storage";
import {
  CHAT_SANDBOX_ACTION_POLICY_PATH,
  CHAT_SANDBOX_AGENT_BROWSER_BIN,
  CHAT_SANDBOX_SCREENSHOT_DIR,
  type ChatSandbox,
  chatSandboxName,
  getChatSandbox,
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
  useProfile(input: { profileId: string }): Promise<BrowserProfileUseOutput>;
  endActiveProfile(): Promise<void>;
  getUsage(): ChatBrowserSandboxUsage | null;
};

export type BrowserProfileUseOutput = {
  ok: boolean;
  profile?: ConnectedBrowserProfile;
  liveViewUrl?: string;
  message?: string;
  error?: string;
};

export function createChatBrowserToolSession(input: {
  chatSessionId: string;
  userWorkosId: string;
  signal: AbortSignal;
  createBrowserProfileAgentSession?: (profileId: string) => Promise<BrowserProfileAgentSession>;
  endBrowserProfileAgentSession?: (session: BrowserProfileAgentSession) => Promise<void>;
}): ChatBrowserToolSession {
  const browserSessionId = chatSandboxName(input.chatSessionId);
  const budget = createBrowserObservationBudget();
  let sandboxPromise: Promise<ChatSandbox> | null = null;
  let sandbox: ChatSandbox | null = null;
  let startedAt: Date | null = null;
  let commandCount = 0;
  let queue = Promise.resolve();
  let activeProfileSession: BrowserProfileAgentSession | null = null;
  let activeProfileEndPromise: Promise<void> | null = null;
  let lastKnownUrl = "";

  const getSandbox = () => {
    startedAt ??= new Date();
    sandboxPromise ??= getChatSandbox({
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

  const useProfile = async ({
    profileId,
  }: {
    profileId: string;
  }): Promise<BrowserProfileUseOutput> => {
    if (!input.createBrowserProfileAgentSession) {
      return {
        ok: false,
        error: "Authenticated browser profiles are not configured.",
      };
    }
    if (activeProfileSession) {
      return {
        ok: false,
        error: `The ${activeProfileSession.profile.name} browser profile is already active.`,
      };
    }
    try {
      activeProfileSession = await input.createBrowserProfileAgentSession(profileId);
      lastKnownUrl = `https://${activeProfileSession.profile.siteHost}/`;
      return {
        ok: true,
        profile: activeProfileSession.profile,
        liveViewUrl: activeProfileSession.liveViewPath,
        message: `Authenticated browser profile active for ${activeProfileSession.profile.siteHost}.`,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Could not start browser profile session.",
      };
    }
  };

  const endActiveProfile = async () => {
    if (!activeProfileSession || !input.endBrowserProfileAgentSession) return;
    if (!activeProfileEndPromise) {
      const session = activeProfileSession;
      activeProfileSession = null;
      activeProfileEndPromise = input
        .endBrowserProfileAgentSession(session)
        .catch((error) => {
          logger.warn("Browser profile session cleanup failed", {
            event: "goat.browser_profile_session_cleanup_failed",
            chat_session_id: input.chatSessionId,
            profile_id: session.profile.id,
            error,
          });
        })
        .finally(() => {
          activeProfileEndPromise = null;
        });
    }
    await activeProfileEndPromise;
  };

  const executeBrowserTool = async ({
    name,
    args,
  }: {
    name: BrowserToolName;
    args: unknown;
  }): Promise<BrowserToolOutput> => {
    const activeSandbox = await getSandbox();
    if (activeProfileSession && browserProfilesKilled()) {
      await endActiveProfile();
      return {
        ok: false,
        command: name,
        error: "Authenticated browser profiles are temporarily disabled.",
      };
    }
    const screenshotFilename = name === "browser_screenshot" ? chatScreenshotFilename() : undefined;
    const screenshotPath = screenshotFilename
      ? `${CHAT_SANDBOX_SCREENSHOT_DIR}/${screenshotFilename}`
      : undefined;
    const commandOutput = await executeBrowserCommand(activeSandbox, {
      name,
      args,
      browserSessionId,
      activeProfileSession,
      lastKnownUrl,
      ...(screenshotPath ? { screenshotPath } : {}),
      signal: input.signal,
      onCommand: () => {
        commandCount += 1;
      },
    });
    if (commandOutput.ok && typeof commandOutput.output === "string") {
      if (name === "browser_open") {
        const record = asRecord(args);
        lastKnownUrl = readOptionalString(record, "url") || lastKnownUrl;
      } else if (name === "browser_get" && readOptionalString(asRecord(args), "target") === "url") {
        lastKnownUrl = commandOutput.output.trim() || lastKnownUrl;
      }
    }

    const modelOutput = modelFacingBrowserOutput({
      name,
      output: commandOutput,
      budget,
    }) as BrowserToolOutput;
    if (name === "browser_close") await endActiveProfile();
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
          chatScreenshotBlobPath({
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
          screenshotUrl: chatScreenshotUrl({
            chatSessionId: input.chatSessionId,
            filename: screenshotFilename,
          }),
        };
      } catch (error) {
        if (input.signal.aborted) throw error;
        logger.warn("Chat browser screenshot storage failed", {
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
        activeProfileSession,
        lastKnownUrl,
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
    useProfile,
    endActiveProfile,
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
  sandbox: ChatSandbox,
  input: {
    name: BrowserToolName;
    args: unknown;
    browserSessionId: string;
    activeProfileSession: BrowserProfileAgentSession | null;
    lastKnownUrl: string;
    screenshotPath?: string;
    signal: AbortSignal;
    onCommand: () => void;
  },
): Promise<BrowserToolOutput> {
  const profile = input.activeProfileSession?.profile;
  if (
    profile &&
    browserActionRequiresIrreversibleApproval(input.name, input.args, input.lastKnownUrl)
  ) {
    return {
      ok: false,
      command: input.name,
      error:
        "This looks like an irreversible browser action. Retry the action with irreversible=true and a user-facing summary so it can be approved first.",
    };
  }
  if (input.name === "browser_read") {
    return executeBrowserRead(sandbox, input);
  }
  const argv = buildBrowserToolArgv({
    name: input.name,
    args: input.args,
    sessionId: input.browserSessionId,
    actionPolicyPath: CHAT_SANDBOX_ACTION_POLICY_PATH,
    ...(input.activeProfileSession
      ? {
          cdpUrl: input.activeProfileSession.connectUrl,
          allowedHosts: input.activeProfileSession.profile.allowedHosts,
        }
      : {}),
    ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {}),
  });
  return runBrowserArgv(sandbox, input.name, argv, input.signal, input.onCommand);
}

async function executeBrowserRead(
  sandbox: ChatSandbox,
  input: {
    args: unknown;
    browserSessionId: string;
    activeProfileSession: BrowserProfileAgentSession | null;
    lastKnownUrl: string;
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
      actionPolicyPath: CHAT_SANDBOX_ACTION_POLICY_PATH,
      ...(input.activeProfileSession
        ? {
            cdpUrl: input.activeProfileSession.connectUrl,
            allowedHosts: input.activeProfileSession.profile.allowedHosts,
          }
        : {}),
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
    actionPolicyPath: CHAT_SANDBOX_ACTION_POLICY_PATH,
    ...(input.activeProfileSession
      ? {
          cdpUrl: input.activeProfileSession.connectUrl,
          allowedHosts: input.activeProfileSession.profile.allowedHosts,
        }
      : {}),
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

function browserActionRequiresIrreversibleApproval(
  name: BrowserToolName,
  args: unknown,
  lastKnownUrl: string,
) {
  if (name !== "browser_click" && name !== "browser_find") return false;
  const record = asRecord(args);
  if (record.irreversible === true) return false;
  if (name === "browser_find" && readOptionalString(record, "action") !== "click") return false;
  return /checkout|payment|billing|order|confirm/i.test(lastKnownUrl);
}

async function runBrowserArgv(
  sandbox: ChatSandbox,
  name: BrowserToolName,
  argv: string[],
  signal: AbortSignal,
  onCommand: () => void,
): Promise<BrowserToolOutput> {
  onCommand();
  const command = await runSandboxCommand(sandbox, {
    cmd: sandbox.image ? "agent-browser" : CHAT_SANDBOX_AGENT_BROWSER_BIN,
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
