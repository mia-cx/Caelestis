/**
 * The public presentation an operator configures for their server: a Discord invite, home page
 * copy, a header logo and a default link preview.
 *
 * Everything here is validated on the way in (backend, userscript) and rendered from parsed
 * structure on the way out (frontend), so admin text never reaches a page as markup.
 */

export const MAX_HOME_COPY_LENGTH = 4_000
export const MAX_HOME_COPY_LINKS = 20
export const MAX_LOGO_TEXT_LENGTH = 64
export const MAX_DISCORD_INVITE_URL_LENGTH = 128

/** Content types an operator may upload for a logo or preview. SVG is excluded: it can script. */
export const SERVER_ASSET_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const
export type ServerAssetContentType = (typeof SERVER_ASSET_CONTENT_TYPES)[number]

export type ServerAssetKind = 'logo' | 'preview'
export const SERVER_ASSET_KINDS: readonly ServerAssetKind[] = ['logo', 'preview']

/** Upload byte limits per asset kind. A header logo should stay small; a preview is one card. */
export const SERVER_ASSET_MAX_BYTES: Readonly<Record<ServerAssetKind, number>> = {
  logo: 512 * 1024,
  preview: 2 * 1024 * 1024,
}

/** A stored branding asset. The etag is the SHA-256 digest of its bytes, so a URL can be immutable. */
export interface ServerAsset {
  readonly etag: string
  readonly contentType: ServerAssetContentType
}

export const isServerAssetContentType = (value: unknown): value is ServerAssetContentType =>
  typeof value === 'string' &&
  (SERVER_ASSET_CONTENT_TYPES as readonly string[]).includes(value.toLowerCase())

/** Sniff the container from its leading bytes, because a content-type header is a claim. */
export const sniffServerAssetContentType = (bytes: Uint8Array): ServerAssetContentType | null => {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg'
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  )
    return 'image/gif'
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image/webp'
  return null
}

export const parseServerAsset = (value: unknown): ServerAsset | null => {
  if (typeof value !== 'object' || value === null) return null
  const { etag, contentType } = value as { etag?: unknown; contentType?: unknown }
  if (typeof etag !== 'string' || !/^[0-9a-f]{64}$/.test(etag)) return null
  if (!isServerAssetContentType(contentType)) return null
  return { etag, contentType: contentType.toLowerCase() as ServerAssetContentType }
}

/** Where the frontend serves a branding asset from, relative to the API root. */
export const serverAssetPath = (kind: ServerAssetKind, asset: ServerAsset): string =>
  `/server/assets/${kind}?v=${asset.etag}`

const DISCORD_INVITE =
  /^https:\/\/(?:www\.)?(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/([A-Za-z0-9-]{2,64})\/?$/

/**
 * Accept only a Discord invite and answer its canonical form, so the page links where the admin
 * meant and never to an arbitrary host.
 */
export const parseDiscordInviteUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_DISCORD_INVITE_URL_LENGTH) return null
  const match = DISCORD_INVITE.exec(trimmed)
  return match === null ? null : `https://discord.gg/${match[1]}`
}

export const logoText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const text = value.normalize('NFC').trim()
  return text.length > 0 && text.length <= MAX_LOGO_TEXT_LENGTH && !/[\p{Cc}\p{Cf}]/u.test(text)
    ? text
    : null
}

export type HomeCopyInline =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'strong'; readonly text: string }
  | { readonly type: 'em'; readonly text: string }
  | { readonly type: 'link'; readonly text: string; readonly href: string }

export type HomeCopyBlock =
  | { readonly type: 'heading'; readonly inlines: readonly HomeCopyInline[] }
  | { readonly type: 'paragraph'; readonly inlines: readonly HomeCopyInline[] }
  | { readonly type: 'list'; readonly items: readonly (readonly HomeCopyInline[])[] }

export type HomeCopyResult =
  | { readonly ok: true; readonly blocks: readonly HomeCopyBlock[] }
  | { readonly ok: false; readonly message: string }

