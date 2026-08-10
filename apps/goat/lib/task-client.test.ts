import { afterEach, describe, expect, it, vi } from "vitest";
import { continueGoatTask } from "@/lib/task-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("continueGoatTask", () => {
  it("posts continuations to a deployment-stable API route", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, error: null, messageId: "goat_chat_msg_1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      continueGoatTask("TASK-172", "Check again.", "goat_chat_msg_1", [
        { kind: "skill", id: "product-work" },
      ]),
    ).resolves.toEqual({ ok: true, error: null, messageId: "goat_chat_msg_1" });

    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/TASK-172/continue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Check again.",
        clientMessageId: "goat_chat_msg_1",
        mentions: [{ kind: "skill", id: "product-work" }],
      }),
    });
  });

  it("returns a useful fallback when the route response is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not found", { status: 404 })),
    );

    await expect(
      continueGoatTask("goat_task_1", "Check again.", "goat_chat_msg_1"),
    ).resolves.toEqual({
      ok: false,
      error: "Could not continue that task.",
      messageId: null,
    });
  });
});
