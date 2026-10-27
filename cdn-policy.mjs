export const vkAudioFamily = "vkuseraudio.ru";
export const vkAudioPermission = "https://*.vkuseraudio.ru/*";
export const exactAudioHost = "cs1-76v4.vkuseraudio.ru"; // Preserve the previously granted required origin.
export const approvedFamilies = Object.freeze(["vkuseraudio.ru", "vkuseraudio.net", "userapi.com", "vkuser.net", "okcdn.ru", "mycdn.me"]);
export const approvedOrigins = Object.freeze(approvedFamilies.map(domain => `https://*.${domain}/*`));
export const sourceReasons = new Set(["URL_ALLOWED", "FAMILY_UNAPPROVED", "PROTOCOL_NOT_HTTPS", "PORT_NOT_ALLOWED", "URL_AUTH_PRESENT",
  "URL_PARSE_FAILED", "URL_FORMAT_INVALID", "PATH_PLAYLIST_MARKER", "PERMISSION_REQUIRED", "PERMISSION_CHECK_FAILED",
  "SOURCE_MISSING", "SOURCE_MASKED"]);
const protocols = new Set(["https:", "http:", "ftp:", "file:", "blob:", "data:", "javascript:", "OTHER"]);
export const safeHostname = value => typeof value === "string" && (/^[a-z0-9.-]{1,253}$/.test(value) || /^\[[a-f0-9:.]{2,45}\]$/.test(value)) ? value : null;
export const exactSourceHostname = value => safeHostname(value) === value && value.includes(".") &&
  !/^\d+(?:\.\d+){3}$/.test(value) && value.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
export function cdnFamily(hostname) {
  if (!safeHostname(hostname)) return null;
  if (!hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  if (/^vd\d+\.okcdn\.ru$/.test(hostname)) return "okcdn_vd";
  if (hostname === vkAudioFamily || hostname.endsWith("." + vkAudioFamily)) return "vkuseraudio";
  return approvedFamilies.find(domain => hostname === domain || hostname.endsWith("." + domain)) || null;
}
export function safeSourceFacts(value = {}) {
  const hostname = safeHostname(value.hostname ?? value.host);
  return { hostname, protocol: protocols.has(value.protocol) ? value.protocol : null,
    family: (["okcdn_vd", "vkuseraudio", ...approvedFamilies].includes(value.family) && value.family === cdnFamily(hostname)) ? value.family : null,
    reason: sourceReasons.has(value.reason ?? value.sourceReason) ? value.reason ?? value.sourceReason : null };
}
export function inspectSourceAddress(raw, approvedHosts = []) {
  const result = (reason, hostname = null, protocol = null) => safeSourceFacts({ reason, hostname, protocol, family: cdnFamily(hostname) });
  if (typeof raw !== "string" || raw.length > 20000 || raw.trim() !== raw || /[\s\\]/.test(raw)) return result("URL_FORMAT_INVALID");
  let url; try { url = new URL(raw); } catch { return result("URL_PARSE_FAILED"); }
  const hostname = url.hostname || null, protocol = protocols.has(url.protocol) ? url.protocol : "OTHER";
  const reason = url.protocol !== "https:" ? "PROTOCOL_NOT_HTTPS" : url.username || url.password ? "URL_AUTH_PRESENT" :
    url.port ? "PORT_NOT_ALLOWED" : !cdnFamily(hostname) && !(exactSourceHostname(hostname) && approvedHosts.includes(hostname)) ? "FAMILY_UNAPPROVED" :
    /\.m3u8(?:$|[/?])/i.test(url.pathname) ? "PATH_PLAYLIST_MARKER" : "URL_ALLOWED";
  return result(reason, hostname, protocol);
}
