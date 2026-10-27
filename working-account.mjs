import { accountCandidatePage, sanitizeAccountCandidate } from './account-identity.mjs';
import { accountBinding, sameAccount } from './account-state.mjs';
import { isMusicPage, PrototypeError } from './core.mjs';
export { workingAccountMessages } from './account-messages.mjs';
import { workingAccountMessages } from './account-messages.mjs';
export async function readWorkingAccount(api, sender, expected = null) {
  const denied = (code, sourceStatus = null) => ({ allowed: false, code, message: workingAccountMessages[code], sourceStatus, accountId: null, libraryOwnerId: null });
  try {
    if (sender?.id !== api.runtime.id || sender.frameId !== 0 || !Number.isSafeInteger(sender.tab?.id) || !sender.documentId) return denied('ACCOUNT_UNKNOWN');
    const execute = () => api.scripting.executeScript({ target: {tabId:sender.tab.id,documentIds:[sender.documentId]},world:'MAIN',func:accountCandidatePage });
    const read = entries => entries?.length === 1 && entries[0].frameId === 0 && entries[0].documentId === sender.documentId ? sanitizeAccountCandidate(entries[0].result) : null;
    const a = read(await execute()), b = read(await execute());
    const tab = await api.tabs.get(sender.tab.id);
    if (tab.pendingUrl || tab.status === 'loading' || tab.url !== sender.url || JSON.stringify(a) !== JSON.stringify(b)) return denied('ACCOUNT_CHANGED');
    if (!b || b.status !== 'CANDIDATE_FOUND' || !isMusicPage(sender.url,b.libraryOwnerId)) return denied('ACCOUNT_UNKNOWN',b?.status);
    if (!b.idsMatch) return {...denied('ACCOUNT_FOREIGN_LIBRARY',b.status),accountId:b.candidateId,libraryOwnerId:b.libraryOwnerId};
    const binding = accountBinding({accountId:b.candidateId,libraryOwnerId:b.libraryOwnerId});
    if (!binding || (expected && !sameAccount(binding,expected))) return denied('ACCOUNT_CHANGED',b.status);
    return { allowed:true, code:'ACCOUNT_READY',sourceStatus:b.status,...binding };
  } catch { return denied(expected ? 'ACCOUNT_CHANGED' : 'ACCOUNT_UNKNOWN'); }
}
export async function requireWorkingAccount(api,sender,expected=null) {
  const value=await readWorkingAccount(api,sender,expected);
  if (!value.allowed) throw new PrototypeError(value.code,{stage:'page_scope',requestState:'not_sent'});
  return accountBinding(value);
}
