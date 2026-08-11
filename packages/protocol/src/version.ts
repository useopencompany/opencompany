// 1.1.0: additive `message.part_updated` RunEvent, typed `Message.parts` (text/reasoning/tool),
// and a `partId`/`kind` discriminator on `message.presentation_delta`. See ADR 0001 addendum
// "Typed reasoning parts" for the compatibility decision — this is a minor, additive bump: no
// existing field, event type, or route changed shape or was removed.
export const PROTOCOL_VERSION = "1.1.0" as const;
export const API_VERSION = "v1" as const;
export const EVENT_SCHEMA_VERSION = 1 as const;
export const OPENAPI_DOCUMENT_VERSION = "3.1.0" as const;
