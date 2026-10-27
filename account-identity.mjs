// Shared account admission: data descriptors only, no network or accessor calls.
export function accountCandidatePage() {
  let stage = 'PAGE_SCOPE', libraryOwnerId = null, valueType = null;
  const output = status => ({ source: 'window.vk.id', status, stage, candidateId: null, libraryOwnerId, valueType });
  const id = v => {
    if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? String(v) : null;
    if (typeof v !== 'string' || !/^[1-9]\d{0,15}$/.test(v)) return null;
    const n = Number(v); return Number.isSafeInteger(n) && String(n) === v ? v : null;
  };
  try {
    const href = location.href, page = new URL(href);
    if (page.origin !== 'https://vk.ru') return output('PAGE_SCOPE');
    const match = /^\/audios([^/]*)\/?$/.exec(page.pathname);
    if (!match) return output('NOT_LIBRARY_ROUTE');
    libraryOwnerId = id(match[1]);
    if (!libraryOwnerId) return output('LIBRARY_ID_INVALID');
    stage = 'VK_DESCRIPTOR';
    const vkDescriptor = Object.getOwnPropertyDescriptor(window, 'vk');
    if (!vkDescriptor) return output('VK_OWN_PROPERTY_MISSING');
    if (!Object.hasOwn(vkDescriptor, 'value')) return output('VK_ACCESSOR_SKIPPED');
    const vk = vkDescriptor.value;
    if (vk === null || typeof vk !== 'object' || Array.isArray(vk)) return output('VK_VALUE_INVALID');
    stage = 'ID_DESCRIPTOR';
    const descriptor = Object.getOwnPropertyDescriptor(vk, 'id');
    if (!descriptor) return output('ID_OWN_PROPERTY_MISSING');
    if (!Object.hasOwn(descriptor, 'value')) return output('ID_ACCESSOR_SKIPPED');
    const raw = descriptor.value; valueType = typeof raw;
    if (valueType !== 'number' && valueType !== 'string') return output('ID_TYPE_INVALID');
    const candidateId = id(raw);
    if (!candidateId) return output('ID_VALUE_INVALID');
    stage = 'RECHECK';
    const againVk = Object.getOwnPropertyDescriptor(window, 'vk');
    if (!againVk || !Object.hasOwn(againVk, 'value') || againVk.value !== vk) return output('SOURCE_CHANGED');
    const againId = Object.getOwnPropertyDescriptor(vk, 'id');
    if (!againId || !Object.hasOwn(againId, 'value') || againId.value !== raw) return output('SOURCE_CHANGED');
    if (location.href !== href) return output('PAGE_CHANGED');
    stage = 'COMPLETE';
    return { ...output('CANDIDATE_FOUND'), candidateId };
  } catch { return output('READ_FAILED'); }
}

const accountStatuses = new Set(['CANDIDATE_FOUND', 'VK_OWN_PROPERTY_MISSING', 'VK_ACCESSOR_SKIPPED', 'VK_VALUE_INVALID', 'ID_OWN_PROPERTY_MISSING', 'ID_ACCESSOR_SKIPPED', 'ID_TYPE_INVALID', 'ID_VALUE_INVALID', 'SOURCE_CHANGED', 'PAGE_CHANGED', 'PAGE_SCOPE', 'NOT_LIBRARY_ROUTE', 'LIBRARY_ID_INVALID', 'TAB_UNAVAILABLE', 'TAB_URL_UNAVAILABLE', 'SENDER_NOT_ALLOWED', 'AMBIGUOUS_RESULT', 'CHECK_BUSY', 'CONNECTION_FAILED', 'READ_FAILED']);
const stages = new Set(['PAGE_SCOPE','VK_DESCRIPTOR','ID_DESCRIPTOR','RECHECK','COMPLETE','TAB_LOOKUP','INJECTION']);
const types = new Set(['number','string','object','function','undefined','boolean','symbol','bigint']);
export function numericAccountId(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? String(v) : null;
  if (typeof v !== 'string' || !/^[1-9]\d{0,15}$/.test(v)) return null;
  return Number.isSafeInteger(Number(v)) && String(Number(v)) === v ? v : null;
}
export function sanitizeAccountCandidate(value = {}) {
  let status = typeof value?.status === 'string' && accountStatuses.has(value.status) ? value.status : 'READ_FAILED';
  let candidateId = status === 'CANDIDATE_FOUND' ? numericAccountId(value?.candidateId) : null;
  const libraryOwnerId = numericAccountId(value?.libraryOwnerId);
  if (status === 'CANDIDATE_FOUND' && !candidateId) status = 'ID_VALUE_INVALID';
  return { source: 'window.vk.id', status, stage: stages.has(value?.stage) ? value.stage : 'INJECTION', candidateId, libraryOwnerId,
    idsMatch: candidateId && libraryOwnerId ? candidateId === libraryOwnerId : null,
    valueType: types.has(value?.valueType) ? value.valueType : null };
}
