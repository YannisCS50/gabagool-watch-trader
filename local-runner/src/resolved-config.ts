// ============================================================
// RESOLVED CONFIG - Single Source of Truth for Strategy v6.x
// ============================================================
// 
// Precedence (DB-FIRST):
// 1. bot_config (database)  ← SOURCE OF TRUTH
// 2. ENV overrides (config.ts)
// 3. Code defaults (hardcoded fallbacks)
//
// This module ensures NO conflicting parameters, full transparency.
// ============================================================

import { config as envConfig } from './config.js';
import { saveBotEvent } from './backend.js';

// ============================================================
// CONFIG VERSION
// ============================================================
export const CONFIG_VERSION = '7.1.0';
export const CONFIG_SOURCE = 'DB_FIRST';

// ============================================================
// TEST MODE CONFIGURATION
// Low-risk settings that still exercise full mechanics
// ============================================================
export const TEST_MODE_ENABLED = true; // Set to false for production

// ============================================================
// RESOLVED CONFIG TYPES
// ============================================================

export interface ResolvedTradeSizing {
  base: number;      // Base trade size in USDC
  min: number;       // Minimum trade size
  max: number;       // Maximum trade size
}

export interface ResolvedEdge {
  baseBuffer: number;           // Minimum mispricing required (e.g. 0.015 = 1.5¢)
  strongEdge: number;           // Strong edge threshold
  allowOverpay: number;         // Max overpay allowed for fill
  feesBuffer: number;           // Buffer for Polymarket fees
  slippageBuffer: number;       // Buffer for execution slippage
  deepDislocationThreshold: number; // Combined ≤ this = DEEP mode
  minExecutableEdge: number;    // Computed: baseBuffer + feesBuffer + slippageBuffer
}

export interface ResolvedTiming {
  stopNewTradesSec: number;     // No new positions under this time remaining
  hedgeTimeoutSec: number;      // Force hedge after this time one-sided
  hedgeMustBySec: number;       // Must be hedged by this time remaining
  unwindStartSec: number;       // Start unwind at this time remaining
}

export interface ResolvedSkew {
  target: number;               // Target distribution (0.50 = 50/50)
  rebalanceThreshold: number;   // Deviation that triggers rebalance
  hardCap: number;              // Never exceed this on one side
}

export interface ResolvedLimits {
  maxTotalNotional: number;     // Max total investment
  maxPerSide: number;           // Max per side
  maxSharesPerSide: number;     // Max shares per side
  maxNotionalPerTrade: number;  // Max notional per single trade
}

export interface ResolvedOpening {
  maxPrice: number;             // Max price for opening trade
  shares: number;               // Default shares for opening
  skipEdgeCheck: boolean;       // Skip edge check at open
  maxDelayMs: number;           // Max wait after market open
}

export interface ResolvedHedge {
  maxPrice: number;             // Never pay more than this for hedge
  cushionTicks: number;         // Extra ticks for fill
  shares: number;               // Default shares for hedge
  forceTimeoutSec: number;      // Force hedge after this time
  cooldownMs: number;           // Cooldown between hedge attempts
}

export interface ResolvedEntry {
  minSecondsRemaining: number;
  minPrice: number;
  maxPrice: number;
  staleBookMs: number;
}

export interface ResolvedThrottle {
  minOrderIntervalMs: number;   // Minimum ms between orders
  cloudflareBackoffMs: number;  // Backoff on cloudflare block
  cooldownMs: number;           // General cooldown between trades
}

export interface ResolvedTick {
  fallback: number;
  validTicks: number[];
  hedgeCushion: number;
}

// v7.1.0: Shares-based sizing config
export interface ResolvedSizing {
  baseLotShares: number;         // Base lot size in shares
  minLotShares: number;          // Minimum lot size
  maxNotionalPerTrade: number;   // Max $ per single order
  minNotionalPerTrade: number;   // Min $ per order
}

