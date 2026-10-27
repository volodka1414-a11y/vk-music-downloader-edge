import { inspectSourceAddress, safeSourceFacts } from "./cdn-policy.mjs";
import { safeFailureFields } from "./failure-details.mjs";
// Только разрешённые поля. Ни raw URL/headers, ни exception/cause сюда не попадают.
const stages = Object.freeze({
  preflight: "до подготовки", page_scope: "проверка страницы", row_data: "чтение выбранной строки",
  source_url: "проверка адреса источника", whole_object_url: "проверка удаления bytes",
  source_range_policy: "проверка применимости bytes к этому серверу", final_source_url: "проверка конечного адреса загрузки",
  source_permission: "проверка доступа к согласованному CDN",
  filename: "проверка имени файла", filename_build: "формирование имени файла", probe_request: "запрос проверки CDN",
  probe_response: "проверка ответа CDN", row_recheck: "повторная проверка строки",
  download_request: "запрос сохранения браузером", download_check: "проверка загрузки браузера",
  job_status: "чтение состояния загрузок", internal: "внутренняя операция"
});
const classes = Object.freeze({
  unknown: "не установлен", no_source: "ссылка отсутствует", masked_marker: "замаскированная ссылка",
  url_unclassified: "формат по URL не установлен",
  path_m3u8_marker: "признак .m3u8 в пути; содержимое не проверено",
  declared_audio_mp4: "сервер объявил audio/mp4; содержимое не анализировалось",
  declared_audio_mpeg: "сервер объявил audio/mpeg; содержимое не анализировалось",
  declared_playlist: "сервер объявил MIME плейлиста; содержимое не проверено",
  declared_html: "сервер объявил HTML", declared_binary: "сервер объявил общий двоичный тип",
  declared_other: "сервер объявил другой MIME", missing_mime: "Content-Type отсутствует",
  invalid_mime: "Content-Type не распознан"
});

export function normalizedContentType(raw) {
  if (!raw) return { contentType: null, contentTypeState: "missing" };
  // Параметры заголовка не выводим: они не нужны для проверки и могут содержать посторонние данные.
  const mime = String(raw).split(";")[0].trim().toLowerCase();
  if (mime.length > 100 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) {
    return { contentType: null, contentTypeState: "invalid" };
  }
  return { contentType: mime, contentTypeState: "valid" };
}

export function sourceDiagnostic(raw, approvedHosts = []) {
  const facts = inspectSourceAddress(raw, approvedHosts);
  return {
    host: facts.hostname, protocol: facts.protocol, family: facts.family, sourceReason: facts.reason,
    sourceClass: facts.reason === "PATH_PLAYLIST_MARKER" ? "path_m3u8_marker" : facts.hostname ? "url_unclassified" : "unknown"
  };
}

export function responseDiagnostic(response) {
  const mime = normalizedContentType(response.headers.get("content-type"));
  let sourceClass = "declared_other";
  if (mime.contentTypeState === "missing") sourceClass = "missing_mime";
  else if (mime.contentTypeState === "invalid") sourceClass = "invalid_mime";
  else if (mime.contentType === "audio/mp4") sourceClass = "declared_audio_mp4";
  else if (mime.contentType === "audio/mpeg") sourceClass = "declared_audio_mpeg";
  else if (["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl"].includes(mime.contentType)) sourceClass = "declared_playlist";
  else if (mime.contentType === "text/html") sourceClass = "declared_html";
  else if (mime.contentType === "application/octet-stream") sourceClass = "declared_binary";
  return sanitizeDiagnostic({ stage: "probe_response", requestState: "response_received",
    status: response.status, ...mime, sourceClass });
}

export function sanitizeDiagnostic(value = {}) {
  if (!value || typeof value !== "object") value = {};
  const contentType = normalizedContentType(value.contentType);
  const facts = safeSourceFacts({ ...value, reason: value.sourceReason });
  return {
    stage: Object.hasOwn(stages, value.stage) ? value.stage : "internal",
    ...safeFailureFields(value),
    requestState: ["not_sent", "attempted_no_response", "response_received"].includes(value.requestState) ? value.requestState : "unknown",
    host: typeof value.host === "string" && /^[a-z0-9.-]{1,253}$/.test(value.host) ? value.host : null,
    protocol: facts.protocol, family: facts.family, sourceReason: facts.reason,
    sourceClass: Object.hasOwn(classes, value.sourceClass) ? value.sourceClass : "unknown",
    status: Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? value.status : null,
    contentType: contentType.contentType,
    contentTypeState: value.contentTypeState === "invalid" ? "invalid" : contentType.contentTypeState,
    expectedSize: Number.isSafeInteger(value.expectedSize) && value.expectedSize >= 0 ? value.expectedSize : null,
    actualFileSize: Number.isSafeInteger(value.actualFileSize) && value.actualFileSize >= 0 ? value.actualFileSize : null,
    bytesReceived: Number.isSafeInteger(value.bytesReceived) && value.bytesReceived >= 0 ? value.bytesReceived : null
  };
}

export function diagnosticText(value) {
  const d = sanitizeDiagnostic(value);
  const network = {
    not_sent: "Сетевой запрос к CDN не выполнялся в этой попытке.",
    attempted_no_response: "Запрос к CDN предпринят; HTTP-ответ недоступен. Отправку по сети подтвердить нельзя.",
    response_received: "Получен HTTP-ответ проверки CDN.",
    unknown: "Состояние запроса к CDN неизвестно."
  }[d.requestState];
  const mime = d.contentType || (d.requestState !== "response_received" ? "нет доступного ответа" :
    d.contentTypeState === "invalid" ? "нераспознанный (значение скрыто)" : "заголовок отсутствует");
  const sizes = d.expectedSize !== null || d.actualFileSize !== null || d.bytesReceived !== null ? ` Ожидалось байт: ${d.expectedSize ?? "нет данных"}; размер файла: ${d.actualFileSize ?? "нет данных"}; получено: ${d.bytesReceived ?? "нет данных"}.` : "";
  const fields = ["matchingRows", "rowConnected", "idUsable", "titleUsable", "artistUsable", "artistPartEmpty", "titlePartEmpty"]
    .filter(key => d[key] !== null).map(key => `${key}=${d[key]}`).join("; ");
  const detail = (d.condition ? ` Условие: ${d.condition}.` : "") + (fields ? ` Признаки: ${fields}.` : "") +
    (d.filenameMode ? ` Вариант имени: ${d.filenameMode}.` : "") +
    (d.browserCategory ? ` Тип ошибки: ${d.browserErrorType || "не установлен"}; категория: ${d.browserCategory}.` : "");
  return `Этап: ${stages[d.stage]} (${d.stage}). ${network} HTTP проверки: ${d.status ?? "нет данных"}; Content-Type: ${mime}. Сервер: ${d.host || "не установлен"}. Протокол: ${d.protocol || "не установлен"}; причина проверки адреса: ${d.sourceReason || "не сохранена"}. Класс: ${classes[d.sourceClass]}.${sizes}${detail}`;
}
