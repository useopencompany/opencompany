import { slackApiRequest } from "@/lib/integrations/slack";

// Slack-side lifecycle for one answer: 👀 on the triggering message, a status
// message that updates in place while the agent works, and a final in-place
// swap to the answer (👀 → ✅, or ⚠️ on failure). Everything here is
// best-effort — a missing scope on a stale install or a Slack hiccup degrades
// to the old post-only behavior instead of failing the answer.

const STATUS_UPDATE_MIN_INTERVAL_MS = 1500;
const INITIAL_STATUS_TEXT = "_Working on it…_";

export type SlackBotStatusReporter = {
  setPhase: (text: string) => void;
  finish: (answerText: string) => Promise<{ replyTs: string | null }>;
  fail: (message: string) => Promise<void>;
};

export function createSlackBotStatusReporter(input: {
  botToken: string;
  channelId: string;
  // The user's triggering message (reaction target).
  triggerTs: string;
  // Thread to answer in; null posts flat (DMs).
  threadTs: string | null;
  canReact: boolean;
  nowMs?: () => number;
}): SlackBotStatusReporter {
  const now = input.nowMs ?? Date.now;
  let statusTs: string | null = null;
  // null = no chat.update yet; the first phase replaces "Working on it…"
  // immediately instead of waiting out the throttle window.
  let lastUpdateAt: number | null = null;
  let lastText = INITIAL_STATUS_TEXT;
  let settled = false;

  const call = (method: string, form: Record<string, string>) =>
    slackApiRequest({ method, token: input.botToken, form }).catch((error) => {
      console.error("[goat-slack-bot] Status call failed", {
        method,
        channelId: input.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

  const react = (name: string, action: "add" | "remove") => {
    if (!input.canReact) return Promise.resolve(null);
    return call(`reactions.${action}`, {
      channel: input.channelId,
      timestamp: input.triggerTs,
      name,
    });
  };

  void react("eyes", "add");
  const statusTsPromise = call("chat.postMessage", {
    channel: input.channelId,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    text: INITIAL_STATUS_TEXT,
    unfurl_links: "false",
  }).then((result) => {
    const ts = (result as { ts?: string } | null)?.ts;
    statusTs = typeof ts === "string" ? ts : null;
    // The initial post intentionally does not arm the throttle: the first real
    // phase ("Searching the brain…") should replace "Working on it…" as soon
    // as the agent picks a tool.
    return statusTs;
  });

  // Serializes chat.update calls; phase updates that arrive while one is in
  // flight or inside the throttle window are dropped (never queued) — the next
  // phase change or the final answer supersedes them anyway.
  let updateInFlight = false;
  let latestPhaseUpdate: Promise<unknown> = Promise.resolve();

  const setPhase = (text: string) => {
    const phaseText = `_${text}_`;
    if (settled || updateInFlight || phaseText === lastText) return;
    if (lastUpdateAt !== null && now() - lastUpdateAt < STATUS_UPDATE_MIN_INTERVAL_MS) return;
    updateInFlight = true;
    latestPhaseUpdate = statusTsPromise
      .then((ts) => {
        if (!ts || settled) return null;
        lastText = phaseText;
        lastUpdateAt = now();
        return call("chat.update", { channel: input.channelId, ts, text: phaseText });
      })
      .finally(() => {
        updateInFlight = false;
      });
    void latestPhaseUpdate;
  };

  const settle = async (text: string, reaction: "white_check_mark" | "warning") => {
    settled = true;
    // A phase update may already be in flight. Let it finish before writing the
    // terminal text so a slow Slack response cannot overwrite the final answer.
    await latestPhaseUpdate;
    const ts = await statusTsPromise;
    let replyTs = ts;
    if (ts) {
      await call("chat.update", { channel: input.channelId, ts, text });
    } else {
      // The status message never made it up; fall back to a plain reply so the
      // answer is delivered regardless.
      const posted = await call("chat.postMessage", {
        channel: input.channelId,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
        text,
        unfurl_links: "false",
      });
      const postedTs = (posted as { ts?: string } | null)?.ts;
      replyTs = typeof postedTs === "string" ? postedTs : null;
    }
    await react("eyes", "remove");
    await react(reaction, "add");
    return { replyTs };
  };

  return {
    setPhase,
    finish: (answerText: string) => settle(answerText, "white_check_mark"),
    fail: async (message: string) => {
      await settle(message, "warning");
    },
  };
}
