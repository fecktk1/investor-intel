import React, { useId, useState } from 'react'

// Desktop keeps its toolbar; narrow screens disclose the same controls in place.
export default function ResponsiveChartTools({ label, children }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return <div className="intel-responsive-tools" data-open={open}>
    <button type="button" className="intel-responsive-tools-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{label} <span aria-hidden="true">{open ? '−' : '+'}</span></button>
    <div id={id} className="intel-responsive-tools-content">{children}</div>
  </div>
}
