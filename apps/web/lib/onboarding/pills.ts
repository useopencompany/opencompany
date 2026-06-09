"use server";

import { GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS } from "@opencompany/agent-runtime";
import { createGateway, generateText } from "ai";

// The identity a brand-new user gives us on the first onboarding screen. We use it to tailor the
// example pills on the next screen, and it is also injected (invisibly) into the agent's first
// message so the onboarding skill starts already knowing who it serves.
export type OnboardingContext = {
  name: string;
  website: string;
  role: string;
};

// A fast, cheap model — pills are a low-stakes warm-up, not the agent's real work. Mirrors the
// session-title model the runner already uses through the gateway.
const PILLS_MODEL = "openai/gpt-5.4-mini";
const MAX_PILLS = 4;
const MAX_PILL_LENGTH = 60;

// Shown when we can't (or don't have enough context to) generate tailored pills. Deliberately
// generic but action-oriented so the screen is never empty.
const FALLBACK_PILLS = [
  "Research someone before my next meeting",
  "Draft an email I need to send",
  "Summarize a long document for me",
  "Plan out a project I'm starting",
];

// Generate 3–4 short, tailored "what could you do for me" suggestions for the prompt screen.
// Best-effort: any failure (missing key, model error, empty output) falls back to the static set,
// so the onboarding flow never blocks on this.
export async function generateOnboardingPills(
  context: OnboardingContext,
): Promise<{ pills: string[] }> {
  const apiKey = process.env.VERCEL_AI_GATEWAY_API_KEY;
  if (!apiKey) return { pills: FALLBACK_PILLS };

  const name = context.name.trim();
  const role = context.role.trim();
  const website = context.website.trim();

  // Without a role or a website there's nothing to tailor on — skip the model call.
  if (!role && !website) return { pills: FALLBACK_PILLS };

  const facts = [
    name ? `Name: ${name}` : null,
    role ? `Role: ${role}` : null,
    website ? `Website: ${website}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const gateway = createGateway({ apiKey });
    const result = await generateText({
      model: gateway(PILLS_MODEL),
      system:
        "You write short, concrete example tasks a capable personal AI agent could do for someone, " +
        'phrased in the user\'s own first-person voice ("Research...", "Draft...", "Find..."). ' +
        "Each suggestion must be specific to this person's role and company, easy to say yes to, and " +
        "under 8 words. Avoid generic capabilities and meta phrasing. Return exactly one suggestion " +
        "per line, no numbering, no bullets, no quotes.",
      prompt: `Here is who I am:\n${facts}\n\nGive me ${MAX_PILLS} example tasks I might ask you to do for me today, tailored to my role and what my company does.`,
      maxOutputTokens: 200,
      temperature: 0.7,
      providerOptions: GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS,
    });

    const pills = parsePills(result.text);
    return { pills: pills.length >= 2 ? pills : FALLBACK_PILLS };
  } catch {
    return { pills: FALLBACK_PILLS };
  }
}

function parsePills(text: string): string[] {
  return text
    .split("\n")
    .map((line) =>
      line
        .trim()
        // Strip any leading bullet/number the model may add despite instructions.
        .replace(/^[-*•\d.)\s]+/, "")
        .replace(/^["'`]+|["'`]+$/g, "")
        .trim(),
    )
    .filter((line) => line.length > 0 && line.length <= MAX_PILL_LENGTH)
    .slice(0, MAX_PILLS);
}
