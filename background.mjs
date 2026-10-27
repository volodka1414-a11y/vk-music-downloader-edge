import { PrototypeError, fail, isMusicPage, wholeObjectUrl,
  probeInfo, safeError, messages, diagnosticError } from "./core.mjs";
import { sourceDiagnostic, responseDiagnostic, sanitizeDiagnostic, diagnosticText } from "./diagnostics.mjs";
import { readSelectedTrack } from "./resolver.mjs";
import "./library-scope.js";
import { createBatchService } from "./batch.mjs";
import { ensureSourceAccess, downloadStateWithAccess } from "./source-access.mjs";
import { prepareSourceRetry } from "./retry-plan.mjs";
import { approvedExactHosts, activateSelectedSources } from "./source-policy-store.mjs";
import { downloadFilenameFor, trackIdentity, launchDiagnostic, validDownloadId } from "./download-names.mjs";
import { recordSuccess } from "./success-history.mjs";
import { accountCandidatePage } from "./account-identity.mjs";
import { accountBinding, accountPrefix, sameAccount, scopedAccountApi, storedAccounts, ensureAccountHistory } from './account-state.mjs';
import { readWorkingAccount, requireWorkingAccount, workingAccountMessages } from './working-account.mjs';

const tickets = new Map(); // URL только в памяти, максимум 30 секунд до подтверждения.
const preparing = new Set();
const services = new Map();
let batchReservations = 0, batchAdmission = Promise.resolve();
const keyFor = id => `job:${id}`;
const singleIntentKey = "vkSingleLaunch:v1", rejectionKey = tabId => `vkSingleRejected:${tabId}`;
const singlePending = async () => !!(await chrome.storage.session.get(singleIntentKey))[singleIntentKey];
async function singleLaunchGuard() { if (await singlePending()) fail("DOWNLOAD_START_UNCERTAIN"); }
function serviceFor(account) {
  account=accountBinding(account);
  const key=accountPrefix(account); if(services.has(key)) return services.get(key);
  const api=scopedAccountApi(chrome,account), ownerId=account.libraryOwnerId;
  const authorize = sender => requireWorkingAccount(chrome,sender,account);
  const batchService = createBatchService({ api, ownerId, account, authorize,
  async validateState(state) {
    try { const tab=await chrome.tabs.get(state.tabId);
      await authorize({id:chrome.runtime.id,frameId:0,tab:{id:state.tabId},documentId:state.documentId,url:tab.url});
    } catch(error) {
      // Preserve a confirmed account refusal. Unknown document/read failures remain generic.
      if(error instanceof PrototypeError && ['ACCOUNT_FOREIGN_LIBRARY','ACCOUNT_UNKNOWN','ACCOUNT_CHANGED'].includes(error.code)) throw error;
      fail('ACCOUNT_CHANGED');
    }
  },
  async scope(sender, rowKey) {
    await authorize(sender);
    try {
      const entries = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
        world: "MAIN", func: globalThis.VkMusicLibraryScope, args: [rowKey, ownerId, "check"] });
      return entries[0]?.result || { ok: false, code: "LIBRARY_READ_FAILED" };
    } catch { return { ok: false, code: "PAGE_SCOPE" }; }
  },
  async metadata(sender, rowKey) {
    await authorize(sender);
    let entries;
    try {
    entries = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
      world: "MAIN", func: readSelectedTrack, args: [rowKey, ownerId, "metadata"] });
    } catch { fail("TRACK_METADATA", { stage: "row_data", condition: "ROW_READ_FAILED", requestState: "not_sent" }); }
    const value = entries[0]?.result;
    if (!value?.ok) fail(messages[value?.code] ? value.code : "TRACK_METADATA", sanitizeDiagnostic({ ...value?.diagnostic, stage: "row_data", requestState: "not_sent" }));
    if (!/^-?\d+_\d+$/.test(value.id) || typeof value.title !== "string" || typeof value.artist !== "string") fail("TRACK_METADATA", { stage: "row_data", condition: "INVALID_METADATA_RESULT", requestState: "not_sent" });
    return { id: value.id, title: value.title, artist: value.artist };
  }, readRow: (sender,rowKey) => readRow(sender,rowKey,account), inspectSource: url => inspectSource(url, true),
  async singleIdle() {
    await singleLaunchGuard();
    if (preparing.size || [...tickets.values()].some(ticket => ticket.expires > Date.now())) fail("BUSY");
    for (const [key, job] of Object.entries(await chrome.storage.session.get(null))) {
      if (key.startsWith("job:") && (await statusOf(job)).phase === "downloading") fail("BUSY");
    }
  }
  });
  const result={api,account,batch:batchService}; services.set(key,result); return result;
}
async function allServices() { for(const binding of await storedAccounts(chrome)) serviceFor(binding); return [...services.values()]; }
const batch = {
  async active() { if(batchReservations) return true; for(const s of await allServices()) if(await s.batch.blocking()) return true; return false; },
  async reconcile(recovering) { for(const s of await allServices()) await s.batch.reconcile(recovering); },
  async fileRemoved(id) { for(const s of await allServices()) await s.batch.fileRemoved(id); },
  async pageClosed(id) { for(const s of await allServices()) await s.batch.pageClosed(id); }
};
async function invalidateTab(tabId,reason='ACCOUNT_CHANGED') {
  for(const [id,ticket] of tickets) if(ticket.tabId===tabId) tickets.delete(id);
  await chrome.storage.session.remove(rejectionKey(tabId));
  for(const s of await allServices()) { const state=(await s.api.storage.local.get('vkBatch:v1'))['vkBatch:v1']; if(state?.tabId===tabId) await s.batch.accountLost(reason); }
}
async function observedAccount(sender) {
  const found=await readWorkingAccount(chrome,sender);
  if(!found.allowed) await invalidateTab(sender.tab?.id,found.code);
  else { for(const s of await allServices()) if(!sameAccount(s.account,found)) { const state=(await s.api.storage.local.get('vkBatch:v1'))['vkBatch:v1']; if(state?.tabId===sender.tab.id) await s.batch.accountLost('ACCOUNT_CHANGED'); }
    try { await ensureAccountHistory(chrome,found); } catch { fail('ACCOUNT_STORAGE'); }
    for(const [id,ticket] of tickets) if(ticket.tabId===sender.tab.id && !sameAccount(ticket.account,found)) tickets.delete(id);
  }
  return found;
}
chrome.alarms?.onAlarm?.addListener(alarm => { if (alarm.name === 'vk-batch-reconcile') void batch.reconcile(false).catch(()=>{}); });
chrome.downloads?.onChanged?.addListener(delta => {
  if (delta.exists?.current === false) void batch.fileRemoved(delta.id).catch(()=>{});
  if (delta.state?.current === 'complete') void reconcileSingleSuccess(delta.id);
  void batch.reconcile(false).catch(()=>{});
});
chrome.tabs?.onRemoved?.addListener(tabId => { void batch.pageClosed(tabId).catch(()=>{}); });
chrome.runtime.onStartup?.addListener(() => { void batch.reconcile(true).catch(()=>{}); });
void batch.reconcile(true).catch(()=>{});

