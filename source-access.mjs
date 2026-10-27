import { PrototypeError, checkedCdnUrl, downloadState } from "./core.mjs";
import { sourceDiagnostic, sanitizeDiagnostic } from "./diagnostics.mjs";
import { vkAudioPermission, approvedOrigins, exactSourceHostname } from "./cdn-policy.mjs";
import { approvedExactHosts } from "./source-policy-store.mjs";

export async function ensureSourceAccess(api, raw, stage = "source_permission") {
  const approved = await approvedExactHosts(api), url = checkedCdnUrl(raw, approved);
  let granted;
  try {
    if (!api.permissions?.contains) throw new Error("unavailable");
    granted = await api.permissions.contains({ origins: [`https://${url.hostname}/*`] });
  } catch { throw new PrototypeError("CDN_PERMISSION_CHECK", sanitizeDiagnostic({ ...sourceDiagnostic(raw, approved), stage,
    sourceReason: "PERMISSION_CHECK_FAILED", requestState: "not_sent" })); }
  if (!granted) throw new PrototypeError("CDN_PERMISSION_REQUIRED", sanitizeDiagnostic({ ...sourceDiagnostic(raw, approved), stage,
    sourceReason: "PERMISSION_REQUIRED", requestState: "not_sent" }));
}
export async function downloadStateWithAccess(api, item, job) {
  const approved = await approvedExactHosts(api), result = downloadState(item, job, approved);
  if (result.phase !== "saved") return result;
  const raw = item.finalUrl || item.url;
  try { await ensureSourceAccess(api, raw, "final_source_url"); }
  catch (error) { return { phase: "error", code: error.code === "CDN_PERMISSION_REQUIRED" ? "DOWNLOAD_PERMISSION_REQUIRED" : "DOWNLOAD_PERMISSION_CHECK",
    diagnostic: sanitizeDiagnostic({ ...error.diagnostic, stage: "final_source_url", requestState: "unknown" }) }; }
  return { ...result, diagnostic: sanitizeDiagnostic({ ...sourceDiagnostic(raw, approved), stage: "final_source_url", requestState: "unknown" }) };
}
// Called synchronously by a report-page click handler, before any await.
export function requestApprovedFamily(api, family) {
  if (family !== "vkuseraudio") return Promise.resolve({ granted: false, reason: "FAMILY_NOT_APPROVED" });
  try { return Promise.resolve(api.permissions.request({ origins: [vkAudioPermission] })).then(
    granted => ({ granted: granted === true, reason: granted ? "GRANTED" : "DENIED" }),
    () => ({ granted: false, reason: "REQUEST_FAILED" })); }
  catch { return Promise.resolve({ granted: false, reason: "REQUEST_FAILED" }); }
}
export function requestApprovedSet(api) { return requestOrigins(api, [...approvedOrigins]); }
export function requestSelectedHosts(api, hosts) {
  if (!Array.isArray(hosts) || !hosts.length || hosts.length > 100 || hosts.some(host => !exactSourceHostname(host))) return Promise.resolve({ granted: false, reason: "INVALID_SELECTION" });
  return requestOrigins(api, [...new Set(hosts)].map(host => `https://${host}/*`));
}
function requestOrigins(api, origins) {
  // Only a fixed agreed set or exact validated hostnames: never request https://*/*.
  try { return Promise.resolve(api.permissions.request({ origins })).then(granted => ({ granted: granted === true, reason: granted ? "GRANTED" : "DENIED" }),
    () => ({ granted: false, reason: "REQUEST_FAILED" })); }
  catch { return Promise.resolve({ granted: false, reason: "REQUEST_FAILED" }); }
}
