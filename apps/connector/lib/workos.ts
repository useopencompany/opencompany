export function getConnectorWorkOSRedirectUri() {
  return (
    process.env.CONNECTOR_WORKOS_REDIRECT_URI ??
    process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ??
    process.env.WORKOS_REDIRECT_URI ??
    "http://localhost:3002/auth/callback"
  );
}