async function checkSender(sender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab?.id ||
      !sender.documentId) fail("PAGE_SCOPE", { stage: "page_scope", requestState: "not_sent" });
  const found=await observedAccount(sender); if(!found.allowed) fail(found.code,{stage:'page_scope',requestState:'not_sent'});
  return accountBinding(found);
}

async function readRow(sender, rowKey, expected = null) {
  const account=await requireWorkingAccount(chrome,sender,expected), ownerId=account.libraryOwnerId;
  const scope = await chrome.scripting.executeScript({target:{tabId:sender.tab.id,documentIds:[sender.documentId]},world:'MAIN',func:globalThis.VkMusicLibraryScope,args:[rowKey,ownerId,'check']});
  if(!scope[0]?.result?.ok) fail(scope[0]?.result?.code || 'PAGE_SCOPE');
  let result;
  try {
    const entries = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
      world: "MAIN", func: readSelectedTrack, args: [rowKey, ownerId]
    });
    result = entries[0]?.result;
  } catch { fail("ROW_MISSING"); }
  if (!result?.ok) fail(messages[result?.code] ? result.code : "TRACK_METADATA", {
    ...sanitizeDiagnostic(result?.diagnostic),
    stage: "row_data", requestState: "not_sent",
    sourceReason: result?.code === "SOURCE_MISSING" ? "SOURCE_MISSING" : result?.code === "SOURCE_MASKED" ? "SOURCE_MASKED" : null,
    condition: result?.code === "SOURCE_MISSING" ? "SOURCE_MISSING" : result?.code === "SOURCE_MASKED" ? "SOURCE_MASKED" : result?.diagnostic?.condition,
    sourceClass: result?.code === "SOURCE_MISSING" ? "no_source" : result?.code === "SOURCE_MASKED" ? "masked_marker" : "unknown"
  });
  if (!/^-?\d+_\d+$/.test(result.id) || typeof result.artist !== "string" || typeof result.title !== "string") fail("TRACK_METADATA");
  await ensureSourceAccess(chrome, result.url);
  return result;
}

