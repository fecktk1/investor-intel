// Tests for the X oEmbed extractor behind the chart's post drawing. Run:
//   deno test --allow-read --allow-net --allow-env --no-check \
//     supabase/functions/intel-tweet-embed/
//
// index.ts is the Deno.serve listener plus the same four lines of Intel auth as
// intel-asset-facts; what is proved here is the part that handles third-party
// content: markup never survives as markup, a refusal is a named state rather
// than empty text, the response is bounded, and one post is fetched once.

import { assert, assertEquals as eq, assertRejects, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { cachedTweet, decodeEntities, extractTweet, fetchTweetEmbed, forgetTweets, plainText, syndicationToken, OEMBED, SYNDICATION, TEXT_LIMIT } from './oembed.ts'

const URL_ONE = 'https://x.com/Interior/status/507185938620219395'
const payload = (html: string, extra: Record<string, unknown> = {}) => ({
  author_name: 'US Dept of Interior', author_url: 'https://twitter.com/Interior', html, ...extra,
})
const POST = payload(
  '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Sunsets don&#39;t get much better than this one over ' +
  '<a href="https://twitter.com/GrandTetonNPS">@GrandTetonNPS</a>.<br>Second line &amp; more.</p>&mdash; ' +
  'US Dept of Interior (@Interior) <a href="https://twitter.com/Interior/status/507185938620219395?ref_src=twsrc%5Etfw">September 3, 2014</a></blockquote>',
)

const respond = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), init)

Deno.test('the post is returned as plain text with its author, handle and posting time', () => {
  const tweet = extractTweet(POST, URL_ONE)
  eq(tweet.author, 'US Dept of Interior')
  eq(tweet.handle, 'Interior')
  eq(tweet.text, "Sunsets don't get much better than this one over @GrandTetonNPS.\nSecond line & more.")
  eq(tweet.postedAt, new Date('September 3, 2014').toISOString())
  eq(tweet.url, URL_ONE)
})

Deno.test('markup in a post never survives extraction as markup', () => {
  const hostile = payload('<blockquote><p><script>steal()</script><img src=x onerror="steal()">Read <b>this</b></p>' +
    '<a href="https://twitter.com/a/status/1">January 2, 2026</a></blockquote>')
  const tweet = extractTweet(hostile, URL_ONE)
  assert(!tweet.text.includes('<'))
  assert(!tweet.text.includes('onerror'))
  eq(tweet.text, 'steal()Read this')
  // An author name arrives decoded, not as markup either.
  eq(extractTweet(payload(POST.html, { author_name: '<b>Name</b> &amp; Co' }), URL_ONE).author, '<b>Name</b> & Co')
})

Deno.test('entities decode only for real code points and leave anything else written as it is', () => {
  eq(decodeEntities('a &amp; b &#39;c&#39; &#x2014; &hellip;'), "a & b 'c' — …")
  eq(decodeEntities('&#0; &#1114112; &#xD800; &notarealentity;'), '&#0; &#1114112; &#xD800; &notarealentity;')
})

Deno.test('extraction is bounded and an empty or shapeless payload is an error, never blank text', () => {
  const long = payload(`<blockquote><p>${'x'.repeat(5000)}</p></blockquote>`)
  eq(extractTweet(long, URL_ONE).text.length, TEXT_LIMIT)
  for (const value of [null, {}, { html: '' }, 'not an object']) assertThrows(() => extractTweet(value, URL_ONE))
  // A post whose body cannot be located reports an empty text with its author, not a guess.
  eq(extractTweet(payload('<blockquote>no body</blockquote>'), URL_ONE).text, '')
})

Deno.test('a missing or withheld post is a named refusal rather than an empty card', async () => {
  forgetTweets()
  await assertRejects(() => fetchTweetEmbed(URL_ONE, () => Promise.resolve(respond('', { status: 404 }))), Error, 'tweet_not_found')
  await assertRejects(() => fetchTweetEmbed(URL_ONE, () => Promise.resolve(respond('', { status: 403 }))), Error, 'tweet_refused')
  await assertRejects(() => fetchTweetEmbed(URL_ONE, () => Promise.resolve(respond('{', { status: 200 }))), Error, 'tweet_embed_unavailable')
  await assertRejects(() => fetchTweetEmbed(URL_ONE, () => Promise.reject(new Error('offline'))), Error, 'tweet_embed_unavailable')
  await assertRejects(
    () => fetchTweetEmbed(URL_ONE, () => Promise.resolve(respond(POST, { headers: { 'content-length': '900000' } }))),
    Error, 'tweet_embed_unavailable',
  )
  eq(cachedTweet(URL_ONE), null)
})

Deno.test('one post is read once for the life of the process and expires on its own', async () => {
  forgetTweets()
  // Only the post read is counted: the image read beside it is its own request.
  let calls = 0
  const source = ((input: RequestInfo | URL) => { if (String(input).startsWith(OEMBED)) calls++; return Promise.resolve(respond(POST)) }) as typeof fetch
  const first = await fetchTweetEmbed(URL_ONE, source)
  const second = await fetchTweetEmbed(URL_ONE, source)
  eq(calls, 1)
  eq(second.text, first.text)
  await fetchTweetEmbed(URL_ONE, source, Date.now() + 7 * 60 * 60 * 1000)
  eq(calls, 2)
  forgetTweets()
})

Deno.test('the author image is read from the syndication payload, bounded to the image host, and inlined; a missing image is no image', async () => {
  forgetTweets()
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const image = (body: Uint8Array, type = 'image/png') => new Response(body, { headers: { 'content-type': type } })
  const source = ((input: RequestInfo | URL) => {
    const u = String(input)
    if (u.startsWith(OEMBED)) return Promise.resolve(respond(POST))
    if (u.startsWith(SYNDICATION)) { assert(u.includes('id=507185938620219395&lang=en&token=' + syndicationToken('507185938620219395'))); return Promise.resolve(respond({ user: { profile_image_url_https: 'https://pbs.twimg.com/profile_images/1/a_normal.png' } })) }
    if (u === 'https://pbs.twimg.com/profile_images/1/a_bigger.png') return Promise.resolve(image(png))
    return Promise.resolve(respond('', { status: 404 }))
  }) as typeof fetch
  const tweet = await fetchTweetEmbed(URL_ONE, source)
  eq(tweet.avatar, `data:image/png;base64,${btoa(String.fromCharCode(...png))}`)
  eq(tweet.text.length > 0, true)
  // The image is best effort: without it the post is still a post.
  forgetTweets()
  const offline = await fetchTweetEmbed(URL_ONE, ((input: RequestInfo | URL) => String(input).startsWith(OEMBED) ? Promise.resolve(respond(POST)) : Promise.reject(new Error('offline'))) as typeof fetch)
  eq(offline.avatar, null); eq(offline.author, 'US Dept of Interior')
  // Only X's own image host is read, and only an image content type is kept.
  for (const [address, type] of [['https://evil.example/a_normal.png', 'image/png'], ['https://pbs.twimg.com/profile_images/1/a_normal.png', 'text/html']]) {
    forgetTweets()
    const refused = await fetchTweetEmbed(URL_ONE, ((input: RequestInfo | URL) => { const u = String(input); return Promise.resolve(u.startsWith(OEMBED) ? respond(POST) : u.startsWith(SYNDICATION) ? respond({ user: { profile_image_url_https: address } }) : image(png, type)) }) as typeof fetch)
    eq(refused.avatar, null)
  }
  eq(syndicationToken('20'), ((20 / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ''))
})
