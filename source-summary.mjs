import { safeSourceFacts, sourceReasons } from "./cdn-policy.mjs";
import { messages } from "./core.mjs";
import { sanitizeDiagnostic } from "./diagnostics.mjs";
import { safeFailureFields } from "./failure-details.mjs";
import { safeInterruptReason } from "./retry-policy.mjs";
const stages = new Set(["source_url", "source_permission", "row_data", "row_recheck", "filename_build", "probe_request", "probe_response", "source_range_policy", "final_source_url", "download_check", "download_request", "internal"]);
export function safeObservation(value = {}, fallbackCode = null) {
  const facts = safeSourceFacts(value);
  const reason = sourceReasons.has(value.reason) || safeInterruptReason(value.reason) || /^HTTP_(502|503|504)$/.test(value.reason) || ["DEFERRED_ID_NOT_FOUND", "RETRY_CANCELLED_BY_STOP"].includes(value.reason) ? value.reason : Object.hasOwn(messages, value.reason) ? value.reason :
    Object.hasOwn(messages, fallbackCode) ? fallbackCode : "UNAVAILABLE";
  const detail = sanitizeDiagnostic(value);
  return { ...facts, ...safeFailureFields(value), reason, stage: stages.has(value.stage) ? value.stage : "internal", status: detail.status, contentType: detail.contentType,
    expectedSize: detail.expectedSize, actualFileSize: detail.actualFileSize, bytesReceived: detail.bytesReceived };
}
export function observeSource(entry, diagnostic, code = null) {
  if (!diagnostic || typeof diagnostic !== "object") return;
  const reason = diagnostic.sourceReason && diagnostic.sourceReason !== "URL_ALLOWED" ? diagnostic.sourceReason : code || "URL_ALLOWED";
  const item = safeObservation({ ...diagnostic, reason });
  entry.sources ||= [];
  if (!entry.sources.some(old => JSON.stringify(old) === JSON.stringify(item))) {
    if (entry.sources.length < 12) entry.sources.push(item); else entry.sourcesTruncated = true;
  }
}
export function summarizeSources(entries) {
  const groups = new Map(); let withoutHostname = 0, missing = 0, truncatedEntries = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.sourcesTruncated) truncatedEntries++;
    if (entry.status === "error" && entry.code === "SOURCE_MISSING") missing++;
    const sources = Array.isArray(entry.sources) ? entry.sources.map(safeObservation) : [];
    if (!sources.some(source => source.hostname)) withoutHostname++;
    for (const source of sources) {
      if (!source.hostname) continue;
      let group = groups.get(source.hostname);
      if (!group) groups.set(source.hostname, group = { hostname: source.hostname, family: source.family, ids: new Set(), unknownIdRecords: new Set(), reasons: new Map(), stages: new Set(), permission: new Set() });
      if (source.family) group.family = source.family;
      const id = typeof entry.id === "string" && /^-?\d+_\d+$/.test(entry.id) ? entry.id : null;
      if (id) group.ids.add(id); else group.unknownIdRecords.add(entry);
      let reasonIds = group.reasons.get(source.reason); if (!reasonIds) group.reasons.set(source.reason, reasonIds = new Set()); if (id) reasonIds.add(id);
      group.stages.add(source.stage);
      if (source.reason === "FAMILY_UNAPPROVED" && source.protocol === "https:" && !source.family) group.permission.add("FAMILY_APPROVAL_REQUIRED");
      if (source.reason === "PERMISSION_REQUIRED") group.permission.add("PERMISSION_REQUIRED");
    }
  }
  return { available: Array.isArray(entries), withoutHostname, sourceMissing: missing, truncatedEntries, hosts: [...groups.values()].map(group => ({ hostname: group.hostname, family: group.family,
    uniqueTracks: group.ids.size, recordsWithoutId: group.unknownIdRecords.size, reasons: [...group.reasons].map(([reason, ids]) => ({ reason, count: ids.size })),
    stages: [...group.stages], waiting: [...group.permission] })).sort((a, b) => a.hostname.localeCompare(b.hostname)) };
}
