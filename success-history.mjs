export const historyKey = 'vkBatchHistory:v1';
const locks = new WeakMap();
const removedDownloads = new WeakMap();
async function change(api, mutate) {
  const prior = locks.get(api) || Promise.resolve();
  const next = prior.then(async () => {
    const saved = (await api.storage.local.get(historyKey))[historyKey] || {};
    if (mutate(saved)) await api.storage.local.set({ [historyKey]: saved });
  });
  locks.set(api, next.catch(() => {}));
  return next;
}
export function recordSuccess(api, id, entry) {
  return change(api, saved => {
    if (removedDownloads.get(api)?.has(entry.downloadId)) return false;
    if (saved[id]?.downloadId === entry.downloadId) return false;
    saved[id] = { downloadId: entry.downloadId, mime: entry.mime, size: entry.size, completedAt: entry.completedAt,
      ...(entry.fallbackUsed === true ? { fallbackUsed: true } : {}) };
    return true;
  });
}
export function forgetDownload(api, downloadId) {
  let removed = removedDownloads.get(api);
  if (!removed) removedDownloads.set(api, removed = new Set());
  removed.add(downloadId);
  return change(api, saved => { let changed = false; for (const [id, entry] of Object.entries(saved)) if (entry.downloadId === downloadId) { delete saved[id]; changed = true; } return changed; });
}
