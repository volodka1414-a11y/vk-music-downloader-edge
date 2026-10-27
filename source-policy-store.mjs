import { exactSourceHostname, cdnFamily } from "./cdn-policy.mjs";
export const approvedHostsKey = "vkApprovedExactSources:v1";
let activationChain = Promise.resolve();
export async function approvedExactHosts(api) {
  if (!api.storage?.local) return [];
  const value = (await api.storage.local.get(approvedHostsKey))[approvedHostsKey];
  return Array.isArray(value) ? [...new Set(value.filter(host => exactSourceHostname(host) && !cdnFamily(host)))] : [];
}
// Permission is necessary but never sufficient: activation also needs the selected report observation.
export function activateSelectedSources(api, runId, hosts) {
  const result = activationChain.then(() => activate(api, runId, hosts));
  activationChain = result.catch(() => {});
  return result;
}
async function activate(api, runId, hosts) {
  if (!/^[a-f0-9-]{36}$/.test(runId || "") || !Array.isArray(hosts) || !hosts.length || hosts.length > 100 ||
      hosts.some(host => !exactSourceHostname(host) || cdnFamily(host))) return { ok: false, code: "SOURCE_SELECTION_INVALID" };
  const report = (await api.storage.local.get(`vkBatchReport:${runId}`))[`vkBatchReport:${runId}`];
  const previouslyApproved = await approvedExactHosts(api);
  if (!Array.isArray(report?.entries) || hosts.some(host => !report.entries.some(entry => {
    if (entry?.status !== "error" || !Array.isArray(entry.sources)) return false;
    return entry.sources.some(source => source.hostname === host && source.protocol === "https:" &&
      ((entry.code === "SOURCE_HOST" && source.reason === "FAMILY_UNAPPROVED") ||
       (previouslyApproved.includes(host) && ["CDN_PERMISSION_REQUIRED", "DOWNLOAD_PERMISSION_REQUIRED"].includes(entry.code) && source.reason === "PERMISSION_REQUIRED")));
  }))) return { ok: false, code: "SOURCE_SELECTION_INVALID" };
  try { for (const host of hosts) if (!await api.permissions.contains({ origins: [`https://${host}/*`] })) return { ok: false, code: "SOURCE_PERMISSION_REQUIRED" }; }
  catch { return { ok: false, code: "SOURCE_PERMISSION_REQUIRED" }; }
  try { await api.storage.local.set({ [approvedHostsKey]: [...new Set([...(await approvedExactHosts(api)), ...hosts])] }); }
  catch { return { ok: false, code: "BATCH_STORAGE" }; }
  return { ok: true };
}
