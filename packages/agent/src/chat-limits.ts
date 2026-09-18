export const MAX_BROWSER_CALLS_PER_TURN = 12;
export const MAX_WEB_FETCH_CALLS_PER_TURN = 4;
export const MAX_WEB_SEARCH_CALLS_PER_TURN = 4;
// A turn may fan out to several workflow runs, but each one is a durable, billable Task the user
// has to supervise. Four is the ceiling a person can still read off one assistant message.
export const MAX_WORKFLOW_STARTS_PER_TURN = 4;
