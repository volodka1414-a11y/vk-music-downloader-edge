import { PrototypeError, filenameFor } from './core.mjs';
import { normalizedContentType } from './diagnostics.mjs';
import { browserErrorType, browserRejectionCategory, filenameFacts } from './failure-details.mjs';

export function fallbackFilename(trackId, mime) {
  if (typeof trackId !== 'string' || trackId.length > 64 || !/^-?\d+_\d+$/.test(trackId)) throw new PrototypeError('TRACK_METADATA');
  const extension = { 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a' }[normalizedContentType(mime).contentType];
  if (!extension) throw new PrototypeError('PREPARED_MIME');
  return `track_${trackId}${extension}`;
}
export function downloadFilenameFor(track, mime, preferFallback = false) {
  if (!preferFallback) {
    try { return { filename: filenameFor(track.artist, track.title, mime), filenameMode: 'normal' }; }
    catch (error) {
      if (!(error instanceof PrototypeError) || error.diagnostic?.condition !== 'FILENAME_PART_EMPTY') throw error;
    }
  }
  return { filename: fallbackFilename(track.id, mime), filenameMode: 'fallback' };
}
export const trackIdentity = async track => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(JSON.stringify([track.id, track.title, track.artist]))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
export const launchDiagnostic = (error, filename, filenameMode) => ({ stage: 'download_request', operation: 'download_start',
  browserCategory: browserRejectionCategory(error), browserErrorType: browserErrorType(error), ...filenameFacts(filename), filenameMode });
// saveAs:false only. An accepted ID, interruption or uncertain result never enters this branch.
// A dialog cancellation cannot be classified safely from native message text: single mode is manual.
export function mayFallbackWithoutDialog(error) {
  return browserErrorType(error) === 'ERROR' && ['API_REJECTED_UNSPECIFIED', 'TYPE_ERROR'].includes(browserRejectionCategory(error));
}
export const validDownloadId = id => Number.isSafeInteger(id) && id >= 0;
