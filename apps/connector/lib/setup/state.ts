import type { SerializedConnectorOrganization } from "./data";

export type OrganizationActionState = {
  error: string | null;
  organization: SerializedConnectorOrganization | null;
};

export type FinishSetupActionState = {
  error: string | null;
};

export const initialOrganizationActionState: OrganizationActionState = {
  error: null,
  organization: null,
};

export const initialFinishSetupActionState: FinishSetupActionState = {
  error: null,
};

export function setupStatusMessage(searchParams: URLSearchParams) {
  if (searchParams.get("mcp") !== "linear") return null;
  const status = searchParams.get("setup");
  if (status === "connected") return { type: "success" as const, text: "Linear connected." };
  if (status !== "error") return null;

  switch (searchParams.get("reason")) {
    case "invalid_state":
      return { type: "error" as const, text: "Linear returned an invalid setup state." };
    case "session_mismatch":
      return {
        type: "error" as const,
        text: "Linear setup was started from a different session.",
      };
    case "missing_code":
      return { type: "error" as const, text: "Linear did not return an authorization code." };
    case "token_exchange_failed":
      return {
        type: "error" as const,
        text: "Linear authorized the connection, but token exchange failed.",
      };
    case "start_failed":
      return { type: "error" as const, text: "Linear authorization could not start." };
    default:
      return { type: "error" as const, text: "Linear setup was canceled or denied." };
  }
}
