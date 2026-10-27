import { PrototypeError, messages, wholeObjectUrl } from "./core.mjs";
import "./library-scope.js";
import { sourceDiagnostic, sanitizeDiagnostic } from "./diagnostics.mjs";
import { observeSource, safeObservation } from "./source-summary.mjs";
import { downloadStateWithAccess, ensureSourceAccess } from "./source-access.mjs";
import { readRetryPlan, retryPlanKey } from "./retry-plan.mjs";
import { approvedExactHosts } from "./source-policy-store.mjs";
import { retryDelays, transientReason, safeInterruptReason } from "./retry-policy.mjs";
import { downloadFilenameFor, fallbackFilename, launchDiagnostic, mayFallbackWithoutDialog, validDownloadId } from "./download-names.mjs";
import { recordSuccess, forgetDownload } from "./success-history.mjs";
import { workingAccountMessages } from './working-account.mjs';
import { reportLocation } from './account-state.mjs';

export const batchMessages = Object.freeze({
  ...workingAccountMessages,
  LIBRARY_SECTION_MISSING: "Основная секция треков не найдена. Откройте личную «Моя музыка» → «Все».",
  LIBRARY_SECTION_AMBIGUOUS: "Найдено несколько секций треков. Обход остановлен, область не выбрана.",
  LIBRARY_HEADER_INVALID: "Не подтверждён единственный заголовок «Треки» основной секции.",
  LIBRARY_LIST_MISSING: "В секции треков не найден нужный список.",
  LIBRARY_LIST_AMBIGUOUS: "В секции треков несколько подходящих списков. Обход остановлен.",
  LIBRARY_ROWS_EMPTY: "В основном списке пока нет распознанных строк. Пустота библиотеки не подтверждена.",
  LIBRARY_ROW_OUTSIDE: "Строка исчезла или больше не принадлежит подтверждённому основному списку.",
  LIBRARY_READ_FAILED: "Область списка не удалось проверить. Обход остановлен.",
  BATCH_ACTIVE: "Другой обход уже активен. Параллельная очередь не запускается.",
  BATCH_WAITING_PAGE: "Ожидание страницы VK. Откройте «Моя музыка» → «Все» и нажмите «Продолжить обход».",
  BATCH_WRONG_CONTROLLER: "Продолжение закреплено за другой вкладкой или документом.",
  BATCH_STOPPED: "Остановлено пользователем. Новые задания не запускаются.",
  TEST_LIMIT: "Архивный запуск остановлен ограничением прежней версии.", // Old reports only; no new run uses this reason.
  NO_PROGRESS_NOT_END: "Новые треки не обнаружены; полнота библиотеки не подтверждена",
  LIBRARY_UNSTABLE: "Контейнер списка многократно заменяется без новых ID. Состояние сохранено; требуется явное продолжение.",
  SCROLL_GEOMETRY_UNAVAILABLE: "Не удалось безопасно определить область прокрутки списка. Состояние сохранено.",
  START_NOT_CONFIRMED: "Не удалось подтвердить начало списка по его положению после прокрутки вверх.",
  DOWNLOAD_START_UNCERTAIN: "Worker остановился между запросом загрузки и сохранением её ID. Возможная загрузка не запускается повторно. Проверьте edge://downloads и пришлите этот статус.",
  PREPARATION_INTERRUPTED: "Подготовка прервалась. Нужна страница и явное продолжение для повторного чтения источника.",
  RETRY_ROW_UNAVAILABLE: "Повтор ожидает прежнюю строку и документ. Другая строка не подставляется. Верните строку и нажмите «Продолжить обход»; после перезагрузки страницы может потребоваться остановка и новый запуск.",
  RETRY_CANCELLED_BY_STOP: "Ожидающий повтор отменён пользователем. Новая попытка не начата.",
  DEFERRED_ID_NOT_FOUND: "Отложенный ID не найден или не подтверждён среди доступных строк повторного прохода. Успех не подтверждён; полнота библиотеки не установлена.",
  STOPPED_BEFORE_START: "Остановка запрошена до запуска файла. Источник повторно не запрашивается.",
  ROW_NOT_REFOUND: "Ранее обнаруженная строка не найдена при возобновлении обхода.",
  FILE_REMOVED: "Браузер сообщил, что ранее сохранённого файла больше нет; успех удалён из истории.",
  REPORT_OPEN_FAILED: "Отчёт сохранён локально, но вкладку открыть не удалось. Нажмите «Открыть отчёт».",
  BATCH_STORAGE: "Не удалось записать локальное состояние или историю. Новые задания остановлены; автоматический повтор не выполняется. Не очищайте данные расширения.",
  BATCH_INTERNAL: "Ошибка очереди. Новые задания остановлены; перед продолжением будет проверено последнее сохранённое состояние.",
  RETRY_PLAN_INVALID: "Подготовленный список дозагрузки недоступен или изменился. Подготовьте его заново в отчёте.",
  RETRY_ROW_NOT_FOUND: "ID выбран для дозагрузки, но его строка не встретилась при повторном обходе. Полнота библиотеки не подтверждена."
});
export const batchReason = code => batchMessages[code] || messages[code] || batchMessages.BATCH_INTERNAL;
const allowedCode = code => Object.hasOwn(batchMessages, code) || Object.hasOwn(messages, code) ? code : "BATCH_INTERNAL";
const label = value => typeof value === "string" ? value.normalize("NFC").replace(/https?:\/\/\S+/gi, "[ссылка скрыта]")
  .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0, 500) : "";
