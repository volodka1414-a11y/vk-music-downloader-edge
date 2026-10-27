// Self-contained both in the content script and scripting.executeScript MAIN.
globalThis.VkMusicLibraryScope = function libraryScope(rowKey = null, ownerId = null, mode = "dom") {
  const diagnostic = { sectionCount: null, headerCount: null, listCount: null, tracksTitleSpanPresent: null, failedCheck: null };
  const error = (code, failedCheck) => ({ ok: false, code, diagnostic: { ...diagnostic, failedCheck } });
  try {
    if (ownerId) {
      const url = new URL(location.href);
      if (url.origin !== "https://vk.ru" || url.pathname !== `/audios${ownerId}` ||
          (url.searchParams.has("section") && url.searchParams.get("section") !== "all") ||
          ["q", "z", "playlist_id", "album_id"].some(key => url.searchParams.has(key))) return error("PAGE_SCOPE", "PAGE_SCOPE");
    }
    const sectionSelector = 'section[data-testid="AudioCatalog_SectionTracks"]';
    const listSelector = '[data-testid="AudioCatalog_BlockMusicAudiosList"]';
    const headerSelector = '[data-testid="AudioCatalog_BlockHeaderTracks"]';
    const sections = document.querySelectorAll(sectionSelector);
    diagnostic.sectionCount = sections.length;
    if (sections.length !== 1) return error(sections.length ? "LIBRARY_SECTION_AMBIGUOUS" : "LIBRARY_SECTION_MISSING", "SECTION_COUNT");
    const section = sections[0];
    const headers = section.querySelectorAll(headerSelector);
    const lists = section.querySelectorAll(listSelector);
    diagnostic.headerCount = headers.length;
    diagnostic.listCount = lists.length;
    if (headers.length !== 1) return error("LIBRARY_HEADER_INVALID", "HEADER_COUNT");
    const titles = headers[0].querySelectorAll('span[title="Треки"]');
    diagnostic.tracksTitleSpanPresent = titles.length > 0;
    if (headers[0].closest(sectionSelector) !== section) return error("LIBRARY_HEADER_INVALID", "HEADER_SECTION_OWNER");
    if (!titles.length) return error("LIBRARY_HEADER_INVALID", "TITLE_MARKER_MISSING");
    if (titles.length !== 1) return error("LIBRARY_HEADER_INVALID", "TITLE_MARKER_AMBIGUOUS");
    if (titles[0].closest(headerSelector) !== headers[0]) return error("LIBRARY_HEADER_INVALID", "TITLE_HEADER_OWNER");
    if (titles[0].closest(sectionSelector) !== section) return error("LIBRARY_HEADER_INVALID", "TITLE_SECTION_OWNER");
    if (lists.length !== 1) return error(lists.length > 1 ? "LIBRARY_LIST_AMBIGUOUS" : "LIBRARY_LIST_MISSING", "LIST_COUNT");
    if (lists[0].closest(sectionSelector) !== section) return error("LIBRARY_LIST_MISSING", "LIST_SECTION_OWNER");
    const list = lists[0];
    const rowSelector = '[data-testid="MusicTrackRow"], [data-testid="MusicTrackCell"], [data-testid="MusicTrackItem"], .audio_row[data-audio], .audio_row[data-full-id]';
    const rows = [...list.querySelectorAll(rowSelector)].filter(row => row.isConnected &&
      row.closest(listSelector) === list && row.closest(sectionSelector) === section && !row.parentElement?.closest(rowSelector));
    if (!rows.length) return error("LIBRARY_ROWS_EMPTY", "RECOGNIZED_ROWS");
    if (rowKey !== null) {
      if (typeof rowKey !== "string" || !/^[a-f0-9-]{36}$/.test(rowKey)) return error("ROW_MISSING", "ROW_KEY");
      const marked = document.querySelectorAll(`[data-vkdl-row="${rowKey}"]`);
      if (marked.length !== 1 || !rows.includes(marked[0])) return error("LIBRARY_ROW_OUTSIDE", "ROW_MEMBERSHIP");
    }
    return mode === "dom" ? { ok: true, section, list, header: headers[0], rows } : { ok: true, rowCount: rows.length };
  } catch { return error("LIBRARY_READ_FAILED", "READ_FAILED"); }
};

// Only fixed keys, counters and booleans cross into a diagnostic message.
// null means the check did not run, not zero or false.
globalThis.VkMusicLibraryScopeDiagnostic = function scopeDiagnosticText(value) {
  if (!value || typeof value !== "object") return "";
  const count = name => Number.isSafeInteger(value[name]) && value[name] >= 0 ? value[name] : "NOT_CHECKED";
  const flag = typeof value.tracksTitleSpanPresent === "boolean" ? value.tracksTitleSpanPresent : "NOT_CHECKED";
  const checks = ["PAGE_SCOPE", "SECTION_COUNT", "HEADER_COUNT", "HEADER_SECTION_OWNER", "TITLE_MARKER_MISSING",
    "TITLE_MARKER_AMBIGUOUS", "TITLE_HEADER_OWNER", "TITLE_SECTION_OWNER", "LIST_COUNT", "LIST_SECTION_OWNER",
    "RECOGNIZED_ROWS", "ROW_KEY", "ROW_MEMBERSHIP", "READ_FAILED"];
  const failed = checks.includes(value.failedCheck) ? value.failedCheck : "UNAVAILABLE";
  return `sectionCount=${count("sectionCount")}; headerCount=${count("headerCount")}; listCount=${count("listCount")}; tracksTitleSpanPresent=${flag}; failedCheck=${failed}`;
};
