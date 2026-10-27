// Самодостаточная функция для chrome.scripting.executeScript в MAIN world.
// Только чтение выбранной строки. Никаких fetch, плеера, глобального поиска URL.
export function readSelectedTrack(rowKey, ownerId, mode = "source") {
  const flags = { matchingRows: null, rowConnected: null, idUsable: null, titleUsable: null, artistUsable: null };
  const err = (code, condition) => ({ ok: false, code, diagnostic: { ...flags, ...(condition ? { condition } : {}) } });
  if (ownerId) {
    const u = new URL(location.href);
    if (u.origin !== "https://vk.ru" || u.pathname !== `/audios${ownerId}` ||
        (u.searchParams.has("section") && u.searchParams.get("section") !== "all") ||
        ["z", "playlist_id", "album_id", "q"].some(key => u.searchParams.has(key))) return err("PAGE_SCOPE");
  }
  if (typeof rowKey !== "string" || !/^[a-f0-9-]{36}$/.test(rowKey)) return err("ROW_MISSING");
  const rows = document.querySelectorAll(`[data-vkdl-row="${rowKey}"]`);
  flags.matchingRows = rows.length;
  if (rows.length === 1) flags.rowConnected = rows[0].isConnected === true;
  if (rows.length !== 1 || !rows[0].isConnected) return err("ROW_MISSING");
  const row = rows[0];
  const norm = value => String(value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  const text = value => {
    // Декодирование сущностей в отключённом текстовом элементе; не вставляем HTML в страницу.
    const box = document.createElement("textarea");
    box.innerHTML = String(value ?? "");
    return norm(box.value);
  };
  const visible = selectors => {
    for (const sel of selectors) {
      const hit = row.querySelector(sel);
      if (hit && norm(hit.textContent)) return norm(hit.textContent);
    }
    return "";
  };
  const domTitle = visible(['.audio_row__title_inner', '.audio_row__title', '[data-testid="audiorow-title"]', '[data-testid="audio-title"]', '[data-testid="MusicTrackTitle"]']);
  const domArtist = visible(['.audio_row__performers', '[data-testid="audiorow-performers"]', '[data-testid="audio-performer"]', '[data-testid="MusicTrackArtists"]']);
  const explicitIds = [row.getAttribute("data-full-id"), row.id?.replace(/^audio/, "")]
    .filter(v => /^-?\d+_\d+$/.test(v || ""));
  const candidates = [];
  function add(a, binding) {
    if (!a || typeof a !== "object") return;
    if (!/^-?\d+$/.test(String(a.owner_id)) || !/^\d+$/.test(String(a.id))) { flags.idUsable ??= false; return; }
    flags.idUsable = true;
    const id = `${a.owner_id}_${a.id}`;
    const title = text(a.title), artist = text(a.artist);
    flags.titleUsable = flags.titleUsable === true || !!title;
    flags.artistUsable = flags.artistUsable === true || !!artist;
    if (!title || !artist) return;
    candidates.push({ id, title, artist, duration: Number(a.duration) || null,
      url: typeof a.url === "string" ? a.url : "", binding });
  }
  const data = row.getAttribute("data-audio");
  if (data) {
    let a;
    try { a = JSON.parse(data); } catch { return err("TRACK_METADATA", "DATA_AUDIO_JSON_INVALID"); }
    try {
      if (Array.isArray(a)) add({ id: a[0], owner_id: a[1], url: a[2], title: a[3], artist: a[4], duration: a[5] }, "data-audio");
      else add(a, "data-audio-object");
    } catch { return err("TRACK_METADATA", "DATA_AUDIO_PROCESSING_FAILED"); }
  }
  // Ограниченный обход fiber только выбранного row-subtree и его компонентов.
  // Останавливаемся на первом DOM-предке снаружи строки. Player/список не читаются.
  const nodes = [row, ...Array.from(row.querySelectorAll("*")).slice(0, 200)];
  const seen = new Set();
  for (const node of nodes) {
    if (node.closest("[data-vkdl-ui]")) continue;
    const key = Object.keys(node).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    let fiber = key ? node[key] : null;
    for (let depth = 0; fiber && depth < 20 && !seen.has(fiber); depth++, fiber = fiber.return) {
      const host = fiber.stateNode;
      if (host instanceof Element && host !== row && !row.contains(host)) break;
      seen.add(fiber);
      const p = fiber.memoizedProps;
      if (!p || typeof p !== "object") continue;
      for (const obj of [p.track?.entity?.apiAudio, p.track?.data?.apiAudio,
        p.audio?.entity?.apiAudio, p.audio, p.originalAttachment]) add(obj, "row-react-props");
    }
  }
  if (!candidates.length) return err("TRACK_METADATA", "NO_COMPLETE_CANDIDATE");
  if (new Set(candidates.map(a => a.id)).size !== 1) return err("TRACK_AMBIGUOUS");
  const first = candidates[0];
  if (explicitIds.some(id => id !== first.id) || candidates.some(a => a.title !== first.title || a.artist !== first.artist)) return err("TRACK_MISMATCH");
  if ((domTitle && domTitle !== first.title) || (domArtist && domArtist !== first.artist)) return err("TRACK_MISMATCH");
  if (mode === "metadata") return { ok: true, id: first.id, title: first.title, artist: first.artist,
    duration: first.duration, binding: [...new Set(candidates.map(a => a.binding))].join(" + ") };
  const urls = [...new Set(candidates.map(a => a.url).filter(Boolean))];
  if (urls.length > 1) return err("TRACK_AMBIGUOUS");
  // Source-only diagnostic: keep the same identity checks but allow an absent/masked URL to be observed.
  if (mode === "source_diagnostic") return { ok: true, ...first, url: urls[0] || "", binding: [...new Set(candidates.map(a => a.binding))].join(" + ") };
  if (!urls.length) return err("SOURCE_MISSING");
  if (urls[0].includes("audio_api_unavailable")) return err("SOURCE_MASKED");
  return { ok: true, ...first, url: urls[0], binding: [...new Set(candidates.map(a => a.binding))].join(" + ") };
}