export async function inspectSource(url, classifyTemporary = false) {
  // GET Range=0-0 устанавливает MIME/общий размер реального GET, а не HEAD.
  // Если CDN игнорирует Range, тело сразу отменяется. Это один выбранный трек.
  const sourceFacts = sourceDiagnostic(url, await approvedExactHosts(chrome));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
  let response;
  try {
    response = await fetch(url, {
      method: "GET", headers: { Range: "bytes=0-0" }, credentials: "include",
      redirect: "error", cache: "no-store", signal: controller.signal
    });
    const responseFacts = responseDiagnostic(response);
    return { ...probeInfo(response), diagnostic: sanitizeDiagnostic({ ...responseFacts, ...sourceFacts, sourceClass: responseFacts.sourceClass }) };
  } catch (error) {
    const context = { stage: "probe_request", requestState: "attempted_no_response", ...sourceFacts };
    if (response) Object.assign(context, responseDiagnostic(response), sourceFacts);
    throw diagnosticError(error instanceof PrototypeError ? error : new PrototypeError(classifyTemporary && timedOut && !response ? "PROBE_TIMEOUT" : "NETWORK"), context);
  } finally {
    try { await response?.body?.cancel(); } catch { /* Не выводить исходное исключение. */ }
    controller.abort();
    clearTimeout(timer);
  }
}

async function allJobs(sender) {
  const values = Object.entries(await chrome.storage.session.get(null));
  return values.filter(([key, job]) => key.startsWith("job:") && job.tabId === sender.tab.id && sameAccount(job.account,sender.account)).map(([, job]) => job);
}

async function statusOf(job) {
  if(!accountBinding(job?.account)) fail("ACCOUNT_UNKNOWN");
  const items = await chrome.downloads.search({ id: job.downloadId });
  const result = await downloadStateWithAccess(chrome, items[0], job);
  if (result.phase === "saved" && items[0]?.exists === false) return { ...job, phase: "error", code: "DOWNLOAD_MISSING" };
  if (result.phase === "saved" && job.historyEligible === true) { await recordSuccess(serviceFor(job.account).api, job.trackId, { downloadId: job.downloadId, size: job.size, mime: job.mime,
    completedAt: Date.now(), fallbackUsed: job.fallbackUsed === true });
  }
  return { ...job, ...result };
}

async function reconcileSingleSuccess(downloadId) {
  try {
    const job = (await chrome.storage.session.get(keyFor(downloadId)))[keyFor(downloadId)];
    if (job?.historyEligible === true) await statusOf(job);
  } catch { /* Keep job metadata; a later explicit status read can recheck and retry the history write. */ }
}

function publicJob(job) {
  // Ни URL, ни полные пути из downloads.search не отправляются в страницу.
  return { downloadId: job.downloadId, rowKey: job.rowKey, trackId: job.trackId,
    artist: job.artist, title: job.title, duration: job.duration, size: job.size,
    binding: job.binding, phase: job.phase, received: job.received,
    fallbackUsed: job.fallbackUsed === true,
    code: job.code, message: job.code ? safeError(new PrototypeError(job.code, {
      ...job.diagnostic, stage: job.diagnostic?.stage === "final_source_url" ? "final_source_url" : "download_check"
    })).message : undefined };
}

