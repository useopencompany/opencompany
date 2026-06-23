import { getWorkOS } from "@workos-inc/authkit-nextjs";

export function getWorkOSClient() {
  return getWorkOS();
}

export function getWorkOSRedirectUri() {
  const uri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ?? process.env.WORKOS_REDIRECT_URI;
  if (uri) return uri;
  // Fail loudly in production rather than handing WorkOS a localhost redirect_uri
  // (which would silently break the login flow). The localhost default is dev-only.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "NEXT_PUBLIC_WORKOS_REDIRECT_URI (or WORKOS_REDIRECT_URI) is required in production.",
    );
  }
  return "http://localhost:3000/auth/callback";
}
