// TEST STAND-IN: not the production module; used only so the published Investor Intel tests can run without the private platform.
//
// Stands in for: src/lib/profile-context.jsx
// What that is:  The platform's signed-in profile and organization context. It
//                is not published.
//
// Every export throws when used (test-support/stand-ins/unavailable.ts), so a
// passing test never reached it. The Intel page tests that run replace this
// module with their own fixed profile (vi.mock); the stand-in exists so the
// import resolves at all. The names are the ones that published Intel modules
// import from the real module, and nothing else.

import { unavailable } from '../../unavailable.ts'

export const useProfile = unavailable('src/lib/profile-context.jsx useProfile')