// v7.1.0: Risk limits
export interface ResolvedRisk {
  maxSharesPerSide: number;       // Max shares on UP or DOWN
  maxTotalSharesPerMarket: number; // Max total shares per market
  maxNotionalPerMarket: number;   // Max $ per market
  globalMaxNotional: number;      // Max $ across all markets
}

export interface ConfigConflict {
  field: string;
  dbValue: any;
  envValue: any;
  codeValue: any;
  resolvedValue: any;
  action: 'CLAMP' | 'OVERRIDE' | 'USE_DB' | 'USE_ENV' | 'USE_CODE';
  reason: string;
}

export interface ResolvedConfig {
  version: string;
  source: string;
  testMode: boolean;              // v7.1.0: Test mode flag
  buildTimestamp: number;
  buildIso: string;

  // Core config sections
  tradeSizing: ResolvedTradeSizing;
  sizing: ResolvedSizing;         // v7.1.0: Shares-based sizing
  risk: ResolvedRisk;             // v7.1.0: Risk limits
  edge: ResolvedEdge;
  timing: ResolvedTiming;
  skew: ResolvedSkew;
  limits: ResolvedLimits;
  opening: ResolvedOpening;
  hedge: ResolvedHedge;
  entry: ResolvedEntry;
  throttle: ResolvedThrottle;
  tick: ResolvedTick;

  // Trading parameters
  tradeAssets: string[];
  strategyEnabled: boolean;

  // VPN settings
  vpn: {
    required: boolean;
    endpoint: string | null;
  };

  // Polymarket address
  polymarketAddress: string;

  // Conflicts detected during build
  conflicts: ConfigConflict[];
}

// ============================================================
// CODE DEFAULTS (fallback only)
// ============================================================

// Test Mode Defaults - Low risk but functional
const TEST_DEFAULTS = {
  sizing: {
    baseLotShares: 25,           // Base lot size in shares
    minLotShares: 5,             // Minimum lot size
    maxNotionalPerTrade: 20,     // $20 max per order (fits 25 @ 75¢ hedge)
    minNotionalPerTrade: 8,      // $8 minimum per order
  },
  risk: {
    maxSharesPerSide: 100,       // Low risk: max 100 shares per side
    maxTotalSharesPerMarket: 200, // Low risk: max 200 total per market
    maxNotionalPerMarket: 80,    // Low risk: $80 per market
    globalMaxNotional: 250,      // Low risk: $250 total exposure
  },
  tradeAssets: ['BTC', 'ETH', 'SOL', 'XRP'],
};

// Production Defaults - Higher limits
const PROD_DEFAULTS = {
  sizing: {
    baseLotShares: 50,
    minLotShares: 10,
    maxNotionalPerTrade: 50,
    minNotionalPerTrade: 15,
  },
  risk: {
    maxSharesPerSide: 500,
    maxTotalSharesPerMarket: 1000,
    maxNotionalPerMarket: 300,
    globalMaxNotional: 1000,
  },
  tradeAssets: ['BTC', 'ETH'],
};

// Select defaults based on test mode
const MODE_DEFAULTS = TEST_MODE_ENABLED ? TEST_DEFAULTS : PROD_DEFAULTS;

