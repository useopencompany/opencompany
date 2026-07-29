// The shared Goat chat agent loop, tool context, and system prompt — used by
// the interactive chat route, the headless Slack bot, and the runner's task
// executor. Most consumers import the granular subpaths (./chat-agent,
// ./chat-ui, ./prompts, ./actions/*); this barrel re-exports the loop surface.
export * from "./chat-agent";
