import { slackApiRequest } from "@opencompany/core/integrations/slack";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackBotStatusReporter } from "./status";

vi.mock("@opencompany/core/integrations/slack", () => ({
  slackApiRequest: vi.fn(async () => ({ ok: true, ts: "111.222" })),
}));

type SlackCall = { method: string; form?: Record<string, string> };

function calls(): SlackCall[] {
  return vi.mocked(slackApiRequest).mock.calls.map(([input]) => ({
    method: input.method,
    ...(input.form ? { form: input.form } : {}),
  }));
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const BASE = {
  botToken: "xoxb-token",
  channelId: "C123",
  triggerTs: "1784196000.000100",
  threadTs: "1784196000.000100",
};

describe("createSlackBotStatusReporter", () => {
  beforeEach(() => {
    vi.mocked(slackApiRequest).mockClear();
    vi.mocked(slackApiRequest).mockResolvedValue({ ok: true, ts: "111.222" });
  });

  it("reacts with eyes, posts a status message, and swaps it for the answer", async () => {
    let nowValue = 0;
    const status = createSlackBotStatusReporter({
      ...BASE,
      canReact: true,
      nowMs: () => nowValue,
    });
    await flush();

    status.setPhase("Searching the brain…");
    await flush();
    nowValue = 5000;

    const { replyTs } = await status.finish("*Answer:* everything shipped.");
    expect(replyTs).toBe("111.222");

    const seen = calls();
    expect(seen[0]).toMatchObject({ method: "reactions.add", form: { name: "eyes" } });
    expect(seen[1]).toMatchObject({
      method: "chat.postMessage",
      form: { channel: "C123", thread_ts: BASE.threadTs },
    });
    expect(seen[2]).toMatchObject({
      method: "chat.update",
      form: { ts: "111.222", text: "_Searching the brain…_" },
    });
    expect(seen[3]).toMatchObject({
      method: "chat.update",
      form: { ts: "111.222", text: "*Answer:* everything shipped." },
    });
    expect(seen[4]).toMatchObject({ method: "reactions.remove", form: { name: "eyes" } });
    expect(seen[5]).toMatchObject({
      method: "reactions.add",
      form: { name: "white_check_mark" },
    });
  });

  it("drops phase updates inside the throttle window and repeats of the same phase", async () => {
    let nowValue = 0;
    const status = createSlackBotStatusReporter({
      ...BASE,
      canReact: false,
      nowMs: () => nowValue,
    });
    await flush();

    status.setPhase("Searching the brain…");
    await flush();
    nowValue = 500; // inside the 1.5s window
    status.setPhase("Searching the web…");
    await flush();
    nowValue = 5000;
    status.setPhase("Searching the brain…"); // same as last posted text
    await flush();

    const updates = calls().filter((call) => call.method === "chat.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.form?.text).toBe("_Searching the brain…_");
  });

  it("waits for an in-flight phase update before writing the final answer", async () => {
    let releasePhaseUpdate: (() => void) | undefined;
    const phaseUpdate = new Promise<void>((resolve) => {
      releasePhaseUpdate = resolve;
    });
    vi.mocked(slackApiRequest).mockImplementation(async (input) => {
      if (input.method === "chat.update" && input.form?.text === "_Searching the brain…_") {
        await phaseUpdate;
      }
      return { ok: true, ts: "111.222" };
    });

    const status = createSlackBotStatusReporter({ ...BASE, canReact: false });
    await flush();
    status.setPhase("Searching the brain…");
    await flush();

    const finishPromise = status.finish("final answer");
    await flush();
    expect(
      calls().filter((call) => call.method === "chat.update" && call.form?.text === "final answer"),
    ).toHaveLength(0);

    releasePhaseUpdate?.();
    await finishPromise;
    const updates = calls().filter((call) => call.method === "chat.update");
    expect(updates.map((call) => call.form?.text)).toEqual([
      "_Searching the brain…_",
      "final answer",
    ]);
  });

  it("skips reactions when the install lacks the scope", async () => {
    const status = createSlackBotStatusReporter({ ...BASE, canReact: false });
    await status.finish("done");
    expect(calls().every((call) => !call.method.startsWith("reactions."))).toBe(true);
  });

  it("falls back to a plain reply when the status message never posted", async () => {
    vi.mocked(slackApiRequest).mockRejectedValueOnce(new Error("missing_scope")); // reactions.add
    vi.mocked(slackApiRequest).mockRejectedValueOnce(new Error("channel_not_found")); // postMessage
    vi.mocked(slackApiRequest).mockResolvedValue({ ok: true, ts: "999.111" });

    const status = createSlackBotStatusReporter({ ...BASE, canReact: true });
    await flush();
    const { replyTs } = await status.finish("the answer");

    expect(replyTs).toBe("999.111");
    const posts = calls().filter((call) => call.method === "chat.postMessage");
    expect(posts.at(-1)?.form?.text).toBe("the answer");
  });

  it("marks failures with a warning reaction and an apology update", async () => {
    const status = createSlackBotStatusReporter({ ...BASE, canReact: true });
    await flush();
    await status.fail("Something went wrong.");

    const seen = calls();
    expect(seen.some((call) => call.method === "chat.update")).toBe(true);
    expect(seen.at(-1)).toMatchObject({ method: "reactions.add", form: { name: "warning" } });
  });
});
