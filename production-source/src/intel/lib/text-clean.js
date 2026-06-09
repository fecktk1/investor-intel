// Investor Intel — turn raw HTML/embeds (X oEmbed blockquotes, RSS content,
// <br>/<a>/<script>) into clean plain-English text for display.

export function toPlainText(html) {
  if (!html) return ''
  const raw = String(html)
  try {
    // Inject spaces at block boundaries so adjacent blocks don't merge into one word.
    const spaced = raw.replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|div|li|h[1-6]|blockquote|tr|td)>/gi, ' ')
    const doc = new DOMParser().parseFromString(spaced, 'text/html')
    doc.querySelectorAll('script,style,noscript').forEach((el) => el.remove())
    let s = doc.body?.textContent || ''
    s = s.replace(/\bhttps?:\/\/\S+/gi, '').replace(/\b(?:[a-z0-9-]+\.)+(?:com|co|io|org|net|xyz|finance|app|gg|me)\/\S*/gi, '').replace(/\s+/g, ' ').trim()
    return s
  } catch {
    return raw
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&hellip;/g, '…')
      .replace(/\bhttps?:\/\/\S+/gi, '').replace(/\b(?:[a-z0-9-]+\.)+(?:com|co|io|org|net|xyz|finance|app|gg|me)\/\S*/gi, '').replace(/\s+/g, ' ').trim()
  }
}

// Headline: plain text, no trailing URL/HTML; falls back to the body if the
// "title" was only a link.
export function cleanNewsTitle(title, fallback = '') {
  const s = toPlainText(title)
  return s || (fallback ? `${fallback.slice(0, 90)}${fallback.length > 90 ? '…' : ''}` : '(untitled)')
}
