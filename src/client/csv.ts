/** A table as a CSV file a spreadsheet opens as it is (M2.1 导出表格), and handing a file to the reader. */

/**
 * `rows` as CSV text: fields with a comma, a quote or a line break quoted (inner quotes doubled), lines ended with CRLF,
 * and a byte-order mark first, so that Excel reads the Chinese as UTF-8 instead of guessing a local code page. A field
 * that a spreadsheet would take for a formula (starting with = + - @) gets a leading apostrophe, so it stays text.
 */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const field = (raw: string) => {
    const value = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
    return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
  }
  return `\uFEFF${rows.map(row => row.map(field).join(',')).join('\r\n')}\r\n`
}

/** What the desktop app answers a save with (`@deepseek-ai/dsh-client-ui-file-actions` `FileSaveResult`). */
type SaveResult = { status: 'cancelled' } | { status: 'requested' } | { status: 'saved'; path: string }
/**
 * The desktop app's own file saving, which it gives its main window as `window.dshDesktop.fileActions` (its preload): a
 * `download` lands in the Downloads folder under the name asked for (made unique), as its own 「下载」 menu does. A page
 * outside the desktop app (DSH's web version) has none.
 */
interface DesktopFiles { save(request: { url: string; name?: string; mediaType?: string; mode: 'download' | 'saveAs' }): Promise<SaveResult> }
const desktopFiles = (): DesktopFiles | undefined =>
  (globalThis as { dshDesktop?: { fileActions?: Partial<DesktopFiles> } }).dshDesktop?.fileActions?.save ? (globalThis as unknown as { dshDesktop: { fileActions: DesktopFiles } }).dshDesktop.fileActions : undefined

/**
 * Saves `text` as a file named `name`: in the desktop app, into the Downloads folder (resolving with where it went); in a
 * browser, as a download the browser handles (resolving with null, since the page cannot know where it went).
 * @throws When the desktop app could not save it.
 */
export async function saveFile(name: string, text: string, type = 'text/csv;charset=utf-8'): Promise<string | null> {
  const url = URL.createObjectURL(new Blob([text], { type }))
  try {
    const desktop = desktopFiles()
    if (desktop) {
      const result = await desktop.save({ url, name, mediaType: type, mode: 'download' })
      return result.status === 'saved' ? result.path : null
    }
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.style.display = 'none'
    document.body.append(link)
    link.click()
    link.remove()
    return null
  } finally {
    // The download has its own copy by now; the address is let go a little later for browsers that read it lazily.
    setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
  }
}

/** A file name without the characters file systems refuse (`/\:*?"<>|`), each made a hyphen. */
export const fileName = (name: string) => name.replace(/[/\\:*?"<>|]+/g, '-').trim()