async function ensureIdle(sender) {
  await singleLaunchGuard();
  for (const [key, ticket] of tickets) {
    if (Date.now() > ticket.expires) tickets.delete(key);
    else if (ticket.tabId === sender.tab.id) fail("BUSY");
  }
  for (const [key, job] of Object.entries(await chrome.storage.session.get(null))) {
    if (!key.startsWith("job:")) continue;
    if ((await statusOf(job)).phase === "downloading") fail("BUSY");
  }
}

async function prepare(message, sender, fallback = false) {
  const account=await requireWorkingAccount(chrome,sender,sender.account);
  if (preparing.has(sender.tab.id) || preparing.has("single-start")) fail("BUSY", { stage: "preflight", requestState: "not_sent" });
  preparing.add(sender.tab.id);
  let diagnostic = { stage: "preflight", requestState: "not_sent" };
  try {
    await ensureIdle(sender);
    let rejection;
    if (fallback) {
      rejection = (await chrome.storage.session.get(rejectionKey(sender.tab.id)))[rejectionKey(sender.tab.id)];
      if (!rejection || !sameAccount(rejection.account,account) || rejection.id !== message.rejectionId || rejection.rowKey !== message.rowKey || rejection.documentId !== sender.documentId ||
          Date.now() - rejection.createdAt > 600000) fail("FALLBACK_UNAVAILABLE");
    } else await chrome.storage.session.remove(rejectionKey(sender.tab.id));
    diagnostic.stage = "row_data";
    const track = await readRow(sender, message.rowKey,account);
    if (fallback && (track.id !== rejection.trackId || await trackIdentity(track) !== rejection.identity)) fail("TRACK_MISMATCH");
    const approvedHosts = await approvedExactHosts(chrome);
    diagnostic = { ...diagnostic, ...sourceDiagnostic(track.url, approvedHosts), stage: "whole_object_url" };
    const url = wholeObjectUrl(track.url, approvedHosts);
    diagnostic.stage = "probe_request";
    const source = await inspectSource(url);
    diagnostic = { ...source.diagnostic, stage: "filename_build" };
    const { filename, filenameMode } = downloadFilenameFor(track, source.mime, fallback);
    await requireWorkingAccount(chrome,sender,account);
    diagnostic = source.diagnostic;
    const ticketId = crypto.randomUUID();
    tickets.set(ticketId, { account, tabId: sender.tab.id, documentId: sender.documentId,
      rowKey: message.rowKey, track, url, filename, filenameMode, fallback, rejectionId: rejection?.id, ...source, expires: Date.now() + 30000 });
    setTimeout(() => tickets.delete(ticketId), 30000);
    return { ok: true, ticketId, trackId: track.id, artist: track.artist, title: track.title,
      duration: track.duration, binding: track.binding, size: source.size, mime: source.mime, diagnostic,
      diagnosticText: diagnosticText(diagnostic) };
  } catch (error) {
    throw diagnosticError(error, diagnostic);
  } finally { preparing.delete(sender.tab.id); }
}

