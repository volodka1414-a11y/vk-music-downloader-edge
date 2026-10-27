import { sourceDiagnostic, responseDiagnostic, sanitizeDiagnostic, diagnosticText, normalizedContentType } from "./diagnostics.mjs";
import { inspectSourceAddress, exactAudioHost } from "./cdn-policy.mjs";
import { filenamePart } from "./filename-text.mjs";
import { workingAccountMessages } from './account-messages.mjs';

const audioExtensions = Object.freeze({ "audio/mp4": ".m4a", "audio/mpeg": ".mp3" });
const supportedMime = mime => Object.hasOwn(audioExtensions, mime);
export { exactAudioHost };

export class PrototypeError extends Error {
  constructor(code, diagnostic) { super(code); this.code = code; this.diagnostic = diagnostic; }
}

export const fail = (code, diagnostic) => { throw new PrototypeError(code, diagnostic); };

export function diagnosticError(error, context) {
  const code = error instanceof PrototypeError && Object.hasOwn(messages, error.code) ? error.code : "INTERNAL";
  const detail = error instanceof PrototypeError ? error.diagnostic || {} : {};
  const merged = { ...context, ...detail };
  for (const field of ["host", "protocol", "family", "sourceReason"]) if (!detail[field]) merged[field] = context?.[field];
  // Повторная проверка строки не отменяет уже полученный в этой попытке ответ CDN.
  if (context?.requestState === "response_received" && detail.requestState !== "response_received") {
    for (const field of ["requestState", "status", "contentType", "contentTypeState"]) merged[field] = context[field];
  }
  return new PrototypeError(code, sanitizeDiagnostic(merged));
}

export function isMusicPage(raw, ownerId) {
  try {
    const u = new URL(raw);
    return u.origin === "https://vk.ru" && u.pathname === `/audios${ownerId}` &&
      (!u.searchParams.has("section") || u.searchParams.get("section") === "all") &&
      !["z", "playlist_id", "album_id", "q"].some(key => u.searchParams.has(key));
  } catch { return false; }
}

export function checkedCdnUrl(raw, approvedHosts = []) {
  const diagnostic = { stage: "source_url", requestState: "not_sent", ...sourceDiagnostic(raw, approvedHosts) };
  const facts = inspectSourceAddress(raw, approvedHosts);
  if (["URL_FORMAT_INVALID", "URL_PARSE_FAILED"].includes(facts.reason)) fail("SOURCE_URL", diagnostic);
  if (facts.reason === "PATH_PLAYLIST_MARKER") fail("SOURCE_PATH_M3U8", diagnostic);
  if (facts.reason !== "URL_ALLOWED") fail("SOURCE_HOST", diagnostic);
  return new URL(raw);
}

export function wholeObjectUrl(raw, approvedHosts = []) {
  const parsed = checkedCdnUrl(raw, approvedHosts);
  if (!/^vd\d+\.okcdn\.ru$/.test(parsed.hostname)) {
    // No evidence that the okcdn bytes convention applies to this server.
    // Keep the complete original string, or stop before a request; never rewrite it.
    if (parsed.searchParams.has("bytes")) fail("SOURCE_RANGE_UNVERIFIED", {
      stage: "source_range_policy", requestState: "not_sent", ...sourceDiagnostic(raw, approvedHosts)
    });
    return raw;
  }
  const hashAt = raw.indexOf("#");
  const main = hashAt < 0 ? raw : raw.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : raw.slice(hashAt);
  const at = main.indexOf("?");
  if (at < 0) return raw;
  // Не сериализовать URLSearchParams: это может изменить кодировку подписи.
  const kept = main.slice(at + 1).split("&").filter(part => {
    const eq = part.indexOf("=");
    const key = eq < 0 ? part : part.slice(0, eq);
    let decoded;
    try { decoded = decodeURIComponent(key); } catch { fail("SOURCE_URL"); }
    if (decoded !== "bytes") return true;
    const value = eq < 0 ? "" : part.slice(eq + 1);
    if (!/^\d+-\d+$/.test(value)) fail("RANGE_QUERY");
    const [start, end] = value.split("-").map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) fail("RANGE_QUERY");
    return false;
  });
  return main.slice(0, at) + (kept.length ? `?${kept.join("&")}` : "") + hash;
}

export function filenameFor(artist, title, preparedMime) {
  const a = filenamePart(artist), t = filenamePart(title);
  if (!a || !t) fail("TRACK_METADATA", { stage: "filename_build", operation: "filename_build", condition: "FILENAME_PART_EMPTY", artistPartEmpty: !a, titlePartEmpty: !t });
  let base = `${a} — ${t}`;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  const mime = normalizedContentType(preparedMime).contentType;
  if (!supportedMime(mime)) fail("PREPARED_MIME");
  return `${base}${audioExtensions[mime]}`;
}