const HTTP_LINK = /^https?:\/\/[^\s<>"'`]+$/

const parseInlines = (
  line: string,
  links: { count: number },
): readonly HomeCopyInline[] | string => {
  const inlines: HomeCopyInline[] = []
  let text = ''
  const flush = (): void => {
    if (text.length > 0) inlines.push({ type: 'text', text })
    text = ''
  }
  let index = 0
  while (index < line.length) {
    const rest = line.slice(index)
    const link = /^\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/.exec(rest)
    if (link !== null) {
      const href = link[2] ?? ''
      if (!HTTP_LINK.test(href)) return `Links must start with http:// or https://: ${href}`
      if (++links.count > MAX_HOME_COPY_LINKS)
        return `Use at most ${MAX_HOME_COPY_LINKS} links in the home page copy.`
      flush()
      inlines.push({ type: 'link', text: (link[1] ?? '').trim() || href, href })
      index += link[0].length
      continue
    }
    const strong = /^\*\*([^*\n]+)\*\*/.exec(rest)
    if (strong !== null) {
      flush()
      inlines.push({ type: 'strong', text: strong[1] ?? '' })
      index += strong[0].length
      continue
    }
    const em = /^\*([^*\n]+)\*/.exec(rest)
    if (em !== null) {
      flush()
      inlines.push({ type: 'em', text: em[1] ?? '' })
      index += em[0].length
      continue
    }
    text += line[index]
    index += 1
  }
  flush()
  return inlines
}

/**
 * Parse an operator's home page copy into blocks the frontend renders as elements.
 *
 * A bounded markdown subset: blank lines separate paragraphs, `## ` starts a heading, `- ` starts a
 * bullet, `**bold**`, `*italic*` and `[label](https://...)` work inline. Everything else is text.
 * Refuses control characters, oversized input, non-http links and too many links, with a message
 * the userscript can show.
 */
export const parseHomeCopy = (value: unknown): HomeCopyResult => {
  if (typeof value !== 'string') return { ok: false, message: 'Home page copy must be text.' }
  const copy = value.normalize('NFC').replace(/\r\n?/g, '\n')
  if (copy.length > MAX_HOME_COPY_LENGTH)
    return {
      ok: false,
      message: `Home page copy must be at most ${MAX_HOME_COPY_LENGTH} characters.`,
    }
  if (/[^\P{Cc}\n\t]|\p{Cf}/u.test(copy))
    return { ok: false, message: 'Home page copy cannot contain control characters.' }
  const blocks: HomeCopyBlock[] = []
  const links = { count: 0 }
  let paragraph: string[] = []
  let list: (readonly HomeCopyInline[])[] = []
  const inline = (line: string): readonly HomeCopyInline[] | string => parseInlines(line, links)
  const closeParagraph = (): string | null => {
    if (paragraph.length === 0) return null
    const inlines = inline(paragraph.join(' '))
    paragraph = []
    if (typeof inlines === 'string') return inlines
    blocks.push({ type: 'paragraph', inlines })
    return null
  }
  const closeList = (): void => {
    if (list.length > 0) blocks.push({ type: 'list', items: list })
    list = []
  }
  for (const raw of copy.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) {
      const error = closeParagraph()
      if (error !== null) return { ok: false, message: error }
      closeList()
      continue
    }
    if (line.startsWith('## ') || line.startsWith('# ')) {
      const error = closeParagraph()
      if (error !== null) return { ok: false, message: error }
      closeList()
      const inlines = inline(line.replace(/^#+\s+/, ''))
      if (typeof inlines === 'string') return { ok: false, message: inlines }
      blocks.push({ type: 'heading', inlines })
      continue
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      const error = closeParagraph()
      if (error !== null) return { ok: false, message: error }
      const inlines = inline(line.slice(2).trim())
      if (typeof inlines === 'string') return { ok: false, message: inlines }
      list.push(inlines)
      continue
    }
    closeList()
    paragraph.push(line)
  }
  const error = closeParagraph()
  if (error !== null) return { ok: false, message: error }
  closeList()
  return { ok: true, blocks }
}

/** Canonical stored form: trimmed, normalised, unix newlines; null when there is nothing to keep. */
export const normaliseHomeCopy = (value: string): string | null => {
  const copy = value.normalize('NFC').replace(/\r\n?/g, '\n').trim()
  return copy.length === 0 ? null : copy
}
