import { getWorkOS } from "@workos-inc/authkit-nextjs";

const LOCAL_CALLBACK_PATH = "/auth/callback";
const DEFAULT_LOCAL_ORIGIN = "http://localhost:3000";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function getWorkOSClient() {
  return getWorkOS();
}

function configuredRedirectUri() {
  return (
    process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim() ||
    process.env.WORKOS_REDIRECT_URI?.trim() ||
    `${DEFAULT_LOCAL_ORIGIN}${LOCAL_CALLBACK_PATH}`
  );
}

function requestUrl(request: Request | URL | string) {
  if (request instanceof URL) return request;
  if (typeof request === "string") return new URL(request);
  return new URL(request.url);
}

export function getWorkOSRedirectUri(request?: Request | URL | string) {
  if (!request) return configuredRedirectUri();

  const url = requestUrl(request);
  if (!LOOPBACK_HOSTS.has(url.hostname)) return configuredRedirectUri();

  url.hostname = "localhost";
  url.pathname = LOCAL_CALLBACK_PATH;
  url.search = "";
  url.hash = "";

  return url.toString();
}
