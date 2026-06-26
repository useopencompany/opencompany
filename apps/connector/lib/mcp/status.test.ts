import { describe, expect, it } from "vitest";
import type { ConnectorLinearMcpSettings } from "./data";
import { describeConnectorLinearStatus } from "./status";

describe("connector MCP status mapping", () => {
  it("shows configured Linear MCP as connected", () => {
    expect(describeConnectorLinearStatus(settings({ configured: true }))).toEqual({
      label: "Connected",
      tone: "success",
      detail: "OAuth credentials are stored for Linear MCP.",
    });
  });

  it("surfaces Linear connection errors", () => {
    expect(
      describeConnectorLinearStatus(
        settings({ status: "error", statusReason: "Token exchange failed." }),
      ),
    ).toEqual({
      label: "Error",
      tone: "error",
      detail: "Token exchange failed.",
    });
  });

  it("distinguishes missing credentials from untouched setup", () => {
    expect(describeConnectorLinearStatus(settings({ status: "missing_credential" }))).toEqual({
      label: "Not connected",
      tone: "warning",
      detail: "Connect Linear before finishing setup.",
    });
    expect(describeConnectorLinearStatus(settings())).toEqual({
      label: "Not connected",
      tone: "muted",
      detail: "Linear MCP has not been configured yet.",
    });
  });
});

function settings(overrides: Partial<ConnectorLinearMcpSettings> = {}): ConnectorLinearMcpSettings {
  return {
    configured: false,
    serverId: null,
    status: null,
    statusReason: null,
    updatedAt: null,
    ...overrides,
  };
}
