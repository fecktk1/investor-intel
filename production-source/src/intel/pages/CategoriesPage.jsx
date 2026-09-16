import React from 'react'
import { useTranslation } from 'react-i18next'
import { Layers } from 'lucide-react'
import { IntelPageHeader, IntelPageShell } from '../components/IntelPrimitives'
import CaptureReceipts from '../components/CaptureReceipts'
import CategoryBoard from '../components/CategoryBoard'
import CategoryDisagreement from '../components/CategoryDisagreement'

// /intel/categories — the CoinMarketCap category list read as a SECOND source of
// market breadth beside the CoinGecko categories the rest of Intel uses. Two
// figures: what the categories are worth and how they moved, and how internally
// consistent the catalogue's own category and tag lists are.
//
// Each figure owns its read, so an undeployed or unrun capture degrades to its
// own stated reason instead of blanking the page.
// The capture lanes whose newest run the receipt drawer describes.
const CAPTURE_RECEIPT_LANES = ['categories']

export default function CategoriesPage() {
  const { t } = useTranslation('intel', { useSuspense: false })

  return (
    <IntelPageShell>
      <IntelPageHeader
        icon={Layers}
        eyebrow={t('categories.eyebrow', { defaultValue: 'Categories' })}
        title={t('categories.title', { defaultValue: 'CoinMarketCap categories' })}
        subtitle={t('categories.subtitle', {
          defaultValue: 'The category list CoinMarketCap publishes, read straight from the capture tables: what each category is worth, how it moved, and how far its membership agrees with the tags on the same catalogue. A second source of breadth, never blended with the CoinGecko categories used elsewhere in Intel.',
        })}
      />
      <CaptureReceipts lanes={CAPTURE_RECEIPT_LANES} />
      <CategoryBoard />
      <CategoryDisagreement />
    </IntelPageShell>
  )
}