const STATE = "vkBatch:v1", HISTORY = "vkBatchHistory:v1";
const identity = async track => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([track.id, track.title, track.artist]))))]
  .map(byte => byte.toString(16).padStart(2, "0")).join("");
export const batchKeys = { STATE, HISTORY };

// All mutations are serialized in the one extension worker, across every tab.
// STOP sets an immediate in-memory signal before joining the mutation queue.
export function createBatchService({ api, ownerId, account = null, authorize = async () => {}, validateState = null, scope, metadata, readRow, inspectSource, singleIdle, now = Date.now, uuid = () => crypto.randomUUID() }) {
  let chain = Promise.resolve(), stopSignal = null, startsPending = 0;
  const serial = fn => { const next = chain.then(fn); chain = next.catch(() => {}); return next; };
  const load = async () => (await api.storage.local.get(STATE))[STATE] || null;
  const history = async () => (await api.storage.local.get(HISTORY))[HISTORY] || {};
  const put = async values => { try { await api.storage.local.set(values); } catch { fail("BATCH_STORAGE"); } };
  const save = state => put({ [STATE]: state });
  const view = (state, includeEntries = true) => state ? { id: state.id, account: state.account || account, phase: state.phase, reason: state.reason,
    reasonText: state.reason ? batchReason(state.reason) + (state.scopeDiagnostic ? "\n" + globalThis.VkMusicLibraryScopeDiagnostic(state.scopeDiagnostic) : "") : null, stopRequested: state.stopRequested,
    tabId: state.tabId, documentId: state.documentId, mode: state.mode || "legacy", libraryComplete: false,
    uniqueIds: state.entries.filter(e => typeof e.id === "string").length, uncertain: !!state.uncertain, reportReady: !!state.reportReady,
    discovered: state.entries.length, saved: state.entries.filter(e => e.status === "saved").length,
    skipped: state.entries.filter(e => e.status === "skipped").length, errors: state.entries.filter(e => e.status === "error").length,
    current: state.current === null ? null : state.entries[state.current]?.status,
    passRound: state.passRound || 0, passToken: state.passToken || 0,
    mainPassComplete: !!state.mainPassComplete, deferred: state.entries.filter(e => ["deferred", "retry_wait"].includes(e.status)).length,
    retry: state.entries[state.current]?.status === "retry_wait" ? {
      number: state.entries[state.current].attempts, remainingMs: Math.max(0, state.entries[state.current].retryAt - now()),
      rowKey: state.entries[state.current].retryBinding?.rowKey || null,
      documentId: state.entries[state.current].retryBinding?.documentId || null
    } : null,
    retryTargetCount: state.retryTargets?.length || 0,
    ...(includeEntries ? { entries: state.entries.map(e => ({ id: e.id, title: e.title, artist: e.artist, status: e.status, code: e.code || null,
      attempts: [1, 2].includes(state.retryPolicyVersion) && Number.isInteger(e.attempts) ? e.attempts : null, retryExhausted: !!e.retryExhausted,
      ...(typeof e.filenameMode === "string" ? { filenameMode: e.filenameMode === "fallback" ? "fallback" : "normal", fallbackUsed: e.status === "saved" && e.filenameMode === "fallback" } : {}),
      roundsExhausted: !!e.roundsExhausted, finalFailure: e.finalFailure ? { code: e.finalFailure.code, ...safeObservation(e.finalFailure) } : null,
      lastFailure: e.lastFailure ? { code: e.lastFailure.code, reason: e.lastFailure.reason } : null,
      ...(Array.isArray(e.sources) ? { sources: e.sources.map(source => safeObservation(source)), sourcesTruncated: !!e.sourcesTruncated } : {}) })) } : {}) } : null;
  const terminal = state => ["finished", "stopped"].includes(state.phase);
  const owns = (state, sender) => state.tabId === sender.tab.id && state.documentId === sender.documentId;
  const cleanScopeDiagnostic = diagnostic => diagnostic && typeof diagnostic === "object" ? {
      sectionCount: Number.isSafeInteger(diagnostic.sectionCount) && diagnostic.sectionCount >= 0 ? diagnostic.sectionCount : null,
      headerCount: Number.isSafeInteger(diagnostic.headerCount) && diagnostic.headerCount >= 0 ? diagnostic.headerCount : null,
      listCount: Number.isSafeInteger(diagnostic.listCount) && diagnostic.listCount >= 0 ? diagnostic.listCount : null,
      tracksTitleSpanPresent: typeof diagnostic.tracksTitleSpanPresent === "boolean" ? diagnostic.tracksTitleSpanPresent : null,
      failedCheck: globalThis.VkMusicLibraryScopeDiagnostic(diagnostic).match(/failedCheck=([A-Z_]+)$/)?.[1] || "UNAVAILABLE"
    } : null;
  const fail = (code, diagnostic = null) => {
    const error = new PrototypeError(code);
    error.scopeDiagnostic = cleanScopeDiagnostic(diagnostic);
    throw error;
  };
  const pause = async (state, reason, diagnostic = null) => {
    state.phase = "waiting_page"; state.reason = reason; state.scopeDiagnostic = cleanScopeDiagnostic(diagnostic); state.reportReady = true;
    await put({ [STATE]: state, [`vkBatchReport:${state.id}`]: { ...view(state), updatedAt: now(), libraryComplete: false } });
    if (!Object.hasOwn(workingAccountMessages, reason) && state.current === null && !state.reportRequested && !state.stopRequested && stopSignal !== state.id) {
      state.reportRequested = true; await save(state);
      try { await openReport(state); } catch { /* Saved report remains available through its explicit button. */ }
    }
  };
  const openReport = async state => {
    await api.tabs.create({ url: reportLocation(api, account, state.id) });
  };
  const finish = async (state, reason) => {
    if (state.phase === "waiting_page") state.reportRequested = false;
    for (const target of state.retryTargets || []) if (!state.entries.some(entry => entry.id === target.id)) {
      state.entries.push({ id: target.id, title: target.title, artist: target.artist, status: "error", code: state.stopRequested ? "STOPPED_BEFORE_START" : "RETRY_ROW_NOT_FOUND" });
    }
    for (const entry of state.entries) if (["pending", "preparing", "fallback_pending", "starting", "retry_wait", "deferred"].includes(entry.status)) {
      if (["retry_wait", "deferred"].includes(entry.status) && state.stopRequested) { entry.status = "error"; entry.code = "RETRY_CANCELLED_BY_STOP"; entry.finalFailure = { code: entry.code, operation: "recovery", reason: entry.code, stage: "internal" }; delete entry.retryAt; continue; }
      entry.status = "error"; entry.code = state.uncertain ? "DOWNLOAD_START_UNCERTAIN" : state.stopRequested ? "STOPPED_BEFORE_START" : "ROW_NOT_REFOUND";
      entry.finalFailure = { code: entry.code, reason: entry.code, operation: "recovery", stage: "internal" };
    }
    state.current = null; state.phase = state.stopRequested ? "stopped" : "finished"; state.reason = reason; state.scopeDiagnostic = null; state.reportReady = true;
    await put({ [STATE]: state, [`vkBatchReport:${state.id}`]: { ...view(state), finishedAt: now(), libraryComplete: false } });
    // Persist intent before opening to avoid opening duplicate reports on worker recovery.
    if (!state.reportRequested) {
      state.reportRequested = true; await save(state);
      try { await openReport(state); } catch { state.reason = "REPORT_OPEN_FAILED"; await save(state); }
    }
    await api.alarms?.clear("vk-batch-reconcile");
  };
  const recordFailure = async (state, entry, code, diagnostic, item = null, operation = "internal") => {
    const temporary = transientReason(code, diagnostic, item);
    entry.code = code; entry.lastFailure = { code, reason: temporary || safeInterruptReason(item?.error) || code };
    const detail = sanitizeDiagnostic({ ...diagnostic, operation, attempt: entry.attempts,
      ...(operation === "row_recheck" ? { stage: "row_recheck" } : {}),
      ...(operation === "filename_build" ? { stage: "filename_build" } : {}),
      ...(operation === "download_start" ? { stage: "download_request" } : {}),
      ...(operation === "download_check" && diagnostic?.stage !== "final_source_url" ? { stage: "download_check" } : {}) });
    if (operation !== "cdn_probe") { detail.status = null; detail.contentType = null; }
    entry.finalFailure = { ...detail, code, reason: entry.lastFailure.reason };
    observeSource(entry, detail, code);
    if (!Number.isInteger(entry.attempts)) entry.attempts = 1; // An existing pre-upgrade active attempt.
    if (state.retryPolicyVersion === 2 && temporary && !state.stopRequested && stopSignal !== state.id && entry.attempts < 3 && entry.retryIdentity) {
      entry.status = "deferred"; entry.retryAt = now() + retryDelays[entry.attempts - 1]; state.current = null;
      await save(state); return;
    }
    if (state.retryPolicyVersion === 1 && temporary && !state.stopRequested && stopSignal !== state.id && entry.attempts < 3 && entry.retryBinding) {
      entry.status = "retry_wait"; entry.retryAt = now() + retryDelays[entry.attempts - 1];
      await save(state); return;
    }
    entry.status = "error"; entry.retryExhausted = !!temporary && entry.attempts >= 3;
    delete entry.retryAt; state.current = null; await save(state);
  };
  const reconcileState = async (state, recovering = false) => {
    if (!state || terminal(state)) return state;
    const entry = state.current === null ? null : state.entries[state.current];
    if (entry?.status === "retry_wait") {
      if (state.stopRequested || stopSignal === state.id) { state.stopRequested = true; await finish(state, "BATCH_STOPPED"); return state; }
      // Recheck the previous transfer, including after a worker restart. Never duplicate it.
      if (entry.downloadId != null) {
        const [previous] = await api.downloads.search({ id: entry.downloadId });
        if (previous?.state === "complete" || previous?.state === "in_progress") {
          entry.status = "downloading"; delete entry.retryAt; await save(state);
        } else if (!previous || !transientReason("DOWNLOAD_INTERRUPTED", null, previous)) {
          await recordFailure(state, entry, previous ? "DOWNLOAD_INTERRUPTED" : "DOWNLOAD_MISSING", null, previous, "download_check");
        }
      }
    }
    if (entry?.status === "downloading") {
      const [item] = await api.downloads.search({ id: entry.downloadId });
      const result = await downloadStateWithAccess(api, item, entry);
      if (result.diagnostic) observeSource(entry, { ...result.diagnostic, operation: "download_check", attempt: entry.attempts }, result.code);
      if (result.phase !== "downloading") {
        if (result.phase === "error") await recordFailure(state, entry, result.code, result.diagnostic, item, "download_check");
        else { entry.status = result.phase; entry.code = result.code || null; entry.finalFailure = null; }
        if (result.phase === "saved" && item?.exists === false) { entry.status = "error"; entry.code = "FILE_REMOVED"; }
        if (entry.status === "saved") {
          try { await recordSuccess(api, entry.id, { downloadId: entry.downloadId, mime: entry.mime, size: entry.size, completedAt: now(), fallbackUsed: entry.filenameMode === "fallback" }); }
          catch { fail("BATCH_STORAGE"); }
        }
        if (entry.status !== "retry_wait") state.current = null;
        if (state.phase === "waiting_page") await pause(state, state.reason, state.scopeDiagnostic);
        else await save(state);
      }
    } else if (entry?.status === "starting") {
      state.uncertain = true; state.phase = "attention"; state.reason = "DOWNLOAD_START_UNCERTAIN"; await save(state); return state;
    } else if (["preparing", "fallback_pending"].includes(entry?.status)) {
      if (!Number.isInteger(entry.attempts)) entry.attempts = 1;
      if (state.retryPolicyVersion === 2) {
        await recordFailure(state, entry, "PREPARATION_INTERRUPTED", { stage: "internal" }, null, "recovery");
      } else { entry.status = "pending"; state.current = null; }
      await pause(state, "PREPARATION_INTERRUPTED");
    }
    if (state.current === null) {
      if (state.stopRequested) await finish(state, "BATCH_STOPPED");
      else if (recovering && state.phase !== "waiting_page") await pause(state, "BATCH_WAITING_PAGE");
    } else if (recovering && state.phase !== "attention" && state.phase !== "waiting_page") {
      await pause(state, "BATCH_WAITING_PAGE");
    }
    if (validateState && !terminal(state)) {
      try { await validateState(state); }
      catch (error) { if (state.phase !== 'waiting_page' || state.reason !== allowedCode(error.code)) await pause(state, allowedCode(error.code)); }
    }
    return state;
  };
  const wake = async () => { await api.alarms?.create("vk-batch-reconcile", { periodInMinutes: 1 }); };
  const allowedScope = async (sender, rowKey = null) => { await authorize(sender); const found = await scope(sender, rowKey); if (!found.ok) fail(allowedCode(found.code), found.diagnostic); };
  const active = async () => { const s = await load(); return startsPending > 0 || (!!s && (!terminal(s) || s.uncertain)); };
  const submit = async (state, sender, message, retryEntry = null) => {
    if (!owns(state, sender)) fail("BATCH_WRONG_CONTROLLER");
    const retrying = retryEntry && state.entries[state.current] === retryEntry && retryEntry.status === "retry_wait";
    if (state.phase !== "running" || state.stopRequested || stopSignal === state.id || (state.current !== null && !retrying)) return;
    await allowedScope(sender, message.rowKey);
    let track;
    try { track = await metadata(sender, message.rowKey); }
    catch (error) {
      if (retrying) { await recordFailure(state, retryEntry, allowedCode(error.code), error.diagnostic, null, "retry_lookup"); return; }
      if (state.retryPolicyVersion === 2 && state.passRound > 0) return;
      if (state.retryTargets) return; // This row cannot be bound to any selected ID.
      if (state.entries.some(e => e.documentId === sender.documentId && e.rowKey === message.rowKey)) return;
      const code = allowedCode(error.code);
      state.entries.push({ id: null, title: label(message.title) || "Не удалось прочитать название", artist: label(message.artist),
        status: "error", code, attempts: 0, documentId: sender.documentId, rowKey: message.rowKey,
        finalFailure: { ...sanitizeDiagnostic({ ...error.diagnostic, operation: "metadata_initial" }), code, reason: code } });
      await save(state); return;
    }
    if (!retrying && state.retryPolicyVersion === 2 && state.passRound > 0) {
      const deferred = state.entries.find(e => e.id === track.id);
      if (!state.passTargets?.includes(track.id) || deferred?.status !== "deferred" || deferred.lastAttemptRound === state.passRound) return;
      state.current = state.entries.indexOf(deferred); deferred.status = "retry_wait";
      deferred.retryBinding = { rowKey: message.rowKey, documentId: sender.documentId };
      await save(state); await reconcileState(state);
      if (deferred.status === "retry_wait") await retry(state, sender, { ...message, type: "BATCH_RETRY" });
      return;
    }
    if (retrying && (track.id !== retryEntry.id || await identity(track) !== retryEntry.retryIdentity)) {
      await recordFailure(state, retryEntry, "TRACK_MISMATCH", { condition: "ID_OR_METADATA_CHANGED" }, null, "retry_lookup"); return;
    }
    if (state.retryTargets && !state.retryTargets.some(target => target.id === track.id)) return;
    let index = state.entries.findIndex(e => e.id === track.id);
    if (index >= 0 && state.entries[index].status !== "pending" && !retrying) return;
    if (index < 0) {
      state.entries.push({ id: track.id, title: label(track.title), artist: label(track.artist), status: "pending", attempts: 0 });
      index = state.entries.length - 1;
    }
    const entry = state.entries[index], past = await history();
    if (entry.attempts >= 3) { entry.status = "error"; entry.code = entry.lastFailure?.code || "PREPARATION_INTERRUPTED"; if (state.current === index) state.current = null; await save(state); return; }
    if (past[track.id]) {
      const [known] = await api.downloads.search({ id: past[track.id].downloadId });
      if (known?.exists === false) { try { await forgetDownload(api, past[track.id].downloadId); } catch { fail("BATCH_STORAGE"); } }
      else {
        entry.status = "skipped"; if (state.current === index) state.current = null; delete entry.retryAt; await save(state);
        return;
      }
    }
    entry.status = "preparing"; entry.attempts = (entry.attempts || 0) + 1;
    entry.lastAttemptRound = state.passRound || 0;
    entry.retryBinding = { rowKey: message.rowKey, documentId: sender.documentId };
    entry.retryIdentity = await identity(track);
    delete entry.retryAt; state.current = index; await save(state);
    let operation = "source_read", sourceFacts = null;
    try {
      await singleIdle();
      const source = await readRow(sender, message.rowKey);
      const approvedHosts = await approvedExactHosts(api);
      sourceFacts = sourceDiagnostic(source.url, approvedHosts);
      observeSource(entry, { ...sourceFacts, stage: "source_url", operation, attempt: entry.attempts });
      if (["id", "title", "artist"].some(key => source[key] !== track[key])) throw new PrototypeError("TRACK_MISMATCH", { condition: "ID_OR_METADATA_CHANGED" });
      const url = wholeObjectUrl(source.url, approvedHosts);
      operation = "cdn_probe";
      const prepared = await inspectSource(url);
      observeSource(entry, { ...prepared.diagnostic, operation, attempt: entry.attempts });
      operation = "row_recheck";
      await allowedScope(sender, message.rowKey);
      const current = await readRow(sender, message.rowKey);
      if (["id", "title", "artist", "url"].some(key => current[key] !== source[key])) throw new PrototypeError("TRACK_MISMATCH", { condition: "SOURCE_CHANGED" });
      await singleIdle();
      if (stopSignal === state.id) { state.stopRequested = true; fail("STOPPED_BEFORE_START"); }
      operation = "filename_build";
      const preferred = entry.fallbackPreferred === true;
      const naming = downloadFilenameFor(track, prepared.mime, preferred);
      let filename = "Моя музыка/" + naming.filename, filenameMode = naming.filenameMode;
      if (entry.attempts > 1 && entry.downloadId != null) {
        const [previous] = await api.downloads.search({ id: entry.downloadId });
        if (previous?.state === "complete" || previous?.state === "in_progress") {
          entry.status = "downloading"; await save(state); await reconcileState(state); return;
        }
        if (!previous || !transientReason("DOWNLOAD_INTERRUPTED", null, previous)) {
          await recordFailure(state, entry, previous ? "DOWNLOAD_INTERRUPTED" : "DOWNLOAD_MISSING", null, previous, "download_check"); return;
        }
      }
      const launch = async () => {
        await authorize(sender);
        Object.assign(entry, { size: prepared.size, mime: prepared.mime, status: "starting", filenameMode }); delete entry.downloadId;
        await save(state);
        if (stopSignal === state.id || state.stopRequested) { state.stopRequested = true; fail("STOPPED_BEFORE_START"); }
        await authorize(sender);
        operation = "download_start";
        // Only this native rejection is a known refusal before an ID. Persistence errors are outside the catch.
        let downloadId;
        try { downloadId = await api.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false }); }
        catch (error) { return { error }; }
        if (!validDownloadId(downloadId)) { state.uncertain = true; state.phase = "attention"; state.reason = "DOWNLOAD_START_UNCERTAIN"; await save(state); return { uncertain: true }; }
        entry.downloadId = downloadId; entry.status = "downloading";
        if (filenameMode === "fallback") entry.fallbackPreferred = true;
        // Persist accepted ID before any continuation; an old starting intent remains blocking on failure.
        try { await save(state); } catch { return { uncertain: true }; }
        return { accepted: true };
      };
      let launched = await launch();
      if (launched.uncertain) return;
      if (launched.error) {
        const rejected = launchDiagnostic(launched.error, filename, filenameMode);
        observeSource(entry, { ...sourceFacts, ...rejected, attempt: entry.attempts }, "DOWNLOAD_START");
        if (filenameMode === "fallback" || !mayFallbackWithoutDialog(launched.error)) throw new PrototypeError("DOWNLOAD_START", rejected);
        entry.status = "fallback_pending"; await save(state);
        if (stopSignal === state.id || state.stopRequested) { state.stopRequested = true; fail("STOPPED_BEFORE_START"); }
        operation = "row_recheck";
        await allowedScope(sender, message.rowKey);
        const refreshed = await readRow(sender, message.rowKey);
        if (["id", "title", "artist", "url"].some(key => refreshed[key] !== source[key])) throw new PrototypeError("TRACK_MISMATCH", { condition: "SOURCE_CHANGED" });
        await singleIdle();
        operation = "filename_build"; filename = "Моя музыка/" + fallbackFilename(track.id, prepared.mime); filenameMode = "fallback";
        entry.fallbackAttempt = entry.attempts;
        launched = await launch();
        if (launched.uncertain) return;
        if (launched.error) throw new PrototypeError("DOWNLOAD_START", launchDiagnostic(launched.error, filename, filenameMode));
      }
    } catch (error) {
      if (error.code === "BATCH_STORAGE") return; // Keep the last durable intent; never guess whether a native call happened.
      if (Object.hasOwn(workingAccountMessages, error.code)) {
        entry.status = state.passRound > 0 ? 'deferred' : 'pending'; state.current = null;
        await pause(state,error.code); return; // No native launch occurred; source/preparation is discarded.
      }
      await recordFailure(state, entry, allowedCode(error.code), { ...sourceFacts, ...error.diagnostic,
        host: error.diagnostic?.host || sourceFacts?.host }, null, operation);
      if (["ROW_MISSING", "PAGE_SCOPE"].includes(entry.code) || entry.code.startsWith("LIBRARY_")) {
        entry.status = "pending"; await pause(state, entry.code, error.scopeDiagnostic);
      }
      await save(state);
    }
    if (state.current === null && (state.stopRequested || stopSignal === state.id)) { state.stopRequested = true; await finish(state, "BATCH_STOPPED"); }
    else await reconcileState(state);
  };
  const retry = async (state, sender, message) => {
    if (!owns(state, sender)) fail("BATCH_WRONG_CONTROLLER");
    const entry = state.entries[state.current];
    if (state.phase !== "running" || entry?.status !== "retry_wait" || state.stopRequested || stopSignal === state.id || now() < entry.retryAt) return;
    if (message.rowKey !== entry.retryBinding?.rowKey || sender.documentId !== entry.retryBinding?.documentId || message.type === "BATCH_RETRY_MISSING") {
      if (state.retryPolicyVersion === 2) {
        try { await allowedScope(sender); } catch { await pause(state, "RETRY_ROW_UNAVAILABLE"); return; }
        entry.status = "deferred"; state.current = null; state.passToken++; await save(state); return;
      }
      await pause(state, "RETRY_ROW_UNAVAILABLE"); return;
    }
    try { await allowedScope(sender, message.rowKey); }
    catch { await pause(state, "RETRY_ROW_UNAVAILABLE"); return; }
    let track;
    try { track = await metadata(sender, message.rowKey); }
    catch (error) { await recordFailure(state, entry, allowedCode(error.code), error.diagnostic, null, "retry_lookup"); return; }
    if (track.id !== entry.id || !entry.retryIdentity || await identity(track) !== entry.retryIdentity) {
      await recordFailure(state, entry, "TRACK_MISMATCH", { condition: "ID_OR_METADATA_CHANGED" }, null, "retry_lookup"); return;
    }
    // Remain durably locked in retry_wait until submit persists the next preparing intent.
    try { await submit(state, sender, message, entry); }
    catch (error) {
      if (entry.status === "retry_wait") await pause(state, "RETRY_ROW_UNAVAILABLE");
      else throw error;
    }
  };
  const endPass = async state => {
    if (state.passRound === 0) { state.mainPassComplete = true; state.mainStopReason = "NO_PROGRESS_NOT_END"; }
    if (state.passRound >= 2) {
      for (const entry of state.entries) if (entry.status === "deferred") {
        entry.status = "error"; entry.roundsExhausted = true;
        if (entry.lastAttemptRound !== state.passRound) {
          entry.code = "DEFERRED_ID_NOT_FOUND";
          entry.finalFailure = { code: entry.code, reason: entry.code, operation: "retry_lookup", stage: "row_data", condition: "DEFERRED_ID_NOT_FOUND" };
        }
      }
      await finish(state, "NO_PROGRESS_NOT_END"); return;
    }
    const targets = state.entries.filter(e => e.status === "deferred" && e.attempts < 3).map(e => e.id);
    if (!targets.length) { await finish(state, "NO_PROGRESS_NOT_END"); return; }
    state.passRound++; state.passToken++; state.passTargets = targets;
    state.reason = null; await save(state);
  };
  const handle = (message, sender) => {
    if (message.type === "BATCH_STOP") stopSignal = message.runId;
    if (message.type === "BATCH_START") startsPending++;
    return serial(async () => {
      let state = await reconcileState(await load());
      if (!['BATCH_PAUSE'].includes(message.type)) await authorize(sender);
      if (message.type === "BATCH_STATUS") {
        if (state && !terminal(state) && state.tabId === sender.tab.id && state.documentId !== sender.documentId && state.phase === "running") {
          await pause(state, "BATCH_WAITING_PAGE");
        }
        const plan = await readRetryPlan(api);
        return { ok: true, batch: view(state, message.includeEntries === true), retryPlan: plan ? { id: plan.id, count: plan.entries.length } : null };
      }
      if (message.type === "BATCH_START") {
        if (state?.uncertain) fail("DOWNLOAD_START_UNCERTAIN");
        if (state && !terminal(state)) fail("BATCH_ACTIVE");
        await singleIdle(); await allowedScope(sender);
        let plan = null;
        if (message.retryPlanId) {
          plan = await readRetryPlan(api); if (!plan || plan.id !== message.retryPlanId) fail("RETRY_PLAN_INVALID");
          for (const host of plan.hosts) await ensureSourceAccess(api, `https://${host}/`);
        }
        state = { id: uuid(), ...(account ? {account} : {}), retryPolicyVersion: 2, passRound: 0, passToken: 1, mode: plan ? "source_retry" : "scroll", ...(plan ? { retryTargets: plan.entries } : {}), phase: "running", reason: null, stopRequested: false, tabId: sender.tab.id,
          documentId: sender.documentId, current: null, entries: [], startedAt: now() };
        stopSignal = null;
        if (plan) await put({ [STATE]: state, [retryPlanKey]: null }); else await save(state);
        await wake();
      } else if (!state || message.runId !== state.id) fail("BATCH_ACTIVE");
      else if (message.type === "BATCH_RESUME") {
        if (state.uncertain) fail("DOWNLOAD_START_UNCERTAIN");
        if (terminal(state)) fail("BATCH_ACTIVE");
        if (state.phase === "running" && !owns(state, sender)) fail("BATCH_ACTIVE");
        await allowedScope(sender); state.tabId = sender.tab.id; state.documentId = sender.documentId;
        if (state.retryPolicyVersion === 2) {
          if (state.entries[state.current]?.status === "retry_wait") { state.entries[state.current].status = "deferred"; state.current = null; }
          state.passToken++;
        }
        state.mode = state.retryTargets ? "source_retry" : "scroll"; state.phase = "running"; state.reason = null; state.scopeDiagnostic = null; state.reportRequested = false; await save(state); await wake();
      } else if (message.type === "BATCH_STOP") {
        if (!terminal(state)) {
          state.stopRequested = true;
          if (state.current === null || state.uncertain || state.entries[state.current]?.status === "retry_wait") await finish(state, "BATCH_STOPPED"); else await save(state);
        }
      } else if (["BATCH_RETRY", "BATCH_RETRY_MISSING"].includes(message.type)) {
        if (message.passToken == null || message.passToken === state.passToken) await retry(state, sender, message);
      }
      else if (message.type === "BATCH_ROW") {
        if (message.passToken == null || message.passToken === state.passToken) await submit(state, sender, message);
      }
      else if (message.type === "BATCH_PAUSE") {
        if (!owns(state, sender)) fail("BATCH_WRONG_CONTROLLER");
        await pause(state, allowedCode(message.reason), message.diagnostic);
      } else if (message.type === "BATCH_FINISH") {
        if (!owns(state, sender)) fail("BATCH_WRONG_CONTROLLER");
        if (state.current === null && state.phase === "running" && (message.passToken == null || message.passToken === state.passToken)) {
          if (state.retryPolicyVersion === 2 && message.reason === "NO_PROGRESS_NOT_END") await endPass(state);
          else await finish(state, allowedCode(message.reason));
        }
      } else if (message.type === "BATCH_REPORT") await openReport(state);
      return { ok: true, batch: view(await load(), message.includeEntries === true) };
    }).catch(error => ({ ok: false, code: allowedCode(error.code), message: batchReason(allowedCode(error.code)) +
      (error.scopeDiagnostic ? "\n" + globalThis.VkMusicLibraryScopeDiagnostic(error.scopeDiagnostic) : "") }))
      .finally(() => { if (message.type === "BATCH_START") startsPending--; });
  };
  const reconcile = recovering => serial(async () => {
    const s = await reconcileState(await load(), recovering);
    if (recovering && s && !terminal(s) && !s.uncertain) await wake();
    return view(s);
  }).catch(() => null);
  const pageClosed = tabId => serial(async () => {
    const s = await load(); if (s && !terminal(s) && s.tabId === tabId) await pause(s, "BATCH_WAITING_PAGE");
  }).catch(() => {});
  const fileRemoved = downloadId => serial(async () => {
    await forgetDownload(api, downloadId);
  }).catch(() => {});
  const accountLost = reason => serial(async () => { const s=await load(); if(s && !terminal(s) && (s.phase!=='waiting_page' || s.reason!==allowedCode(reason))) await pause(s,allowedCode(reason)); }).catch(()=>{});
  const blocking = async () => { const s=await load(); return startsPending > 0 || !!s && (s.uncertain || s.phase === 'running' || ['starting','downloading'].includes(s.entries?.[s.current]?.status)); };
  return { handle, active, blocking, reconcile, pageClosed, fileRemoved, accountLost };
}
