import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, RefreshCw, TrendingUp, TrendingDown, DollarSign, Target, Percent,
  Clock, Zap, BarChart3, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ExternalLink,
  Upload, CheckCircle2, XCircle, Flame, Activity, Wifi, WifiOff
} from 'lucide-react';
import { DownloadV26LogicButton } from '@/components/DownloadV26LogicButton';
import { V26StrategyModal } from '@/components/V26StrategyModal';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { format, formatDistanceToNow } from 'date-fns';
import { nl } from 'date-fns/locale';
import { toZonedTime } from 'date-fns-tz';

interface V26Trade {
  id: string;
  created_at: string;
  asset: string;
  market_slug: string;
  event_start_time: string;
  event_end_time: string;
  order_id: string | null;
  side: string;
  price: number;
  shares: number;
  notional: number;
  status: string;
  filled_shares: number;
  avg_fill_price: number | null;
  fill_time_ms: number | null;
  result: string | null;
  pnl: number | null;
  fill_matched_at: string | null;
}

interface StrikePrice {
  market_slug: string;
  strike_price: number;
  close_price: number | null;
}

interface FillLog {
  order_id: string;
  ts: number; // Unix timestamp in ms
  market_id: string;
  seconds_remaining: number | null; // Seconds remaining until market close at fill time
}

interface TradeLog {
  id: string;
  market: string;
  marketSlug: string;
  asset: string;
  time: string;
  shares: number;
  pricePerShare: number;
  total: number;
  orderType: 'LIMIT';
  result: 'WIN' | 'LOSS' | 'LIVE' | 'PENDING' | 'NOT_BOUGHT';
  resultSource: 'PNL' | 'RESULT' | 'DELTA' | 'LIVE' | 'NOT_FILLED' | 'UNKNOWN'; // Source of result decision
  pnl: number | null;
  expectedPayout: number | null; // What we'd get if we win ($1 * shares)
  fillTimeMs: number | null;
  filledOffsetSec: number | null; // Seconds before (negative) or after (positive) market open
  filledSource: 'match' | 'log' | null; // Source of fill time: 'match' = CLOB match_time, 'log' = fill_logs
  strikePrice: number | null;
  closePrice: number | null;
  delta: number | null;
  status: string;
  eventEndTime: string;
  eventStartTime: string;
  createdAt: string;
  side: string; // UP or DOWN
}

interface AssetStats {
  wins: number;
  losses: number;
  winRate: number;
  pnl: number;
  invested: number;
  placed: number;
  filled: number;
  fillRate: number;
}

const ASSETS = ['ALL', 'BTC', 'ETH', 'SOL', 'XRP'] as const;
const PAGE_SIZE = 20;

