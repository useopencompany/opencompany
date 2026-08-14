import { USD_MICROS_PER_DOLLAR } from "@opencompany/billing";
import {
  expirePendingGoatCapabilityApprovals,
  listUnsettledGoatCapabilityRuns,
} from "@opencompany/db/goat-capabilities";
import { GOAT_METRICS, recordGoatHistogram } from "@opencompany/goat-observability";
import { settleManagedCapabilityRun } from "./execute";
import { isTerminalMonidRun, MonidClient, type MonidMoney } from "./monid";

export async function reconcileGoatCapabilities(limit = 100, deps: { db?: any } = {}) {
  const expiredApprovals = await expirePendingGoatCapabilityApprovals({ db: deps.db });
  const apiKey = process.env.MONID_API_KEY?.trim();
  if (!apiKey) {
    return {
      expiredApprovals,
      candidates: 0,
      settled: 0,
      pending: 0,
      failed: 0,
      wallet: null,
    };
  }

  const client = new MonidClient({ apiKey });
  const candidates = await listUnsettledGoatCapabilityRuns({ limit, db: deps.db });
  let settled = 0;
  let pending = 0;
  let failed = 0;
  for (const auditRun of candidates) {
    try {
      const providerRun = await client.getRun(auditRun.monidRunId!);
      if (!isTerminalMonidRun(providerRun.status)) {
        pending += 1;
        continue;
      }
      const contractMismatch =
        providerRun.provider !== auditRun.provider || providerRun.endpoint !== auditRun.endpoint;
      const pendingForcedFailure =
        auditRun.errorCode && auditRun.errorMessage
          ? {
              code: auditRun.errorCode,
              message: auditRun.errorMessage,
            }
          : null;
      const result = await settleManagedCapabilityRun({
        auditRun,
        providerRun,
        db: deps.db,
        ...(contractMismatch
          ? {
              forceFailure: {
                code: "provider_contract_mismatch",
                message: "The paid capability returned a run for a different reviewed endpoint.",
              },
            }
          : pendingForcedFailure
            ? { forceFailure: pendingForcedFailure }
            : {}),
      });
      if (result.totalCostUsdMicros === null) pending += 1;
      else settled += 1;
    } catch {
      failed += 1;
    }
  }

  let wallet: { balance: MonidMoney; held?: MonidMoney } | null = null;
  try {
    wallet = await client.getWalletBalance();
    recordGoatHistogram(
      GOAT_METRICS.capabilityWalletBalanceUsdMicros,
      Math.max(0, Math.round(wallet.balance.value * USD_MICROS_PER_DOLLAR)),
    );
  } catch {
    // Run settlement is independent from wallet observability.
  }
  return {
    expiredApprovals,
    candidates: candidates.length,
    settled,
    pending,
    failed,
    wallet,
  };
}