const CODE_DEFAULTS = {
  tradeSizing: {
    base: MODE_DEFAULTS.sizing.baseLotShares,
    min: MODE_DEFAULTS.sizing.minNotionalPerTrade,
    max: MODE_DEFAULTS.sizing.maxNotionalPerTrade,
  },
  sizing: MODE_DEFAULTS.sizing,
  risk: MODE_DEFAULTS.risk,
  edge: {
    baseBuffer: 0.015,        // 1.5¢
    strongEdge: 0.04,
    allowOverpay: 0.01,
    feesBuffer: 0.002,
    slippageBuffer: 0.004,
    deepDislocationThreshold: 0.96,
  },
  timing: {
    stopNewTradesSec: 30,
    hedgeTimeoutSec: 12,
    hedgeMustBySec: 60,
    unwindStartSec: 45,
  },
  skew: {
    target: 0.50,
    rebalanceThreshold: 0.20,
    hardCap: 0.70,
  },
  limits: {
    maxTotalNotional: MODE_DEFAULTS.risk.globalMaxNotional,
    maxPerSide: MODE_DEFAULTS.risk.maxNotionalPerMarket,
    maxSharesPerSide: MODE_DEFAULTS.risk.maxSharesPerSide,
    maxNotionalPerTrade: MODE_DEFAULTS.sizing.maxNotionalPerTrade,
  },
  opening: {
    maxPrice: 0.52,
    shares: MODE_DEFAULTS.sizing.baseLotShares,
    skipEdgeCheck: true,
    maxDelayMs: 5000,
  },
  hedge: {
    maxPrice: 0.75,
    cushionTicks: 3,
    shares: MODE_DEFAULTS.sizing.baseLotShares,
    forceTimeoutSec: 12,
    cooldownMs: 2000,
  },
  entry: {
    minSecondsRemaining: 45,
    minPrice: 0.03,
    maxPrice: 0.92,
    staleBookMs: 5000,
  },
  throttle: {
    minOrderIntervalMs: 1500,
    cloudflareBackoffMs: 60000,
    cooldownMs: 5000,
  },
  tick: {
    fallback: 0.01,
    validTicks: [0.01, 0.005, 0.002, 0.001],
    hedgeCushion: 3,
  },
  tradeAssets: MODE_DEFAULTS.tradeAssets,
  strategyEnabled: true,
  vpn: {
    required: true,
    endpoint: null,
  },
};

// ============================================================
// DATABASE CONFIG INTERFACE (from bot_config table)
// ============================================================

interface DatabaseConfig {
  id: string;
  backend_url: string | null;
  polymarket_address: string | null;
  vpn_required: boolean | null;
  vpn_endpoint: string | null;
  trade_assets: string[] | null;
  max_notional_per_trade: number | null;
  max_position_size: number | null;
  min_edge_threshold: number | null;
  min_order_interval_ms: number | null;
  cloudflare_backoff_ms: number | null;
  opening_max_price: number | null;
  strategy_enabled: boolean | null;
  created_at: string | null;
  updated_at: string | null;
}

// ============================================================
// FETCH DATABASE CONFIG
// ============================================================

async function fetchDatabaseConfig(): Promise<DatabaseConfig | null> {
  try {
    const url = envConfig.backend.url;
    const secret = envConfig.backend.secret;
    
    if (!url || !secret) {
      console.warn('⚠️  [ResolvedConfig] No backend URL/secret configured, skipping DB fetch');
      return null;
    }

    // The backend URL points to get-bot-config edge function
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-runner-secret': secret,
      },
    });

    if (!response.ok) {
      console.warn(`⚠️  [ResolvedConfig] DB config fetch failed: ${response.status}`);
      return null;
    }

    const data = await response.json();
    
    // The edge function returns a transformed config, we need to map back
    // But first, let's try to fetch raw from Supabase if we have the key
    return data as DatabaseConfig;
  } catch (error) {
    console.warn(`⚠️  [ResolvedConfig] Error fetching DB config:`, error);
    return null;
  }
}

// ============================================================
// BUILD RESOLVED CONFIG
// ============================================================

