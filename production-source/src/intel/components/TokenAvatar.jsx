import React, { useState } from 'react'

// Robust token logo (G2): renders the provider image when available, falls back
// cleanly to a deterministic colored monogram on missing/broken images. Fixed
// size → NO layout shift; lazy-loaded; accessible alt; no console noise (onError
// swaps to initials rather than leaving a broken <img>).

const SIZES = {
  xs: 'h-4 w-4 text-[7px]',
  sm: 'h-5 w-5 text-[8px]',
  md: 'h-7 w-7 text-[10px]',
  lg: 'h-10 w-10 text-[13px]',
}

function hueFromSymbol(sym) {
  let h = 0
  const s = String(sym || '?')
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

export default function TokenAvatar({ src, symbol, name, size = 'md', className = '' }) {
  const [errored, setErrored] = useState(false)
  const sz = SIZES[size] || SIZES.md
  const label = String(symbol || name || '?').replace(/^\$/, '')
  const initials = label.slice(0, 3).toUpperCase()
  const showImg = !!src && !errored
  const hue = hueFromSymbol(label)
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full overflow-hidden ${sz} ${className}`}
      style={showImg ? undefined : { background: `hsl(${hue} 45% 20%)`, color: `hsl(${hue} 70% 75%)` }}
      title={label}
    >
      {showImg ? (
        <img
          src={src}
          alt={`${label} logo`}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          onError={() => setErrored(true)}
        />
      ) : (
        <span className="font-semibold leading-none" aria-label={`${label} logo`}>{initials}</span>
      )}
    </span>
  )
}
