// Only save-file text, never track identity, UI labels or report metadata.
// Segmentation/properties use the Unicode data bundled with the running JS engine.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const pictograph = /\p{Extended_Pictographic}/u;
const presentation = /\p{Emoji_Presentation}|\p{Emoji_Modifier}|\p{Regional_Indicator}/u;
const keycap = /[#*0-9]\uFE0F?\u20E3/u;
const plainTextSymbols = /^(?:[©®™]|\p{P})\uFE0E?\p{M}*$/u;
const textNeighbor = /[\p{L}\p{M}]/u;
function emoji(segment) {
  if (keycap.test(segment)) return true;
  // Preserve text punctuation (including ‼/⁉) and ©/®/™; explicit emoji styling is removed.
  if (plainTextSymbols.test(segment) && !segment.includes('\uFE0F') && !presentation.test(segment)) return false;
  return presentation.test(segment) || pictograph.test(segment);
}
export function stripFilenameEmoji(value) {
  // In Unicode mode a valid surrogate pair is a scalar and is not matched by this class.
  const wellFormed = String(value ?? '').replace(/[\uD800-\uDFFF]/gu, '').normalize('NFC');
  const parts = [...segmenter.segment(wellFormed)].map(({ segment }) => ({ segment, emoji: emoji(segment) }));
  const joined = parts.map((part, i) => {
    let text = part.segment;
    if (part.emoji) {
      // A stray skin modifier can share a grapheme with a normal letter/number.
      // Keep that text base rather than deleting it together with the modifier.
      const ordinaryBase = [...text].some(char => /[\p{L}\p{N}\p{P}\p{S}]/u.test(char) && !pictograph.test(char) && !presentation.test(char));
      if (keycap.test(text) || !ordinaryBase) return '';
      text = [...text].filter(char => !pictograph.test(char) && !presentation.test(char)).join('');
    }
    text = text.replace(/[\uFE0E\uFE0F\u20E3\u{E0000}-\u{E007F}]/gu, '');
    if (parts[i + 1]?.emoji) text = text.replace(/\u200D+$/u, '');
    if (parts[i - 1]?.emoji) text = text.replace(/^\u200D+/u, '');
    return text;
  }).join('');
  // Keep genuine text-shaping joiners (e.g. Indic/Arabic); remove detached emoji/control joiners.
  const scalars = [...joined];
  return scalars.filter((char, i) => char !== '\u200D' ||
    (textNeighbor.test(scalars[i - 1] || '') && textNeighbor.test(scalars[i + 1] || ''))).join('').normalize('NFC');
}
export function filenamePart(value) {
  const cleaned = stripFilenameEmoji(value)
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  let limited = '';
  for (const { segment } of segmenter.segment(cleaned)) {
    if (limited.length + segment.length > 75) break;
    limited += segment;
  }
  limited = limited.replace(/\u200D+$/u, '').replace(/[. ]+$/g, '');
  // A sequence of only marks/format controls is not a readable filename part.
  return /[\p{L}\p{N}\p{P}\p{S}]/u.test(limited) ? limited : '';
}