export async function buildResolvedConfig(runId?: string): Promise<ResolvedConfig> {
  const conflicts: ConfigConflict[] = [];
  const now = Date.now();
  
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  🔧 BUILDING RESOLVED CONFIG (DB-FIRST)                        ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  // Fetch database config
  const dbConfig = await fetchDatabaseConfig();
  const hasDbConfig = dbConfig !== null;
  
  if (hasDbConfig) {
    console.log('✅ Database config loaded');
  } else {
    console.log('⚠️  No database config - using ENV + code defaults');
  }

  // ============================================================
  // RESOLVE EACH PARAMETER (DB → ENV → CODE)
  // ============================================================

  // 1. Trade Assets
  const dbAssets = dbConfig?.trade_assets ?? null;
  const envAssets = envConfig.trading.assets;
  const codeAssets = CODE_DEFAULTS.tradeAssets;
  
  let tradeAssets = codeAssets;
  if (dbAssets && dbAssets.length > 0) {
    tradeAssets = dbAssets;
    if (JSON.stringify(envAssets) !== JSON.stringify(dbAssets)) {
      conflicts.push({
        field: 'tradeAssets',
        dbValue: dbAssets,
        envValue: envAssets,
        codeValue: codeAssets,
        resolvedValue: dbAssets,
        action: 'USE_DB',
        reason: 'ENV assets differ from DB - using DB as source of truth',
      });
    }
  } else if (envAssets && envAssets.length > 0) {
    tradeAssets = envAssets;
  }

  // 2. Max Notional Per Trade (CRITICAL)
  const dbMaxNotional = dbConfig?.max_notional_per_trade ?? null;
  const envMaxNotional = envConfig.trading.maxNotionalPerTrade;
  const codeMaxNotional = CODE_DEFAULTS.limits.maxNotionalPerTrade;
  
  let maxNotionalPerTrade = codeMaxNotional;
  if (dbMaxNotional !== null && dbMaxNotional > 0) {
    maxNotionalPerTrade = dbMaxNotional;
  } else if (envMaxNotional > 0) {
    maxNotionalPerTrade = envMaxNotional;
  }

  // 3. Trade Sizing - CLAMP to maxNotionalPerTrade
  let tradeSizingBase = CODE_DEFAULTS.tradeSizing.base;
  let tradeSizingMax = CODE_DEFAULTS.tradeSizing.max;
  
  // CRITICAL: Clamp base to maxNotionalPerTrade
  if (tradeSizingBase > maxNotionalPerTrade) {
    conflicts.push({
      field: 'tradeSizing.base',
      dbValue: null,
      envValue: null,
      codeValue: tradeSizingBase,
      resolvedValue: maxNotionalPerTrade,
      action: 'CLAMP',
      reason: `tradeSizing.base (${tradeSizingBase}) > maxNotionalPerTrade (${maxNotionalPerTrade})`,
    });
    tradeSizingBase = maxNotionalPerTrade;
  }
  
  if (tradeSizingMax > maxNotionalPerTrade) {
    conflicts.push({
      field: 'tradeSizing.max',
      dbValue: null,
      envValue: null,
      codeValue: tradeSizingMax,
      resolvedValue: maxNotionalPerTrade,
      action: 'CLAMP',
      reason: `tradeSizing.max (${tradeSizingMax}) > maxNotionalPerTrade (${maxNotionalPerTrade})`,
    });
    tradeSizingMax = maxNotionalPerTrade;
  }

  // 4. Edge Threshold (CRITICAL)
  const dbEdgeThreshold = dbConfig?.min_edge_threshold ?? null;
  const codeEdgeBuffer = CODE_DEFAULTS.edge.baseBuffer;
  
  let edgeBaseBuffer = codeEdgeBuffer;
  if (dbEdgeThreshold !== null && dbEdgeThreshold > 0) {
    edgeBaseBuffer = dbEdgeThreshold;
    if (Math.abs(dbEdgeThreshold - codeEdgeBuffer) > 0.001) {
      conflicts.push({
        field: 'edge.baseBuffer',
        dbValue: dbEdgeThreshold,
        envValue: null,
        codeValue: codeEdgeBuffer,
        resolvedValue: dbEdgeThreshold,
        action: 'USE_DB',
        reason: `DB min_edge_threshold (${(dbEdgeThreshold * 100).toFixed(1)}%) differs from code (${(codeEdgeBuffer * 100).toFixed(1)}%)`,
      });
    }
  }

  // 5. Opening Max Price
  const dbOpeningMaxPrice = dbConfig?.opening_max_price ?? null;
  const envOpeningMaxPrice = envConfig.trading.openingMaxPrice;
  const codeOpeningMaxPrice = CODE_DEFAULTS.opening.maxPrice;
  
  let openingMaxPrice = codeOpeningMaxPrice;
  if (dbOpeningMaxPrice !== null && dbOpeningMaxPrice > 0) {
    openingMaxPrice = dbOpeningMaxPrice;
  } else if (envOpeningMaxPrice > 0) {
    openingMaxPrice = envOpeningMaxPrice;
  }

  // 6. Throttle settings
  const dbMinOrderInterval = dbConfig?.min_order_interval_ms ?? null;
  const dbCloudflareBackoff = dbConfig?.cloudflare_backoff_ms ?? null;
  const envMinOrderInterval = envConfig.trading.minOrderIntervalMs;
  const envCloudflareBackoff = envConfig.trading.cloudflareBackoffMs;
  
  const minOrderIntervalMs = dbMinOrderInterval ?? envMinOrderInterval ?? CODE_DEFAULTS.throttle.minOrderIntervalMs;
  const cloudflareBackoffMs = dbCloudflareBackoff ?? envCloudflareBackoff ?? CODE_DEFAULTS.throttle.cloudflareBackoffMs;

  // 7. VPN settings
  const dbVpnRequired = dbConfig?.vpn_required ?? null;
  const dbVpnEndpoint = dbConfig?.vpn_endpoint ?? null;
  
  const vpnRequired = dbVpnRequired ?? envConfig.vpn.required ?? CODE_DEFAULTS.vpn.required;
  const vpnEndpoint = dbVpnEndpoint ?? null;

  // 8. Strategy enabled
  const strategyEnabled = dbConfig?.strategy_enabled ?? CODE_DEFAULTS.strategyEnabled;

  // 9. Polymarket address
  const polymarketAddress = dbConfig?.polymarket_address ?? envConfig.polymarket.address ?? '';

  // ============================================================
  // BUILD FINAL CONFIG OBJECT
  // ============================================================

  const resolvedConfig: ResolvedConfig = {
    version: CONFIG_VERSION,
    source: hasDbConfig ? 'DATABASE' : 'ENV_FALLBACK',
    testMode: TEST_MODE_ENABLED,
    buildTimestamp: now,
    buildIso: new Date(now).toISOString(),

    tradeSizing: {
      base: tradeSizingBase,
      min: Math.min(CODE_DEFAULTS.tradeSizing.min, tradeSizingBase),
      max: tradeSizingMax,
    },

    // v7.1.0: Shares-based sizing
    sizing: CODE_DEFAULTS.sizing,
    
    // v7.1.0: Risk limits
    risk: CODE_DEFAULTS.risk,

    edge: {
      baseBuffer: edgeBaseBuffer,
      strongEdge: CODE_DEFAULTS.edge.strongEdge,
      allowOverpay: CODE_DEFAULTS.edge.allowOverpay,
      feesBuffer: CODE_DEFAULTS.edge.feesBuffer,
      slippageBuffer: CODE_DEFAULTS.edge.slippageBuffer,
      deepDislocationThreshold: CODE_DEFAULTS.edge.deepDislocationThreshold,
      minExecutableEdge: edgeBaseBuffer + CODE_DEFAULTS.edge.feesBuffer + CODE_DEFAULTS.edge.slippageBuffer,
    },

    timing: CODE_DEFAULTS.timing,

    skew: CODE_DEFAULTS.skew,

    limits: {
      maxTotalNotional: CODE_DEFAULTS.limits.maxTotalNotional,
      maxPerSide: CODE_DEFAULTS.limits.maxPerSide,
      maxSharesPerSide: CODE_DEFAULTS.limits.maxSharesPerSide,
      maxNotionalPerTrade,
    },

    opening: {
      maxPrice: openingMaxPrice,
      shares: CODE_DEFAULTS.sizing.baseLotShares,  // Use baseLotShares directly
      skipEdgeCheck: CODE_DEFAULTS.opening.skipEdgeCheck,
      maxDelayMs: CODE_DEFAULTS.opening.maxDelayMs,
    },

    hedge: {
      maxPrice: CODE_DEFAULTS.hedge.maxPrice,
      cushionTicks: CODE_DEFAULTS.hedge.cushionTicks,
      shares: CODE_DEFAULTS.sizing.baseLotShares,  // Use baseLotShares
      forceTimeoutSec: CODE_DEFAULTS.timing.hedgeTimeoutSec,
      cooldownMs: CODE_DEFAULTS.hedge.cooldownMs,
    },

    entry: CODE_DEFAULTS.entry,

    throttle: {
      minOrderIntervalMs,
      cloudflareBackoffMs,
      cooldownMs: CODE_DEFAULTS.throttle.cooldownMs,
    },

    tick: CODE_DEFAULTS.tick,

    tradeAssets,
    strategyEnabled,

    vpn: {
      required: vpnRequired,
      endpoint: vpnEndpoint,
    },

    polymarketAddress,
    conflicts,
  };

  // ============================================================
  // LOG RESOLVED CONFIG
  // ============================================================

  console.log('\n┌────────────────────────────────────────────────────────────────┐');
  console.log('│  📋 RESOLVED CONFIG (EFFECTIVE VALUES)                         │');
  console.log('├────────────────────────────────────────────────────────────────┤');
  const modeStr = resolvedConfig.testMode ? '🧪 TEST MODE' : '🚀 PRODUCTION';
  console.log(`│  Mode: ${modeStr.padEnd(56)}│`);
  console.log(`│  Source: ${resolvedConfig.source.padEnd(54)}│`);
  console.log(`│  Version: ${CONFIG_VERSION.padEnd(53)}│`);
  console.log('├────────────────────────────────────────────────────────────────┤');
  console.log('│  📊 SIZING:                                                    │');
  console.log(`│     BaseLotShares: ${resolvedConfig.sizing.baseLotShares}, MinLotShares: ${resolvedConfig.sizing.minLotShares}`.padEnd(65) + '│');
  console.log(`│     MaxNotionalPerTrade: $${resolvedConfig.sizing.maxNotionalPerTrade}, MinNotional: $${resolvedConfig.sizing.minNotionalPerTrade}`.padEnd(65) + '│');
  console.log('├────────────────────────────────────────────────────────────────┤');
  console.log('│  ⚠️  RISK LIMITS:                                               │');
  console.log(`│     MaxSharesPerSide: ${resolvedConfig.risk.maxSharesPerSide}, MaxTotalShares/Market: ${resolvedConfig.risk.maxTotalSharesPerMarket}`.padEnd(65) + '│');
  console.log(`│     MaxNotionalPerMarket: $${resolvedConfig.risk.maxNotionalPerMarket}, GlobalMax: $${resolvedConfig.risk.globalMaxNotional}`.padEnd(65) + '│');
  console.log('├────────────────────────────────────────────────────────────────┤');
  console.log(`│  Edge Buffer: ${(resolvedConfig.edge.baseBuffer * 100).toFixed(1)}% (min exec: ${(resolvedConfig.edge.minExecutableEdge * 100).toFixed(1)}%)`.padEnd(65) + '│');
  console.log(`│  Opening Max: ${(resolvedConfig.opening.maxPrice * 100).toFixed(0)}¢ (${resolvedConfig.opening.shares} shares)`.padEnd(65) + '│');
  console.log(`│  Hedge Max: ${(resolvedConfig.hedge.maxPrice * 100).toFixed(0)}¢ (${resolvedConfig.hedge.shares} shares)`.padEnd(65) + '│');
  console.log(`│  Assets: ${resolvedConfig.tradeAssets.join(', ')}`.padEnd(65) + '│');
  console.log(`│  Strategy Enabled: ${resolvedConfig.strategyEnabled}`.padEnd(65) + '│');
  console.log('└────────────────────────────────────────────────────────────────┘');

  // ============================================================
  // LOG CONFLICTS
  // ============================================================

  if (conflicts.length > 0) {
    console.log('\n⚠️  CONFIG CONFLICTS DETECTED:');
    console.log('┌────────────────────────────────────────────────────────────────┐');
    for (const c of conflicts) {
      console.log(`│  ${c.action}: ${c.field}`.padEnd(65) + '│');
      console.log(`│    → ${c.reason}`.padEnd(65) + '│');
    }
    console.log('└────────────────────────────────────────────────────────────────┘');

    // Persist conflicts to DB
    for (const c of conflicts) {
      saveBotEvent({
        event_type: `CONFIG_${c.action}`,
        asset: 'ALL',
        run_id: runId,
        reason_code: c.field,
        data: c,
        ts: now,
      }).catch(() => { /* non-critical */ });
    }
  } else {
    console.log('\n✅ No config conflicts detected');
  }

  // Persist effective config to DB
  saveBotEvent({
    event_type: 'CONFIG_RESOLVED',
    asset: 'ALL',
    run_id: runId,
    data: {
      version: resolvedConfig.version,
      source: resolvedConfig.source,
      testMode: resolvedConfig.testMode,
      effective: {
        sizing: resolvedConfig.sizing,
        risk: resolvedConfig.risk,
        tradeSizing: resolvedConfig.tradeSizing,
        limits: resolvedConfig.limits,
        edge: resolvedConfig.edge,
        opening: resolvedConfig.opening,
        hedge: resolvedConfig.hedge,
        tradeAssets: resolvedConfig.tradeAssets,
        strategyEnabled: resolvedConfig.strategyEnabled,
      },
      conflictCount: conflicts.length,
    },
    ts: now,
  }).catch(() => { /* non-critical */ });

  console.log('');

  return resolvedConfig;
}

