"use server";

import { randomUUID } from "node:crypto";
import type { AuthenticationResponse } from "@workos-inc/node";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { completeGoatAuthentication } from "@/lib/auth";
import { isSafeGoatReturnPath, setGoatOAuthStateCookie } from "@/lib/auth-methods";
import { getGoatAppUrl, getGoatWorkOSRedirectUri } from "@/lib/workos";
import { getWorkOSClient } from "@/lib/workos-client";

type GoatAuthActionResult = { ok: true } | { ok: false; error: string };

// authkit-nextjs's getWorkOS() doesn't thread WORKOS_CLIENT_ID down into
// userManagement's per-call default, so calls made directly against the SDK
// (bypassing authkit-nextjs's own sign-in helpers) need it passed explicitly.
const WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? "";

async function getRequestSignals() {
  const headerList = await headers();
  const ipAddress = headerList.get("x-forwarded-for")?.split(",")[0]?.trim();
  const userAgent = headerList.get("user-agent") ?? undefined;
  return {
    ...(ipAddress ? { ipAddress } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

// Bound to a <form action> in AuthCard, so it takes FormData rather than a
// typed object.
export async function startGoogleAuth(formData: FormData) {
  const invitationToken = formData.get("invitationToken");
  const returnPathname = formData.get("returnPathname");

  const state = randomUUID();
  await setGoatOAuthStateCookie({
    state,
    ...(typeof invitationToken === "string" ? { invitationToken } : {}),
    ...(typeof returnPathname === "string" && isSafeGoatReturnPath(returnPathname)
      ? { returnPathname }
      : {}),
  });
  // screenHint (sign-in vs sign-up) only applies to WorkOS's own hosted
  // "authkit" provider picker; Google's authorize screen has no such concept,
  // and WorkOS auto-provisions the user on first Google sign-in either way.
  const url = getWorkOSClient().userManagement.getAuthorizationUrl({
    clientId: WORKOS_CLIENT_ID,
    provider: "GoogleOAuth",
    redirectUri: getGoatWorkOSRedirectUri(),
    state,
  });
  redirect(url);
}

export async function requestMagicCode(input: {
  email: string;
  invitationToken?: string;
}): Promise<GoatAuthActionResult> {
  const email = input.email.trim().toLowerCase();
  if (!email) return { ok: false, error: "Enter your email address." };

  try {
    await getWorkOSClient().userManagement.createMagicAuth({
      email,
      ...(input.invitationToken ? { invitationToken: input.invitationToken } : {}),
    });
    return { ok: true };
  } catch (error) {
    console.error("[goat] Failed to send a magic sign-in code", error);
    return { ok: false, error: "We couldn't send that code. Try again in a moment." };
  }
}

export async function verifyMagicCode(input: {
  email: string;
  code: string;
  invitationToken?: string;
}): Promise<GoatAuthActionResult> {
  const email = input.email.trim().toLowerCase();
  const code = input.code.trim();
  if (!code) return { ok: false, error: "Enter the code from your email." };

  const signals = await getRequestSignals();
  let authResponse: AuthenticationResponse;
  try {
    authResponse = await getWorkOSClient().userManagement.authenticateWithMagicAuth({
      clientId: WORKOS_CLIENT_ID,
      email,
      code,
      ...(input.invitationToken ? { invitationToken: input.invitationToken } : {}),
      ...signals,
    });
  } catch (error) {
    console.error("[goat] Failed to verify a magic sign-in code", error);
    return { ok: false, error: "That code is invalid or expired. Request a new one." };
  }

  await completeGoatAuthentication(authResponse, getGoatAppUrl());
  redirect("/");
}
