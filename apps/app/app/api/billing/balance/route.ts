import {
  ensureMonthlyIncludedUsage,
  isCreditsEnforcementEnabled,
  LOW_BALANCE_WARN_USD_MICROS,
} from "@opencompany/db/billing";
import { getCreditBalanceUsdMicros } from "@opencompany/db/credits";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";

// Light balance read for the chat surface: initial value comes as a server
// prop; the client refetches here after each turn and on a 402.
export async function GET() {
  try {
    const context = await currentUser();
    await ensureMonthlyIncludedUsage(context.workspace.id);
    const balanceUsdMicros = await getCreditBalanceUsdMicros(context.workspace.id);
    return NextResponse.json({
      balanceUsdMicros,
      lowBalanceWarnUsdMicros: LOW_BALANCE_WARN_USD_MICROS,
      enforcementEnabled: isCreditsEnforcementEnabled(),
    });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
