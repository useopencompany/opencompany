// AI SDK retries retryable provider/gateway request failures closest to the model call.
// Keep runner job retries separate: once a turn has streamed output or executed tools,
// replaying the whole job can duplicate side effects.
export const MODEL_CALL_MAX_RETRIES = 2;
