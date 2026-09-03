export const GOOGLE_CALENDAR_FULL_SCOPE = "https://www.googleapis.com/auth/calendar";
export const GOOGLE_CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const GOOGLE_CALENDAR_READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const GOOGLE_CALENDAR_LIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist";
export const GOOGLE_CALENDAR_LIST_READ_SCOPE =
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly";

export const GOOGLE_CALENDAR_MCP_RECONNECT_REASON =
  "Reconnect Google Calendar to grant the official plugin's calendar-list and event-management access.";

export function googleCalendarMcpScopesSatisfied(scopes: readonly string[]) {
  const granted = new Set(scopes);
  if (granted.has(GOOGLE_CALENDAR_FULL_SCOPE)) return true;
  const canManageEvents = granted.has(GOOGLE_CALENDAR_EVENTS_SCOPE);
  const canListCalendars =
    granted.has(GOOGLE_CALENDAR_READ_SCOPE) ||
    granted.has(GOOGLE_CALENDAR_LIST_SCOPE) ||
    granted.has(GOOGLE_CALENDAR_LIST_READ_SCOPE);
  return canManageEvents && canListCalendars;
}
