import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  SentryEnvelopeSchema,
  type SentryOccurrence,
  sentryApiBase,
  sentryConditionsMatch,
  sentryEventType,
  sentryRefreshJwt,
  sentryRequest,
  verifySentrySignature,
} from "./sentry";

const issue = { id: "42", title: "Error", project: { id: "1", slug: "web" }, priority: "high" };
const filters = {
  project: { id: "1" },
  priority: { id: "high" },
  environment: { id: "production" },
  tags: {
    id: "exact",
    pairs: [
      { key: "tenant", value: "acme" },
      { key: "region", value: "us" },
    ],
  },
};
afterEach(() => vi.unstubAllEnvs());
it("verifies the exact raw body and rejects malformed or altered signatures", () => {
  const raw = '{ "action": "created" }';
  const signature = createHmac("sha256", "test-secret").update(raw).digest("hex");
  expect(verifySentrySignature(raw, signature, "test-secret")).toBe(true);
  expect(verifySentrySignature(JSON.stringify(JSON.parse(raw)), signature, "test-secret")).toBe(
    false,
  );
  expect(verifySentrySignature(raw, "short", "test-secret")).toBe(false);
  expect(verifySentrySignature(raw, null, "test-secret")).toBe(false);
});
it("routes error creation, true regression and alerts, excluding manual reopening and other categories", () => {
  const envelope = (action: string, issue: Record<string, string> = {}) =>
    SentryEnvelopeSchema.parse({
      action,
      installation: { uuid: "a8e5d37a-696c-4c54-adb5-b3f28d64c7de" },
      data: { issue },
    });
  expect(sentryEventType("issue", envelope("created", { issueCategory: "error" }))).toBe(
    "issue.created",
  );
  expect(sentryEventType("issue", envelope("created", { issueCategory: "outage" }))).toBeNull();
  expect(sentryEventType("issue", envelope("unresolved", { substatus: "regressed" }))).toBe(
    "issue.regressed",
  );
  expect(sentryEventType("issue", envelope("unresolved", { substatus: "ongoing" }))).toBeNull();
  expect(sentryEventType("event_alert", envelope("triggered"))).toBe("issue_alert.triggered");
});
it("requires environment and all exact tags on one occurrence", () => {
  const production: SentryOccurrence = {
    tags: [
      { key: "environment", value: "production" },
      { key: "tenant", value: "acme" },
      { key: "region", value: "us" },
    ],
  };
  expect(sentryConditionsMatch(filters, issue, production)).toBeNull();
  expect(sentryConditionsMatch(filters, issue, { ...production, environment: "staging" })).toBe(
    "conditions not matched: environment",
  );
  expect(
    sentryConditionsMatch(filters, issue, {
      tags: [
        ["environment", "production"],
        ["tenant", "acme-other"],
        ["region", "us"],
      ],
    }),
  ).toBe("conditions not matched: tags");
  expect(
    sentryConditionsMatch(filters, issue, {
      tags: [
        ["environment", "production"],
        ["tenant", "acme"],
      ],
    }),
  ).toBe("conditions not matched: missing tag");
  expect(sentryConditionsMatch(filters, issue, null)).toBe("occurrence context unavailable");
  expect(sentryConditionsMatch(filters, issue, {})).toBe(
    "occurrence context unavailable: environment",
  );
});
it("uses regional data APIs and a one-minute client-secret-signed JWT refresh", () => {
  vi.stubEnv("SENTRY_APP_CLIENT_ID", "test-client");
  vi.stubEnv("SENTRY_APP_CLIENT_SECRET", "test-secret");
  expect(sentryApiBase("eu")).toBe("https://de.sentry.io/api/0/");
  expect(sentryApiBase("us")).toBe("https://us.sentry.io/api/0/");
  const jwt = sentryRefreshJwt(new Date("2026-10-03T12:00:00Z"));
  const [header, payload, signature] = jwt.split(".");
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
  expect(claims).toMatchObject({
    iss: "test-client",
    sub: "test-client",
    iat: 1791028800,
    exp: 1791028860,
  });
  expect(signature).toBe(
    createHmac("sha256", "test-secret").update(`${header}.${payload}`).digest("base64url"),
  );
});

it.each([
  "../organizations/",
  "\\\\evil.example/",
  "https://evil.example/",
  "projects/acme/1/releases/%2E%2E/",
])("rejects unsafe API paths before sending credentials: %s", async (path) => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  try {
    await expect(sentryRequest(path, new URLSearchParams(), "fixture-token")).rejects.toThrow(
      "Invalid Sentry API path",
    );
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
