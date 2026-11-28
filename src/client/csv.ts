/** A table as a CSV file a spreadsheet opens as it is (M2.1 导出表格), and handing a file to the reader. */

/**
 * `rows` as CSV text: fields with a comma, a quote or a line break quoted (inner quotes doubled), lines ended with CRLF,
 * and a byte-order mark first, so that Excel reads the Chinese as UTF-8 instead of guessing a local code page.
 */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const field = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
  return `﻿${rows.map(row => row.map(field).join(',')).join('\r\n')}\r\n`
}

/** Offers `text` to the reader as a file named `name` (a download, as the browser or the desktop app handles one). */
export function saveFile(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.style.display = 'none'
  document.body.append(link)
  link.click()
  link.remove()
  // The download has its own copy by now; the address is let go a little later for browsers that read it lazily.
  setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
}

/** A file name without the characters file systems refuse (`/\:*?"<>|`), each made a hyphen. */
export const fileName = (name: string) => name.replace(/[/\\:*?"<>|]+/g, '-').trim()
