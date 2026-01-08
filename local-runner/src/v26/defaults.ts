// ============================================================
// V26 DEFAULTS - constants used by multiple modules
// (kept separate to avoid circular imports)
// ============================================================

export const V26_CONFIG = {
  // Which assets to trade
  assets: ['BTC', 'ETH', 'SOL', 'XRP'] as const,

  // Order parameters
  side: 'DOWN' as const,
  price: 0.48,
  shares: 10,

  // Timing (in seconds relative to market start)
  maxLeadTimeSec: 600, // Place order up to 10 minutes before market opens
  minLeadTimeSec: 60, // Must place at least 1 minute before start (after this = too late)
  cancelAfterStartSec: 30, // Cancel 30s AFTER market start if not filled

  // Safety
  maxOrdersPerBar: 1, // Only 1 order per market per asset
  enabled: true,
};
