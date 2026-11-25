/**
 * Product icons, downloaded with Node's `fetch` (the DSH host routes it through the user's proxy) into
 * `<dataDir>/icons/<productId>.<ext>`. The addresses come from the research agent, that is from web pages, so they are
 * not trusted: only http(s) to public hosts (checked again after every redirect), only raster images, at most 256 KiB,
 * 10 seconds per address. Any failure moves on to the next address; none usable gives null.
 */
import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { BlockList, isIP } from 'node:net'
import { join } from 'node:path'
import type { Id } from '../core/types.ts'
import type { IconFetcher } from './ports.ts'

export const ICON_MAX_BYTES = 256 * 1024
const TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3

/**
 * The image types kept, by file extension; the file's extension says which type to serve it as. SVG is left out on
 * purpose: opened by itself it can run script in the page's origin.
 */
export const ICON_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
}
const EXTENSION_OF: Record<string, string> = {
  ...Object.fromEntries(Object.entries(ICON_TYPES).map(([ext, type]) => [type, ext])),
  'image/jpg': 'jpg', 'image/pjpeg': 'jpg', 'image/vnd.microsoft.icon': 'ico', 'image/ico': 'ico', 'image/x-ms-bmp': 'bmp',
}

/** Hosts an icon may not come from: this machine, its local networks, and link-local addresses (cloud metadata among them). */
const INSIDE = new BlockList()
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const)
  INSIDE.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const)
  INSIDE.addSubnet(network, prefix, 'ipv6') // IPv4-mapped addresses (::ffff:127.0.0.1) are checked against the IPv4 rules

export interface IconFetcherOptions {
  /** Default: the global `fetch`. */
  fetch?: typeof globalThis.fetch
  /** The addresses a host name resolves to. Default: the system resolver, every address. */
  resolve?: (hostname: string) => Promise<string[]>
  /** Time limit per address. Default 10 seconds. */
  timeoutMs?: number
}

export class NodeIconFetcher implements IconFetcher {
  /** @param iconsDir - where icons are saved (`<dataDir>/icons`); made when missing. */
  constructor(private readonly iconsDir: string, private readonly options: IconFetcherOptions = {}) {}

  async fetch(productId: Id, candidates: string[]): Promise<string | null> {
    if (!/^[\w-]+$/.test(productId)) return null // it names a file
    for (const candidate of candidates) {
      try {
        const icon = await this.download(candidate)
        if (icon) return await this.save(productId, icon)
      } catch { /* this address did not work out; try the next */ }
    }
    return null
  }

  private async download(address: string): Promise<{ ext: string; bytes: Uint8Array } | null> {
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? TIMEOUT_MS)
    const fetch = this.options.fetch ?? globalThis.fetch
    let url = new URL(address)
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!(await this.isPublic(url))) return null
      const response = await fetch(url.href, { redirect: 'manual', signal, headers: { accept: 'image/*' } })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location) return null
        url = new URL(location, url)
        continue
      }
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      const ext = EXTENSION_OF[type]
      if (!response.ok || !ext || Number(response.headers.get('content-length')) > ICON_MAX_BYTES) {
        await response.body?.cancel()
        return null
      }
      const bytes = await readAtMost(response, ICON_MAX_BYTES)
      return bytes?.length ? { ext, bytes } : null
    }
    return null
  }

  /** Whether `url` is http(s) on a host that is, and resolves only to, a public address. */
  private async isPublic(url: URL): Promise<boolean> {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost')) return false
    const addresses = isIP(host) ? [host] : await (this.options.resolve ?? resolveAll)(host)
    return addresses.length > 0 && addresses.every(isPublicAddress)
  }

  private async save(productId: Id, icon: { ext: string; bytes: Uint8Array }): Promise<string> {
    await mkdir(this.iconsDir, { recursive: true })
    const path = join(this.iconsDir, `${productId}.${icon.ext}`)
    const partial = `${path}.${randomUUID()}.part`
    try {
      await writeFile(partial, icon.bytes)
      await rename(partial, path)
    } catch (error) {
      await rm(partial, { force: true })
      throw error
    }
    return path
  }
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  return family !== 0 && !INSIDE.check(address, family === 6 ? 'ipv6' : 'ipv4')
}

async function resolveAll(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(a => a.address)
}

/** The body, or null as soon as it grows past `cap` bytes (the rest is not read). */
async function readAtMost(response: Response, cap: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > cap) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}
