export const retryDelays = Object.freeze([5000, 15000]);
const temporaryInterrupts = new Set(["NETWORK_TIMEOUT", "NETWORK_DISCONNECTED", "NETWORK_SERVER_DOWN"]);
const interruptReasons = new Set(["FILE_FAILED", "FILE_ACCESS_DENIED", "FILE_NO_SPACE", "FILE_NAME_TOO_LONG", "FILE_TOO_LARGE", "FILE_VIRUS_INFECTED",
  "FILE_TRANSIENT_ERROR", "FILE_BLOCKED", "FILE_SECURITY_CHECK_FAILED", "FILE_TOO_SHORT", "FILE_HASH_MISMATCH", "FILE_SAME_AS_SOURCE",
  "NETWORK_FAILED", ...temporaryInterrupts, "NETWORK_INVALID_REQUEST", "SERVER_FAILED", "SERVER_NO_RANGE", "SERVER_BAD_CONTENT", "SERVER_UNAUTHORIZED",
  "SERVER_CERT_PROBLEM", "SERVER_FORBIDDEN", "SERVER_UNREACHABLE", "SERVER_CONTENT_LENGTH_MISMATCH", "SERVER_CROSS_ORIGIN_REDIRECT", "USER_CANCELED", "USER_SHUTDOWN", "CRASH"]);
export const safeInterruptReason = value => interruptReasons.has(value) ? value : null;
export function transientReason(code, diagnostic, item = null) {
  if (code === "HTTP_STATUS" && [502, 503, 504].includes(diagnostic?.status)) return `HTTP_${diagnostic.status}`;
  if (code === "PROBE_TIMEOUT") return "PROBE_TIMEOUT";
  if (code === "DOWNLOAD_INTERRUPTED" && item?.state === "interrupted" && temporaryInterrupts.has(item.error) &&
      !item.paused && (!item.danger || item.danger === "safe" || item.danger === "accepted")) return item.error;
  return null;
}
