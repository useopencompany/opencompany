import { POST as legacyPost } from "@/lib/legacy-chat-route";

// Compatibility endpoint for deployments that roll back the canonical browser flag. The model
// loop lives outside the route boundary so /api/chat can be removed after the rollout window.
export const maxDuration = 800;
export const runtime = "nodejs";

export const POST = legacyPost;
