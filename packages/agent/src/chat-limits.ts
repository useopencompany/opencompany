export const MAX_BROWSER_CALLS_PER_TURN = 12;
export const MAX_WEB_FETCH_CALLS_PER_TURN = 4;
// A search is cheap and its results are snippets, so the cap only exists to keep a chat turn from
// turning into deep research. Four cut off ordinary multi-part questions, where the model needs a
// query per entity plus a confirming source; ten covers those without reaching task territory.
export const MAX_WEB_SEARCH_CALLS_PER_TURN = 10;
// A turn may fan out to several workflow runs, but each one is a durable, billable Task the user
// has to supervise. Four is the ceiling a person can still read off one assistant message.
export const MAX_WORKFLOW_STARTS_PER_TURN = 4;
