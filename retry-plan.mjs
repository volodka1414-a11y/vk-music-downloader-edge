import { cdnFamily } from "./cdn-policy.mjs";
import { ensureSourceAccess } from "./source-access.mjs";
import { approvedExactHosts } from "./source-policy-store.mjs";
import { exactSourceHostname } from "./cdn-policy.mjs";
export const retryPlanKey = "vkSourceRetry:v1";
const text = value => typeof value === "string" ? value.replace(/https?:\/\/\S+/gi, "[ссылка скрыта]").replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0, 500) : "";
export async function readRetryPlan(api) {
  const plan = (await api.storage.local.get(retryPlanKey))[retryPlanKey];
  const approved = await approvedExactHosts(api);
  if (!/^[a-f0-9-]{36}$/.test(plan?.id || "") || !Array.isArray(plan.hosts) || !plan.hosts.length ||
      plan.hosts.some(host => !exactSourceHostname(host) || (!cdnFamily(host) && !approved.includes(host))) ||
      !Array.isArray(plan.entries) || !plan.entries.length || plan.entries.some(entry => !/^-?\d+_\d+$/.test(entry?.id || ""))) return null;
  return { id: plan.id, hosts: [...new Set(plan.hosts)], entries: plan.entries.map(entry => ({ id: entry.id, title: text(entry.title), artist: text(entry.artist) })) };
}
export async function prepareSourceRetry(api, runId, hosts, uuid = () => crypto.randomUUID()) {
  const approved = await approvedExactHosts(api);
  if (!/^[a-f0-9-]{36}$/.test(runId || "") || !Array.isArray(hosts) || !hosts.length || hosts.length > 2000 ||
      hosts.some(host => !exactSourceHostname(host) || (!cdnFamily(host) && !approved.includes(host)))) return { ok: false, code: "RETRY_SOURCE_INVALID" };
  const selected = new Set(hosts), report = (await api.storage.local.get(`vkBatchReport:${runId}`))[`vkBatchReport:${runId}`];
  if (!Array.isArray(report?.entries)) return { ok: false, code: "RETRY_REPORT_UNAVAILABLE" };
  const entries = new Map();
  for (const entry of report.entries) {
    if (entry?.status !== "error" || !["CDN_PERMISSION_REQUIRED", "DOWNLOAD_PERMISSION_REQUIRED", "SOURCE_HOST"].includes(entry.code) || !/^-?\d+_\d+$/.test(entry.id || "")) continue;
    const matched = Array.isArray(entry.sources) && entry.sources.some(source => {
      if (!selected.has(source.hostname)) return false;
      return entry.code === "SOURCE_HOST" ? source.reason === "FAMILY_UNAPPROVED" && source.protocol === "https:" : source.reason === "PERMISSION_REQUIRED";
    });
    if (!matched) continue;
    entries.set(entry.id, { id: entry.id, title: text(entry.title), artist: text(entry.artist) });
  }
  if (!entries.size) return { ok: false, code: "RETRY_NO_MATCHES" };
  try { for (const host of selected) await ensureSourceAccess(api, `https://${host}/`); }
  catch { return { ok: false, code: "RETRY_PERMISSION_REQUIRED" }; }
  const plan = { id: uuid(), fromRunId: runId, hosts: [...selected], entries: [...entries.values()], createdAt: Date.now() };
  try { await api.storage.local.set({ [retryPlanKey]: plan }); }
  catch { return { ok: false, code: "BATCH_STORAGE" }; }
  return { ok: true, retryPlan: { id: plan.id, count: plan.entries.length } };
}
