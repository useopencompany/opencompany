// Shared between the server page (reads it to resume) and the client wizard
// (writes it on each step change). Kept in its own module so the client bundle
// doesn't pull in the page's server-only imports.
export const ONBOARDING_STEP_COOKIE = "goat-onboarding-step";
