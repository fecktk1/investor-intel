// TEST STAND-IN: not the production module; used only so the published Investor Intel tests can run without the private platform.
//
// Stands in for: src/lib/supabase.js
// What that is:  The platform's browser Supabase client, created at load from
//                the app's environment. It is not published.
//
// Every export throws when used (test-support/stand-ins/unavailable.ts), so a
// passing test never reached it. The Intel frontend tests that run hand their
// modules their own client, built on a fake network. The names are the ones that
// published Intel modules import from the real module, and nothing else.

import { unavailable, unavailableConstant } from '../../unavailable.ts'

export const supabase = unavailableConstant('src/lib/supabase.js supabase')
export const createAuthenticatedClient = unavailable('src/lib/supabase.js createAuthenticatedClient')
export const getAuthenticatedAccessToken = unavailable('src/lib/supabase.js getAuthenticatedAccessToken')
export const setSupabaseFetch = unavailable('src/lib/supabase.js setSupabaseFetch')
export const disableSupabaseRealtime = unavailable('src/lib/supabase.js disableSupabaseRealtime')
