import { GoatActionInvalidParamsError } from "../actions/types";

export type ShapedCompanyEmployeesOutput = {
  companyUrl: string;
  filters?: {
    query?: string;
    location?: string;
  };
  employees: Record<string, unknown>[];
};

export function shapeCompanyEmployeesOutput(
  output: unknown,
  params: Record<string, unknown>,
): ShapedCompanyEmployeesOutput {
  const companyUrl = text(params.companyUrl) ?? "the requested LinkedIn company URL";
  const employees = employeeRows(output).map(shapeEmployeeRow).filter(hasUsefulEmployeeData);

  if (employees.length === 0) {
    throw new GoatActionInvalidParamsError(
      `No employees were returned for ${companyUrl}. Verify that companyUrl is the canonical LinkedIn company URL, for example https://www.linkedin.com/company/<company-slug>, and retry with a smaller or broader query.`,
    );
  }

  return compact({
    companyUrl,
    filters: optionalObject(
      compact({
        query: text(params.query),
        location: text(params.location),
      }),
    ),
    employees,
  }) as ShapedCompanyEmployeesOutput;
}

function employeeRows(output: unknown): unknown[] {
  if (Array.isArray(output)) return output;
  const response = record(output);
  if (!response) return [];
  const directRows = rowsFromRecord(response);
  if (directRows) return directRows;
  for (const value of Object.values(response)) {
    const nested = record(value);
    if (!nested) continue;
    const nestedRows = rowsFromRecord(nested);
    if (nestedRows) return nestedRows;
  }
  return [];
}

function rowsFromRecord(response: Record<string, unknown>) {
  for (const key of ["employees", "items", "data", "results", "rows"]) {
    const value = response[key];
    if (Array.isArray(value)) return value;
  }
  const firstArray = Object.values(response).find(Array.isArray);
  return firstArray;
}

function shapeEmployeeRow(value: unknown) {
  const person = record(value);
  if (!person) return {};
  const company = record(person.company) ?? record(person.currentCompany);
  const profileUrl = linkedInPersonUrl(
    firstText(
      person.linkedinUrl,
      person.linkedin_url,
      person.profileUrl,
      person.profile_url,
      person.url,
    ),
  );
  const companyUrl = linkedInCompanyUrl(
    firstText(
      person.companyUrl,
      person.company_url,
      person.companyLinkedinUrl,
      person.company_linkedin_url,
      company?.linkedinUrl,
      company?.linkedin_url,
      company?.url,
    ),
  );

  return compact({
    full_name: firstText(person.fullName, person.full_name, person.name),
    first_name: firstText(person.firstName, person.first_name),
    last_name: firstText(person.lastName, person.last_name),
    job_title: firstText(person.jobTitle, person.job_title, person.title, person.position),
    headline: firstText(person.headline, person.subtitle),
    location: firstText(person.location, person.locationName, person.location_name),
    linkedin_url: profileUrl,
    work_email: firstText(person.workEmail, person.work_email, person.email),
    company_name: firstText(
      person.companyName,
      person.company_name,
      person.currentCompanyName,
      person.current_company_name,
      company?.name,
    ),
    company_linkedin_url: companyUrl,
  });
}

function hasUsefulEmployeeData(value: Record<string, unknown>) {
  return Boolean(value.full_name || value.linkedin_url || value.job_title || value.work_email);
}

function linkedInPersonUrl(value: string | undefined) {
  return linkedInUrl(value, /^\/in\/[^/]+\/?$/);
}

function linkedInCompanyUrl(value: string | undefined) {
  return linkedInUrl(value, /^\/company\/[^/]+\/?$/);
}

function linkedInUrl(value: string | undefined, pathnamePattern: RegExp) {
  if (!value) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (
      (hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com")) ||
      !pathnamePattern.test(url.pathname)
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

function firstText(...values: unknown[]) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function text(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function compact(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function optionalObject(value: Record<string, unknown>) {
  return Object.keys(value).length > 0 ? value : undefined;
}
