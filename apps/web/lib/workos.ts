export function getWorkOSRedirectUri() {
  return (
    process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ??
    process.env.WORKOS_REDIRECT_URI ??
    "http://localhost:3000/auth/callback"
  );
}
