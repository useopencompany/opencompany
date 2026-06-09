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

function randomSuffix() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}
