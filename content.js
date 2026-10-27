(() => {
  "use strict";
  if (globalThis.__vkPersonalAudioPrototype) return;
  globalThis.__vkPersonalAudioPrototype = true;
  let ownerId = globalThis.VkWorkingAccount?.libraryOwnerId;
  const rowSelector = '[data-testid="MusicTrackRow"], [data-testid="MusicTrackCell"], [data-testid="MusicTrackItem"], .audio_row[data-audio], .audio_row[data-full-id]';
  const records = new Map();
  let banner, active = false, busy = false, scanning = false, polling = false;
  let latest = "Музыка не запускается. Нажмите «Скачать» у одного трека. Формат определяется после проверки CDN.";
  let displayedJobId = null, restoreJobs = true;
  let diagnosticLocked = false, attemptNumber = 0;
  let fallbackOffer = null;
  const slotWidth = 112, slotGap = 8;
  let placementQueued = false;
  const rowResize = new ResizeObserver(schedulePlacement);
  const layoutCss = document.createElement("span").style;

  function eligible() {
    const u = new URL(location.href);
    return globalThis.VkWorkingAccount?.allowed === true && u.origin === "https://vk.ru" && u.pathname === `/audios${ownerId}` &&
      (!u.searchParams.has("section") || u.searchParams.get("section") === "all") &&
      !["z", "playlist_id", "album_id", "q"].some(key => u.searchParams.has(key));
  }

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message) || { ok: false, message: clientDiagnostic("UI_NO_REPLY", "связь с расширением", "Нет ответа расширения. Перезагрузите его и страницу.") };
    } catch {
      return { ok: false, message: clientDiagnostic("UI_CHANNEL", "связь с расширением", "Связь с расширением потеряна. Перезагрузите страницу; результат не подтверждён.") };
    }
  }

  function clientDiagnostic(code, stage, message, context) {
    return `${message} Код: ${code}. Этап: ${stage}. ${context || "Состояние запроса к CDN неизвестно. HTTP проверки: нет данных; Content-Type: нет данных. Сервер и класс источника не установлены."}`;
  }

  function textWithoutUi(row) {
    const clone = row.cloneNode(true);
    clone.querySelectorAll("[data-vkdl-ui]").forEach(node => node.remove());
    return [row.id, row.getAttribute("data-full-id"), row.getAttribute("data-audio"), clone.textContent.replace(/\s+/g, " ").trim()].join("\n");
  }

  function shell(tag, css) {
    const host = document.createElement(tag);
    host.setAttribute("data-vkdl-ui", "");
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = css;
    shadow.append(style);
    return { host, shadow };
  }

  function ensureBanner() {
    if (banner?.host.isConnected) return;
    banner = shell("aside", ':host{position:fixed;right:12px;bottom:12px;z-index:2147483646;display:block;max-width:min(400px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;font:13px/1.45 system-ui;color:#18283b}section{background:#fff;border:1px solid #8b9bac;border-radius:8px;padding:10px 12px;box-shadow:0 3px 15px #0002}strong{display:block}p{margin:5px 0 0;overflow-wrap:anywhere}');
    const section = document.createElement("section");
    const heading = document.createElement("strong");
    heading.textContent = "Моя музыка · скачивание";
    banner.count = document.createElement("p");
    banner.status = document.createElement("p");
    banner.status.setAttribute("role", "status");
    banner.status.setAttribute("aria-live", "polite");
    section.append(heading, banner.count, banner.status);
    banner.fallbackButton = document.createElement("button"); banner.fallbackButton.type = "button";
    banner.fallbackButton.textContent = "Сохранить с резервным именем"; banner.fallbackButton.hidden = true;
    banner.fallbackButton.setAttribute("data-vkdl-fallback", "");
    banner.fallbackHint = document.createElement("p"); banner.fallbackHint.hidden = true;
    banner.fallbackHint.textContent = "Обычный запуск отклонён; отмену диалога нельзя надёжно отличить от отказа имени. Автоматического повтора нет. Эта кнопка заново проверит тот же трек и CDN, затем откроет диалог с коротким именем track_<owner_id>_<id>.";
    banner.fallbackButton.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      if (event.isTrusted && validFallbackOffer()) void choose(fallbackOffer.record, true).catch(() => {
        busy = false; showDiagnostic(clientDiagnostic("UI_INTERNAL", "резервное сохранение", "Результат не подтверждён. Проверьте загрузки браузера.")); refreshDisabled();
      });
    });
    section.append(banner.fallbackButton, banner.fallbackHint);
    banner.shadow.append(section);
    document.body.append(banner.host);
  }

  function announce(text, force = false) {
    if (diagnosticLocked && !force) return;
    latest = text;
    if (banner) banner.status.textContent = latest;
  }

  function showDiagnostic(text, record) {
    if (diagnosticLocked) return;
    diagnosticLocked = true;
    if (record) setRow(record, text, true);
    announce(text, true);
  }

  function setRow(record, text, error = false) {
    record.status.textContent = text;
    record.status.style.color = error ? "#b42318" : "#315474";
    record.button.title = text;
  }

  function validFallbackOffer() {
    const offer = fallbackOffer;
    return !!offer && eligible() && offer.record.row.isConnected && records.get(offer.record.key) === offer.record &&
      offer.record.row.getAttribute("data-vkdl-row") === offer.record.key && textWithoutUi(offer.record.row) === offer.fingerprint;
  }

  async function choose(record, fallback = false) {
    if (busy || !eligible() || !record.row.isConnected) return;
    if (fallback && (!validFallbackOffer() || fallbackOffer.record !== record)) return;
    const offer = fallbackOffer; fallbackOffer = null;
    busy = true;
    attemptNumber++;
    const attempt = attemptNumber;
    diagnosticLocked = false;
    restoreJobs = false;
    displayedJobId = null;
    record.fingerprint = textWithoutUi(record.row);
    setRow(record, "Проверка данных и CDN…");
    announce("Проверка только выбранной строки. Воспроизведение не меняется.");
    refreshDisabled();
    let ticketId;
    try {
      const prepared = await send({ type: fallback ? "PREPARE_FALLBACK" : "PREPARE", rowKey: record.key, ...(fallback ? { rejectionId: offer.rejectionId } : {}) });
      ticketId=prepared?.ticketId;
      if(attempt!==attemptNumber || !eligible()) return;
      if (!prepared.ok) { showDiagnostic(prepared.message, record); return; }
      ticketId = prepared.ticketId;
      if (!eligible() || !record.row.isConnected || textWithoutUi(record.row) !== record.fingerprint) {
        showDiagnostic(clientDiagnostic("UI_ROW_CHANGED", "проверка строки перед сохранением", "Строка изменилась при подготовке. Скачивание отменено.", prepared.diagnosticText), record);
        return;
      }
      record.trackId = prepared.trackId;
      const identity = `${prepared.artist} — ${prepared.title} [${prepared.trackId}]`;
      announce(`${identity} · связь: ${prepared.binding} · ${prepared.size} байт · тип CDN: ${prepared.mime}. Ожидается сохранение браузером.`);
      const started = await send({ type: "START", ticketId });
      ticketId = null;
      if(attempt!==attemptNumber || !eligible()) return;
      if (!started.ok) {
        if (!fallback && started.fallbackAvailable === true && /^[a-f0-9-]{36}$/.test(started.rejectionId || "") && record.row.isConnected &&
            textWithoutUi(record.row) === record.fingerprint) fallbackOffer = { record, rejectionId: started.rejectionId, fingerprint: record.fingerprint };
        showDiagnostic(started.message, record); return;
      }
      record.downloadId = started.job.downloadId;
      displayedJobId = started.job.downloadId;
      renderJob(started.job);
    } finally {
      if (ticketId) await send({ type: "ABORT", ticketId });
      busy = false;
      refreshDisabled();
      await pollJobs();
    }
  }

  function refreshDisabled() {
    for (const record of records.values()) record.button.disabled = busy || pollingDownload;
    if (banner?.fallbackButton) {
      const available = validFallbackOffer();
      banner.fallbackButton.hidden = !available; banner.fallbackHint.hidden = !available;
      banner.fallbackButton.disabled = busy || pollingDownload || !available;
    }
  }
  let pollingDownload = false;

  function renderJob(job) {
    const identity = `${job.artist} — ${job.title} [${job.trackId}]`;
    let text;
    if (job.phase === "saved") text = `${job.fallbackUsed ? "Сохранено с резервным именем" : "Сохранено"} · ${job.size} байт, размер совпал. Длительность и звук проверьте в плеере.`;
    else if (job.phase === "error") text = job.message || "Результат не подтверждён.";
    else text = `Скачивание: ${Math.min(100, Math.floor((job.received || 0) / job.size * 100))}% · ожидается завершение браузером.`;
    const record = records.get(job.rowKey);
    if (record && record.trackId === job.trackId && textWithoutUi(record.row) === record.fingerprint) setRow(record, text, job.phase === "error");
    if (job.downloadId === displayedJobId) {
      if (job.phase === "error") showDiagnostic(text);
      else announce(`${identity} · ${text}`);
    }
  }

  async function pollJobs() {
    if (!active || polling) return;
    polling = true;
    const attempt = attemptNumber;
    try {
      const result = await send({ type: "JOBS" });
      if (attempt !== attemptNumber) return;
      if (!result.ok) {
        if (pollingDownload && !busy) showDiagnostic(result.message);
        return;
      }
      pollingDownload = result.jobs.some(job => job.phase === "downloading");
      if (restoreJobs) {
        displayedJobId = result.jobs[0]?.downloadId ?? null;
        restoreJobs = false;
      }
      // Последняя загрузка — в панели; более старые обновляют только свои строки.
      for (const job of [...result.jobs].reverse()) renderJob(job);
      refreshDisabled();
    } finally { polling = false; }
  }

  function setLayoutStyle(record, property, value) {
    // CSSOM может нормализовать min(..., calc(...)); сравниваем канонические
    // значения, иначе наблюдение style само провоцировало бы новые сканирования.
    layoutCss.setProperty(property, value);
    value = layoutCss.getPropertyValue(property);
    const current = record.row.style.getPropertyValue(property);
    const priority = record.row.style.getPropertyPriority(property);
    const owned = record.layoutStyles.get(property);
    // Сохраняем и исходные стили, и последующие правки, сделанные самим VK.
    if (!owned || current !== owned.applied || priority !== "important") {
      record.layoutStyles.set(property, { value: current, priority, applied: value });
    } else owned.applied = value;
    if (current !== value || priority !== "important") record.row.style.setProperty(property, value, "important");
  }

  function reserveSlot(record) {
    const parent = record.row.parentElement;
    const parentStyle = getComputedStyle(parent);
    const available = parent.clientWidth - (parseFloat(parentStyle.paddingLeft) || 0) -
      (parseFloat(parentStyle.paddingRight) || 0);
    const width = available < 480 ? 40 : slotWidth;
    if (record.slotWidth !== width) {
      record.slotWidth = width;
      record.host.style.setProperty("inline-size", `${width}px`, "important");
      record.button.textContent = width === slotWidth ? "Скачать" : "↓";
      record.button.classList.toggle("compact", width !== slotWidth);
    }
    const owned = record.layoutStyles.get("max-inline-size");
    if (!owned || record.row.style.getPropertyValue("max-inline-size") !== owned.applied ||
        record.row.style.getPropertyPriority("max-inline-size") !== "important") {
      record.maxInlineSize = getComputedStyle(record.row).maxInlineSize;
    }
    const limit = `calc(100% - ${record.slotWidth + slotGap}px)`;
    const ceiling = record.maxInlineSize;
    setLayoutStyle(record, "max-inline-size", ceiling && ceiling !== "none" ? `min(${ceiling}, ${limit})` : limit);
    setLayoutStyle(record, "min-inline-size", "0px");
    setLayoutStyle(record, "box-sizing", "border-box");
  }

  function attachSlot(record) {
    const parent = record.row.parentElement;
    if (!parent) return;
    reserveSlot(record);
    // Не оборачиваем и не перемещаем DOM VK. Кнопка — сосед строки,
    // вне её capture/bubble пути и вне контейнера штатных действий.
    if (record.host.parentElement !== parent) parent.append(record.host);
    if (record.layoutParent !== parent) {
      const previous = record.layoutParent;
      record.layoutParent = parent;
      if (previous && ![...records.values()].some(other => other !== record && other.layoutParent === previous)) rowResize.unobserve(previous);
      rowResize.observe(parent);
    }
    rowResize.observe(record.row);
  }

  function removeSlot(record) {
    record.host.remove();
    rowResize.unobserve(record.row);
    for (const [property, saved] of record.layoutStyles) {
      if (record.row.style.getPropertyValue(property) !== saved.applied ||
          record.row.style.getPropertyPriority(property) !== "important") continue;
      if (saved.value) record.row.style.setProperty(property, saved.value, saved.priority);
      else record.row.style.removeProperty(property);
    }
    if (record.row.getAttribute("data-vkdl-row") === record.key) record.row.removeAttribute("data-vkdl-row");
    if (record.layoutParent && ![...records.values()].some(other => other !== record && other.layoutParent === record.layoutParent)) rowResize.unobserve(record.layoutParent);
  }

  function placeSlots() {
    placementQueued = false;
    if (!active) return;
    for (const record of records.values()) {
      if (!record.row.isConnected || !record.host.isConnected) continue;
      reserveSlot(record);
      const rowRect = record.row.getBoundingClientRect();
      const visible = rowRect.width > 0 && rowRect.height > 0;
      const visibility = visible ? "visible" : "hidden";
      if (record.host.style.visibility !== visibility) record.host.style.setProperty("visibility", visibility, "important");
      if (!visible) continue;
      const slotRect = record.host.getBoundingClientRect();
      // Измеряем фактический containing block через сам slot: это учитывает
      // позиционированного предка, рамки и прокрутку без правок стилей списка.
      const dx = rowRect.right + slotGap - slotRect.left;
      const dy = rowRect.top + (rowRect.height - slotRect.height) / 2 - slotRect.top;
      if (Math.abs(dx) > 0.25) record.host.style.setProperty("left", `${(parseFloat(record.host.style.left) || 0) + dx}px`, "important");
      if (Math.abs(dy) > 0.25) record.host.style.setProperty("top", `${(parseFloat(record.host.style.top) || 0) + dy}px`, "important");
    }
  }

  function schedulePlacement() {
    if (placementQueued) return;
    placementQueued = true;
    requestAnimationFrame(placeSlots);
  }

  function mount(row) {
    const existing = [...records.values()].find(record => record.row === row);
    if (existing) { attachSlot(existing); return; }
    const key = crypto.randomUUID();
    row.setAttribute("data-vkdl-row", key);
    const { host, shadow } = shell("span", ':host{font:12px/1.35 system-ui}button{box-sizing:border-box;display:block;width:100%;height:32px;font:12px/1.35 system-ui;background:#e8f1ff;color:#064b94;border:1px solid #8eb8e8;border-radius:5px;padding:5px 8px;cursor:pointer;white-space:nowrap}button.compact{font-size:20px;line-height:1}button:hover{background:#d8e9ff}button:focus-visible{outline:2px solid #075cc1;outline-offset:2px}button:disabled{opacity:.55;cursor:wait}.status{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}');
    host.setAttribute("data-vkdl-slot", key);
    host.style.cssText = `all:initial!important;position:absolute!important;display:block!important;box-sizing:border-box!important;inline-size:${slotWidth}px!important;block-size:32px!important;margin:0!important;inset:auto!important;left:0!important;top:0!important;visibility:hidden!important;pointer-events:auto!important;`;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Скачать";
    button.setAttribute("aria-label", "Скачать");
    button.title = "Только этот трек. Без запуска музыки. Расширение определяется по Content-Type CDN: audio/mpeg → .mp3, audio/mp4 → .m4a. Без перекодирования.";
    const status = document.createElement("span");
    status.className = "status";
    status.id = `status-${key}`;
    status.setAttribute("role", "status");
    button.setAttribute("aria-describedby", status.id);
    shadow.append(button, status);
    const record = { row, key, host, button, status, layoutStyles: new Map() };
    records.set(key, record);
    // Строка VK не входит в путь события. Дополнительно не выпускаем
    // события кнопки в делегированные bubble-обработчики списка.
    for (const name of ["pointerdown", "mousedown", "dblclick", "keydown", "keyup"]) {
      host.addEventListener(name, e => e.stopPropagation());
    }
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (event.isTrusted) void choose(record).catch(() => {
        busy = false;
        showDiagnostic(clientDiagnostic("UI_INTERNAL", "обработка действия расширения", "Ошибка расширения; результат не подтверждён."), record);
        refreshDisabled();
      });
    });
    host.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); });
    attachSlot(record);
    button.disabled = busy || pollingDownload;
  }

  function scan() {
    scanning = false;
    active = eligible();
    if (!active) {
      fallbackOffer = null;
      for (const record of records.values()) {
        removeSlot(record);
      }
      records.clear();
      rowResize.disconnect();
      banner?.host.remove();
      banner = null;
      return;
    }
    ensureBanner();
    for (const [key, record] of records) {
      if (!record.row.isConnected || !record.row.matches(rowSelector)) {
        removeSlot(record);
        records.delete(key);
        continue;
      }
      // Виртуализированный DOM может переиспользовать строку для другого трека.
      if (record.fingerprint && textWithoutUi(record.row) !== record.fingerprint) {
        record.status.textContent = "";
        record.trackId = null;
        record.fingerprint = null;
      }
    }
    const rows = [...document.querySelectorAll(rowSelector)]
      .filter(row => !row.parentElement?.closest(rowSelector));
    rows.forEach(mount);
    if (fallbackOffer && !validFallbackOffer()) fallbackOffer = null;
    refreshDisabled();
    schedulePlacement();
    const countText = `Распознано строк: ${rows.length}. ${rows.length ? "" : "Разметка VK пока не распознана."}`;
    if (banner.count.textContent !== countText) banner.count.textContent = countText;
    if (banner.status.textContent !== latest) banner.status.textContent = latest;
  }

  function scheduleScan() {
    if (scanning) return;
    scanning = true;
    setTimeout(scan, 100);
  }

  new MutationObserver(mutations => {
    if (mutations.some(m => !(m.target instanceof Element && m.target.closest("[data-vkdl-ui]")))) scheduleScan();
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ["data-audio", "data-full-id", "data-testid", "id", "style", "class"] });
  addEventListener("popstate", scheduleScan);
  addEventListener("hashchange", scheduleScan);
  addEventListener("resize", schedulePlacement, { passive: true });
  document.addEventListener("scroll", schedulePlacement, { passive: true, capture: true });
  let previousHref = location.href;
  addEventListener('vkdl-account-change', () => {
    ownerId=globalThis.VkWorkingAccount?.libraryOwnerId;
    attemptNumber++; fallbackOffer=null; displayedJobId=null; restoreJobs=true; pollingDownload=false;
    for(const record of records.values()) removeSlot(record); records.clear();
    banner?.host.remove(); banner=null; scan();
  });
  setInterval(() => {
    if (location.href !== previousHref) { previousHref = location.href; scan(); }
    if (active) void pollJobs();
  }, 1500);
  scan();
  void pollJobs();
})();
