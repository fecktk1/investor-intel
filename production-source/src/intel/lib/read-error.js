// Product-facing read errors never expose database signatures or upstream payloads.
export function intelReadError(error, fallback = 'This information is temporarily unavailable. Please retry.') {
  if (error?.code === '401' || error?.status === 401) return 'Sign in again to load your private research.'
  if (error?.code === '403' || error?.status === 403) return 'This information is not available in the selected workspace.'
  return fallback
}
