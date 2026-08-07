const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function shapePdlPersonEmailOutput(output: unknown) {
  const response = requiredRecord(output);
  const person = record(response.data) ?? response;
  const workEmail = text(person.work_email);
  if (!workEmail || !EMAIL_PATTERN.test(workEmail)) {
    throw new Error("PDL person enrichment did not return a valid work email.");
  }

  return compact({
    work_email: workEmail,
    full_name: text(person.full_name),
    job_title: text(person.job_title),
    job_title_levels: textList(person.job_title_levels),
    job_company_name: text(person.job_company_name),
    location_name: text(person.location_name),
    linkedin_url: linkedInUrl(person.linkedin_url),
    likelihood: likelihood(response.likelihood ?? person.likelihood),
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredRecord(value: unknown) {
  const parsed = record(value);
  if (!parsed) throw new Error("PDL person enrichment returned a malformed response.");
  return parsed;
}

function text(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function textList(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const values = value.flatMap((entry) => {
    const normalized = text(entry);
    return normalized ? [normalized] : [];
  });
  return values.length > 0 ? [...new Set(values)].slice(0, 10) : undefined;
}

function likelihood(value: unknown) {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 10
    ? (value as number)
    : undefined;
}

function linkedInUrl(value: unknown) {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (
      (hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com")) ||
      !/^\/in\/[^/]+\/?$/.test(url.pathname)
    ) {
      return undefined;
    }
    url.protocol = "https:";
    url.hostname = "www.linkedin.com";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function compact(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
