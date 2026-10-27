(() => {
  "use strict";
  if (globalThis.__vkdlBatchContent) return;
  globalThis.__vkdlBatchContent = true;
  let owner = globalThis.VkWorkingAccount?.libraryOwnerId;
  let panel = null, state = null, retryPlan = null, note = "Готов к ручному запуску. Музыка не запускается.", walking = false, epoch = 0, polling = false, commanding = false, scopeFailure = false;
  const eligible = () => {
    const u = new URL(location.href);
    return globalThis.VkWorkingAccount?.allowed === true && u.origin === "https://vk.ru" && u.pathname === `/audios${owner}` &&
      (!u.searchParams.has("section") || u.searchParams.get("section") === "all") &&
      !["q", "z", "playlist_id", "album_id"].some(key => u.searchParams.has(key));
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const quietWaitMs = 15000, quietRoundsRequired = 8;
  const scope = () => globalThis.VkMusicLibraryScope(null, owner);
  const scopeExplanation = code => ({
    PAGE_SCOPE: "Откройте личную «Моя музыка» → «Все», без поиска и плейлиста.",
    LIBRARY_SECTION_MISSING: "Основная секция треков не найдена.",
    LIBRARY_SECTION_AMBIGUOUS: "Найдено несколько секций треков; выбирать одну автоматически нельзя.",
    LIBRARY_HEADER_INVALID: "Не подтверждён единственный заголовок «Треки».",
    LIBRARY_LIST_MISSING: "В основной секции не найден ожидаемый список.",
    LIBRARY_LIST_AMBIGUOUS: "В основной секции несколько подходящих списков.",
    LIBRARY_ROWS_EMPTY: "В основном списке пока нет распознанных строк; конец библиотеки не подтверждён."
  })[code] || "Область списка не удалось проверить.";
  const terminal = s => !s || ["finished", "stopped"].includes(s.phase);
  async function send(message) {
    const generation=globalThis.VkWorkingAccount?.generation;
    try { const response=await chrome.runtime.sendMessage(message);
      if(generation!==globalThis.VkWorkingAccount?.generation) return {ok:false,code:'ACCOUNT_CHANGED',message:'Аккаунт/страница изменились; прежний ответ очереди не применяется.'};
      return response;
    }
    catch { return { ok: false, code: "BATCH_CHANNEL", message: "Связь с worker потеряна. Новые задания не запускаются; после восстановления нажмите «Продолжить обход»." }; }
  }
  function render() {
    if (!panel) return;
    const account=globalThis.VkWorkingAccount;
    panel.status.textContent = `Аккаунт и библиотека: ${account?.accountId || 'не установлен'}. История успехов: ${Number.isSafeInteger(account?.historyCount) ? account.historyCount : 'не прочитана'}.\n${note}\n${state ? `Состояние: ${state.phase}${state.reason ? " · " + state.reason : ""}${state.reasonText ? "\n" + state.reasonText : ""}\nОбнаружено: ${state.discovered}; сохранено: ${state.saved}; пропущено по истории: ${state.skipped}; ошибки: ${state.errors}.` : "Активного обхода нет."}`;
    if (state) panel.status.textContent += `\nПроход: ${state.passRound ? `круг повторов ${state.passRound}/2` : "основной"}; отложено: ${state.deferred || 0}. Полнота не подтверждена.`;
    if (state?.retry) panel.status.textContent += `\nПовтор ${state.retry.number}/2 через ${Math.ceil(state.retry.remainingMs / 1000)} с. ` +
      (state.phase === "running" ? "Источник будет прочитан заново из прежней строки." : "Ожидание сохранено. Для продолжения нажмите «Продолжить обход».");
    panel.start.disabled = !terminal(state) || !!state?.uncertain || walking || commanding;
    panel.resume.disabled = !state || terminal(state) || !["waiting_page", "running"].includes(state.phase) || !!state.uncertain || walking || commanding;
    panel.stop.disabled = !state || terminal(state) || state.stopRequested;
    panel.report.disabled = !state?.reportReady;
    panel.retry.disabled = !retryPlan || !terminal(state) || walking || commanding || !!state?.uncertain;
    panel.retry.textContent = retryPlan ? `Дозагрузить разрешённые (${retryPlan.count})` : "Дозагрузить разрешённые";
  }
  function accept(result) {
    if (result?.ok) {
      state = result.batch;
      if (Object.hasOwn(result, "retryPlan")) retryPlan = result.retryPlan;
      if (state && terminal(state) && !scopeFailure) note = state.phase === "stopped" ? "Обход остановлен пользователем." : "Обход остановлен. Полнота библиотеки не подтверждена.";
      render(); return true;
    }
    scopeFailure = result?.code === "PAGE_SCOPE" || result?.code?.startsWith("LIBRARY_") === true;
    note = `${result?.code || "BATCH_INTERNAL"}: ${result?.message || "Ответ очереди не получен."}`; render(); return false;
  }
  function mount() {
    if (panel?.host.isConnected) return;
    const host = document.createElement("aside"); host.setAttribute("data-vkdl-ui", ""); host.setAttribute("data-vkdl-batch", "");
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ':host{position:fixed;left:12px;bottom:12px;z-index:2147483646;display:block;max-width:min(365px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;color:#18283b;font:13px/1.45 system-ui}section{padding:12px;background:white;border:1px solid #8b9bac;border-radius:8px;box-shadow:0 3px 15px #0002}p{margin:7px 0;white-space:pre-line;overflow-wrap:anywhere}button{font:inherit;padding:7px 9px;margin:3px 3px 3px 0;background:#edf3fb;border:1px solid #8eb8e8;border-radius:5px;color:#064b94;cursor:pointer}button:disabled{opacity:.55;cursor:default}button:focus-visible{outline:2px solid #075cc1}';
    style.textContent += '@media(max-width:850px){:host{top:12px;bottom:auto;max-height:calc(40vh - 24px)}}';
    root.append(style); const section = document.createElement("section"), heading = document.createElement("strong");
    heading.textContent = "Скачать мою музыку · последовательная очередь";
    const info = document.createElement("p");
    info.textContent = "С начала основного списка, без ограничения числа треков. Папка: Загрузки / Моя музыка. Держите вкладку VK открытой.";
    const status = document.createElement("p"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    panel = { host, status };
    const buttons = [["start", "Скачать всю мою музыку", () => begin(false)], ["resume", "Продолжить обход", () => begin(true)],
      ["stop", "Остановить после текущего файла", stop], ["retry", "Дозагрузить разрешённые", () => begin(false, true)], ["report", "Открыть отчёт", async () => { accept(await send({ type: "BATCH_REPORT", runId: state?.id })); }]];
    section.append(heading, info);
    for (const [key, title, handler] of buttons) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = title; panel[key] = button;
      button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); if (event.isTrusted) void handler(); }); section.append(button);
    }
    for (const name of ["pointerdown", "mousedown", "click", "dblclick", "keydown", "keyup"]) host.addEventListener(name, event => event.stopPropagation());
    section.append(status); root.append(section); document.body.append(host); render();
  }
  function scroller(list) {
    for (let node = list; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 4) return node;
    }
    return document.scrollingElement;
  }
  async function beginning() {
    let found = scope(); if (!found.ok) throw found;
    const parent = scroller(found.list);
    if (parent === document.scrollingElement) window.scrollTo({ top: Math.max(0, found.header.getBoundingClientRect().top + window.scrollY - 24), behavior: "instant" });
    else parent.scrollTo({ top: 0, behavior: "instant" });
    await sleep(1400);
    found = scope(); if (!found.ok) throw found;
    const first = found.rows[0].getBoundingClientRect(), list = found.list.getBoundingClientRect();
    if (Math.abs(first.top - list.top) > Math.max(120, first.height * 2)) throw { code: "START_NOT_CONFIRMED" };
    if (scroller(found.list) !== document.scrollingElement && scroller(found.list).scrollTop > 2) throw { code: "START_NOT_CONFIRMED" };
    return found;
  }
  async function scrollStep(list) {
    const parent = scroller(list), doc = parent === document.scrollingElement;
    const height = doc ? innerHeight : parent.clientHeight;
    const before = doc ? scrollY : parent.scrollTop;
    const rect = list.getBoundingClientRect();
    if (!Number.isFinite(rect.bottom) || rect.height <= 0 || height <= 0) throw { code: "SCROLL_GEOMETRY_UNAVAILABLE" };
    const end = parent === list ? parent.scrollHeight : doc ? rect.bottom + scrollY :
      rect.bottom - parent.getBoundingClientRect().top + parent.scrollTop - parent.clientTop;
    const maximum = Math.max(0, Math.min(parent.scrollHeight - height, end - height + (parent === list ? 0 : 24)));
    const target = Math.min(maximum, before + Math.max(120, height * 0.6));
    if (doc) window.scrollTo({ top: target, behavior: "instant" }); else parent.scrollTo({ top: target, behavior: "instant" });
    await sleep(1100);
    return (doc ? scrollY : parent.scrollTop) > before + 2;
  }
  async function begin(resume, sourceRetry = false) {
    if (walking || commanding || !eligible()) return;
    const found = scope(); if (!found.ok) {
      scopeFailure = true;
      note = `${found.code}: ${scopeExplanation(found.code)} Обход не запущен.\n${globalThis.VkMusicLibraryScopeDiagnostic(found.diagnostic)}`;
      render(); return;
    }
    scopeFailure = false;
    commanding = true; render();
    if (sourceRetry && !retryPlan) { commanding = false; render(); return; }
    const result = await send({ type: resume ? "BATCH_RESUME" : "BATCH_START", runId: state?.id,
      ...(sourceRetry ? { retryPlanId: retryPlan.id } : {}) });
    commanding = false;
    if (!accept(result)) return;
    const mine = ++epoch; walking = true; note = state?.mode === "source_retry" ?
      "Повторный обход с начала для выбранных ID. Ссылки читаются заново; другие треки не скачиваются." :
      "Автопрокрутка и последовательная очередь. Остановка позволит текущему файлу завершиться."; render();
    let visited = new WeakMap(), passToken = state.passToken;
    let previousList = null, knownIds = state.uniqueIds || 0, lastNewId = performance.now();
    let blockedSince = null, quietRounds = 0, attemptsWithoutNewId = 0, unmarkedSince = null, replacements = 0, endProbeGranted = false;
    const observe = () => {
      if ((state?.uniqueIds || 0) <= knownIds) return false;
      knownIds = state.uniqueIds; lastNewId = performance.now();
      blockedSince = null; quietRounds = 0; attemptsWithoutNewId = 0; replacements = 0; endProbeGranted = false; return true;
    };
    try {
      let current = state?.retry ? scope() : await beginning(); if (!current.ok) throw current; previousList = current.list;
      while (mine === epoch && eligible() && state?.phase === "running" && !state.stopRequested) {
        if (state.passToken !== passToken) {
          passToken = state.passToken; visited = new WeakMap();
          knownIds = state.uniqueIds || 0; lastNewId = performance.now(); blockedSince = null; quietRounds = 0;
          attemptsWithoutNewId = 0; unmarkedSince = null; replacements = 0; endProbeGranted = false;
          current = await beginning(); previousList = current.list;
        }
        if (state.retry) {
          if (state.retry.remainingMs <= 0) {
            const found = scope();
            const rows = found.ok ? found.rows.filter(row => row.getAttribute("data-vkdl-row") === state.retry.rowKey) : [];
            if (!accept(await send({ type: rows.length === 1 ? "BATCH_RETRY" : "BATCH_RETRY_MISSING", runId: state.id, passToken, rowKey: state.retry.rowKey }))) break;
          }
          await sleep(500); if (!accept(await send({ type: "BATCH_STATUS" }))) break;
          blockedSince = null; quietRounds = 0; lastNewId = performance.now(); continue;
        }
        if (state.current) {
          await sleep(900); if (!accept(await send({ type: "BATCH_STATUS" }))) break;
          blockedSince = null; quietRounds = 0; lastNewId = performance.now(); continue;
        }
        current = scope();
        if (!current.ok) { await sleep(1200); current = scope(); if (!current.ok) throw current; }
        if (current.list !== previousList) {
          if (++replacements >= 6 && performance.now() - lastNewId >= quietWaitMs) throw { code: "LIBRARY_UNSTABLE" };
          current = await beginning(); previousList = current.list;
        }
        let row = current.rows.find(candidate => {
          const key = candidate.getAttribute("data-vkdl-row");
          const signature = [key, candidate.id, candidate.getAttribute("data-full-id"), candidate.getAttribute("data-audio"), candidate.textContent].join("\n");
          return key && visited.get(candidate) !== signature;
        });
        if (row) {
          const key = row.getAttribute("data-vkdl-row");
          visited.set(row, [key, row.id, row.getAttribute("data-full-id"), row.getAttribute("data-audio"), row.textContent].join("\n"));
          const visible = selector => row.querySelector(selector)?.textContent?.trim().slice(0, 500) || "";
          const result = await send({ type: "BATCH_ROW", runId: state.id, passToken, rowKey: key,
            title: visible('[data-testid="audiorow-title"],.audio_row__title_inner'), artist: visible('[data-testid="audiorow-performers"],.audio_row__performers') });
          if (!accept(result)) throw { code: result?.code || "LIBRARY_READ_FAILED" };
          unmarkedSince = null;
          const added = observe();
          await sleep(150);
          if (state.current || state.phase !== "running" || state.stopRequested) continue;
          if (added || ++attemptsWithoutNewId < current.rows.length) continue;
        }
        if (current.rows.some(candidate => !candidate.hasAttribute("data-vkdl-row"))) {
          unmarkedSince ??= performance.now();
          if (performance.now() - unmarkedSince >= 5000) throw { code: "LIBRARY_READ_FAILED" };
          await sleep(350); continue;
        }
        unmarkedSince = null; attemptsWithoutNewId = 0;
        if (mine !== epoch || !eligible() || state?.phase !== "running" || state.stopRequested) break;
        const advanced = await scrollStep(current.list);
        if (!accept(await send({ type: "BATCH_STATUS" }))) break;
        observe();
        if (advanced) { blockedSince = null; quietRounds = 0; endProbeGranted = false; }
        else {
          blockedSince ??= performance.now(); quietRounds++;
          if (quietRounds >= quietRoundsRequired && performance.now() - blockedSince >= quietWaitMs &&
              performance.now() - lastNewId >= quietWaitMs) {
            const finalScope = scope(); if (!finalScope.ok) throw finalScope;
            const unseen = finalScope.rows.some(candidate => {
              const key = candidate.getAttribute("data-vkdl-row");
              return key && visited.get(candidate) !== [key, candidate.id, candidate.getAttribute("data-full-id"), candidate.getAttribute("data-audio"), candidate.textContent].join("\n");
            });
            if (!endProbeGranted && unseen) { endProbeGranted = true; continue; }
            if (!accept(await send({ type: "BATCH_FINISH", runId: state.id, passToken, reason: "NO_PROGRESS_NOT_END" }))) break;
            if (state?.phase === "running" && state.passToken !== passToken) continue;
            break;
          }
        }
      }
    } catch (failure) {
      if (mine === epoch && eligible() && state && !terminal(state)) {
        const reason = typeof failure?.code === "string" ? failure.code : "BATCH_INTERNAL";
        accept(await send({ type: reason === "NO_PROGRESS_NOT_END" ? "BATCH_FINISH" : "BATCH_PAUSE", runId: state.id,
          reason, diagnostic: failure?.diagnostic }));
      }
    } finally {
      if (mine === epoch) { walking = false; if (state?.phase === "waiting_page") note = "Очередь сохранена. Требуется явное продолжение на странице с основным списком."; render(); }
    }
  }
  async function stop() {
    if (!state || terminal(state)) return;
    scopeFailure = false;
    epoch++; walking = false;
    note = "Остановка запрошена. Новые задания не берутся; текущему файлу разрешено завершиться."; render();
    accept(await send({ type: "BATCH_STOP", runId: state.id }));
  }
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      if (!eligible()) {
        epoch++; walking = false;
        if (panel && state && !terminal(state)) await send({ type: "BATCH_PAUSE", runId: state.id, reason: "BATCH_WAITING_PAGE" });
        panel?.host.remove(); panel = null; return;
      }
      mount(); accept(await send({ type: "BATCH_STATUS" }));
    } finally { polling = false; }
  }
  addEventListener("popstate", () => { void poll(); }); addEventListener("hashchange", () => { void poll(); });
  addEventListener('vkdl-account-change', () => {
    epoch++; walking=false; commanding=false;
    owner=globalThis.VkWorkingAccount?.libraryOwnerId;
    state=null; retryPlan=null; panel?.host.remove(); panel=null;
    note='Аккаунт проверен. Продолжение сохранённой очереди — только явным нажатием.';
    void poll();
  });
  setInterval(() => { void poll(); }, 1500); void poll();
})();
