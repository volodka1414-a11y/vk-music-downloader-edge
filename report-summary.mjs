import { messages } from "./core.mjs";
import { batchMessages } from "./batch.mjs";

export function reportErrorCode(raw) {
  return typeof raw !== "string" || !raw ? "MISSING_CODE" :
    Object.hasOwn(messages, raw) || Object.hasOwn(batchMessages, raw) ? raw : "UNRECOGNIZED_CODE";
}

export function summarizeErrors(report) {
  const statuses = new Set(["saved", "skipped", "error", "pending", "preparing", "starting", "downloading", "retry_wait", "deferred"]);
  const expected = Number.isSafeInteger(report?.errors) && report.errors >= 0 ? report.errors : null;
  if (!Array.isArray(report?.entries)) return { available: false, expected, recorded: null, sum: null, matches: null, invalidEntries: null, groups: [] };
  const counts = new Map(); let recorded = 0, invalidEntries = 0;
  for (const entry of report.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !statuses.has(entry.status)) { invalidEntries++; continue; }
    if (entry.status !== "error") continue;
    recorded++;
    const code = reportErrorCode(entry.code);
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  const groups = [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const sum = groups.reduce((total, entry) => total + entry.count, 0);
  return { available: true, expected, recorded, sum, invalidEntries, matches: expected === null ? null : expected === sum && invalidEntries === 0, groups };
}

export function summaryText(value) {
  if (!value.available) return `Сводка недоступна: сохранённый список записей отсутствует.\nОшибок в заголовке: ${value.expected ?? "UNAVAILABLE"}.`;
  return ["Код ошибки → количество", ...value.groups.map(entry => `${entry.code} → ${entry.count}`),
    `Сумма сводки: ${value.sum}`, `Записей со статусом error: ${value.recorded}`, `Ошибок в заголовке: ${value.expected ?? "UNAVAILABLE"}`,
    `Неполных/некорректных записей: ${value.invalidEntries}`,
    `Проверка суммы: ${value.matches === null ? "НЕВОЗМОЖНА — общее число не сохранено" : value.matches ? "СОВПАДАЕТ" : "НЕ СОВПАДАЕТ ИЛИ ДАННЫЕ НЕПОЛНЫ"}`].join("\n");
}
