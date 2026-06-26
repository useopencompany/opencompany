import type { ConnectorLinearMcpSettings } from "./data";

export type ConnectorConnectionTone = "success" | "warning" | "error" | "muted";

export type ConnectorConnectionStatus = {
  label: string;
  tone: ConnectorConnectionTone;
  detail: string;
};

export function describeConnectorLinearStatus(
  settings: ConnectorLinearMcpSettings,
): ConnectorConnectionStatus {
  if (settings.configured) {
    return {
      label: "Connected",
      tone: "success",
      detail: "OAuth credentials are stored for Linear MCP.",
    };
  }

  if (settings.status === "error") {
    return {
      label: "Error",
      tone: "error",
      detail: settings.statusReason ?? "Linear MCP connection needs attention.",
    };
  }

  if (settings.status === "missing_credential") {
    return {
      label: "Not connected",
      tone: "warning",
      detail: settings.statusReason ?? "Connect Linear before finishing setup.",
    };
  }

  return {
    label: "Not connected",
    tone: "muted",
    detail: "Linear MCP has not been configured yet.",
  };
}