async function start(message, sender) {
  if (preparing.has(sender.tab.id) || preparing.has("single-start")) fail("BUSY", { stage: "preflight", requestState: "unknown" });
  const ticket = tickets.get(message.ticketId);
  if (!ticket || ticket.tabId !== sender.tab.id || ticket.documentId !== sender.documentId || Date.now() > ticket.expires) fail("TICKET", { stage: "row_recheck", requestState: "unknown" });
  tickets.delete(message.ticketId); // Одноразовый, в том числе при ошибке.
  preparing.add(sender.tab.id);
  preparing.add("single-start");
  const diagnostic = { ...ticket.diagnostic, stage: "row_recheck" };
  try {
    await ensureIdle(sender);
    await requireWorkingAccount(chrome,sender,ticket.account);
    const current = await readRow(sender, ticket.rowKey,ticket.account);
    if (["id", "artist", "title", "url"].some(key => current[key] !== ticket.track[key])) fail("TRACK_MISMATCH");
    if (ticket.fallback) {
      const gate = (await chrome.storage.session.get(rejectionKey(sender.tab.id)))[rejectionKey(sender.tab.id)];
      if (!gate || !sameAccount(gate.account,ticket.account) || gate.id !== ticket.rejectionId || gate.documentId !== sender.documentId || gate.rowKey !== ticket.rowKey) fail("FALLBACK_UNAVAILABLE");
    }
    // A durable intent contains no source URL. Worker loss before saving the returned ID blocks a blind restart.
    await requireWorkingAccount(chrome,sender,ticket.account);
    await chrome.storage.session.set({ [singleIntentKey]: { account:ticket.account, phase: "starting", tabId: sender.tab.id, documentId: sender.documentId, rowKey: ticket.rowKey, trackId: current.id } });
    try { await requireWorkingAccount(chrome,sender,ticket.account); } catch(error) { await chrome.storage.session.set({[singleIntentKey]:null}); throw error; }
    if (ticket.fallback) await chrome.storage.session.remove(rejectionKey(sender.tab.id));
    let downloadId;
    diagnostic.stage = "download_request";
    try {
      downloadId = await chrome.downloads.download({ url: ticket.url, filename: ticket.filename,
        conflictAction: "uniquify", saveAs: true });
    } catch (error) {
      const rejection = ticket.filenameMode === "fallback" ? null : { account:ticket.account, id: crypto.randomUUID(), rowKey: ticket.rowKey, documentId: sender.documentId,
        trackId: current.id, identity: await trackIdentity(current), createdAt: Date.now() };
      // saveAs:true can reject on cancellation: no automatic fallback and no guessed cancellation code.
      await chrome.storage.session.set({ [singleIntentKey]: null, [rejectionKey(sender.tab.id)]: rejection });
      return { ...safeError(diagnosticError(new PrototypeError("DOWNLOAD_START", launchDiagnostic(error, ticket.filename, ticket.filenameMode)), diagnostic)),
        fallbackAvailable: !!rejection, rejectionId: rejection?.id || null };
    }
    if (!validDownloadId(downloadId)) fail("DOWNLOAD_START_UNCERTAIN");
    const job = { account:ticket.account, downloadId, tabId: sender.tab.id, rowKey: ticket.rowKey,
      trackId: current.id, artist: current.artist, title: current.title, duration: current.duration,
      binding: current.binding, size: ticket.size, mime: ticket.mime, historyEligible: true, fallbackUsed: ticket.filenameMode === "fallback", created: Date.now(), diagnostic: sanitizeDiagnostic(diagnostic) };
    diagnostic.stage = "download_check";
    await chrome.storage.session.set({ [keyFor(downloadId)]: job, [singleIntentKey]: null });
    // Ограничиваем только собственные записи в памяти, не историю браузера.
    const previous = (await allJobs(sender)).sort((a, b) => b.created - a.created);
    for (const old of previous.slice(50)) await chrome.storage.session.remove(keyFor(old.downloadId));
    return { ok: true, job: publicJob(await statusOf(job)) };
  } catch (error) {
    let uncertain;
    try { uncertain = await singlePending(); } catch { uncertain = true; }
    if (uncertain) throw diagnosticError(new PrototypeError("DOWNLOAD_START_UNCERTAIN"), diagnostic);
    throw diagnosticError(error, diagnostic);
  } finally { preparing.delete(sender.tab.id); preparing.delete("single-start"); }
}

