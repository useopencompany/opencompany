"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type GoatBillingActionResult = { ok: false; error: string } | never;

export async function createGoatCreditTopUpAction(
  amountCents: number,
  idempotencyKey: string = randomUUID(),
): Promise<GoatBillingActionResult> {
  const client = await serverApiClient();
  const response = await client.v1.billing["top-ups"].$post({
    header: { "idempotency-key": idempotencyKey },
    json: { amountCents },
  });
  if (!response.ok) {
    return {
      ok: false,
      error: await serverApiErrorMessage(response, "Could not start the credit top-up checkout."),
    };
  }
  redirect((await response.json()).data.redirectUrl);
}

export async function createGoatProCheckoutAction(
  idempotencyKey: string = randomUUID(),
): Promise<GoatBillingActionResult> {
  const client = await serverApiClient();
  const response = await client.v1.billing["subscription-checkouts"].$post({
    header: { "idempotency-key": idempotencyKey },
  });
  if (!response.ok) {
    return {
      ok: false,
      error: await serverApiErrorMessage(response, "Could not start seat checkout."),
    };
  }
  redirect((await response.json()).data.redirectUrl);
}

export async function setGoatAutoRefillAction(
  input: { enabled: boolean; amountCents: number },
  idempotencyKey: string = randomUUID(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = await serverApiClient();
  const response = await client.v1.billing["auto-refill"].$put({
    header: { "idempotency-key": idempotencyKey },
    json: input,
  });
  if (!response.ok) {
    return {
      ok: false,
      error: await serverApiErrorMessage(response, "Could not update auto-refill."),
    };
  }
  await response.json();
  return { ok: true };
}

export async function createGoatBillingPortalAction(
  idempotencyKey: string = randomUUID(),
): Promise<GoatBillingActionResult> {
  const client = await serverApiClient();
  const response = await client.v1.billing["portal-sessions"].$post({
    header: { "idempotency-key": idempotencyKey },
  });
  if (!response.ok) {
    return {
      ok: false,
      error: await serverApiErrorMessage(response, "Could not open Stripe billing management."),
    };
  }
  redirect((await response.json()).data.redirectUrl);
}
