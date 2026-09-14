import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
export default function AssetSectionNav({ sections }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [active, setActive] = useState(sections[0]?.id)
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => {
      const entry = entries.find(value => value.isIntersecting)
      if (entry) setActive(entry.target.id)
    }, { root: document.getElementById('intel-main'), rootMargin: '-48px 0px -65% 0px', threshold: 0 })
    sections.forEach(section => { const node = document.getElementById(section.id); if (node) observer.observe(node) })
    return () => observer.disconnect()
  }, [sections])
  return <nav className="intel-asset-section-nav" aria-label={t('asset.sections', { defaultValue: 'On this asset page' })}>{sections.map(section => <a href={`#${section.id}`} key={section.id} aria-current={active === section.id ? 'location' : undefined} onClick={() => setActive(section.id)}>{t(section.key, { defaultValue: section.label })}</a>)}</nav>
}
