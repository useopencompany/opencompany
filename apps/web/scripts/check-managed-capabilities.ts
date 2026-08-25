import {
  isImageGenerationActionSpec,
  MANAGED_CAPABILITY_ACTIONS,
  managedCapabilityContractProbeParams,
} from "../lib/capabilities/catalog";
import { assertManagedCapabilityInspection } from "../lib/capabilities/contract";
import type { MonidInspection } from "../lib/capabilities/monid";

const apiKey = process.env.MONID_API_KEY?.trim();
if (!apiKey) {
  throw new Error(
    "MONID_API_KEY is required. This opt-in check only inspects contracts and does not run or bill capabilities.",
  );
}

// Keep production releases fail-closed for new contract drift without letting
// pre-existing drift hide the signal from newly reviewed capabilities. Remove
// entries as their catalog contracts are repaired.
const KNOWN_DRIFTED_CONTRACTS = new Map([
  ["lead.get_linkedin_contact", "tikhub:/api/v1/linkedin/web/get_user_contact"],
  ["lead.search_prospects", "pdl:/v5/person/search"],
  ["linkedin.search_posts", "tikhub:/api/v1/linkedin/web/search_posts"],
]);

for (const [actionId, expectedContract] of KNOWN_DRIFTED_CONTRACTS) {
  const action = MANAGED_CAPABILITY_ACTIONS.find((candidate) => candidate.id === actionId);
  const actualContract = action ? `${action.provider}:${action.endpoint}` : null;
  if (actualContract !== expectedContract) {
    throw new Error(`Known drift baseline for ${actionId} is stale and requires review.`);
  }
}

let failed = 0;
let knownDrifted = 0;
const inspections = new Map<string, { response: Response; value: unknown }>();
for (const action of MANAGED_CAPABILITY_ACTIONS) {
  if (isImageGenerationActionSpec(action)) continue;
  const contractKey = `${action.provider}:${action.endpoint}`;
  let inspected = inspections.get(contractKey);
  if (!inspected) {
    const response = await fetch("https://api.monid.ai/v1/inspect", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: action.provider,
        endpoint: action.endpoint,
      }),
    });
    inspected = {
      response,
      value: await response.json().catch(() => null),
    };
    inspections.set(contractKey, inspected);
  }
  try {
    if (!inspected.response.ok || !isRecord(inspected.value) || !isRecord(inspected.value.price)) {
      throw new Error("Malformed inspection response.");
    }
    const price = normalizeInspectionPrice(inspected.value.price);
    assertManagedCapabilityInspection(
      action,
      action.mapInput(managedCapabilityContractProbeParams(action.id)),
      {
        ...inspected.value,
        price,
      } as unknown as MonidInspection,
    );
    if (KNOWN_DRIFTED_CONTRACTS.get(action.id) === contractKey) {
      console.warn(`RESOLVED ${action.id} ${action.provider} ${action.endpoint}: remove baseline.`);
    }
    console.log(`OK   ${action.provider} ${action.endpoint} ${action.priceType}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown contract error.";
    if (KNOWN_DRIFTED_CONTRACTS.get(action.id) === contractKey) {
      knownDrifted += 1;
      console.warn(`KNOWN ${action.id} ${action.provider} ${action.endpoint}: ${reason}`);
      continue;
    }
    failed += 1;
    console.error(`FAIL ${action.id} ${action.provider} ${action.endpoint}: ${reason}`);
  }
}

if (knownDrifted > 0) {
  console.warn(
    `${knownDrifted} known managed capability contract${knownDrifted === 1 ? " remains" : "s remain"} to repair.`,
  );
}

if (failed > 0) {
  throw new Error(`${failed} managed capability contract${failed === 1 ? "" : "s"} drifted.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeInspectionPrice(value: Record<string, unknown>): MonidInspection["price"] {
  const amount = normalizeMoney(value.amount, value.currency);
  const flatFee =
    value.flatFee === undefined ? undefined : normalizeMoney(value.flatFee, value.currency).value;
  return {
    type: typeof value.type === "string" ? value.type : "",
    amount: amount.value,
    currency: amount.currency,
    ...(flatFee === undefined ? {} : { flatFee }),
  };
}

function normalizeMoney(
  value: unknown,
  fallbackCurrency: unknown,
): { value: number; currency: "USD" } {
  const amount = isRecord(value) ? value.value : value;
  const currency = isRecord(value) ? value.currency : fallbackCurrency;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || currency !== "USD") {
    throw new Error("Malformed inspection price.");
  }
  return { value: amount, currency };
}