// ============================================================
// SINGLETON & REFRESH
// ============================================================

let currentConfig: ResolvedConfig | null = null;
let lastRefreshMs = 0;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export async function getResolvedConfig(runId?: string, forceRefresh = false): Promise<ResolvedConfig> {
  const now = Date.now();
  
  if (!currentConfig || forceRefresh || (now - lastRefreshMs > REFRESH_INTERVAL_MS)) {
    currentConfig = await buildResolvedConfig(runId);
    lastRefreshMs = now;
  }
  
  return currentConfig;
}

export function getCurrentConfig(): ResolvedConfig | null {
  return currentConfig;
}

// ============================================================
// HELPER: Create STRATEGY-like object for backwards compatibility
// ============================================================

export function toStrategyObject(cfg: ResolvedConfig) {
  return {
    tradeSizeUsd: cfg.tradeSizing,
    edge: {
      baseBuffer: cfg.edge.baseBuffer,
      buffer: cfg.edge.baseBuffer,  // alias
      strongEdge: cfg.edge.strongEdge,
      allowOverpay: cfg.edge.allowOverpay,
      feesBuffer: cfg.edge.feesBuffer,
      slippageBuffer: cfg.edge.slippageBuffer,
      deepDislocationThreshold: cfg.edge.deepDislocationThreshold,
      minExecutableEdge: cfg.edge.minExecutableEdge,
    },
    timing: cfg.timing,
    skew: cfg.skew,
    limits: {
      ...cfg.limits,
      stopTradesSec: cfg.timing.stopNewTradesSec,
      unwindStartSec: cfg.timing.unwindStartSec,
    },
    tick: cfg.tick,
    opening: cfg.opening,
    hedge: cfg.hedge,
    entry: cfg.entry,
    cooldownMs: cfg.throttle.cooldownMs,
  };
}
