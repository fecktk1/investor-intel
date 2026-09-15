// Disable only for previews/releases whose database has not received the
// reviewed history migration. The legacy cache/memory path stays operational.
export const portfolioReadingHistoryEnabled=()=>import.meta.env.VITE_INTEL_PORTFOLIO_READING_HISTORY!=='false'
