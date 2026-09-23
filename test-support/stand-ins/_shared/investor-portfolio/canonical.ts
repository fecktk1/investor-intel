// TEST STAND-IN: not the production module; used only so the published Investor Intel tests can run without the private platform.
//
// Stands in for: supabase/functions/_shared/investor-portfolio/canonical.ts
// What that is:  The platform's canonical asset-key helper (shared with SQL and the portfolio tracker). It is not published.
//
// Every export throws when used (test-support/stand-ins/unavailable.ts), so a
// passing test never reached it. The names are the ones that published Intel
// modules import from the real module, and nothing else.

import { unavailable } from '../../unavailable.ts'

export const canonicalAssetKey = unavailable('supabase/functions/_shared/investor-portfolio/canonical.ts canonicalAssetKey')
