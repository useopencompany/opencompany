// Shared between the server page (reads it to resume) and the client wizard
// (writes it on each step change). Kept in its own module so the client bundle
// doesn't pull in the page's server-only imports.
// Bump the key when the ordered step list changes so a numeric index written by
// an older flow cannot resume on the wrong screen after a deployment.
export const ONBOARDING_STEP_COOKIE = "goat-onboarding-step-v2";
