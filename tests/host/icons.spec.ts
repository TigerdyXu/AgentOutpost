import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ICON_MAX_BYTES, NodeIconFetcher } from '../../src/host/icons.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
/** Public addresses of the made-up hosts; anything else does not resolve. */
const DNS: Record<string, string[]> = {
  'cursor.example': ['93.184.216.34'],
  'cdn.example': ['2606:2800:220:1::1'],
  'rebind.example': ['93.184.216.35', '10.0.0.7'],
  'intranet.example': ['192.168.1.20'],
}

let dir: string
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>
/** Responses by URL; a URL with none answers 404. */
let pages: Record<string, () => Response>
let icons: NodeIconFetcher

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-icons-'))
  pages = {}
  fetch = vi.fn<typeof globalThis.fetch>(async input => (pages[String(input)] ?? (() => new Response('not found', { status: 404 })))())
  icons = new NodeIconFetcher(join(dir, 'icons'), { fetch, resolve: async host => DNS[host] ?? [] })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const image = (bytes: Uint8Array<ArrayBuffer> = PNG, type = 'image/png', headers: Record<string, string> = {}) => () => new Response(bytes, { headers: { 'content-type': type, ...headers } })
const fetched = () => fetch.mock.calls.map(([input]) => String(input))

describe('NodeIconFetcher', () => {
  it('saves the first candidate that answers with an image', async () => {
    pages['https://cursor.example/favicon.ico'] = () => new Response('<html>验证一下</html>', { headers: { 'content-type': 'text/html' } })
    pages['https://cursor.example/apple-touch-icon.png'] = image()

    const path = await icons.fetch('p1', ['https://cdn.example/cursor.png', 'https://cursor.example/favicon.ico', 'https://cursor.example/apple-touch-icon.png'])

    expect(path).toBe(join(dir, 'icons', 'p1.png'))
    expect(new Uint8Array(readFileSync(path!))).toEqual(PNG)
    expect(fetched()).toEqual(['https://cdn.example/cursor.png', 'https://cursor.example/favicon.ico', 'https://cursor.example/apple-touch-icon.png'])
  })

  it('names the file after the image type', async () => {
    pages['https://cursor.example/favicon.ico'] = image(PNG, 'image/vnd.microsoft.icon')
    expect(await icons.fetch('p1', ['https://cursor.example/favicon.ico'])).toBe(join(dir, 'icons', 'p1.ico'))
    pages['https://cursor.example/logo.jpg'] = image(PNG, 'image/jpeg; charset=binary')
    expect(await icons.fetch('p2', ['https://cursor.example/logo.jpg'])).toBe(join(dir, 'icons', 'p2.jpg'))
  })

  it('refuses SVG, which could carry script', async () => {
    pages['https://cursor.example/logo.svg'] = image(new TextEncoder().encode('<svg onload="alert(1)"/>'), 'image/svg+xml')
    expect(await icons.fetch('p1', ['https://cursor.example/logo.svg'])).toBeNull()
  })

  it('refuses an image over 256 KiB, declared or not', async () => {
    pages['https://cursor.example/big.png'] = image(PNG, 'image/png', { 'content-length': String(ICON_MAX_BYTES + 1) })
    expect(await icons.fetch('p1', ['https://cursor.example/big.png'])).toBeNull()

    // No length given: reading stops once the cap is passed.
    let pulled = 0
    const chunk = new Uint8Array(64 * 1024)
    pages['https://cursor.example/endless.png'] = () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(chunk) } }), { headers: { 'content-type': 'image/png' } })
    expect(await icons.fetch('p1', ['https://cursor.example/endless.png'])).toBeNull()
    expect(pulled).toBeLessThan(10)

    // Exactly the cap is fine.
    pages['https://cursor.example/full.png'] = image(new Uint8Array(ICON_MAX_BYTES), 'image/png')
    expect(await icons.fetch('p1', ['https://cursor.example/full.png'])).toBe(join(dir, 'icons', 'p1.png'))
  })

  it('refuses loopback, link-local and private hosts before fetching', async () => {
    const inside = ['http://127.0.0.1/a.png', 'http://localhost:11434/a.png', 'http://api.localhost/a.png', 'http://10.1.2.3/a.png', 'http://172.20.0.1/a.png',
      'http://192.168.0.1/a.png', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/a.png', 'http://[fd12::1]/a.png', 'http://[fe80::1]/a.png',
      'http://[::ffff:127.0.0.1]/a.png', 'http://0.0.0.0/a.png', 'http://2130706433/a.png', 'https://intranet.example/a.png', 'https://rebind.example/a.png',
      'https://unknown.example/a.png', 'file:///etc/passwd', 'ftp://cursor.example/a.png', 'not a url']
    expect(await icons.fetch('p1', inside)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('follows redirects only to public hosts', async () => {
    pages['https://cursor.example/icon'] = () => new Response(null, { status: 302, headers: { location: 'https://cdn.example/icon.png' } })
    pages['https://cdn.example/icon.png'] = image()
    expect(await icons.fetch('p1', ['https://cursor.example/icon'])).toBe(join(dir, 'icons', 'p1.png'))
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' })

    pages['https://cursor.example/sneaky'] = () => new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
    fetch.mockClear()
    expect(await icons.fetch('p2', ['https://cursor.example/sneaky'])).toBeNull()
    expect(fetched()).toEqual(['https://cursor.example/sneaky'])
  })

  it('returns null when every candidate fails, and writes nothing', async () => {
    pages['https://cursor.example/boom.png'] = () => { throw new TypeError('fetch failed') }
    expect(await icons.fetch('p1', ['https://cursor.example/boom.png', 'https://cursor.example/missing.png'])).toBeNull()
    expect(await icons.fetch('p1', [])).toBeNull()
    expect(existsSync(join(dir, 'icons', 'p1.png'))).toBe(false)
  })

  it('gives up on a slow server after the time limit', async () => {
    icons = new NodeIconFetcher(join(dir, 'icons'), { fetch, resolve: async host => DNS[host] ?? [], timeoutMs: 20 })
    fetch.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
    }))
    expect(await icons.fetch('p1', ['https://cursor.example/slow.png'])).toBeNull()
  })

  it('refuses a product id that is not a plain name', async () => {
    pages['https://cursor.example/a.png'] = image()
    expect(await icons.fetch('../outside', ['https://cursor.example/a.png'])).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})
