const MAX_INTEGRATION_STATUS_REASON_LENGTH = 240;

export function sanitizeIntegrationStatusReason(reason: string, fallback: string | null = null) {
  const sanitized = reason
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_INTEGRATION_STATUS_REASON_LENGTH);

  return sanitized || fallback;
}
