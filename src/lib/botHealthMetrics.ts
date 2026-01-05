// Bot Health Metrics Engine
// Computes exposures, skew, invariants, and status badge

export interface BotEvent {
  id: string;
  ts: number;
  event_type: string;
  asset: string;
  market_id: string | null;
  reason_code: string | null;
  data: Record<string, unknown> | null;
  run_id: string | null;
  correlation_id: string | null;
  created_at: string;
}

export interface Order {
  id: string;
  client_order_id: string;
  market_id: string;
  asset: string;
  side: string;
  intent_type: string;
  price: number;
  qty: number;
  filled_qty: number | null;
  status: string;
  created_ts: number;
  last_update_ts: number;
}

export interface Fill {
  id: string;
  ts: number;
  asset: string;
  market_id: string;
  side: string;
  intent: string;
  fill_qty: number;
  fill_price: number;
  fill_notional: number;
  order_id: string | null;
}

export interface InventorySnapshot {
  id: string;
  ts: number;
  asset: string;
  market_id: string;
  up_shares: number;
  down_shares: number;
  state: string;
  pair_cost: number | null;
  skew_allowed_reason: string | null;
}

export interface BotConfig {
  maxSharesPerSide: number;
  maxTotalSharesPerMarket: number;
  lateExpirySeconds: number;
}

export type HealthStatus = 'GREEN' | 'YELLOW' | 'RED';

export interface StatusReason {
  type: 'cap_breach' | 'emergency_rate' | 'order_failure' | 'skew' | 'hedge_outside_pairing' | 'aggressive_hedge';
  message: string;
  severity: HealthStatus;
}

export interface HealthMetrics {
  status: HealthStatus;
  reasons: StatusReason[];
  
  // Key numbers
  totalPnL: number;
  maxSharesPerSide: number;
  maxTotalSharesPerMarket: number;
  emergencyEventsPerHour: number;
  orderFailureRate: number;
  
  // Counters
  oneSidedOpensCount: number;
  pairingStartedCount: number;
  pairingTimeoutRevertCount: number;
  hedgeBlockedCount: number;
  unwindOnlyCount: number;
  
  // Invariant checks
  invariants: {
    noPositionOver100PerSide: boolean;
    noTotalOver200PerMarket: boolean;
    noHedgesOutsidePairing: boolean;
    noAggressiveHedgeFallback: boolean;
    noLateExpiryTrading: boolean;
  };
  
  // Time series data (5-min buckets)
  exposureOverTime: { timestamp: number; maxExposure: number }[];
  skewOverTime: { timestamp: number; worstSkew: number }[];
  emergencyTimeline: { timestamp: number; count: number }[];
  orderFailuresTimeline: { timestamp: number; count: number }[];
  
  // Top risky markets
  riskyMarkets: RiskyMarket[];
}

export interface RiskyMarket {
  marketId: string;
  asset: string;
  windowStart: number;
  windowEnd: number;
  upShares: number;
  downShares: number;
  skewPct: number;
  timeLeft: number;
  state: string;
  notes: string;
}

const DEFAULT_CONFIG: BotConfig = {
  maxSharesPerSide: 100,
  maxTotalSharesPerMarket: 200,
  lateExpirySeconds: 180,
};

// Bucket data into 5-minute intervals
function bucketByTime<T extends { ts: number }>(
  data: T[],
  bucketMs: number = 5 * 60 * 1000
): Map<number, T[]> {
  const buckets = new Map<number, T[]>();
  
  for (const item of data) {
    const bucketKey = Math.floor(item.ts / bucketMs) * bucketMs;
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, []);
    }
    buckets.get(bucketKey)!.push(item);
  }
  
  return buckets;
}

// Compute skew percentage
export function computeSkewPct(upShares: number, downShares: number): number {
  const total = upShares + downShares;
  if (total === 0) return 0;
  return (Math.abs(upShares - downShares) / total) * 100;
}

