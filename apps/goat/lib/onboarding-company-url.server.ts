import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

const MAX_REDIRECTS = 5;
const URL_CHECK_TIMEOUT_MS = 8_000;

type LookupAddress = { address: string };
type CompanyUrlResponse = Pick<Response, "status" | "headers" | "body">;

type CompanyUrlVerificationDependencies = {
  lookup?: (hostname: string) => Promise<readonly LookupAddress[]>;
  request?: (url: URL, addresses: readonly LookupAddress[]) => Promise<CompanyUrlResponse>;
};

export async function verifyGoatOnboardingCompanyUrl(
  companyUrl: string,
  dependencies: CompanyUrlVerificationDependencies = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const lookup = dependencies.lookup ?? lookupPublicAddresses;
  const requestUrl = dependencies.request ?? requestPinnedHttpUrl;
  let currentUrl = new URL(companyUrl);

  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const addresses = await publicHttpAddresses(currentUrl, lookup);
      if (!addresses) {
        return { ok: false, error: "Enter a public company URL." };
      }

      // Resolve and validate once, then pin the request to one of those exact
      // addresses. A second, implicit DNS lookup here would allow a hostname to
      // rebind from a public address to an internal service between checks.
      const response = await requestUrl(currentUrl, addresses);

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirectCount === MAX_REDIRECTS) {
          return { ok: false, error: "That company URL redirects too many times." };
        }
        currentUrl = new URL(location, currentUrl);
        continue;
      }

      await response.body?.cancel();
      if (response.status >= 500 || response.status === 404) {
        return { ok: false, error: "We couldn't find a working website at that URL." };
      }
      return { ok: true };
    }
  } catch {
    return { ok: false, error: "We couldn't reach that company URL. Check it and try again." };
  }

  return { ok: false, error: "We couldn't reach that company URL. Check it and try again." };
}

async function lookupPublicAddresses(hostname: string): Promise<readonly LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function publicHttpAddresses(
  url: URL,
  lookup: (hostname: string) => Promise<readonly LookupAddress[]>,
): Promise<readonly LookupAddress[] | null> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) return null;

  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname);
  return addresses.length > 0 && addresses.every(({ address }) => isPublicIpAddress(address))
    ? addresses
    : null;
}

function requestPinnedHttpUrl(
  url: URL,
  addresses: readonly LookupAddress[],
): Promise<CompanyUrlResponse> {
  const address = addresses.find((candidate) => isIP(candidate.address) === 4) ?? addresses[0];
  if (!address) return Promise.reject(new Error("The company URL did not resolve."));
  const family = isIP(address.address);
  if (!family) return Promise.reject(new Error("The company URL resolved to an invalid address."));

  const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, address.address, family);
  };
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: "GET",
        lookup: pinnedLookup,
        signal: AbortSignal.timeout(URL_CHECK_TIMEOUT_MS),
        headers: {
          Accept: "text/html,application/xhtml+xml",
          Range: "bytes=0-0",
          "User-Agent": "OpenCompany onboarding URL verifier",
        },
      },
      (incoming) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const entry of value) headers.append(name, entry);
          } else if (value !== undefined) {
            headers.set(name, value);
          }
        }
        incoming.destroy();
        resolve({ status: incoming.statusCode ?? 500, headers, body: null });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

export function isPublicIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = ipv4FromMappedIpv6(normalized);
    if (mappedIpv4) return isPublicIpAddress(mappedIpv4);
    return !(
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("2001:db8") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  }
  return false;
}

function ipv4FromMappedIpv6(value: string) {
  if (!value.startsWith("::ffff:")) return null;
  const suffix = value.slice("::ffff:".length);
  if (isIP(suffix) === 4) return suffix;
  const parts = suffix.split(":");
  if (parts.length !== 2) return null;
  const high = Number.parseInt(parts[0] ?? "", 16);
  const low = Number.parseInt(parts[1] ?? "", 16);
  if (![high, low].every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)) {
    return null;
  }
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}
