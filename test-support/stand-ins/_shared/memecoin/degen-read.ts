// TEST STAND-IN: not the production module; used only so the published Investor Intel tests can run without the private platform.
//
// Stands in for: supabase/functions/_shared/memecoin/degen-read.ts
// What that is:  The platform's Degen screen reader, which reads the production database. It is not published.
//
// Every export throws when used (test-support/stand-ins/unavailable.ts), so a
// passing test never reached it. The names are the ones that published Intel
// modules import from the real module, and nothing else.

import { unavailable, unavailableConstant } from '../../unavailable.ts'

export const DEGEN_TOKEN_LIMIT = unavailableConstant('supabase/functions/_shared/memecoin/degen-read.ts DEGEN_TOKEN_LIMIT')
export const degenScreenBody = unavailable('supabase/functions/_shared/memecoin/degen-read.ts degenScreenBody')
export const degenScreenRows = unavailable('supabase/functions/_shared/memecoin/degen-read.ts degenScreenRows')
export const readCatalogueContracts = unavailable('supabase/functions/_shared/memecoin/degen-read.ts readCatalogueContracts')
export const readDegenTokens = unavailable('supabase/functions/_shared/memecoin/degen-read.ts readDegenTokens')