// Reconstruct positions from fills if no snapshots available
export function reconstructPositionsFromFills(
  fills: Fill[]
): Map<string, { upShares: number; downShares: number; upAvgPrice: number; downAvgPrice: number }> {
  const positions = new Map<string, { 
    upShares: number; 
    downShares: number; 
    upTotalCost: number;
    downTotalCost: number;
  }>();
  
  // Sort fills by timestamp
  const sortedFills = [...fills].sort((a, b) => a.ts - b.ts);
  
  for (const fill of sortedFills) {
    const key = fill.market_id;
    if (!positions.has(key)) {
      positions.set(key, { upShares: 0, downShares: 0, upTotalCost: 0, downTotalCost: 0 });
    }
    const pos = positions.get(key)!;
    
    const isUp = fill.intent.toLowerCase().includes('up') || fill.side.toLowerCase() === 'up';
    const isBuy = fill.side.toLowerCase() === 'buy';
    
    if (isUp) {
      if (isBuy) {
        pos.upShares += fill.fill_qty;
        pos.upTotalCost += fill.fill_notional;
      } else {
        pos.upShares = Math.max(0, pos.upShares - fill.fill_qty);
      }
    } else {
      if (isBuy) {
        pos.downShares += fill.fill_qty;
        pos.downTotalCost += fill.fill_notional;
      } else {
        pos.downShares = Math.max(0, pos.downShares - fill.fill_qty);
      }
    }
  }
  
  // Convert to final format
  const result = new Map<string, { upShares: number; downShares: number; upAvgPrice: number; downAvgPrice: number }>();
  for (const [key, pos] of positions) {
    result.set(key, {
      upShares: pos.upShares,
      downShares: pos.downShares,
      upAvgPrice: pos.upShares > 0 ? pos.upTotalCost / pos.upShares : 0,
      downAvgPrice: pos.downShares > 0 ? pos.downTotalCost / pos.downShares : 0,
    });
  }
  
  return result;
}

