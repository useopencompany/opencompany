import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isObservabilityProbeAuthorized } from "@/lib/observability-probe";

export const dynamic = "force-dynamic";

export default async function ServerErrorObservabilityProbe() {
  const requestHeaders = await headers();
  if (
    !isObservabilityProbeAuthorized(requestHeaders.get("authorization"), process.env.CRON_SECRET)
  ) {
    notFound();
  }

  const error = new Error("Authenticated production server-render error capture probe.");
  error.name = "ObservabilityVerificationError";
  throw error;
}
