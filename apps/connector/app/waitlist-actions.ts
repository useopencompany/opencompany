"use server";

import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { connectorWaitlistSignups } from "@opencompany/db/schema";

export type WaitlistState =
  | { status: "idle" }
  | { status: "success" }
  | { status: "error"; message: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function joinWaitlist(
  _prevState: WaitlistState,
  formData: FormData,
): Promise<WaitlistState> {
  const raw = formData.get("email");
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";

  if (!email || email.length > 320 || !EMAIL_PATTERN.test(email)) {
    return { status: "error", message: "Enter a valid email address." };
  }

  try {
    const db = getDb();
    await db
      .insert(connectorWaitlistSignups)
      .values({ id: randomUUID(), email })
      .onConflictDoNothing({ target: connectorWaitlistSignups.email });

    return { status: "success" };
  } catch (error) {
    console.error("connector waitlist signup failed", error);
    return { status: "error", message: "Something went wrong. Please try again." };
  }
}
