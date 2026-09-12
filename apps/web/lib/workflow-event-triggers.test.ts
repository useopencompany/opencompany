import { describe, expect, it } from "vitest";
import {
  workflowEventProviderOptions,
  workflowEventProvidersReady,
} from "./workflow-event-triggers";

type TestPlugin = Parameters<typeof workflowEventProviderOptions>[0]["plugins"][number];

function plugin(overrides: Record<string, unknown> = {}): TestPlugin {
  return {
    name: "granola",
    status: "enabled",
    events: [
      {
        id: "meeting.notes_ready",
        label: "Meeting notes ready",
        description: "Starts once the summary is generated.",
        delivery: "poll",
        filters: [],
      },
    ],
    eventModes: { "meeting.notes_ready": true },
    ...overrides,
  } as unknown as TestPlugin;
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    integrationId: "gint_1",
    connected: true,
    connectionLabel: "ada@example.com",
    ...overrides,
  } as never;
}

const granolaEvents = plugin().events;

describe("workflowEventProviderOptions", () => {
  it("offers only events the workspace switched on", () => {
    const [option] = workflowEventProviderOptions({
      plugins: [
        plugin({
          events: [
            ...granolaEvents,
            {
              id: "meeting.shared",
              label: "Meeting shared",
              description: "Off.",
              delivery: "poll",
              filters: [],
            },
          ],
        }),
      ],
      personalAccounts: { granola: [account()] },
    });

    expect(option?.events.map((event) => event.id)).toEqual(["meeting.notes_ready"]);
    expect(option?.accounts).toEqual([{ integrationId: "gint_1", label: "ada@example.com" }]);
  });

  it("skips a disabled plugin and one with every event off", () => {
    expect(
      workflowEventProviderOptions({
        plugins: [plugin({ status: "disabled" }), plugin({ eventModes: {} })],
        personalAccounts: { granola: [account()] },
      }),
    ).toEqual([]);
  });

  it("routes Granola event accounts to the API key connection, not the MCP plugin page", () => {
    const [option] = workflowEventProviderOptions({
      plugins: [plugin()],
      personalAccounts: {},
    });

    expect(option).toMatchObject({
      accountHref: "/settings/plugins/granola#events",
      accountLabel: "Add a Granola API key",
      accounts: [],
    });
    expect(workflowEventProvidersReady([option!])).toBe(false);
  });

  it("drops a disconnected account so the trigger cannot bind to it", () => {
    const [option] = workflowEventProviderOptions({
      plugins: [plugin()],
      personalAccounts: { granola: [account({ connected: false })] },
    });

    expect(option?.accounts).toEqual([]);
  });
});
