const SESSION_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

export function sharedSessionCookieHeaders(input: {
  name: string;
  value: string;
  configuredDomain: string | undefined;
  requestHostname: string;
  apiOrigin: string | undefined;
  secure: boolean;
}) {
  if (!COOKIE_NAME_PATTERN.test(input.name)) {
    throw new Error("WORKOS_COOKIE_NAME is invalid.");
  }
  const domain = normalizedCookieDomain(input.configuredDomain);
  const apiHostname = configuredApiHostname(input.apiOrigin);
  if (
    !hostnameUsesDomain(input.requestHostname, domain) ||
    !hostnameUsesDomain(apiHostname, domain)
  ) {
    throw new Error("WORKOS_COOKIE_DOMAIN must cover the web and canonical API hostnames.");
  }
  const attributes = ["Path=/", "HttpOnly", "SameSite=Lax", input.secure ? "Secure" : ""].filter(
    Boolean,
  );
  return [
    `${input.name}=; ${attributes.join("; ")}; Max-Age=0`,
    `${input.name}=${encodeURIComponent(input.value)}; ${attributes.join("; ")}; ` +
      `Domain=${domain}; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
}

export function hostSessionCookieDeletion(name: string, secure: boolean) {
  if (!COOKIE_NAME_PATTERN.test(name)) throw new Error("WORKOS_COOKIE_NAME is invalid.");
  return {
    name,
    value: "",
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    maxAge: 0,
  };
}

function normalizedCookieDomain(value: string | undefined) {
  const domain = value?.trim().replace(/^\./u, "").toLowerCase();
  if (!domain || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(domain)) {
    throw new Error("WORKOS_COOKIE_DOMAIN must be a registrable DNS domain.");
  }
  return domain;
}

function configuredApiHostname(value: string | undefined) {
  if (!value?.trim()) throw new Error("NEXT_PUBLIC_GOAT_API_ORIGIN is required.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("NEXT_PUBLIC_GOAT_API_ORIGIN must be a valid HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("NEXT_PUBLIC_GOAT_API_ORIGIN must be a valid HTTPS origin.");
  }
  return url.hostname;
}

function hostnameUsesDomain(hostname: string, domain: string) {
  const normalized = hostname.toLowerCase();
  return normalized === domain || normalized.endsWith(`.${domain}`);
}
