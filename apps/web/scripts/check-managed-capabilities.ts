import {
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

let failed = 0;
const inspections = new Map<string, { response: Response; value: unknown }>();
for (const action of MANAGED_CAPABILITY_ACTIONS) {
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
    console.log(`OK   ${action.provider} ${action.endpoint} ${action.priceType}`);
  } catch {
    failed += 1;
    console.error(`FAIL ${action.provider} ${action.endpoint}`);
  }
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
