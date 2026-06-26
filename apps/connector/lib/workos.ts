export function getConnectorAppUrl() {
  return (
    process.env.CONNECTOR_APP_URL ??
    process.env.NEXT_PUBLIC_CONNECTOR_APP_URL ??
    "http://localhost:3002"
  ).replace(/\/$/, "");
}

export function getConnectorWorkOSRedirectUri() {
  return (
    process.env.CONNECTOR_WORKOS_REDIRECT_URI ??
    process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ??
    process.env.WORKOS_REDIRECT_URI ??
    `${getConnectorAppUrl()}/auth/callback`
  );
}