export async function handleMessage(message, sender) {
  if(message?.type === 'WORK_ACCOUNT') {
    const value=await observedAccount(sender);
    if(value.allowed) {
      const history=(await serviceFor(value).api.storage.local.get('vkBatchHistory:v1'))['vkBatchHistory:v1'] || {};
      value.historyCount=Object.keys(history).length;
    }
    return {ok:true,account:value};
  }
  if (["REPORT_ACCOUNT_CHECK", "PREPARE_SOURCE_RETRY", "ACTIVATE_SELECTED_SOURCES"].includes(message?.type)) {
    let url;
    try { url = new URL(sender.url); } catch { fail("PAGE_SCOPE"); }
    const reportURL = new URL(chrome.runtime.getURL("batch-report.html"));
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || url.protocol !== reportURL.protocol || url.hostname !== reportURL.hostname || url.pathname !== reportURL.pathname || url.searchParams.get("run") !== message.runId) fail("PAGE_SCOPE");
    const account=accountBinding({accountId:url.searchParams.get('account'),libraryOwnerId:url.searchParams.get('library')});
    if(!account) fail('ACCOUNT_REPORT_MISMATCH');
    const service=serviceFor(account), report=(await service.api.storage.local.get(`vkBatchReport:${message.runId}`))[`vkBatchReport:${message.runId}`];
    if(!sameAccount(report?.account,account)) fail('ACCOUNT_REPORT_MISMATCH');
    const pages=await chrome.tabs.query({url:'https://vk.ru/*'}); let matched=false;
    for(const tab of pages) {
      let page; try {page=new URL(tab.url);} catch {continue;}
      if(!/^\/audios[1-9]\d*$/.test(page.pathname)) continue;
      const entries=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},world:'MAIN',func:accountCandidatePage});
      if(entries.length!==1 || !entries[0].documentId) continue;
      const found=await readWorkingAccount(chrome,{id:chrome.runtime.id,frameId:0,tab:{id:tab.id},documentId:entries[0].documentId,url:tab.url});
      if(!found.allowed || !sameAccount(found,account)) fail('ACCOUNT_REPORT_MISMATCH'); matched=true;
    }
    if(!matched) fail('ACCOUNT_REPORT_MISMATCH');
    if(message.type==='REPORT_ACCOUNT_CHECK') return {ok:true};
    if (await batch.active()) return { ok: false, code: "BATCH_ACTIVE" };
    if (message.type === "ACTIVATE_SELECTED_SOURCES") return activateSelectedSources(service.api, message.runId, message.hosts);
    return prepareSourceRetry(service.api, message.runId, message.hosts);
  }
  // A route exit can only pause the already bound controller; it cannot read a row
  // or start a request. Other commands retain the original personal-page check.
  if (message?.type === "BATCH_PAUSE") {
    let origin;
    try { origin = new URL(sender.url).origin; } catch { /* Fixed safe failure below. */ }
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab?.id ||
        !sender.documentId || origin !== "https://vk.ru") fail("PAGE_SCOPE");
    for(const s of await allServices()) {
      const state=(await s.api.storage.local.get('vkBatch:v1'))['vkBatch:v1'];
      if(state?.id===message.runId && state.tabId===sender.tab.id && state.documentId===sender.documentId) await s.batch.accountLost('ACCOUNT_CHANGED');
    }
    return {ok:true};
  }
  const account=await checkSender(sender);
  sender={...sender,account};
  const service=serviceFor(account);
  if (message?.type?.startsWith("BATCH_")) {
    if(message.runId) for(const other of await allServices()) if(!sameAccount(other.account,account)) {
      const original=(await other.api.storage.local.get('vkBatch:v1'))['vkBatch:v1'];
      if(original?.id===message.runId) fail('ACCOUNT_CHANGED');
    }
    if(message.type==='BATCH_START' || message.type==='BATCH_RESUME') {
      batchReservations++;
      const task=batchAdmission.then(async()=>{
        for(const other of await allServices()) if(!sameAccount(other.account,account) && await other.batch.blocking()) fail('BATCH_ACTIVE');
        return service.batch.handle(message,sender);
      }); batchAdmission=task.catch(()=>{});
      try{return await task;}finally{batchReservations--;}
    }
    return service.batch.handle(message,sender);
  }
  if (["PREPARE", "PREPARE_FALLBACK", "START"].includes(message?.type) && await batch.active()) fail("BUSY");
  if (message?.type === "PREPARE") return prepare(message, sender);
  if (message?.type === "PREPARE_FALLBACK") return prepare(message, sender, true);
  if (message?.type === "START") return start(message, sender);
  if (message?.type === "ABORT") {
    const ticket = tickets.get(message.ticketId);
    if (ticket?.tabId === sender.tab.id && ticket.documentId === sender.documentId) tickets.delete(message.ticketId);
    return { ok: true };
  }
  if (message?.type === "JOBS") {
    await singleLaunchGuard();
    const jobs = (await allJobs(sender)).sort((a, b) => b.created - a.created).slice(0, 50);
    return { ok: true, jobs: await Promise.all(jobs.map(async job => publicJob(await statusOf(job)))) };
  }
  fail("INTERNAL");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse, error => sendResponse(safeError(diagnosticError(error, {
    stage: message?.type === "JOBS" ? "job_status" : "preflight", requestState: "unknown"
  }))));
  return true;
});
