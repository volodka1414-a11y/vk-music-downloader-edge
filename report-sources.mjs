import { summarizeSources } from "./source-summary.mjs";
import { requestApprovedSet, requestSelectedHosts } from "./source-access.mjs";
import { cdnFamily, approvedFamilies, exactSourceHostname } from "./cdn-policy.mjs";

export function renderSourceReport(container, report, runId, api, {readOnly=false} = {}) {
  container.replaceChildren();
  const summary = summarizeSources(report.entries);
  const p = text => { const node = document.createElement("p"); node.textContent = text; container.append(node); return node; };
  p(summary.available ? `SOURCE_MISSING: ${summary.sourceMissing}. Новый доступ сам по себе отсутствие ссылки не исправляет. Записей без наблюдавшегося hostname: ${summary.withoutHostname}; усечённых списков источников: ${summary.truncatedEntries}. Старые hostname не восстанавливались.` :
    "Массив записей отчёта отсутствует. Число SOURCE_MISSING и сведения об источниках недоступны.");
  const table = document.createElement("table"), head = document.createElement("tr");
  for (const label of ["Hostname", "Уникальных ID", "Причины / уникальные ID", "Сохранённые этапы"]) { const th = document.createElement("th"); th.textContent = label; head.append(th); } table.append(head);
  for (const host of summary.hosts) {
    const row = document.createElement("tr");
    for (const value of [host.hostname, String(host.uniqueTracks), host.reasons.map(item => `${item.reason}: ${item.count}`).join("; ") + (host.recordsWithoutId ? `; без ID: ${host.recordsWithoutId}` : ""), host.stages.join(", ")]) {
      const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
    } table.append(row);
  }
  if (summary.hosts.length) container.append(table); else p("Наблюдавшиеся hostname не сохранены.");
  p("Один ID может иметь несколько наблюдений и причин, включая промежуточные отказы до успешного повтора. Это не число итоговых ошибок: они отдельно в сводке кодов и списке нескачанных. Пропущенным по истории источники не приписываются. HTTP-статусы, MIME и размеры показываются только при наличии в записи; старые значения не угадываются.");
  const title = document.createElement("h3"); title.textContent = "Доступ к источникам"; container.append(title);
  p(`Согласованные семейства (корень и поддомены): ${approvedFamilies.join(", ")}. Первая кнопка запрашивает доступ только к этому набору. HTTPS, порт, авторизация и проверки файлов остаются обязательными.`);
  const choices = [];
  for (const host of summary.hosts) {
    if (!exactSourceHostname(host.hostname)) continue;
    const access = host.waiting.includes("PERMISSION_REQUIRED"), family = host.waiting.includes("FAMILY_APPROVAL_REQUIRED");
    if (!access && !family) continue;
    const known = !!cdnFamily(host.hostname), label = document.createElement("label"), checkbox = document.createElement("input");
    checkbox.type = "checkbox"; checkbox.checked = known;
    label.append(checkbox, document.createTextNode(`${host.hostname} — ID: ${host.uniqueTracks}; ${known ? "согласованное семейство" : "неизвестное семейство: разрешение только этого hostname"}`));
    container.append(label, document.createElement("br")); choices.push({ checkbox, hostname: host.hostname, known });
  }
  const unknown = choices.filter(choice => !choice.known);
  if (!unknown.length) p("Неизвестных hostname, ожидающих явного разрешения, в сохранённых наблюдениях нет.");
  else p("Неизвестные hostname выше изначально не выбраны. Отметьте только проверенные вами источники. Вторая кнопка запросит точные HTTPS-hostname без wildcard; соседние поддомены не разрешаются.");
  if(readOnly) { p('Только просмотр. Доступ и дозагрузка из этого отчёта заблокированы: исходный аккаунт/библиотека не подтверждены либо старый отчёт не имеет привязки. Старые записи не переклассифицированы.'); return; }
  const button = label => { const node = document.createElement("button"); node.type = "button"; node.textContent = label; container.append(node); return node; };
  const grant = button("Разрешить согласованный набор CDN");
  const grantUnknown = button("Разрешить выбранные неизвестные hostname"); grantUnknown.disabled = !unknown.length;
  const retry = button("Подготовить дозагрузку выбранных"); retry.disabled = !choices.length;
  const status = p("Разрешения и дозагрузка автоматически не запускаются. Подготовка плана заново проверит фактический доступ."); status.setAttribute("role", "status");
  p("https://*/* объявлен только как optional-возможность для будущих точных источников. Фактический запрос доступа ко всем сайтам никогда не выполняется. HTTP_STATUS и SOURCE_MISSING разрешением не исправляются автоматически.");
  if (!choices.length) p("В этом отчёте нет сохранённых отказов, подходящих для дозагрузки после разрешения. Старый SOURCE_HOST без hostname нельзя сопоставить с CDN. HTTP-ошибки и отсутствие ссылки требуют отдельной оценки; доступ к CDN сам по себе их не исправляет.");
  let busy = false;
  function begin() { if (busy) return false; busy = true; grant.disabled = grantUnknown.disabled = retry.disabled = true; return true; }
  function end() { busy = false; grant.disabled = false; grantUnknown.disabled = !unknown.length; retry.disabled = !choices.length; }
  function denied(result) { status.textContent = result.reason === "DENIED" ? "Доступ не предоставлен. Повторные загрузки не запускались." : "Запрос доступа не выполнен; исключение скрыто. Загрузки не запускались."; }
  grant.addEventListener("click", event => {
    if (!event.isTrusted || !begin()) return;
    // Invoke synchronously in this trusted click, before any awaited work.
    requestApprovedSet(api).then(result => {
      if (!result.granted) denied(result);
      else status.textContent = "Доступ к согласованному набору предоставлен. Можно отдельно подготовить дозагрузку выбранных ID с отказами допуска. Предоставление доступа не запускает повторы HTTP-ошибок и не обходит их.";
    }).finally(end);
  });
  grantUnknown.addEventListener("click", event => {
    if (!event.isTrusted || busy) return;
    const hosts = unknown.filter(choice => choice.checkbox.checked).map(choice => choice.hostname);
    if (!hosts.length) { status.textContent = "Явно отметьте хотя бы один неизвестный hostname."; return; }
    if (!begin()) return;
    requestSelectedHosts(api, hosts).then(async result => {
      if (!result.granted) { denied(result); return; }
      const activation = await api.runtime.sendMessage({ type: "ACTIVATE_SELECTED_SOURCES", runId, hosts });
      status.textContent = activation?.ok ? "Выбранные точные hostname разрешены. Соседние поддомены не добавлены. Можно отдельно подготовить дозагрузку выбранных ID; ссылки будут прочитаны заново." : "Браузерный доступ получен, но активация источников не подтверждена. Загрузки не запускались; обновите отчёт и повторите явное действие.";
    }).catch(() => { status.textContent = "Нет связи с расширением. Допуск источников не подтверждён; загрузки не запускались."; }).finally(end);
  });
  retry.addEventListener("click", async event => {
    if (!event.isTrusted || busy) return;
    const hosts = choices.filter(choice => choice.checkbox.checked).map(choice => choice.hostname);
    if (!hosts.length) { status.textContent = "Выберите хотя бы один источник."; return; }
    if (!begin()) return;
    try {
      const result = await api.runtime.sendMessage({ type: "PREPARE_SOURCE_RETRY", runId, hosts });
      if (result?.ok && Number.isSafeInteger(result.retryPlan?.count)) status.textContent = `Подготовлено ID: ${result.retryPlan.count}. Загрузки ещё не начаты. На VK нажмите «Дозагрузить разрешённые». Нужен повторный обход с начала и чтение свежих ссылок только для выбранных ID.`;
      else status.textContent = result?.code === "BATCH_ACTIVE" ? "Сначала остановите текущую очередь." : result?.code === "RETRY_PERMISSION_REQUIRED" ? "Доступ не подтверждён или отозван." : "Нет подходящих сохранённых отказов допуска либо план не подтверждён. Загрузки не запускались.";
    } catch { status.textContent = "Нет связи с расширением. План не подтверждён; загрузки не запускались."; }
    finally { end(); }
  });
}
