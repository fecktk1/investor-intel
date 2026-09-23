// Provider prose (CoinMarketCap asset, RWA and exchange descriptions) arrives
// with light markdown: "### " headings, "**bold**", "- " bullets and
// [text](url) links. Printed as plain text a reader sees the markers ("###").
//
// This module turns such text into plain blocks the app can render with its own
// elements. It NEVER produces HTML and never follows a link: a link becomes its
// text, so provider prose cannot inject markup or send a reader anywhere. Text
// with no markdown comes back as the same paragraphs it already was.

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/
const NUMBERED = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
// A bare "#" run at the start of a line with nothing after it is a marker too.
const EMPTY_HEADING = /^\s{0,3}#{1,6}\s*$/

/** Does this text carry markdown markers worth rendering? Headings, bullets,
 * bold pairs or links. */
export function hasProviderMarkdown(text) {
  if (typeof text !== 'string' || !text) return false
  return /(^|\n)\s{0,3}#{1,6}(\s|$)/.test(text) || /\*\*[^*\n]+\*\*/.test(text) || /__[^_\n]+__/.test(text)
    || /\[[^\]\n]+\]\((?:https?:\/\/|\/)[^)\s]*\)/.test(text) || /(^|\n)\s{0,3}[-*+]\s+\S/.test(text)
}

/** Inline markers out: **bold**, __bold__, `code` and [text](url) keep their text. */
export function stripInlineMarkdown(text) {
  return String(text ?? '')
    .replace(/\[([^\]\n]+)\]\((?:[^)\s]*)\)/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
}

/** The text as blocks: { type: 'heading' | 'paragraph', text } and
 * { type: 'list', ordered, items }. Blank lines separate paragraphs; single
 * line breaks inside a paragraph are kept, as the provider wrote them. */
export function providerTextBlocks(text) {
  const blocks = []
  let paragraph = [], list = null
  const flushParagraph = () => { if (paragraph.length) { blocks.push({ type: 'paragraph', text: stripInlineMarkdown(paragraph.join('\n')).trim() }); paragraph = [] } }
  const flushList = () => { if (list) { blocks.push(list); list = null } }
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) { flushParagraph(); flushList(); continue }
    if (EMPTY_HEADING.test(line) || RULE.test(line)) { flushParagraph(); flushList(); continue }
    const heading = line.match(HEADING)
    if (heading) { flushParagraph(); flushList(); const value = stripInlineMarkdown(heading[1]).trim(); if (value) blocks.push({ type: 'heading', text: value }); continue }
    const bullet = line.match(BULLET), numbered = bullet ? null : line.match(NUMBERED)
    if (bullet || numbered) {
      flushParagraph()
      const ordered = !!numbered
      if (!list || list.ordered !== ordered) { flushList(); list = { type: 'list', ordered, items: [] } }
      list.items.push(stripInlineMarkdown((bullet || numbered)[1]).trim())
      continue
    }
    flushList()
    paragraph.push(line.trim())
  }
  flushParagraph(); flushList()
  return blocks.filter(b => b.type === 'list' ? b.items.length : b.text)
}

/** The same text with every marker removed, one block per line: for a one-line
 * or clamped context that cannot render blocks. */
export function plainProviderText(text) {
  return providerTextBlocks(text).map(b => b.type === 'list' ? b.items.map(item => `• ${item}`).join('\n') : b.text).join('\n\n')
}

/** The first blocks that fit in `limit` characters of text, the last one cut
 * at a sentence or word boundary. `clamped` says whether anything was left out. */
export function clampProviderBlocks(blocks, limit) {
  const out = []
  let used = 0
  for (const block of blocks) {
    const size = block.type === 'list' ? block.items.join(' ').length : block.text.length
    if (used + size <= limit) { out.push(block); used += size; continue }
    const room = limit - used
    if (block.type !== 'list' && room > 80) {
      const window = block.text.slice(0, room)
      const sentence = window.lastIndexOf('. ')
      const cut = sentence > room * 0.5 ? sentence + 1 : (window.lastIndexOf(' ') > 0 ? window.lastIndexOf(' ') : room)
      out.push({ ...block, text: block.text.slice(0, cut).trim() })
    } else if (block.type === 'list' && room > 40) {
      const items = []
      let left = room
      for (const item of block.items) { if (item.length > left) break; items.push(item); left -= item.length }
      if (items.length) out.push({ ...block, items })
    }
    return { blocks: out, clamped: true }
  }
  return { blocks: out, clamped: false }
}
