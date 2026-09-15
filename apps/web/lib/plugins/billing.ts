// Shared by the server action and its client form. A "use server" module may only export async
// functions, so this ceiling cannot live next to the action itself.
export const PLUGIN_DAILY_LIMIT_MAX_USD = 10_000;
