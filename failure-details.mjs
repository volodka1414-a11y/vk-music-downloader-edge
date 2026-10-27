// Closed diagnostic vocabulary. Never inspect exception messages or include filenames/URLs.
export const failureOperations = new Set(["metadata_initial", "source_read", "cdn_probe", "row_recheck", "filename_build", "download_start", "download_check", "retry_lookup", "recovery", "internal"]);
export const failureConditions = new Set(["DATA_AUDIO_JSON_INVALID", "DATA_AUDIO_PROCESSING_FAILED", "FILENAME_PART_EMPTY", "NO_COMPLETE_CANDIDATE", "INVALID_METADATA_RESULT", "ROW_READ_FAILED", "SOURCE_MISSING", "SOURCE_MASKED", "ID_OR_METADATA_CHANGED", "SOURCE_CHANGED", "DEFERRED_ID_NOT_FOUND", "UNKNOWN"]);
const categories = new Set(["API_REJECTED_UNSPECIFIED", "TYPE_ERROR", "SECURITY_ERROR", "NOT_ALLOWED_ERROR", "ABORT_ERROR", "QUOTA_EXCEEDED_ERROR"]);
export function browserRejectionCategory(error) {
  const names = { TypeError: "TYPE_ERROR", SecurityError: "SECURITY_ERROR", NotAllowedError: "NOT_ALLOWED_ERROR", AbortError: "ABORT_ERROR", QuotaExceededError: "QUOTA_EXCEEDED_ERROR" };
  try { return Object.hasOwn(names, error?.name) ? names[error.name] : "API_REJECTED_UNSPECIFIED"; }
  catch { return "API_REJECTED_UNSPECIFIED"; }
}
export function browserErrorType(error) {
  try {
    if (typeof DOMException !== "undefined" && error instanceof DOMException) return "DOM_EXCEPTION";
    if (error instanceof Error) return "ERROR";
    if (error === null) return "NULL";
    return ({ undefined: "UNDEFINED", string: "STRING", object: "OTHER_OBJECT" })[typeof error] || "OTHER";
  } catch { return "OTHER"; }
}
export function filenameFacts(filename) {
  return { filenameLength: filename.length, filenameUtf8Bytes: new TextEncoder().encode(filename).length,
    filenameNonAscii: /[^\x00-\x7f]/.test(filename), filenameNonBmp: /[\u{10000}-\u{10ffff}]/u.test(filename) };
}
export function safeFailureFields(value = {}) {
  const count = v => Number.isSafeInteger(v) && v >= 0 && v <= 100000 ? v : null;
  return { operation: failureOperations.has(value.operation) ? value.operation : null,
    filenameMode: ["normal", "fallback"].includes(value.filenameMode) ? value.filenameMode : null,
    condition: failureConditions.has(value.condition) ? value.condition : null,
    browserCategory: categories.has(value.browserCategory) ? value.browserCategory : null,
    browserErrorType: ["DOM_EXCEPTION", "ERROR", "NULL", "UNDEFINED", "STRING", "OTHER_OBJECT", "OTHER"].includes(value.browserErrorType) ? value.browserErrorType : null,
    matchingRows: count(value.matchingRows),
    rowConnected: typeof value.rowConnected === "boolean" ? value.rowConnected : null,
    idUsable: typeof value.idUsable === "boolean" ? value.idUsable : null,
    titleUsable: typeof value.titleUsable === "boolean" ? value.titleUsable : null,
    artistUsable: typeof value.artistUsable === "boolean" ? value.artistUsable : null,
    artistPartEmpty: typeof value.artistPartEmpty === "boolean" ? value.artistPartEmpty : null,
    titlePartEmpty: typeof value.titlePartEmpty === "boolean" ? value.titlePartEmpty : null,
    filenameLength: count(value.filenameLength), filenameUtf8Bytes: count(value.filenameUtf8Bytes),
    filenameNonAscii: typeof value.filenameNonAscii === "boolean" ? value.filenameNonAscii : null,
    filenameNonBmp: typeof value.filenameNonBmp === "boolean" ? value.filenameNonBmp : null,
    attempt: Number.isInteger(value.attempt) && value.attempt >= 1 && value.attempt <= 3 ? value.attempt : null };
}
