// Verified 2026-09-11 against Birdeye's endpoint-specific accessibility table:
// https://docs.birdeye.so/docs/data-accessibility-by-packages
// Network support for prices/security does not imply holder-list support.
export const birdeyeHolderListSupported = (chain: string) => chain === 'solana'
