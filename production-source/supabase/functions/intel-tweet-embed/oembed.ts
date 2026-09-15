// Extractor for the public X oEmbed payload.
//
// The browser never talks to X, and the markup X returns is NEVER rendered:
// only plain text is taken out of it, so a post can carry no script, no style,
// no tracking pixel and no markup into an Intel chart.

export type TweetEmbed = { url: string; author: string | null; handle: string | null; text: string; postedAt: string | null; avatar: string | null }

export const TEXT_LIMIT = 1000
export const HTML_LIMIT = 80_000

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·',
}

// Numeric references are bounded to real Unicode scalar values; anything else is
// left as written rather than guessed at.
export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole
      try { return String.fromCodePoint(code) } catch { return whole }
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
}

// Tags out, entities decoded, whitespace collapsed. Line breaks in the markup
// survive as newlines because a post's own line breaks are part of its text.
export function plainText(html: string): string {
  const withBreaks = html.slice(0, HTML_LIMIT)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
  return decodeEntities(withBreaks).replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, TEXT_LIMIT)
}

const HANDLE = /^[A-Za-z0-9_]{1,15}$/
const handleFrom = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const last = value.split('?')[0].split('#')[0].replace(/\/+$/, '').split('/').pop() || ''
  return HANDLE.test(last) ? last : null
}

// The trailing "<em dash> Author (@handle) <a ...>September 3, 2014</a>" byline.
const POSTED = /<a[^>]*>([^<]{4,40})<\/a>\s*<\/blockquote>/i
const BODY = /<p[^>]*>([\s\S]*?)<\/p>/i
const BYLINE = /\(@([A-Za-z0-9_]{1,15})\)/

export function extractTweet(payload: unknown, url: string): TweetEmbed {
  const row = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const html = typeof row.html === 'string' ? row.html.slice(0, HTML_LIMIT) : ''
  if (!html) throw new Error('tweet_embed_empty')
  const text = plainText(BODY.exec(html)?.[1] ?? '')
  const author = typeof row.author_name === 'string' ? decodeEntities(row.author_name).trim().slice(0, 120) : null
  const handle = handleFrom(row.author_url) ?? BYLINE.exec(html)?.[1] ?? handleFrom(url)
  const stamp = POSTED.exec(html)?.[1]
  const parsed = stamp ? Date.parse(decodeEntities(stamp).trim()) : NaN
  return { url, author: author || null, handle, text, postedAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null, avatar: null }
}

// Per-process cache. Keys are the canonical status address, so the same post is
// fetched once however many members or charts reference it.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_LIMIT = 200
const cache = new Map<string, { at: number; value: TweetEmbed }>()

export function cachedTweet(url: string, now = Date.now()): TweetEmbed | null {
  const row = cache.get(url)
  if (!row) return null
  if (now - row.at > CACHE_TTL_MS) { cache.delete(url); return null }
  return row.value
}

export function rememberTweet(url: string, value: TweetEmbed, now = Date.now()): TweetEmbed {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  cache.set(url, { at: now, value })
  return value
}

export function forgetTweets() { cache.clear() }

export const OEMBED = 'https://publish.twitter.com/oembed'
const RESPONSE_LIMIT = 200_000

// Read one post through the public oEmbed endpoint. Returns the cached value
// when there is one; a refusal is raised as a named error, never as empty text.
export async function fetchTweetEmbed(url: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<TweetEmbed> {
  const hit = cachedTweet(url, now)
  if (hit) return hit
  const endpoint = `${OEMBED}?url=${encodeURIComponent(url)}&omit_script=true&dnt=true`
  let response: Response
  try {
    response = await fetchImpl(endpoint, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) })
  } catch { throw new Error('tweet_embed_unavailable') }
  if (response.status === 404) throw new Error('tweet_not_found')
  if (response.status === 401 || response.status === 403) throw new Error('tweet_refused')
  if (!response.ok) throw new Error('tweet_embed_unavailable')
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT) throw new Error('tweet_embed_unavailable')
  const body = (await response.text()).slice(0, RESPONSE_LIMIT)
  let payload: unknown
  try { payload = JSON.parse(body) } catch { throw new Error('tweet_embed_unavailable') }
  const tweet = extractTweet(payload, url)
  // The profile image is best effort: a post whose author's image cannot be
  // read is still a post, with the author's initial standing in on the card.
  const avatar = await fetchTweetAvatar(url, fetchImpl).catch(() => null)
  return rememberTweet(url, { ...tweet, avatar }, now)
}

// ── The author's profile image ──
//
// oEmbed carries no image. X's public syndication payload (the one its own
// embedded timelines read) does, under `user.profile_image_url_https`, and it
// is read here on the server and handed to the browser as an inline data URL,
// so the browser never contacts X or its image host. Only X's image host is
// read, the image is bounded, and only an image content type is accepted.
export const SYNDICATION = 'https://cdn.syndication.twimg.com/tweet-result'
export const AVATAR_HOST = 'https://pbs.twimg.com/'
export const AVATAR_LIMIT = 96_000
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

/** The token the syndication endpoint expects beside a post id: the id scaled
 * and written in base 36, as X's own embed code computes it. */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
}

export function tweetIdFrom(url: string): string | null {
  const match = /\/status\/([0-9]{1,25})$/.exec(url)
  return match ? match[1] : null
}

/** The address of the author's profile image for one post, or null. A larger
 * variant than the 48-pixel default is asked for, because the card draws the
 * image at 40 CSS pixels on displays that are commonly twice as dense. */
export async function fetchTweetAvatarUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const id = tweetIdFrom(url)
  if (!id) return null
  const response = await fetchImpl(`${SYNDICATION}?id=${id}&lang=en&token=${syndicationToken(id)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) })
  if (!response.ok) return null
  const body = (await response.text()).slice(0, RESPONSE_LIMIT)
  let payload: any
  try { payload = JSON.parse(body) } catch { return null }
  const image = payload?.user?.profile_image_url_https
  if (typeof image !== 'string' || !image.startsWith(AVATAR_HOST) || image.length > 500) return null
  return image.replace(/_normal(\.[a-z]+)$/i, '_bigger$1')
}

/** The image itself as a bounded data URL, or null. */
export async function fetchTweetAvatar(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const image = await fetchTweetAvatarUrl(url, fetchImpl)
  if (!image) return null
  const response = await fetchImpl(image, { signal: AbortSignal.timeout(6000) })
  if (!response.ok) return null
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!AVATAR_TYPES.includes(type)) return null
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > AVATAR_LIMIT) return null
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.length || bytes.length > AVATAR_LIMIT) return null
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${type};base64,${btoa(binary)}`
}
