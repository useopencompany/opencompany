import {
  isImageGenerationActionSpec,
  MANAGED_CAPABILITY_ACTIONS,
  managedCapabilityContractProbeParams,
} from "../lib/capabilities/catalog";
import { assertManagedCapabilityInspection } from "../lib/capabilities/contract";
import type { MonidInspection } from "../lib/capabilities/monid";
import {
  inspectManagedCapability,
  ManagedCapabilityInspectionError,
} from "./managed-capability-inspection";

const apiKey = process.env.MONID_API_KEY?.trim();
if (!apiKey) {
  throw new Error(
    "MONID_API_KEY is required. This opt-in check only inspects contracts and does not run or bill capabilities.",
  );
}

let drifted = 0;
const unavailableContracts = new Set<string>();
const inspections = new Map<string, Promise<MonidInspection>>();
for (const action of MANAGED_CAPABILITY_ACTIONS) {
  if (isImageGenerationActionSpec(action)) continue;
  const contractKey = `${action.provider}:${action.endpoint}`;
  let inspection = inspections.get(contractKey);
  if (!inspection) {
    inspection = inspectManagedCapability({
      apiKey,
      provider: action.provider,
      endpoint: action.endpoint,
    });
    inspections.set(contractKey, inspection);
  }
  try {
    const inspected = await inspection;
    const price = normalizeInspectionPrice(inspected.price as unknown as Record<string, unknown>);
    assertManagedCapabilityInspection(
      action,
      action.mapInput(managedCapabilityContractProbeParams(action.id)),
      {
        ...inspected,
        price,
      } as unknown as MonidInspection,
    );
    console.log(`OK   ${action.provider} ${action.endpoint} ${action.priceType}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown contract error.";
    if (error instanceof ManagedCapabilityInspectionError) {
      if (!unavailableContracts.has(contractKey)) {
        console.error(`ERROR ${action.provider} ${action.endpoint}: ${reason}`);
      }
      unavailableContracts.add(contractKey);
      continue;
    }
    drifted += 1;
    console.error(`FAIL ${action.id} ${action.provider} ${action.endpoint}: ${reason}`);
  }
}

if (unavailableContracts.size > 0) {
  throw new Error(
    `${unavailableContracts.size} managed capability inspection request${
      unavailableContracts.size === 1 ? " was" : "s were"
    } unavailable; contract verification could not complete.`,
  );
}

if (drifted > 0) {
  throw new Error(`${drifted} managed capability contract${drifted === 1 ? "" : "s"} drifted.`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
