import {
  ensureGoatMonthlyIncludedUsage,
  GOAT_LOW_BALANCE_WARN_USD_MICROS,
  isGoatCreditsEnforcementEnabled,
} from "@opencompany/db/billing";
import { getGoatCreditBalanceUsdMicros } from "@opencompany/db/credits";
import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";

export const runtime = "nodejs";

// Light balance read for the chat surface: initial value comes as a server
// prop; the client refetches here after each turn and on a 402.
export async function GET() {
  try {
    const context = await currentGoatUser();
    await ensureGoatMonthlyIncludedUsage(context.workspace.id);
    const balanceUsdMicros = await getGoatCreditBalanceUsdMicros(context.workspace.id);
    return NextResponse.json({
      balanceUsdMicros,
      lowBalanceWarnUsdMicros: GOAT_LOW_BALANCE_WARN_USD_MICROS,
      enforcementEnabled: isGoatCreditsEnforcementEnabled(),
    });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
