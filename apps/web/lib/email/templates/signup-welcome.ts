const SIGNUP_WELCOME_SUBJECT = "Welcome to OpenCompany";

function normalizeName(value: string | null | undefined) {
  const next = value?.trim();
  return next || undefined;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderSignupWelcomeEmail(input: { firstName?: string | null | undefined }) {
  const greetingName = normalizeName(input.firstName) ?? "there";
  const greeting = `Hi ${greetingName},`;

  const text = [
    greeting,
    "",
    "Thanks for signing up for OpenCompany.",
    "",
    "I wanted to send a quick personal note: every piece of feedback you submit through the app goes straight to me, and I will move fast on it.",
    "",
    "You can also just reply to this email any time.",
    "",
    "Louis",
  ].join("\n");

  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<body>",
    `<p>${escapeHtml(greeting)}</p>`,
    "<p>Thanks for signing up for OpenCompany.</p>",
    "<p>I wanted to send a quick personal note: every piece of feedback you submit through the app goes straight to me, and I will move fast on it.</p>",
    "<p>You can also just reply to this email any time.</p>",
    "<p>Louis</p>",
    "</body>",
    "</html>",
  ].join("");

  return {
    subject: SIGNUP_WELCOME_SUBJECT,
    text,
    html,
  };
}
