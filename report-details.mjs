import { safeObservation } from "./source-summary.mjs";
import { safeInterruptReason } from "./retry-policy.mjs";
import { reportErrorCode } from "./report-summary.mjs";
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : "не сохранено";
function describe(value, current = false) {
  const d = safeObservation(value);
  let text = `hostname: ${d.hostname || "не сохранён"}; этап: ${d.stage}; операция: ${d.operation || "не сохранена"}; причина: ${d.reason}; HTTP: ${d.status ?? (current ? "недоступен для этого этапа" : "не сохранён")}; Content-Type: ${d.contentType || "не сохранён"}`;
  if (d.condition) text += `; условие: ${d.condition}`;
  if (d.browserCategory) text += `; категория браузера: ${d.browserCategory} (не устанавливает точную причину)`;
  if (d.browserErrorType) text += `; тип ошибки: ${d.browserErrorType}`;
  if (d.filenameMode) text += `; вариант имени: ${d.filenameMode}`;
  for (const key of ["matchingRows", "rowConnected", "idUsable", "titleUsable", "artistUsable", "artistPartEmpty", "titlePartEmpty"]) if (d[key] !== null) text += `; ${key}=${d[key]}`;
  if (d.filenameLength !== null) text += `; имя: UTF-16=${d.filenameLength}, UTF-8=${d.filenameUtf8Bytes}, nonASCII=${d.filenameNonAscii}, nonBMP=${d.filenameNonBmp}`;
  if (d.expectedSize !== null) text += `; ожидаемый размер: ${d.expectedSize}; размер файла: ${number(d.actualFileSize)}; получено байт: ${number(d.bytesReceived)}`;
  return text;
}
export function entryDiagnosticText(entry) {
  const attempts = Number.isInteger(entry?.attempts) && entry.attempts >= 0 && entry.attempts <= 3 ? String(entry.attempts) : "не сохранено";
  let progress = `Попыток: ${attempts}.`;
  if (entry?.retryExhausted) progress += " Два дополнительных повтора исчерпаны.";
  else if (entry?.roundsExhausted) progress += " Два круга поиска повторов завершены; это не подтверждение полноты.";
  if (entry?.lastFailure) {
    const code = reportErrorCode(entry.lastFailure.code), raw = entry.lastFailure.reason;
    const reason = safeInterruptReason(raw) || (/^HTTP_(502|503|504)$/.test(raw) ? raw : raw === code ? code : "UNAVAILABLE");
    progress += ` Последний отказ попытки: ${code}; причина: ${reason}.`;
  }
  if (entry?.finalFailure) progress += `\nФинальный отказ: ${reportErrorCode(entry.finalFailure.code)}; попытка: ${entry.finalFailure.attempt ?? "не начиналась / не сохранена"}. ${describe(entry.finalFailure, true)}`;
  else progress += "\nОтдельные сведения о финальном этапе в старой записи не сохранены. Исторический HTTP-ответ ниже нельзя автоматически считать причиной последующего отказа.";
  const observations = Array.isArray(entry?.sources) ? entry.sources.map(value => safeObservation(value)) : [];
  const matching = observations.filter(value => value.reason !== "URL_ALLOWED" || ["probe_response", "download_check", "final_source_url", "source_permission"].includes(value.stage));
  if (!matching.length) return progress + "\nДополнительная диагностика в записи не сохранена.";
  for (const attempt of [...new Set(matching.map(value => value.attempt))]) {
    progress += `\nНаблюдения ${attempt ? `попытки ${attempt}` : "без сохранённого номера попытки"} (история, не замена финального отказа):\n`;
    progress += [...new Set(matching.filter(value => value.attempt === attempt).map(value => describe(value)))].join("\n");
  }
  return progress;
}
