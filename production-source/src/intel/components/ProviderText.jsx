import React from 'react'
import { providerTextBlocks } from '../lib/provider-text'

/** Provider prose rendered from its light markdown (../lib/provider-text.js):
 * headings as short bold lines, bullet lists as lists, everything else as
 * paragraphs. Plain React text only: no HTML is ever injected and links become
 * their text. `blocks` may be passed pre-clamped; `after` is appended to the
 * last block (an ellipsis on a clamped head). */
export default function ProviderText({ text, blocks, after = null, className = '' }) {
  const list = Array.isArray(blocks) ? blocks : providerTextBlocks(text)
  if (!list.length) return null
  return (
    <div className={`space-y-2 ${className}`.trim()}>
      {list.map((block, index) => {
        const tail = index === list.length - 1 ? after : null
        if (block.type === 'heading') return <p key={index} className="font-semibold pt-1">{block.text}{tail}</p>
        if (block.type === 'list') {
          const Tag = block.ordered ? 'ol' : 'ul'
          return <Tag key={index} className={`${block.ordered ? 'list-decimal' : 'list-disc'} pl-5 space-y-1`}>
            {block.items.map((item, i) => <li key={i}>{item}{i === block.items.length - 1 ? tail : null}</li>)}
          </Tag>
        }
        return <p key={index} className="whitespace-pre-line">{block.text}{tail}</p>
      })}
    </div>
  )
}
