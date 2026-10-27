import { numericAccountId } from './account-identity.mjs';

export function accountBinding(value) {
  const accountId = numericAccountId(value?.accountId), libraryOwnerId = numericAccountId(value?.libraryOwnerId);
  return accountId && accountId === libraryOwnerId ? { accountId, libraryOwnerId } : null;
}
export const sameAccount = (a, b) => !!accountBinding(a) && !!accountBinding(b) && a.accountId === b.accountId && a.libraryOwnerId === b.libraryOwnerId;
export function accountPrefix(value) {
  const binding = accountBinding(value); if (!binding) throw Error('ACCOUNT_UNKNOWN');
  return `vkPublicAccount:v1:${binding.accountId}:${binding.libraryOwnerId}:`;
}
export function accountStorageKey(binding, key) {
  const names = { 'vkBatch:v1': 'queue', 'vkBatchHistory:v1': 'history', 'vkSourceRetry:v1': 'retry' };
  if (Object.hasOwn(names, key)) return accountPrefix(binding) + names[key];
  if (/^vkBatchReport:[a-f0-9-]{36}$/.test(key)) return accountPrefix(binding) + 'report:' + key.slice('vkBatchReport:'.length);
  if(key==='vkApprovedExactSources:v1') return key;
  throw Error('ACCOUNT_STORAGE');
}
export function reportLocation(api, binding, runId) {
  const u = new URL(api.runtime.getURL('batch-report.html')); u.searchParams.set('run', runId);
  if (accountBinding(binding)) { u.searchParams.set('account', binding.accountId); u.searchParams.set('library', binding.libraryOwnerId); }
  return u.href;
}
export function scopedAccountApi(api, binding) {
  const owner = accountBinding(binding); if (!owner) throw Error('ACCOUNT_UNKNOWN');
  const prefix = accountPrefix(owner), reverse = key => {
    if (key === prefix + 'queue') return 'vkBatch:v1'; if (key === prefix + 'history') return 'vkBatchHistory:v1';
    if (key === prefix + 'retry') return 'vkSourceRetry:v1';
    if (key.startsWith(prefix + 'report:')) return 'vkBatchReport:' + key.slice((prefix + 'report:').length);
    return key==='vkApprovedExactSources:v1' ? key : null;
  };
  return { ...api, storage: { ...api.storage, local: {
    async get(keys) {
      if (keys === null) { const all = await api.storage.local.get(null), out = {}; for (const [key, value] of Object.entries(all)) { const mapped = reverse(key); if (mapped) out[mapped] = value; } return out; }
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {}; // Individual reads retain compatibility with Chrome and simple local fixtures.
      for (const key of list) { const mapped = accountStorageKey(owner, key); out[key] = (await api.storage.local.get(mapped))[mapped] ?? (typeof keys === 'object' && !Array.isArray(keys) ? keys[key] : undefined); }
      return out;
    },
    async set(values) {
      const out = {}; for (const [key, value] of Object.entries(values)) {
        const tagged = ['vkBatch:v1','vkSourceRetry:v1'].includes(key) || key.startsWith('vkBatchReport:');
        if (tagged && value && value.account && !sameAccount(value.account, owner)) throw Error('ACCOUNT_CONFLICT');
        out[accountStorageKey(owner, key)] = tagged && value ? { ...value, account: owner } : value;
      } await api.storage.local.set(out);
    },
    async remove(keys) { return api.storage.local.remove((Array.isArray(keys) ? keys : [keys]).map(key => accountStorageKey(owner, key))); }
  } } };
}
export async function storedAccounts(api) {
  const all = await api.storage.local.get(null), bindings = new Map();
  for (const key of Object.keys(all)) { const m = /^vkPublicAccount:v1:([1-9]\d*):([1-9]\d*):(?:queue|history)$/.exec(key); if (m) { const b = accountBinding({accountId:m[1],libraryOwnerId:m[2]}); if (b) bindings.set(accountPrefix(b),b); } }
  return [...bindings.values()];
}

const historyInitializations = new Map();
export function ensureAccountHistory(api, value) {
  const binding=accountBinding(value);
  if(!binding) return Promise.reject(new Error('ACCOUNT_UNKNOWN'));
  const key=accountStorageKey(binding,'vkBatchHistory:v1');
  if(historyInitializations.has(key)) return historyInitializations.get(key);
  const task=(async()=>{
    const snapshot=await api.storage.local.get(key);
    if(Object.hasOwn(snapshot,key)) {
      const history=snapshot[key];
      if(!history || typeof history!=='object' || Array.isArray(history)) throw new Error('ACCOUNT_STORAGE');
      return;
    }
    const queueKey=accountStorageKey(binding,'vkBatch:v1');
    const queue=await api.storage.local.get(queueKey);
    if(Object.hasOwn(queue,queueKey) && queue[queueKey]!==null) throw new Error('ACCOUNT_STORAGE');
    await api.storage.local.set({[key]:{}});
    const verified=await api.storage.local.get(key);
    if(!Object.hasOwn(verified,key) || !verified[key] || typeof verified[key]!=='object' || Array.isArray(verified[key]) || Object.keys(verified[key]).length) throw new Error('ACCOUNT_STORAGE');
  })();
  historyInitializations.set(key,task);
  return task.finally(()=>{if(historyInitializations.get(key)===task)historyInitializations.delete(key);});
}