export default function V26Dashboard() {
  const navigate = useNavigate();
  const [trades, setTrades] = useState<TradeLog[]>([]);
  const [assetFilter, setAssetFilter] = useState<typeof ASSETS[number]>('ALL');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [uploadingSyncing, setUploadingSyncing] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stats, setStats] = useState({
    totalBets: 0,
    filledBets: 0,
    wins: 0,
    losses: 0,
    pending: 0,
    live: 0,
    winRate: 0,
    totalInvested: 0,
    totalPnl: 0,
    avgProfitPerBet: 0,
    avgProfitPerHour: 0,
    totalHours: 0,
    roi: 0,
    fillRate: 0,
    avgEntryOffset: 0,
    currentStreak: 0,
    maxWinStreak: 0,
    maxLossStreak: 0,
    profitFactor: 0,
  });
  const [assetStats, setAssetStats] = useState<Record<string, AssetStats>>({});
  const [fillTimeStats, setFillTimeStats] = useState({
    avgMs: 0,
    bestMs: Infinity,
    worstMs: 0,
    count: 0,
  });
  const [timingAnalysis, setTimingAnalysis] = useState({
    beforeOpen: { wins: 0, losses: 0, winRate: 0, count: 0, pnl: 0 },
    afterOpen: { wins: 0, losses: 0, winRate: 0, count: 0, pnl: 0 },
    pValue: null as number | null,
  });
  const [runnerStatus, setRunnerStatus] = useState<{
    isOnline: boolean;
    lastHeartbeat: string | null;
    runnerId: string | null;
    marketsCount: number;
    version: string | null;
  }>({
    isOnline: false,
    lastHeartbeat: null,
    runnerId: null,
    marketsCount: 0,
    version: null,
  });

  // Two-proportion z-test for comparing win rates
  const calculatePValue = (
    wins1: number, n1: number, 
    wins2: number, n2: number
  ): number | null => {
    if (n1 < 2 || n2 < 2) return null;
    
    const p1 = wins1 / n1;
    const p2 = wins2 / n2;
    const pPooled = (wins1 + wins2) / (n1 + n2);
    
    // Pooled standard error
    const se = Math.sqrt(pPooled * (1 - pPooled) * (1/n1 + 1/n2));
    if (se === 0) return null;
    
    // Z-score
    const z = (p1 - p2) / se;
    
    // Two-tailed p-value using normal CDF approximation
    const pValue = 2 * (1 - normalCDF(Math.abs(z)));
    return pValue;
  };

  // Standard normal CDF approximation (Abramowitz and Stegun)
  const normalCDF = (x: number): number => {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);
    
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    
    return 0.5 * (1.0 + sign * y);
  };

  // V26 went live on January 7, 2026 at 16:00 ET (21:00 UTC)
  const V26_GO_LIVE_DATE = '2026-01-07T21:00:00+00:00';

  const fetchData = async () => {
    setLoading(true);

    const tradesRes = await supabase
      .from('v26_trades')
      .select('*')
      .gte('created_at', V26_GO_LIVE_DATE)
      .order('event_start_time', { ascending: false })
      .limit(500);

    const tradesData = tradesRes.data as V26Trade[] | null;

    if (!tradesData) {
      setLoading(false);
      return;
    }

    const marketSlugs = Array.from(new Set(tradesData.map((t) => t.market_slug))).filter(Boolean);
    const orderIds = Array.from(new Set(tradesData.map((t) => t.order_id).filter(Boolean))) as string[];

    // Fetch strike prices and fill logs in parallel
    const [strikesRes, fillLogsRes] = await Promise.all([
      marketSlugs.length
        ? supabase
            .from('strike_prices')
            .select('market_slug, strike_price, close_price')
            .in('market_slug', marketSlugs)
        : Promise.resolve({ data: [] as StrikePrice[] }),
      orderIds.length
        ? supabase
            .from('fill_logs')
            .select('order_id, ts, market_id, seconds_remaining')
            .in('order_id', orderIds)
        : Promise.resolve({ data: [] as FillLog[] }),
    ]);

    const strikesData = strikesRes.data as StrikePrice[] | null;
    const fillLogsData = fillLogsRes.data as FillLog[] | null;

    const strikeLookup = new Map<string, StrikePrice>();
    if (strikesData) {
      for (const s of strikesData) {
        strikeLookup.set(s.market_slug, s);
      }
    }

    // Build lookup: order_id -> best fill record.
    // If an order has multiple fills, we pick the *latest* fill (smallest seconds_remaining).
    const fillTimeLookup = new Map<string, { ts: number; secondsRemaining: number | null }>();
    if (fillLogsData) {
      for (const f of fillLogsData) {
        const next = { ts: f.ts, secondsRemaining: f.seconds_remaining ?? null };
        const existing = fillTimeLookup.get(f.order_id);

        if (!existing) {
          fillTimeLookup.set(f.order_id, next);
          continue;
        }

        if (existing.secondsRemaining !== null && next.secondsRemaining !== null) {
          if (next.secondsRemaining < existing.secondsRemaining) {
            fillTimeLookup.set(f.order_id, next);
          }
          continue;
        }

        if (next.ts > existing.ts) {
          fillTimeLookup.set(f.order_id, next);
        }
      }
    }

    const logs: TradeLog[] = [];
    let totalWins = 0;
    let totalLosses = 0;
    let totalPending = 0;
    let totalLive = 0;
    let totalFilled = 0;
    let totalInvested = 0;
    let totalPnl = 0;

    // Per-asset stats
    const perAsset: Record<string, AssetStats> = {
      BTC: { wins: 0, losses: 0, winRate: 0, pnl: 0, invested: 0, placed: 0, filled: 0, fillRate: 0 },
      ETH: { wins: 0, losses: 0, winRate: 0, pnl: 0, invested: 0, placed: 0, filled: 0, fillRate: 0 },
      SOL: { wins: 0, losses: 0, winRate: 0, pnl: 0, invested: 0, placed: 0, filled: 0, fillRate: 0 },
      XRP: { wins: 0, losses: 0, winRate: 0, pnl: 0, invested: 0, placed: 0, filled: 0, fillRate: 0 },
    };

    // Fill time tracking
    const fillTimes: number[] = [];
    const entryOffsets: number[] = [];
    
    // For streaks calculation
    const settledResults: ('WIN' | 'LOSS')[] = [];

    const seen = new Set<string>();

    for (const trade of tradesData) {
      if (seen.has(trade.market_slug)) continue;
      seen.add(trade.market_slug);

      // Track placed orders per asset
      if (perAsset[trade.asset]) {
        perAsset[trade.asset].placed++;
      }

      const strike = strikeLookup.get(trade.market_slug);
      const strikePrice = strike?.strike_price ?? null;
      const closePrice = strike?.close_price ?? null;
      const delta = strikePrice !== null && closePrice !== null 
        ? closePrice - strikePrice 
        : null;

      const now = new Date();
      const eventEnd = new Date(trade.event_end_time);
      const isEnded = eventEnd < now;
      const isFilled = trade.status === 'filled' || trade.filled_shares > 0;
      const filledShares = trade.filled_shares || 0;
      
      // Track filled orders per asset
      if (isFilled && perAsset[trade.asset]) {
        perAsset[trade.asset].filled++;
      }
      const avgPrice = trade.avg_fill_price ?? trade.price;
      const cost = filledShares * avgPrice;
      const fillTimeMs = trade.fill_time_ms;

      // Track fill times
      if (fillTimeMs !== null && fillTimeMs > 0) {
        fillTimes.push(fillTimeMs);
      }

      const tradeResult = trade.result;
      const tradePnl = trade.pnl;

      let result: TradeLog['result'];
      let resultSource: TradeLog['resultSource'] = 'UNKNOWN';

      const addFilledAccounting = () => {
        totalFilled++;
        totalInvested += cost;
        perAsset[trade.asset].invested += cost;
      };

      const settleWin = (source: TradeLog['resultSource']) => {
        result = 'WIN';
        resultSource = source;
        totalWins++;
        perAsset[trade.asset].wins++;
        settledResults.push('WIN');
        addFilledAccounting();
      };

      const settleLoss = (source: TradeLog['resultSource']) => {
        result = 'LOSS';
        resultSource = source;
        totalLosses++;
        perAsset[trade.asset].losses++;
        settledResults.push('LOSS');
        addFilledAccounting();
      };

      // Build log identifier for debugging
      const logId = `[${trade.asset}-${format(new Date(trade.event_start_time), 'HH:mm')}]`;

      if (!isFilled) {
        result = 'NOT_BOUGHT';
        resultSource = 'NOT_FILLED';
        console.log(`${logId} Status = NOT_BOUGHT (no fill)`);
      } else {
        const sideUpper = (trade.side ?? '').toUpperCase();
        const resultUpper = (tradeResult ?? '').toUpperCase();

        // PRIORITY 1: Use PnL if available (most reliable source of truth)
        if (tradePnl !== null && tradePnl !== 0) {
          if (tradePnl > 0) {
            settleWin('PNL');
            console.log(`${logId} Result = WIN via pnl ($${tradePnl.toFixed(2)})`);
          } else {
            settleLoss('PNL');
            console.log(`${logId} Result = LOSS via pnl ($${tradePnl.toFixed(2)})`);
          }
        }
        // PRIORITY 2: Market not ended yet -> LIVE
        else if (!isEnded) {
          result = 'LIVE';
          resultSource = 'LIVE';
          totalLive++;
          addFilledAccounting();
          console.log(`${logId} Status = LIVE (market not ended)`);
        }
        // PRIORITY 3: pnl = 0 and market ended - ambiguous, check other sources
        else if (tradePnl === 0) {
          // pnl = 0 could mean tie or data issue - check result/delta
          if (resultUpper === 'UP' || resultUpper === 'DOWN') {
            if (sideUpper && sideUpper === resultUpper) {
              settleWin('RESULT');
              console.log(`${logId} Result = WIN via result (pnl=0 but result=${resultUpper})`);
            } else {
              settleLoss('RESULT');
              console.log(`${logId} Result = LOSS via result (pnl=0 but result=${resultUpper})`);
            }
          } else {
            result = 'PENDING';
            resultSource = 'UNKNOWN';
            totalPending++;
            addFilledAccounting();
            console.log(`${logId} Status = PENDING (pnl=0, no result data)`);
          }
        }
        // PRIORITY 4: Backend stored market winning side (UP/DOWN)
        else if (resultUpper === 'UP' || resultUpper === 'DOWN') {
          if (sideUpper && sideUpper === resultUpper) {
            settleWin('RESULT');
            console.log(`${logId} Result = WIN via result (${sideUpper} === ${resultUpper})`);
          } else {
            settleLoss('RESULT');
            console.log(`${logId} Result = LOSS via result (${sideUpper} !== ${resultUpper})`);
          }
        }
        // PRIORITY 5: Fallback - infer winner from close-vs-strike delta
        else if (delta !== null) {
          if (delta === 0) {
            result = 'PENDING';
            resultSource = 'UNKNOWN';
            totalPending++;
            addFilledAccounting();
            console.log(`${logId} Status = PENDING (delta=0, ambiguous)`);
          } else {
            const winningSide = delta < 0 ? 'DOWN' : 'UP';
            if (sideUpper && sideUpper === winningSide) {
              settleWin('DELTA');
              console.log(`${logId} Result = WIN via delta fallback (delta=${delta.toFixed(2)} → ${winningSide})`);
            } else {
              settleLoss('DELTA');
              console.log(`${logId} Result = LOSS via delta fallback (delta=${delta.toFixed(2)} → ${winningSide})`);
            }
          }
        } else {
          result = 'PENDING';
          resultSource = 'UNKNOWN';
          totalPending++;
          addFilledAccounting();
          console.log(`${logId} Status = PENDING (no pnl, no result, no delta)`);
        }
      }

      // Use stored pnl from database - don't estimate
      let pnl: number | null = tradePnl;
      
      if (pnl !== null) {
        totalPnl += pnl;
        perAsset[trade.asset].pnl += pnl;
      }

      const startTimeUTC = new Date(trade.event_start_time);
      const endTimeUTC = new Date(trade.event_end_time);
      
      // Convert to ET timezone
      const etTimezone = 'America/New_York';
      const startTimeET = toZonedTime(startTimeUTC, etTimezone);
      const endTimeET = toZonedTime(endTimeUTC, etTimezone);
      
      // Format: "XRP Up or Down - January 7, 5:15PM-5:30PM ET"
      const startTimeStr = format(startTimeET, 'h:mma').replace(':00', '');
      const endTimeStr = format(endTimeET, 'h:mma').replace(':00', '');
      const dateStr = format(startTimeET, 'MMMM d');
      const marketTitle = `${trade.asset} Up or Down - ${dateStr}, ${startTimeStr}-${endTimeStr} ET`;

      const eventStartMs = new Date(trade.event_start_time).getTime();
      const eventEndMs = new Date(trade.event_end_time).getTime();
      const marketLenSec = Math.round((eventEndMs - eventStartMs) / 1000);

      // Calculate filled offset - PRIORITY: fill_matched_at (real CLOB match time)
      // Negative = before open, positive = after open
      const { filledOffsetSec, filledSource } = (() => {
        // Priority 1: fill_matched_at from CLOB order details (most accurate)
        if (trade.fill_matched_at) {
          const matchMs = new Date(trade.fill_matched_at).getTime();
          const offset = Math.round((matchMs - eventStartMs) / 1000);
          // Sanity check: offset should be within reasonable bounds
          // Pre-open fills can be up to ~10 min early, post-open up to market length
          if (offset >= -600 && offset <= marketLenSec) {
            return { filledOffsetSec: offset, filledSource: 'match' as const };
          }
        }

        // Priority 2: fill_logs using seconds_remaining 
        // seconds_remaining = seconds until market CLOSE at fill time
        // So offset from start = marketLenSec - seconds_remaining
        if (!trade.order_id) return { filledOffsetSec: null, filledSource: null };

        const fill = fillTimeLookup.get(trade.order_id);
        if (!fill) return { filledOffsetSec: null, filledSource: null };

        if (fill.secondsRemaining !== null) {
          // Only use if seconds_remaining makes sense for this market length
          // Pre-open fills have seconds_remaining > marketLenSec
          const offset = marketLenSec - fill.secondsRemaining;
          // Valid range: up to 10 min early, up to market length after
          if (offset >= -600 && offset <= marketLenSec) {
            return { filledOffsetSec: offset, filledSource: 'log' as const };
          }
        }

        // Fallback: direct timestamp comparison
        const offset = Math.round((fill.ts - eventStartMs) / 1000);
        if (offset >= -600 && offset <= marketLenSec) {
          return { filledOffsetSec: offset, filledSource: 'log' as const };
        }

        return { filledOffsetSec: null, filledSource: null };
      })();

      // Calculate expected payout (what we'd get if we win)
      const expectedPayout = filledShares > 0 ? filledShares * 1.0 : null; // $1 per share if win

      logs.push({
        id: trade.id,
        market: marketTitle,
        marketSlug: trade.market_slug,
        asset: trade.asset,
        time: format(startTimeET, 'dd-MM h:mma').replace(':00', '') + ' ET',
        shares: filledShares,
        pricePerShare: avgPrice,
        total: cost,
        orderType: 'LIMIT',
        result,
        resultSource,
        pnl,
        expectedPayout,
        fillTimeMs,
        filledOffsetSec,
        filledSource,
        strikePrice,
        closePrice,
        delta,
        status: trade.status,
        eventEndTime: trade.event_end_time,
        eventStartTime: trade.event_start_time,
        createdAt: trade.created_at,
        side: trade.side ?? 'DOWN',
      });
    }

    // Calculate win rates and fill rates per asset
    for (const asset of ['BTC', 'ETH', 'SOL', 'XRP']) {
      const a = perAsset[asset];
      a.winRate = a.wins + a.losses > 0 ? (a.wins / (a.wins + a.losses)) * 100 : 0;
      a.fillRate = a.placed > 0 ? (a.filled / a.placed) * 100 : 0;
    }

    const winRate = totalWins + totalLosses > 0 
      ? (totalWins / (totalWins + totalLosses)) * 100 
      : 0;

    // Calculate fill time stats
    const fillTimeStatsCalc = {
      avgMs: fillTimes.length > 0 ? fillTimes.reduce((a, b) => a + b, 0) / fillTimes.length : 0,
      bestMs: fillTimes.length > 0 ? Math.min(...fillTimes) : 0,
      worstMs: fillTimes.length > 0 ? Math.max(...fillTimes) : 0,
      count: fillTimes.length,
    };

    // Calculate avg entry offset from fill_logs
    const validOffsets = logs.filter(l => l.filledOffsetSec !== null).map(l => l.filledOffsetSec as number);
    const avgEntryOffset = validOffsets.length > 0 
      ? validOffsets.reduce((a, b) => a + b, 0) / validOffsets.length 
      : 0;

    // Timing analysis: before open vs after open
    const beforeOpenStats = { wins: 0, losses: 0, winRate: 0, count: 0, pnl: 0 };
    const afterOpenStats = { wins: 0, losses: 0, winRate: 0, count: 0, pnl: 0 };
    
    for (const log of logs) {
      // Only consider settled trades with timing data
      if (log.filledOffsetSec === null) continue;
      if (log.result !== 'WIN' && log.result !== 'LOSS') continue;
      
      const bucket = log.filledOffsetSec < 0 ? beforeOpenStats : afterOpenStats;
      bucket.count++;
      if (log.result === 'WIN') {
        bucket.wins++;
      } else {
        bucket.losses++;
      }
      if (log.pnl !== null) {
        bucket.pnl += log.pnl;
      }
    }
    
    beforeOpenStats.winRate = beforeOpenStats.wins + beforeOpenStats.losses > 0 
      ? (beforeOpenStats.wins / (beforeOpenStats.wins + beforeOpenStats.losses)) * 100 
      : 0;
    afterOpenStats.winRate = afterOpenStats.wins + afterOpenStats.losses > 0 
      ? (afterOpenStats.wins / (afterOpenStats.wins + afterOpenStats.losses)) * 100 
      : 0;
    
    // Calculate p-value for timing difference
    const timingPValue = calculatePValue(
      beforeOpenStats.wins, 
      beforeOpenStats.wins + beforeOpenStats.losses,
      afterOpenStats.wins, 
      afterOpenStats.wins + afterOpenStats.losses
    );

    // Calculate streaks
    let currentStreak = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    let tempWinStreak = 0;
    let tempLossStreak = 0;

    for (const result of settledResults) {
      if (result === 'WIN') {
        tempWinStreak++;
        tempLossStreak = 0;
        if (tempWinStreak > maxWinStreak) maxWinStreak = tempWinStreak;
      } else {
        tempLossStreak++;
        tempWinStreak = 0;
        if (tempLossStreak > maxLossStreak) maxLossStreak = tempLossStreak;
      }
    }

    // Current streak (from most recent)
    if (settledResults.length > 0) {
      const lastResult = settledResults[settledResults.length - 1];
      let streak = 0;
      for (let i = settledResults.length - 1; i >= 0; i--) {
        if (settledResults[i] === lastResult) {
          streak++;
        } else {
          break;
        }
      }
      currentStreak = lastResult === 'WIN' ? streak : -streak;
    }

    // Calculate profit factor (gross profit / gross loss)
    const grossProfit = logs.filter(l => l.pnl !== null && l.pnl > 0).reduce((sum, l) => sum + (l.pnl || 0), 0);
    const grossLoss = Math.abs(logs.filter(l => l.pnl !== null && l.pnl < 0).reduce((sum, l) => sum + (l.pnl || 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Calculate fill rate
    const totalPlaced = logs.length;
    const fillRate = totalPlaced > 0 ? (totalFilled / totalPlaced) * 100 : 0;

    // Calculate avg profit per bet (only settled trades)
    const settledBets = totalWins + totalLosses;
    const avgProfitPerBet = settledBets > 0 ? totalPnl / settledBets : 0;

    // Calculate avg profit per hour = bets/hour * fill rate * avg profit per bet
    // Bets per hour: 4 assets * 4 markets per hour (15min each) = 16
    const betsPerHour = 16;
    const fillRateDecimal = fillRate / 100;
    const avgProfitPerHour = betsPerHour * fillRateDecimal * avgProfitPerBet;
    const totalHours = 0; // Not needed with new formula

    // Calculate ROI
    const roi = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

    setTrades(logs);
    setAssetStats(perAsset);
    setFillTimeStats(fillTimeStatsCalc);
    setTimingAnalysis({ beforeOpen: beforeOpenStats, afterOpen: afterOpenStats, pValue: timingPValue });
    setStats({
      totalBets: logs.length,
      filledBets: totalFilled,
      wins: totalWins,
      losses: totalLosses,
      pending: totalPending,
      live: totalLive,
      winRate,
      totalInvested,
      totalPnl,
      avgProfitPerBet,
      avgProfitPerHour,
      totalHours,
      roi,
      fillRate,
      avgEntryOffset,
      currentStreak,
      maxWinStreak,
      maxLossStreak,
      profitFactor,
    });
    setLoading(false);
  };

  const syncFills = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke('v26-sync-fills');
      if (error) {
        console.error('[V26Dashboard] Sync failed:', error);
      } else {
        console.log('[V26Dashboard] Sync result:', data);
        // Refresh data after sync
        await fetchData();
      }
    } catch (err) {
      console.error('[V26Dashboard] Sync error:', err);
    } finally {
      setSyncing(false);
    }
  };

  const handleCsvUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadingSyncing(true);
    try {
      const csvContent = await file.text();
      console.log('[V26Dashboard] Uploading CSV with', csvContent.split('\n').length, 'lines');

      const { data, error } = await supabase.functions.invoke('v26-sync-csv', {
        body: { csv: csvContent },
      });

      if (error) {
        console.error('[V26Dashboard] CSV sync failed:', error);
      } else {
        console.log('[V26Dashboard] CSV sync result:', data);
        await fetchData();
      }
    } catch (err) {
      console.error('[V26Dashboard] CSV sync error:', err);
    } finally {
      setUploadingSyncing(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const fetchRunnerStatus = async () => {
    const { data, error } = await supabase
      .from('runner_heartbeats')
      .select('*')
      .eq('runner_type', 'v26')
      .order('last_heartbeat', { ascending: false })
      .limit(1)
      .single();

    if (data && !error) {
      const lastHeartbeat = new Date(data.last_heartbeat);
      const now = new Date();
      const diffMs = now.getTime() - lastHeartbeat.getTime();
      const isOnline = diffMs < 60000; // Online if heartbeat within last 60 seconds
      
      setRunnerStatus({
        isOnline,
        lastHeartbeat: data.last_heartbeat,
        runnerId: data.runner_id,
        marketsCount: data.markets_count || 0,
        version: data.version,
      });
    } else {
      setRunnerStatus({
        isOnline: false,
        lastHeartbeat: null,
        runnerId: null,
        marketsCount: 0,
        version: null,
      });
    }
  };

  useEffect(() => {
    fetchData();
    fetchRunnerStatus();
    const dataInterval = setInterval(fetchData, 5 * 60 * 1000);
    const statusInterval = setInterval(fetchRunnerStatus, 10000); // Check status every 10s
    
    const channel = supabase
      .channel('v26_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'v26_trades' }, fetchData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'strike_prices' }, fetchData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'runner_heartbeats' }, fetchRunnerStatus)
      .subscribe();

    return () => {
      clearInterval(dataInterval);
      clearInterval(statusInterval);
      supabase.removeChannel(channel);
    };
  }, []);

  // Reset page when filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [assetFilter]);

  const filtered = useMemo(() => 
    assetFilter === 'ALL' 
      ? trades 
      : trades.filter(t => t.asset === assetFilter),
    [trades, assetFilter]
  );

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginatedTrades = useMemo(() => 
    filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage]
  );

  const getResultBadge = (log: TradeLog) => {
    // Format source indicator
    const sourceLabel = log.resultSource !== 'UNKNOWN' && log.resultSource !== 'NOT_FILLED' && log.resultSource !== 'LIVE'
      ? ` (${log.resultSource.toLowerCase()})`
      : '';
    
    switch (log.result) {
      case 'NOT_BOUGHT':
        return (
          <Badge variant="outline" className="text-muted-foreground text-xs opacity-50">
            ❌ Niet gekocht
          </Badge>
        );
      case 'LIVE':
        return (
          <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20 text-xs animate-pulse">
            🔴 Live
          </Badge>
        );
      case 'PENDING':
        return (
          <Badge className="bg-orange-500/10 text-orange-500 border-orange-500/20 text-xs">
            ⏳ Wacht op oracle
          </Badge>
        );
      case 'WIN':
        return (
          <Badge className="bg-green-500/10 text-green-500 border-green-500/20 text-xs" title={`Bron: ${log.resultSource}`}>
            ✓ WIN{sourceLabel}
          </Badge>
        );
      case 'LOSS':
        return (
          <Badge className="bg-red-500/10 text-red-500 border-red-500/20 text-xs" title={`Bron: ${log.resultSource}`}>
            ✗ LOSS{sourceLabel}
          </Badge>
        );
    }
  };

  const formatFillTime = (ms: number | null) => {
    if (ms === null || ms === 0) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const formatEntryOffset = (sec: number | null) => {
    if (sec === null) return '-';
    const absSec = Math.abs(sec);
    if (absSec < 60) {
      return sec < 0 ? `${absSec}s voor open` : `${absSec}s na open`;
    }
    const mins = Math.floor(absSec / 60);
    const secs = Math.round(absSec % 60);
    const timeStr = secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
    return sec < 0 ? `${timeStr} voor open` : `${timeStr} na open`;
  };

  const getBestAsset = () => {
    let best = { asset: '-', winRate: 0 };
    for (const [asset, stats] of Object.entries(assetStats)) {
      if (stats.wins + stats.losses >= 3 && stats.winRate > best.winRate) {
        best = { asset, winRate: stats.winRate };
      }
    }
    return best;
  };

  const getWorstAsset = () => {
    let worst = { asset: '-', winRate: 100 };
    for (const [asset, stats] of Object.entries(assetStats)) {
      if (stats.wins + stats.losses >= 3 && stats.winRate < worst.winRate) {
        worst = { asset, winRate: stats.winRate };
      }
    }
    return worst.asset === '-' ? { asset: '-', winRate: 0 } : worst;
  };

  const bestAsset = getBestAsset();
  const worstAsset = getWorstAsset();

  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <div className="max-w-7xl mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold">V26 Trade Log</h1>
              <div className="flex items-center gap-2">
                <span className="text-sm">🐍</span>
                <p className="text-sm text-muted-foreground">DOWN @ $0.48 LIMIT orders</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Runner Status Indicator */}
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium ${
              runnerStatus.isOnline 
                ? 'bg-green-500/10 text-green-500 border border-green-500/20' 
                : 'bg-red-500/10 text-red-500 border border-red-500/20'
            }`}>
              {runnerStatus.isOnline ? (
                <>
                  <Wifi className="h-4 w-4" />
                  <span>Online</span>
                  {runnerStatus.marketsCount > 0 && (
                    <span className="text-xs opacity-70">({runnerStatus.marketsCount} markets)</span>
                  )}
                </>
              ) : (
                <>
                  <WifiOff className="h-4 w-4" />
                  <span>Offline</span>
                  {runnerStatus.lastHeartbeat && (
                    <span className="text-xs opacity-70">
                      ({formatDistanceToNow(new Date(runnerStatus.lastHeartbeat), { addSuffix: true, locale: nl })})
                    </span>
                  )}
                </>
              )}
            </div>
            <Button 
              variant="outline" 
              size="sm" 
              asChild
            >
              <a 
                href="https://polymarket.com/profile?tab=portfolio" 
                target="_blank" 
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                Polymarket
              </a>
            </Button>
            <input
              type="file"
              accept=".csv"
              onChange={handleCsvUpload}
              ref={fileInputRef}
              className="hidden"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={uploadingSyncing || loading}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className={`h-4 w-4 mr-2 ${uploadingSyncing ? 'animate-pulse' : ''}`} />
              {uploadingSyncing ? 'Syncing...' : 'CSV Upload'}
            </Button>
            <Button onClick={syncFills} variant="outline" size="sm" disabled={syncing || loading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
              Sync Fills
            </Button>
            <Button onClick={fetchData} variant="outline" size="sm" disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <DownloadV26LogicButton />
            <V26StrategyModal />
          </div>
        </div>

        {/* Main KPIs - Row 1 */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card className="bg-gradient-to-br from-card to-muted/30">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Target className="h-3 w-3" /> Filled
              </div>
              <div className="text-2xl font-bold">{stats.filledBets}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {stats.live > 0 && <span className="text-blue-500">{stats.live} live</span>}
                {stats.live > 0 && stats.pending > 0 && ' · '}
                {stats.pending > 0 && <span className="text-yellow-500">{stats.pending} pending</span>}
              </div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-green-500/5 to-green-500/10 border-green-500/20">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-green-500/70 text-xs mb-1">
                <TrendingUp className="h-3 w-3" /> Wins
              </div>
              <div className="text-2xl font-bold text-green-500">{stats.wins}</div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-red-500/5 to-red-500/10 border-red-500/20">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-red-500/70 text-xs mb-1">
                <TrendingDown className="h-3 w-3" /> Losses
              </div>
              <div className="text-2xl font-bold text-red-500">{stats.losses}</div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-card to-muted/30">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Percent className="h-3 w-3" /> Win Rate
              </div>
              <div className="text-2xl font-bold">{stats.winRate.toFixed(1)}%</div>
            </CardContent>
          </Card>

          <Card className={`bg-gradient-to-br ${stats.totalPnl >= 0 ? 'from-green-500/5 to-green-500/10 border-green-500/20' : 'from-red-500/5 to-red-500/10 border-red-500/20'}`}>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <DollarSign className="h-3 w-3" /> Net P&L
              </div>
              <div className={`text-2xl font-bold ${stats.totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                ${stats.totalPnl.toFixed(2)}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Secondary KPIs - Row 2 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Zap className="h-3 w-3" /> Avg Fill Time
              </div>
              <div className="text-xl font-bold font-mono">
                {formatFillTime(fillTimeStats.avgMs)}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Best: {formatFillTime(fillTimeStats.bestMs)} · Worst: {formatFillTime(fillTimeStats.worstMs)}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <BarChart3 className="h-3 w-3" /> Best Asset
              </div>
              <div className="text-xl font-bold text-green-500">
                {bestAsset.asset}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {bestAsset.winRate.toFixed(0)}% win rate
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <BarChart3 className="h-3 w-3" /> Worst Asset
              </div>
              <div className="text-xl font-bold text-red-500">
                {worstAsset.asset}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {worstAsset.winRate.toFixed(0)}% win rate
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <DollarSign className="h-3 w-3" /> Invested
              </div>
              <div className="text-xl font-bold font-mono">
                ${stats.totalInvested.toFixed(2)}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                ROI: <span className={stats.roi >= 0 ? 'text-green-500' : 'text-red-500'}>{stats.roi.toFixed(1)}%</span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Profit Stats - Row 3 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className={`bg-gradient-to-br ${stats.avgProfitPerBet >= 0 ? 'from-green-500/5 to-green-500/10 border-green-500/20' : 'from-red-500/5 to-red-500/10 border-red-500/20'}`}>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Target className="h-3 w-3" /> Avg Profit / Bet
              </div>
              <div className={`text-xl font-bold font-mono ${stats.avgProfitPerBet >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                {stats.avgProfitPerBet >= 0 ? '+' : ''}${stats.avgProfitPerBet.toFixed(2)}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Over {stats.wins + stats.losses} settled bets
              </div>
            </CardContent>
          </Card>

          <Card className={`bg-gradient-to-br ${stats.avgProfitPerHour >= 0 ? 'from-green-500/5 to-green-500/10 border-green-500/20' : 'from-red-500/5 to-red-500/10 border-red-500/20'}`}>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Clock className="h-3 w-3" /> Avg Profit / Hour
              </div>
              <div className={`text-xl font-bold font-mono ${stats.avgProfitPerHour >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                {stats.avgProfitPerHour >= 0 ? '+' : ''}${stats.avgProfitPerHour.toFixed(2)}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Over {stats.totalHours.toFixed(1)} hours
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <BarChart3 className="h-3 w-3" /> Avg Bet Size
              </div>
              <div className="text-xl font-bold font-mono">
                ${stats.filledBets > 0 ? (stats.totalInvested / stats.filledBets).toFixed(2) : '0.00'}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {stats.filledBets} filled orders
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Zap className="h-3 w-3" /> Expected Value
              </div>
              <div className={`text-xl font-bold font-mono ${stats.avgProfitPerBet >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                {stats.avgProfitPerBet >= 0 ? '+' : ''}{((stats.avgProfitPerBet / (stats.filledBets > 0 ? stats.totalInvested / stats.filledBets : 1)) * 100).toFixed(1)}%
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Per bet EV
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Execution & Risk Stats - Row 4 */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card className="bg-gradient-to-br from-blue-500/5 to-blue-500/10 border-blue-500/20">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-blue-500/70 text-xs mb-1">
                <CheckCircle2 className="h-3 w-3" /> Fill Rate
              </div>
              <div className="text-xl font-bold text-blue-500">
                {stats.fillRate.toFixed(1)}%
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {stats.filledBets}/{stats.totalBets} orders
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Clock className="h-3 w-3" /> Avg Entry
              </div>
              <div className="text-xl font-bold font-mono">
                {stats.avgEntryOffset >= 0 ? '+' : ''}{stats.avgEntryOffset.toFixed(0)}s
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {stats.avgEntryOffset >= 0 ? 'na' : 'voor'} open
              </div>
            </CardContent>
          </Card>

          <Card className={stats.currentStreak > 0 ? 'bg-gradient-to-br from-green-500/5 to-green-500/10 border-green-500/20' : stats.currentStreak < 0 ? 'bg-gradient-to-br from-red-500/5 to-red-500/10 border-red-500/20' : ''}>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Flame className="h-3 w-3" /> Current Streak
              </div>
              <div className={`text-xl font-bold ${stats.currentStreak > 0 ? 'text-green-500' : stats.currentStreak < 0 ? 'text-red-500' : ''}`}>
                {stats.currentStreak > 0 ? `🔥 ${stats.currentStreak}W` : stats.currentStreak < 0 ? `❄️ ${Math.abs(stats.currentStreak)}L` : '-'}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Max: {stats.maxWinStreak}W / {stats.maxLossStreak}L
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Activity className="h-3 w-3" /> Profit Factor
              </div>
              <div className={`text-xl font-bold ${stats.profitFactor >= 1 ? 'text-green-500' : 'text-red-500'}`}>
                {stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2)}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {stats.profitFactor >= 1.5 ? 'Excellent' : stats.profitFactor >= 1 ? 'Profitable' : 'Needs work'}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Target className="h-3 w-3" /> Win $ / Loss $
              </div>
              <div className="text-xl font-bold font-mono">
                {stats.wins > 0 && stats.losses > 0 
                  ? (((stats.totalPnl + Math.abs(stats.losses * (stats.totalInvested / stats.filledBets))) / stats.wins) / 
                     (Math.abs(stats.totalInvested / stats.filledBets))).toFixed(2)
                  : '-'}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Risk/Reward ratio
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Asset Performance Cards - Enhanced */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4" /> Performance per Asset
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {['BTC', 'ETH', 'SOL', 'XRP'].map(asset => {
                const a = assetStats[asset];
                if (!a) return null;
                return (
                  <div key={asset} className="bg-muted/30 rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold">{asset}</span>
                      <Badge variant="outline" className={a.fillRate >= 80 ? 'border-green-500/30 text-green-500' : a.fillRate >= 50 ? 'border-yellow-500/30 text-yellow-500' : 'border-red-500/30 text-red-500'}>
                        {a.fillRate.toFixed(0)}% fill
                      </Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-muted-foreground">Win Rate</span>
                        <div className={`font-mono font-bold ${a.winRate >= 50 ? 'text-green-500' : 'text-red-500'}`}>
                          {a.winRate.toFixed(0)}%
                        </div>
                      </div>
                      <div>
                        <span className="text-muted-foreground">P&L</span>
                        <div className={`font-mono font-bold ${a.pnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                          {a.pnl >= 0 ? '+' : ''}${a.pnl.toFixed(2)}
                        </div>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Record</span>
                        <div className="font-mono">
                          <span className="text-green-500">{a.wins}W</span>
                          <span className="text-muted-foreground"> / </span>
                          <span className="text-red-500">{a.losses}L</span>
                        </div>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Invested</span>
                        <div className="font-mono">
                          ${a.invested.toFixed(0)}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
        <div className="grid grid-cols-4 gap-2">
          {['BTC', 'ETH', 'SOL', 'XRP'].map((asset) => {
            const s = assetStats[asset] || { wins: 0, losses: 0, winRate: 0, pnl: 0 };
            const total = s.wins + s.losses;
            return (
              <Card key={asset} className="overflow-hidden">
                <CardContent className="pt-3 pb-2 px-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-sm">{asset}</span>
                    <span className={`text-xs font-mono ${s.pnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      {s.pnl >= 0 ? '+' : ''}{s.pnl.toFixed(0)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-green-500 transition-all"
                        style={{ width: `${total > 0 ? (s.wins / total) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground w-12 text-right">
                      {s.wins}/{total}
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Timing Analysis: Before vs After Open - Compact */}
        <Card>
          <CardHeader className="pb-2 pt-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <Clock className="h-3.5 w-3.5" /> Timing: Vóór vs. Ná Open
              </CardTitle>
              {timingAnalysis.pValue !== null && (
                <Badge 
                  variant="outline" 
                  className={`text-xs ${timingAnalysis.pValue < 0.05 ? 'bg-green-500/10 text-green-500 border-green-500/20' : timingAnalysis.pValue < 0.1 ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20' : ''}`}
                >
                  p={timingAnalysis.pValue < 0.001 ? '<0.001' : timingAnalysis.pValue.toFixed(3)}
                  {timingAnalysis.pValue < 0.01 ? ' ★★★' : timingAnalysis.pValue < 0.05 ? ' ★★' : timingAnalysis.pValue < 0.1 ? ' ★' : ''}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-0 pb-3">
            <div className="grid grid-cols-2 gap-2">
              {/* Before Open */}
              <div className={`rounded-md p-2 border ${timingAnalysis.beforeOpen.winRate >= timingAnalysis.afterOpen.winRate && timingAnalysis.beforeOpen.count >= 3 ? 'border-green-500/40 bg-green-500/5' : 'border-muted bg-muted/20'}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium">⏪ Vóór Open</span>
                  {timingAnalysis.beforeOpen.winRate >= timingAnalysis.afterOpen.winRate && timingAnalysis.beforeOpen.count >= 3 && (
                    <span className="text-[10px] text-green-500">Best</span>
                  )}
                </div>
                <div className="flex items-baseline gap-2">
                  <span className={`text-lg font-bold ${timingAnalysis.beforeOpen.winRate >= 50 ? 'text-green-500' : 'text-red-500'}`}>
                    {timingAnalysis.beforeOpen.winRate.toFixed(0)}%
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {timingAnalysis.beforeOpen.wins}W/{timingAnalysis.beforeOpen.losses}L
                  </span>
                  <span className={`text-xs font-mono ${timingAnalysis.beforeOpen.pnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    {timingAnalysis.beforeOpen.pnl >= 0 ? '+' : ''}${timingAnalysis.beforeOpen.pnl.toFixed(0)}
                  </span>
                </div>
              </div>

              {/* After Open */}
              <div className={`rounded-md p-2 border ${timingAnalysis.afterOpen.winRate > timingAnalysis.beforeOpen.winRate && timingAnalysis.afterOpen.count >= 3 ? 'border-green-500/40 bg-green-500/5' : 'border-muted bg-muted/20'}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium">⏩ Ná Open</span>
                  {timingAnalysis.afterOpen.winRate > timingAnalysis.beforeOpen.winRate && timingAnalysis.afterOpen.count >= 3 && (
                    <span className="text-[10px] text-green-500">Best</span>
                  )}
                </div>
                <div className="flex items-baseline gap-2">
                  <span className={`text-lg font-bold ${timingAnalysis.afterOpen.winRate >= 50 ? 'text-green-500' : 'text-red-500'}`}>
                    {timingAnalysis.afterOpen.winRate.toFixed(0)}%
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {timingAnalysis.afterOpen.wins}W/{timingAnalysis.afterOpen.losses}L
                  </span>
                  <span className={`text-xs font-mono ${timingAnalysis.afterOpen.pnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    {timingAnalysis.afterOpen.pnl >= 0 ? '+' : ''}${timingAnalysis.afterOpen.pnl.toFixed(0)}
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>


        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            {ASSETS.map((asset) => (
              <Button
                key={asset}
                variant={assetFilter === asset ? 'default' : 'outline'}
                size="sm"
                onClick={() => setAssetFilter(asset)}
                className="text-xs px-3"
              >
                {asset}
              </Button>
            ))}
          </div>
          <div className="text-sm text-muted-foreground">
            {filtered.length} trades · Pagina {currentPage} van {Math.max(totalPages, 1)}
          </div>
        </div>

        {/* Trade Log Table */}
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-border/50">
                    <TableHead className="text-xs font-medium">Markt</TableHead>
                    <TableHead className="text-xs font-medium">Event</TableHead>
                    <TableHead className="text-xs font-medium text-right">Shares</TableHead>
                    <TableHead className="text-xs font-medium text-right">Prijs</TableHead>
                    <TableHead className="text-xs font-medium text-right">Cost</TableHead>
                    <TableHead className="text-xs font-medium">Filled</TableHead>
                    <TableHead className="text-xs font-medium">Result</TableHead>
                    <TableHead className="text-xs font-medium text-right">P&L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedTrades.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                        Geen trades gevonden
                      </TableCell>
                    </TableRow>
                  ) : (
                    paginatedTrades.map((log) => (
                      <TableRow 
                        key={log.id} 
                        className={`border-b border-border/30 ${log.result === 'NOT_BOUGHT' ? 'opacity-40' : ''} hover:bg-muted/30 transition-colors`}
                        title={`Side: ${log.side} | Expected: $${log.expectedPayout?.toFixed(2) ?? '0'} | Source: ${log.resultSource}`}
                      >
                        <TableCell className="py-2">
                          <div className="flex items-center gap-2">
                            <div className="flex flex-col">
                              <span className="font-medium text-sm">{log.market}</span>
                              <span className="text-xs text-muted-foreground">
                                {log.side} @ ${log.pricePerShare.toFixed(2)} · {log.shares > 0 ? `${log.shares} shares` : 'no fill'}
                              </span>
                            </div>
                            <a
                              href={`https://polymarket.com/event/${log.asset.toLowerCase()}-updown-15m-${Math.floor(new Date(log.eventStartTime).getTime() / 1000)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted-foreground hover:text-foreground transition-colors"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </div>
                        </TableCell>
                        <TableCell className="py-2 text-muted-foreground text-sm">{log.time}</TableCell>
                        <TableCell className="py-2 text-right font-mono text-sm">
                          {log.shares > 0 ? log.shares : '-'}
                        </TableCell>
                        <TableCell className="py-2 text-right font-mono text-sm">
                          {log.shares > 0 ? `$${log.pricePerShare.toFixed(2)}` : '-'}
                        </TableCell>
                        <TableCell className="py-2 text-right font-mono text-sm">
                          {log.total > 0 ? `$${log.total.toFixed(2)}` : '-'}
                        </TableCell>
                        <TableCell className="py-2">
                          {log.filledOffsetSec !== null ? (
                            <Badge 
                              variant="outline" 
                              className={`text-xs ${
                                log.filledOffsetSec < 0 
                                  ? 'text-green-500 border-green-500/30' 
                                  : 'text-yellow-500 border-yellow-500/30'
                              }`}
                              title={log.filledSource === 'match' ? 'CLOB match time' : log.filledSource === 'log' ? 'Runner detection time (may be inaccurate)' : undefined}
                            >
                              {formatEntryOffset(log.filledOffsetSec)}
                              {log.filledSource === 'log' && <span className="ml-1 opacity-60">*</span>}
                            </Badge>
                          ) : '-'}
                        </TableCell>
                        <TableCell className="py-2">{getResultBadge(log)}</TableCell>
                        <TableCell className="py-2 text-right font-mono text-sm font-bold">
                          {log.pnl !== null ? (
                            <span className={log.pnl >= 0 ? 'text-green-500' : 'text-red-500'}>
                              {log.pnl >= 0 ? '+' : ''}${log.pnl.toFixed(2)}
                            </span>
                          ) : log.result === 'LIVE' && log.expectedPayout ? (
                            <span className="text-muted-foreground text-xs">
                              (max +${(log.expectedPayout - log.total).toFixed(2)})
                            </span>
                          ) : '-'}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-border/50">
                <div className="text-sm text-muted-foreground">
                  Showing {(currentPage - 1) * PAGE_SIZE + 1}-{Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setCurrentPage(1)}
                    disabled={currentPage === 1}
                  >
                    <ChevronsLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  
                  {/* Page numbers */}
                  <div className="flex items-center gap-1 mx-2">
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                      let pageNum: number;
                      if (totalPages <= 5) {
                        pageNum = i + 1;
                      } else if (currentPage <= 3) {
                        pageNum = i + 1;
                      } else if (currentPage >= totalPages - 2) {
                        pageNum = totalPages - 4 + i;
                      } else {
                        pageNum = currentPage - 2 + i;
                      }
                      return (
                        <Button
                          key={pageNum}
                          variant={currentPage === pageNum ? 'default' : 'outline'}
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => setCurrentPage(pageNum)}
                        >
                          {pageNum}
                        </Button>
                      );
                    })}
                  </div>

                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setCurrentPage(totalPages)}
                    disabled={currentPage === totalPages}
                  >
                    <ChevronsRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
