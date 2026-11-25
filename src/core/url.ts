/** Query parameters that only record who shared a link or where it was clicked, never which page it is. Matched on the lower-cased name. */
const TRACKING_NAMES = new Set(['spm', 'from', 'scene', 'isappinstalled', 'ref', 'src', 'clicktime', 'enterid', 'sessionid', 'chksm'])
const TRACKING_PREFIXES = ['utm_', 'share']

const isTracking = (name: string) => {
  const key = name.toLowerCase()
  return TRACKING_NAMES.has(key) || TRACKING_PREFIXES.some((p) => key.startsWith(p))
}

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * One address per page, for telling whether two sources are the same page (source counting, dedupe).
 * - The scheme is left out (http and https are one page): `https://www.A.com/x/?utm_source=t&b=2&a=1` -> `a.com/x?a=1&b=2`.
 * - The host is lower-cased and loses a leading `www.`; a non-default port stays. The path keeps its case and loses
 *   trailing slashes; the fragment is dropped.
 * - The query stays, because on some sites it *is* the page (a WeChat article is `mp.weixin.qq.com/s?__biz=…&mid=…&sn=…`).
 *   Tracking parameters (`utm_*`, `share*`, `spm`, `from`, `scene`, `chksm`, …) are removed and the rest sorted by name.
 * An address that cannot be parsed comes back trimmed and lower-cased.
 */
export function canonicalUrl(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url.trim().toLowerCase()
  }
  const kept = [...u.searchParams].filter(([name]) => !isTracking(name)).sort(([ka, va], [kb, vb]) => byCodeUnits(ka, kb) || byCodeUnits(va, vb))
  const query = new URLSearchParams(kept).toString()
  const host = u.host.toLowerCase().replace(/^www\./, '')
  const path = u.pathname.replace(/\/+$/, '')
  return host + path + (query ? '?' + query : '')
}
