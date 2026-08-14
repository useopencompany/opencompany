#!/usr/bin/env node

// Called by: @opencompany/stripe-webhooks `bun run dev`, usually through the root dev stack.
// Purpose: forwards Stripe CLI webhook events to the web app.

import "./load-env.mjs";
import { spawn } from "node:child_process";

const disabled = process.env.STRIPE_LISTEN_DISABLED === "1";

if (disabled) {
  console.log("Stripe webhook listener disabled with STRIPE_LISTEN_DISABLED=1.");
  process.exit(0);
}

function appOrigin() {
  // Use Next.js directly so the Stripe CLI does not encounter Caddy's local certificate.
  // scripts/dev.mjs exports the branch-isolated web port through the retained OPENCOMPANY_PORT contract.
  return `http://localhost:${process.env.OPENCOMPANY_PORT?.trim() || "3002"}`;
}

const forwardTo = `${appOrigin()}/api/stripe/webhook`;
const events =
  process.env.STRIPE_LISTEN_EVENTS?.trim() ||
  "checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed,payment_intent.succeeded,payment_intent.payment_failed";
const stripeCliProjectName = process.env.STRIPE_CLI_PROJECT_NAME?.trim();
const webhookSecretKey = "OPENCOMPANY_STRIPE_WEBHOOK_SECRET";

if (!process.env[webhookSecretKey]?.trim()) {
  console.warn(
    `${webhookSecretKey} is not set. The web app will reject forwarded Stripe webhooks until .env.local uses the whsec_ value printed by stripe listen.`,
  );
}

console.log(`Forwarding Stripe events (${events}) to ${forwardTo}`);

const args = [
  ...(stripeCliProjectName ? ["--project-name", stripeCliProjectName] : []),
  "listen",
  "--events",
  events,
  "--forward-to",
  forwardTo,
];

const child = spawn("stripe", args, {
  stdio: "inherit",
  env: process.env,
});

child.on("error", (error) => {
  if (error && "code" in error && error.code === "ENOENT") {
    console.error(
      "Stripe CLI is not installed or not on PATH. Install it or run STRIPE_LISTEN_DISABLED=1 bun run dev.",
    );
    process.exit(1);
    return;
  }

  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
