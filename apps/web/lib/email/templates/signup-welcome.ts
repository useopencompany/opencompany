const SIGNUP_WELCOME_SUBJECT = "Welcome to opencompany";

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

export function renderSignupWelcomeEmail(input: {
  firstName?: string | null | undefined;
  unsubscribeUrl?: string | null | undefined;
}) {
  const greetingName = normalizeName(input.firstName) ?? "there";
  const greeting = `Hi ${greetingName},`;

  const textParts = [
    greeting,
    "",
    "Thanks for signing up for opencompany.",
    "",
    "I wanted to send a quick personal note: every piece of feedback you submit through the app goes straight to me, and I will move fast on it.",
    "",
    "You can also just reply to this email any time.",
    "",
    "Louis",
  ];

  const unsubscribeUrl = input.unsubscribeUrl?.trim();

  if (unsubscribeUrl) {
    textParts.push("", `Unsubscribe: ${unsubscribeUrl}`);
  }

  const htmlParts = [
    "<!doctype html>",
    '<html lang="en">',
    "<body>",
    `<p>${escapeHtml(greeting)}</p>`,
    "<p>Thanks for signing up for opencompany.</p>",
    "<p>I wanted to send a quick personal note: every piece of feedback you submit through the app goes straight to me, and I will move fast on it.</p>",
    "<p>You can also just reply to this email any time.</p>",
    "<p>Louis</p>",
  ];

  if (unsubscribeUrl) {
    htmlParts.push(
      `<p style="color:#666;font-size:12px;margin-top:32px"><a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a></p>`,
    );
  }

  htmlParts.push("</body>", "</html>");

  return {
    subject: SIGNUP_WELCOME_SUBJECT,
    text: textParts.join("\n"),
    html: htmlParts.join(""),
  };
}
