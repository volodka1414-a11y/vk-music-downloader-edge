import { batchReason } from "./batch.mjs";
import { summarizeErrors, summaryText, reportErrorCode } from "./report-summary.mjs";
import { renderSourceReport } from "./report-sources.mjs";
import { entryDiagnosticText } from "./report-details.mjs";
import { accountBinding, accountStorageKey, sameAccount } from './account-state.mjs';
const run = new URL(location.href).searchParams.get("run");
const reportParams=new URL(location.href).searchParams;
const reportAccount=accountBinding({accountId:reportParams.get('account'),libraryOwnerId:reportParams.get('library')});
const summary = document.querySelector("#summary"), errors = document.querySelector("#errors"), results = document.querySelector("#results");
const completionReason = document.querySelector("#completion-reason"), errorSummary = document.querySelector("#error-summary"), legacy = document.querySelector("#legacy-source-host");
let revision = 0;
async function render() {
  const mine = ++revision;
  errors.replaceChildren(); results.replaceChildren(); completionReason.textContent = ""; legacy.textContent = "";
  if (!/^[a-f0-9-]{36}$/.test(run || "")) { summary.textContent = "Неверный идентификатор локального отчёта."; errorSummary.textContent = "Сводка недоступна."; return; }
  if(!reportAccount) { summary.textContent="Не установлена привязка отчёта к аккаунту и собственной библиотеке."; errorSummary.textContent="Отчёт без привязки не открывается."; return; }
  const key = accountStorageKey(reportAccount,`vkBatchReport:${run}`);
  let report;
  try { report = (await chrome.storage.local.get(key))[key]; }
  catch { if (mine === revision) { summary.textContent = "Не удалось прочитать локальный отчёт."; errorSummary.textContent = "Сводка недоступна; исключение скрыто."; } return; }
  if (mine !== revision) return;
  if (!report) { summary.textContent = "Этот локальный отчёт не найден."; errorSummary.textContent = "Сводка недоступна."; return; }
  const grouped = summarizeErrors(report);
  errorSummary.textContent = summaryText(grouped);
  let reportAllowed=false;
  if(reportAccount && sameAccount(report.account,reportAccount)) {
    try { reportAllowed=(await chrome.runtime.sendMessage({type:'REPORT_ACCOUNT_CHECK',runId:run}))?.ok===true; } catch { /* Read-only local report remains available. */ }
  }
  renderSourceReport(document.querySelector("#source-summary"), report, run, chrome, {readOnly:!reportAllowed});
  if (Array.isArray(report.entries) && report.entries.some(entry => entry?.code === "SOURCE_HOST" && !entry.sources?.length)) legacy.textContent = "Есть старые записи SOURCE_HOST без сведений об источнике: этап и точная причина в них не сохранены. Этот код не доказывает отсутствие разрешения сайта. Старые ошибки не переклассифицированы по новым наблюдениям. Новые наблюдения, если они есть, показаны в сводке источников.";
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : "UNAVAILABLE";
  const entries = Array.isArray(report.entries) ? report.entries.filter(entry => entry && typeof entry === "object" && !Array.isArray(entry)) : [];
  const phase = ["finished", "stopped", "waiting_page", "running", "attention"].includes(report.phase) ? report.phase : "UNAVAILABLE";
  const reason = reportErrorCode(report.reason);
  const reasonMessage = reason === "MISSING_CODE" ? "Причина в сохранённом отчёте отсутствует." :
    reason === "UNRECOGNIZED_CODE" ? "Сохранённый код причины не распознан; значение скрыто." : batchReason(reason);
  summary.textContent = `${reportAccount ? `Аккаунт и библиотека: ${reportAccount.accountId}. ` : 'Старый отчёт: принадлежность не установлена; только просмотр. '}${!reportAllowed ? 'Дозагрузка заблокирована до подтверждения исходного аккаунта в своей библиотеке VK. ' : ''}Состояние: ${phase}. Обнаружено: ${number(report.discovered)}; сохранено: ${number(report.saved)}; пропущено по истории: ${number(report.skipped)}; ошибки: ${number(report.errors)}.` +
    (Number.isInteger(report.passRound) ? ` Проход: ${report.passRound ? `круг повторов ${report.passRound}/2` : "основной"}; отложено: ${number(report.deferred)}.` : "");
  completionReason.textContent = `${phase === "waiting_page" ? "Причина паузы" : "Причина завершения обхода"}: ${reason}. ${reasonMessage}`;
  const failed = entries.filter(entry => entry.status === "error");
  if (grouped.available && !grouped.invalidEntries && !failed.length && grouped.expected === 0) errors.textContent = "Ошибок среди обработанных записей нет.";
  else if (!failed.length) errors.textContent = "Данных недостаточно, чтобы подтвердить отсутствие ошибок. Смотрите проверку суммы выше.";
  if (entries.some(entry => !["saved", "skipped", "error"].includes(entry.status))) {
    const pending = document.createElement("p"); pending.textContent = "Есть незавершённые записи. Для продолжения требуется открытая страница VK и явное нажатие «Продолжить обход»."; errors.append(pending);
  }
  const label = value => typeof value === "string" ? value.slice(0, 500) : "";
  for (const entry of failed) {
    const code = reportErrorCode(entry.code), item = document.createElement("div");
    item.className="error-entry";
    const message = code === "MISSING_CODE" ? "Код в записи отсутствует." : code === "UNRECOGNIZED_CODE" ? "Сохранённый код не распознан; значение скрыто." : batchReason(code);
    item.textContent = `${label(entry.artist) || "Исполнитель не прочитан"} — ${label(entry.title) || "Название не прочитано"}: ${code}. ${message}`;
    const details=document.createElement("details"), caption=document.createElement("summary"), technical=document.createElement("p");
    caption.textContent="Технические подробности и попытки"; technical.textContent=entryDiagnosticText(entry);
    details.append(caption,technical); item.append(details); errors.append(item);
  }
  const table = document.createElement("table"), header = document.createElement("tr");
  for (const name of ["Исполнитель", "Название", "Результат"]) { const cell = document.createElement("th"); cell.textContent = name; header.append(cell); } table.append(header);
  const states = { saved: "Сохранено и проверено", skipped: "Пропущено по истории", error: "Не скачано", pending: "Ожидает продолжения", preparing: "Подготовка", fallback_pending: "Сверка перед резервным именем", starting: "Проверка запуска", downloading: "Загружается", retry_wait: "Ожидает ограниченного повтора", deferred: "Отложено до круга повторов" };
  for (const entry of entries) {
    const row = document.createElement("tr");
    const attempts = Number.isInteger(entry.attempts) && entry.attempts >= 0 && entry.attempts <= 3 ? String(entry.attempts) : "не сохранено";
    const outcome = (Object.hasOwn(states, entry.status) ? states[entry.status] : "Статус не распознан") + `; попыток: ${attempts}` + (entry.retryExhausted ? "; лимит повторов исчерпан" : "") +
      (entry.status === "error" ? `; финальная причина: ${reportErrorCode(entry.code)}` : "") +
      (entry.status === "saved" && entry.fallbackUsed === true ? "; Сохранено с резервным именем" : "");
    for (const text of [label(entry.artist), label(entry.title), outcome]) { const cell = document.createElement("td"); cell.textContent = text || "Не прочитано"; row.append(cell); } table.append(row);
  }
  results.append(table);
}
await render();
chrome.storage.onChanged?.addListener((changes, area) => { if (area === "local" && Object.hasOwn(changes, reportAccount ? accountStorageKey(reportAccount,`vkBatchReport:${run}`) : `vkBatchReport:${run}`)) void render(); });