// Compute all health metrics
export function computeHealthMetrics(
  events: BotEvent[],
  orders: Order[],
  fills: Fill[],
  snapshots: InventorySnapshot[],
  config: Partial<BotConfig> = {},
  timeRangeMs: number = 60 * 60 * 1000 // default 1 hour
): HealthMetrics {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = Date.now();
  const startTime = now - timeRangeMs;
  
  // Filter to time range
  const filteredEvents = events.filter(e => e.ts >= startTime);
  const filteredOrders = orders.filter(o => o.created_ts >= startTime);
  const filteredFills = fills.filter(f => f.ts >= startTime);
  const filteredSnapshots = snapshots.filter(s => s.ts >= startTime);
  
  // Calculate max shares observed within the time range
  let maxSharesPerSide = 0;
  let maxTotalShares = 0;

  if (filteredSnapshots.length > 0) {
    for (const s of filteredSnapshots) {
      maxSharesPerSide = Math.max(maxSharesPerSide, s.up_shares, s.down_shares);
      maxTotalShares = Math.max(maxTotalShares, s.up_shares + s.down_shares);
    }
  } else {
    // If no snapshots available, reconstruct from fills and compute maxima from resulting positions
    const positions = reconstructPositionsFromFills(filteredFills);
    for (const pos of positions.values()) {
      maxSharesPerSide = Math.max(maxSharesPerSide, pos.upShares, pos.downShares);
      maxTotalShares = Math.max(maxTotalShares, pos.upShares + pos.downShares);
    }
  }
  
  // Count event types
  const emergencyEvents = filteredEvents.filter(e => 
    e.event_type.includes('EMERGENCY') || 
    e.reason_code?.includes('EMERGENCY')
  );
  
  const oneSidedOpens = filteredEvents.filter(e => e.event_type === 'ONE_SIDED' || e.event_type === 'OPEN_ONE_SIDED');
  const pairingStarted = filteredEvents.filter(e => e.event_type === 'PAIRING_STARTED');
  const pairingTimeout = filteredEvents.filter(e => e.event_type === 'PAIRING_TIMEOUT_REVERT');
  const hedgeBlocked = filteredEvents.filter(e => e.event_type.includes('HEDGE_BLOCKED'));
  const unwindOnly = filteredEvents.filter(e => e.event_type === 'UNWIND_ONLY');
  
  // Order failures
  const failedOrders = filteredOrders.filter(o => o.status === 'FAILED' || o.status === 'REJECTED');
  const orderFailureRate = filteredOrders.length > 0 
    ? (failedOrders.length / filteredOrders.length) * 100 
    : 0;
  
  // Emergency rate per hour
  const hoursInRange = timeRangeMs / (60 * 60 * 1000);
  const emergencyEventsPerHour = hoursInRange > 0 ? emergencyEvents.length / hoursInRange : 0;
  
  // Build time series
  const eventBuckets = bucketByTime(filteredEvents);
  const snapshotBuckets = bucketByTime(filteredSnapshots);
  
  const emergencyTimeline: { timestamp: number; count: number }[] = [];
  const orderFailuresTimeline: { timestamp: number; count: number }[] = [];
  const exposureOverTime: { timestamp: number; maxExposure: number }[] = [];
  const skewOverTime: { timestamp: number; worstSkew: number }[] = [];
  
  // Generate buckets for timeline
  const bucketMs = 5 * 60 * 1000;
  for (let t = Math.floor(startTime / bucketMs) * bucketMs; t <= now; t += bucketMs) {
    const bucketEvents = eventBuckets.get(t) || [];
    const bucketSnapshots = snapshotBuckets.get(t) || [];
    
    emergencyTimeline.push({
      timestamp: t,
      count: bucketEvents.filter(e => e.event_type.includes('EMERGENCY')).length,
    });
    
    orderFailuresTimeline.push({
      timestamp: t,
      count: bucketEvents.filter(e => e.event_type === 'ORDER_FAILED').length,
    });
    
    let maxExp = 0;
    let worstSkew = 0;
    for (const snap of bucketSnapshots) {
      maxExp = Math.max(maxExp, snap.up_shares, snap.down_shares);
      worstSkew = Math.max(worstSkew, computeSkewPct(snap.up_shares, snap.down_shares));
    }
    
    exposureOverTime.push({ timestamp: t, maxExposure: maxExp });
    skewOverTime.push({ timestamp: t, worstSkew });
  }
  
  // Find worst skew
  const worstSkew = Math.max(...skewOverTime.map(s => s.worstSkew), 0);
  
  // Check invariants
  const noPositionOver100 = maxSharesPerSide <= cfg.maxSharesPerSide;
  const noTotalOver200 = maxTotalShares <= cfg.maxTotalSharesPerMarket;
  
  // Hedge outside pairing detection (simplified)
  const hedgeOutsidePairing = filteredEvents.some(e => 
    e.event_type === 'HEDGE_PLACED' && 
    !filteredEvents.some(pe => 
      pe.event_type === 'PAIRING_STARTED' && 
      pe.market_id === e.market_id &&
      pe.ts < e.ts
    )
  );
  
  // Aggressive hedge detection
  const aggressiveHedge = filteredEvents.some(e => 
    e.event_type === 'AGGRESSIVE_HEDGE' || 
    (e.data && (e.data as Record<string, unknown>).aggressive === true)
  );
  
  // Late expiry trading detection (simplified)
  const lateExpiryTrading = false; // Would need market end times to properly detect
  
  // Build risky markets list
  const riskyMarkets: RiskyMarket[] = [];
  const latestSnapshots = new Map<string, InventorySnapshot>();
  
  for (const snap of filteredSnapshots) {
    const existing = latestSnapshots.get(snap.market_id);
    if (!existing || snap.ts > existing.ts) {
      latestSnapshots.set(snap.market_id, snap);
    }
  }
  
  for (const [marketId, snap] of latestSnapshots) {
    const skew = computeSkewPct(snap.up_shares, snap.down_shares);
    if (skew > 30 || snap.up_shares > 50 || snap.down_shares > 50) {
      let notes = '';
      if (snap.up_shares > snap.down_shares * 2) {
        notes = 'Eenzijdig (UP) — wachten op hedge';
      } else if (snap.down_shares > snap.up_shares * 2) {
        notes = 'Eenzijdig (DOWN) — wachten op hedge';
      } else if (snap.state === 'PAIRING') {
        notes = 'In pairing';
      } else if (snap.state === 'UNWIND_ONLY') {
        notes = 'Near expiry — unwind only';
      }
      
      riskyMarkets.push({
        marketId,
        asset: snap.asset,
        windowStart: startTime,
        windowEnd: now,
        upShares: snap.up_shares,
        downShares: snap.down_shares,
        skewPct: skew,
        timeLeft: 0, // Would need market data
        state: snap.state,
        notes,
      });
    }
  }
  
  // Sort by skew descending
  riskyMarkets.sort((a, b) => b.skewPct - a.skewPct);
  
  // Calculate PnL from fills
  let totalPnL = 0;
  const pnlEvents = filteredEvents.filter(e => e.event_type === 'PNL_UPDATE');
  if (pnlEvents.length > 0) {
    const latestPnl = pnlEvents[pnlEvents.length - 1];
    totalPnL = (latestPnl.data as { pnl?: number })?.pnl || 0;
  }
  
  // Determine status
  const reasons: StatusReason[] = [];
  let status: HealthStatus = 'GREEN';
  
  // Check RED conditions
  if (!noPositionOver100) {
    reasons.push({
      type: 'cap_breach',
      message: `Position exceeds ${cfg.maxSharesPerSide} shares per side (observed: ${maxSharesPerSide})`,
      severity: 'RED',
    });
    status = 'RED';
  }
  
  if (!noTotalOver200) {
    reasons.push({
      type: 'cap_breach',
      message: `Total shares exceed ${cfg.maxTotalSharesPerMarket} per market (observed: ${maxTotalShares})`,
      severity: 'RED',
    });
    status = 'RED';
  }
  
  if (hedgeOutsidePairing) {
    reasons.push({
      type: 'hedge_outside_pairing',
      message: 'Hedge placed outside PAIRING state detected',
      severity: 'RED',
    });
    status = 'RED';
  }
  
  if (aggressiveHedge) {
    reasons.push({
      type: 'aggressive_hedge',
      message: 'Aggressive hedge fallback detected',
      severity: 'RED',
    });
    status = 'RED';
  }
  
  if (orderFailureRate > 15) {
    reasons.push({
      type: 'order_failure',
      message: `Order failure rate > 15% (${orderFailureRate.toFixed(1)}%)`,
      severity: 'RED',
    });
    status = 'RED';
  }
  
  if (worstSkew > 85) {
    reasons.push({
      type: 'skew',
      message: `Worst skew > 85% sustained (${worstSkew.toFixed(1)}%)`,
      severity: 'RED',
    });
    status = 'RED';
  }
  
  // Check YELLOW conditions (only if not already RED)
  if (status !== 'RED') {
    if (emergencyEventsPerHour >= 2 && emergencyEventsPerHour <= 6) {
      reasons.push({
        type: 'emergency_rate',
        message: `Emergency rate 2-6/hour (${emergencyEventsPerHour.toFixed(1)}/hour)`,
        severity: 'YELLOW',
      });
      status = 'YELLOW';
    }
    
    if (orderFailureRate >= 5 && orderFailureRate <= 15) {
      reasons.push({
        type: 'order_failure',
        message: `Order failure rate 5-15% (${orderFailureRate.toFixed(1)}%)`,
        severity: 'YELLOW',
      });
      status = 'YELLOW';
    }
    
    if (worstSkew >= 70 && worstSkew <= 85) {
      reasons.push({
        type: 'skew',
        message: `Worst skew 70-85% (${worstSkew.toFixed(1)}%)`,
        severity: 'YELLOW',
      });
      status = 'YELLOW';
    }
  }
  
  if (reasons.length === 0) {
    reasons.push({
      type: 'cap_breach',
      message: 'All systems operating normally',
      severity: 'GREEN',
    });
  }
  
  return {
    status,
    reasons,
    totalPnL,
    maxSharesPerSide,
    maxTotalSharesPerMarket: maxTotalShares,
    emergencyEventsPerHour,
    orderFailureRate,
    oneSidedOpensCount: oneSidedOpens.length,
    pairingStartedCount: pairingStarted.length,
    pairingTimeoutRevertCount: pairingTimeout.length,
    hedgeBlockedCount: hedgeBlocked.length,
    unwindOnlyCount: unwindOnly.length,
    invariants: {
      noPositionOver100PerSide: noPositionOver100,
      noTotalOver200PerMarket: noTotalOver200,
      noHedgesOutsidePairing: !hedgeOutsidePairing,
      noAggressiveHedgeFallback: !aggressiveHedge,
      noLateExpiryTrading: !lateExpiryTrading,
    },
    exposureOverTime,
    skewOverTime,
    emergencyTimeline,
    orderFailuresTimeline,
    riskyMarkets: riskyMarkets.slice(0, 10),
  };
}
