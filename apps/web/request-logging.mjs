// Next's development request logger prints the full URL. OAuth authorization
// codes and signed state belong in neither terminal output nor persisted dev logs.
export const SENSITIVE_CALLBACK_REQUEST_PATTERN =
  /^\/(?:auth\/callback|api\/integrations\/[^/?#]+\/callback)(?:[?#]|$)/;