export function probeInfo(response) {
  const diagnostic = responseDiagnostic(response);
  const stop = code => fail(code, diagnostic);
  if (response.status === 401 || response.status === 403) stop("SOURCE_EXPIRED");
  if (![200, 206].includes(response.status)) stop("HTTP_STATUS");
  const mime = normalizedContentType(response.headers.get("content-type")).contentType;
  if (!supportedMime(mime)) stop(diagnostic.contentTypeState === "missing" ? "RESPONSE_MIME_MISSING" :
    diagnostic.contentTypeState === "invalid" ? "RESPONSE_MIME_INVALID" : "RESPONSE_MIME_OTHER");
  if (response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity") stop("SOURCE_ENCODING");
  const range = response.headers.get("content-range");
  let size;
  if (response.status === 206) {
    const match = /^bytes 0-0\/(\d+)$/.exec(range || "");
    if (!match) stop("PROBE_RANGE");
    size = Number(match[1]);
  } else {
    if (range) stop("PROBE_RANGE");
    const length = response.headers.get("content-length");
    if (!/^\d+$/.test(length || "")) stop("SOURCE_SIZE");
    size = Number(length);
  }
  if (!Number.isSafeInteger(size) || size <= 0) stop("SOURCE_SIZE");
  return { size, mime };
}

export function downloadState(item, job, approvedHosts = []) {
  if (!item) return { phase: "error", code: "DOWNLOAD_MISSING" };
  if (item.state === "interrupted") return { phase: "error", code: "DOWNLOAD_INTERRUPTED" };
  if (item.state !== "complete") return { phase: "downloading", received: item.bytesReceived || 0, size: job.size };
  const expectedMime = normalizedContentType(job.mime).contentType;
  if (!supportedMime(expectedMime)) return { phase: "error", code: "DOWNLOAD_EXPECTED_MIME" };
  if (normalizedContentType(item.mime).contentType !== expectedMime) return { phase: "error", code: "DOWNLOAD_TYPE" };
  if (item.fileSize !== job.size || item.bytesReceived !== job.size) return { phase: "error", code: "DOWNLOAD_SIZE", diagnostic: sanitizeDiagnostic({
    ...sourceDiagnostic(item.finalUrl || item.url, approvedHosts), stage: "download_check", requestState: "unknown",
    expectedSize: job.size, actualFileSize: item.fileSize, bytesReceived: item.bytesReceived
  }) };
  try {
    const final = checkedCdnUrl(item.finalUrl || item.url, approvedHosts);
    if (final.searchParams.has("bytes")) return { phase: "error", code: "DOWNLOAD_RANGE", diagnostic: sanitizeDiagnostic({
      stage: "final_source_url", requestState: "unknown", ...sourceDiagnostic(item.finalUrl || item.url, approvedHosts)
    }) };
  } catch (error) {
    const code = error.code === "SOURCE_URL" ? "DOWNLOAD_SOURCE_URL" :
      error.code === "SOURCE_PATH_M3U8" ? "DOWNLOAD_SOURCE_PATH_M3U8" : "DOWNLOAD_SOURCE_HOST";
    return { phase: "error", code, diagnostic: sanitizeDiagnostic({
      ...error.diagnostic, stage: "final_source_url", requestState: "unknown"
    }) };
  }
  return { phase: "saved", size: job.size };
}

// Сообщения фиксированы: текст исключений браузера иногда содержит URL.
export const messages = Object.freeze({
  ...workingAccountMessages,
  PAGE_SCOPE: "Откройте личную страницу «Моя музыка», раздел «Все».",
  ROW_MISSING: "Строка изменилась или исчезла. Нажмите ещё раз.",
  TRACK_METADATA: "Не удалось получить ID, исполнителя и название из выбранной строки.",
  TRACK_AMBIGUOUS: "Данные строки неоднозначны. Скачивание отменено.",
  TRACK_MISMATCH: "ID или название в данных не совпали со строкой. Скачивание отменено.",
  SOURCE_MISSING: "В данных этой строки нет прямой ссылки. Плеер не запускался.",
  SOURCE_MASKED: "Ссылка скрыта VK. Этот прототип не запрашивает и не расшифровывает её.",
  SOURCE_URL: "Не удалось распознать адрес аудио.",
  SOURCE_HOST: "Адрес не прошёл ограничения HTTPS, допустимого hostname, порта или отсутствия авторизации. Этап указан в диагностике; для старых отчётов он мог не сохраниться.",
  SOURCE_RANGE_UNVERIFIED: "Для этого источника применение параметра bytes не проверено. Адрес не изменён, запрос к CDN не выполнен. Нужна отдельная проверка и согласование.",
  CDN_PERMISSION_REQUIRED: "Семейство CDN согласовано, но браузерный доступ к этому источнику не предоставлен. Запросите доступ кнопкой в отчёте.",
  CDN_PERMISSION_CHECK: "Проверить доступ браузера к CDN не удалось. Запрос к этому CDN не выполнялся.",
  DOWNLOAD_PERMISSION_REQUIRED: "Конечный источник относится к согласованному CDN, но браузерный доступ к нему не подтверждён. Успех не записан.",
  DOWNLOAD_PERMISSION_CHECK: "Не удалось проверить доступ к конечному источнику. Успех не записан.",
  SOURCE_TYPE: "Тип источника не прошёл проверку; фактический формат не установлен.",
  SOURCE_PATH_M3U8: "Не пройдена проверка адреса: в пути есть признак .m3u8. Фактический формат не установлен.",
  RESPONSE_MIME_MISSING: "Не пройдена проверка MIME: в ответе CDN нет Content-Type. Требуется audio/mp4 или audio/mpeg.",
  RESPONSE_MIME_INVALID: "Не пройдена проверка MIME: Content-Type ответа не распознан. Требуется audio/mp4 или audio/mpeg.",
  RESPONSE_MIME_OTHER: "Не пройдена проверка MIME: CDN объявил тип вне audio/mp4 и audio/mpeg. Фактическое содержимое не проверялось.",
  PREPARED_MIME: "Не удалось определить расширение: поддержанный MIME подготовки отсутствует.",
  RANGE_QUERY: "Неожиданный параметр bytes. Адрес не изменён, скачивание отменено.",
  SOURCE_EXPIRED: "VK/CDN отказал в доступе. Возможно, ссылка устарела. Обновите страницу вручную.",
  HTTP_STATUS: "CDN вернул неподдерживаемый HTTP-ответ.",
  SOURCE_ENCODING: "CDN использует неподдерживаемое сжатие объекта.",
  PROBE_RANGE: "CDN вернул неожиданный диапазон. Полноту файла проверить нельзя.",
  SOURCE_SIZE: "CDN не сообщил полный размер. Скачивание отменено.",
  NETWORK: "Проверка CDN не удалась: сеть, перенаправление или ограничения доступа.",
  PROBE_TIMEOUT: "Проверочный запрос CDN остановлен собственным тайм-аутом. Полный файл не скачивался.",
  BUSY: "Дождитесь завершения выбранной загрузки.",
  TICKET: "Подготовка устарела. Нажмите кнопку ещё раз.",
  DOWNLOAD_START: "Браузер не начал скачивание.",
  DOWNLOAD_START_UNCERTAIN: "Исход запуска не установлен. Новая загрузка не запускается. Проверьте edge://downloads; не очищайте состояние расширения.",
  FALLBACK_UNAVAILABLE: "Резервное сохранение не подтверждено для этой строки или устарело. Начните обычное сохранение заново.",
  DOWNLOAD_MISSING: "Загрузка не найдена в браузере; результат не подтверждён.",
  DOWNLOAD_INTERRUPTED: "Браузер прервал загрузку или сохранение отменено. Подробности — edge://downloads.",
  DOWNLOAD_TYPE: "Файл сохранён, но MIME не совпал с типом, полученным при подготовке. Не считайте результат проверенным.",
  DOWNLOAD_EXPECTED_MIME: "MIME подготовки неизвестен или не поддержан. Совпадение типа файла не подтверждено.",
  DOWNLOAD_SIZE: "Файл сохранён, но размер не совпал с ожидаемым. Полнота не подтверждена.",
  DOWNLOAD_RANGE: "Итоговый адрес содержит bytes. Полнота не подтверждена.",
  DOWNLOAD_SOURCE_HOST: "Конечный адрес загрузки не прошёл ограничения HTTPS, допустимого hostname, порта или отсутствия авторизации. Успех не подтверждён.",
  DOWNLOAD_SOURCE_URL: "Конечный адрес загрузки не удалось безопасно разобрать. Успех не подтверждён.",
  DOWNLOAD_SOURCE_PATH_M3U8: "В конечном адресе загрузки найден признак .m3u8. Формат содержимого не установлен; успех не подтверждён.",
  INTERNAL: "Ошибка прототипа. Перезагрузите расширение и страницу; результат не подтверждён."
});

export function safeError(error) {
  const code = error instanceof PrototypeError && Object.hasOwn(messages, error.code) ? error.code : "INTERNAL";
  const diagnostic = sanitizeDiagnostic(error instanceof PrototypeError ? error.diagnostic : {});
  return { ok: false, code, diagnostic, message: `${messages[code]} Код: ${code}. ${diagnosticText(diagnostic)}` };
}
