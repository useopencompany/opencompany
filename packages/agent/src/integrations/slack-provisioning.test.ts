import { describe, expect, it, vi } from "vitest";
import { SlackProvisioningError, slackProvisioningRequest } from "./slack-provisioning";

describe("Slack provisioning HTTP boundary", () => {
  it("uses the developer tooling form protocol for authorization and JSON for manifests", async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, ticket: "test" })),
    );
    await slackProvisioningRequest(
      "apps.hosted.generateAuthTicket",
      { no_rotation: true, slack_cli_version: "v4.8" },
      undefined,
      fetcher as typeof fetch,
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toBe(
      "no_rotation=true&slack_cli_version=v4.8",
    );
    await slackProvisioningRequest(
      "apps.manifest.create",
      { manifest: { display_information: { name: "Agent" } } },
      "test-service-token",
      fetcher as typeof fetch,
    );
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Authorization: "Bearer test-service-token",
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  });
  it("treats transport and server failures as unconfirmed and never echoes provider payloads", async () => {
    for (const fetcher of [
      async () => {
        throw new Error("private request payload");
      },
      async () =>
        new Response(JSON.stringify({ ok: false, error: "internal_error" }), { status: 500 }),
      async () => new Response(JSON.stringify({ ok: false, error: "private request payload" })),
    ]) {
      await expect(
        slackProvisioningRequest("apps.manifest.create", {}, undefined, fetcher as typeof fetch),
      ).rejects.toEqual(new SlackProvisioningError("request_unconfirmed"));
    }
  });
  it("preserves a bounded approval error code without exposing descriptions or credentials", async () => {
    await expect(
      slackProvisioningRequest(
        "apps.developerInstall",
        {},
        "test",
        (async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: "app_approval_request_pending",
              description: "private request payload",
            }),
          )) as typeof fetch,
      ),
    ).rejects.toEqual(new SlackProvisioningError("app_approval_request_pending"));
  });
});
