export function newAgentSessionId() {
  return `ses_${randomSuffix()}`;
}

export function newAgentSessionMessageId() {
  return `msg_${randomSuffix()}`;
}

export function newAgentSessionMessageAttachmentId() {
  return `att_${randomSuffix()}`;
}

export function newRunLeaseId() {
  return `run_${randomSuffix()}`;
}

// Deterministic id for a goat task's run chat session: creation stays
// idempotent (INSERT ... ON CONFLICT on the primary key) and any surface can
// derive the session link from the task id alone.
export function goatTaskRunSessionId(taskId: string) {
  return `goat_chat_task_${taskId}`;
}

function randomSuffix() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}
