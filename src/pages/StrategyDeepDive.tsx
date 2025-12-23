import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { 
  ArrowLeft, 
  Clock, 
  TrendingUp, 
  Target, 
  Zap,
  AlertTriangle,
  BarChart3,
  GitBranch,
  Coins,
  Timer,
  Activity,
  Shield,
  ShieldAlert,
  DollarSign,
  TrendingDown,
  Layers,
  ArrowRight,
  CheckCircle2,
  XCircle,
  BookOpen,
  Code2,
  Lightbulb,
  Scale,
  Repeat,
  PieChart as PieChartIcon,
  Loader2
} from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { useTrades } from '@/hooks/useTrades';
import { OpeningTradeAnalysis } from '@/components/OpeningTradeAnalysis';
import { DCAArbitrageAnalysis } from '@/components/DCAArbitrageAnalysis';
import { TradeSizeEvolutionChart } from '@/components/TradeSizeEvolutionChart';
import { VolatilityAnalysis } from '@/components/VolatilityAnalysis';
import { DCAFormulaAnalysis } from '@/components/DCAFormulaAnalysis';
import { RealTimeSignals } from '@/components/RealTimeSignals';
import { GabagoolCorrelationAnalysis } from '@/components/GabagoolCorrelationAnalysis';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  Tooltip, 
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  ScatterChart,
  Scatter,
  Legend,
  AreaChart,
  Area
} from 'recharts';

interface HedgePair {
  market: string;
  trade1: { outcome: string; price: number; shares: number; timestamp: Date; side: string };
  trade2: { outcome: string; price: number; shares: number; timestamp: Date; side: string };
  delaySeconds: number;
  combinedPrice: number;
  edge: number;
  category: 'arbitrage' | 'neutral' | 'risk';
  firstSide: 'Up' | 'Down';
  asset: 'BTC' | 'ETH' | 'Other';
  hourOfDay: number;
}

interface StrategyAnalysisData {
  category: 'arbitrage' | 'neutral' | 'risk';
  pairs: HedgePair[];
  avgCombinedPrice: number;
  avgEdge: number;
  avgDelay: number;
  avgFirstEntryPrice: number;
  avgSecondEntryPrice: number;
  avgShareSize: number;
  upFirstPercent: number;
  btcPercent: number;
  ethPercent: number;
  hourDistribution: { hour: number; count: number }[];
  priceSpread: number;
  avgTotalInvested: number;
  successIndicators: string[];
  riskFactors: string[];
  hypotheses: string[];
}

// Maximum trades to analyze to prevent browser freeze
const MAX_TRADES_FOR_ANALYSIS = 5000;

const StrategyDeepDive = () => {
  // Use limit option to fetch only the trades we need - much faster!
  const { trades, positions, isLoading } = useTrades('gabagool22', { limit: MAX_TRADES_FOR_ANALYSIS });

  // Calculate position exposure and unrealized P&L
  const exposureAnalysis = useMemo(() => {
    if (positions.length === 0) return null;

    // Group positions by market
    const marketPositions = new Map<string, typeof positions>();
    positions.forEach(p => {
      if (!marketPositions.has(p.market)) marketPositions.set(p.market, []);
      marketPositions.get(p.market)!.push(p);
    });

    let totalExposedCapital = 0;
    let totalHedgedCapital = 0;
    let upExposedShares = 0;
    let downExposedShares = 0;
    let upExposedValue = 0;
    let downExposedValue = 0;
    const exposedPositions: Array<{
      market: string;
      side: string;
      exposedShares: number;
      exposedValue: number;
      pnl: number;
      avgPrice: number;
      currentPrice: number;
    }> = [];

    marketPositions.forEach((marketPos, market) => {
      const upPos = marketPos.find(p => 
        p.outcome === 'Yes' || p.outcome.toLowerCase().includes('up') || p.outcome.toLowerCase().includes('above')
      );
      const downPos = marketPos.find(p => 
        p.outcome === 'No' || p.outcome.toLowerCase().includes('down') || p.outcome.toLowerCase().includes('below')
      );

      const upShares = upPos?.shares || 0;
      const downShares = downPos?.shares || 0;
      const minShares = Math.min(upShares, downShares);
      
      // Hedged capital (matched shares)
      const hedgedValue = minShares * ((upPos?.avgPrice || 0) + (downPos?.avgPrice || 0));
      totalHedgedCapital += hedgedValue;

      // Exposed capital (unmatched shares)
      if (upShares > downShares && upPos) {
        const exposed = upShares - downShares;
        const exposedVal = exposed * upPos.avgPrice;
        upExposedShares += exposed;
        upExposedValue += exposedVal;
        totalExposedCapital += exposedVal;
        
        exposedPositions.push({
          market,
          side: 'Up',
          exposedShares: exposed,
          exposedValue: exposedVal,
          pnl: upPos.pnl || 0,
          avgPrice: upPos.avgPrice,
          currentPrice: upPos.currentPrice
        });
      } else if (downShares > upShares && downPos) {
        const exposed = downShares - upShares;
        const exposedVal = exposed * downPos.avgPrice;
        downExposedShares += exposed;
        downExposedValue += exposedVal;
        totalExposedCapital += exposedVal;
        
        exposedPositions.push({
          market,
          side: 'Down',
          exposedShares: exposed,
          exposedValue: exposedVal,
          pnl: downPos.pnl || 0,
          avgPrice: downPos.avgPrice,
          currentPrice: downPos.currentPrice
        });
      }
    });

    // Sort by exposure value
    const topExposed = [...exposedPositions].sort((a, b) => b.exposedValue - a.exposedValue).slice(0, 10);

    // Calculate total unrealized P&L
    const totalPnl = positions.reduce((sum, p) => sum + (p.pnl || 0), 0);
    const winningPositions = positions.filter(p => (p.pnl || 0) > 0);
    const losingPositions = positions.filter(p => (p.pnl || 0) < 0);
    const totalWinning = winningPositions.reduce((sum, p) => sum + (p.pnl || 0), 0);
    const totalLosing = losingPositions.reduce((sum, p) => sum + (p.pnl || 0), 0);

    // Top winners and losers
    const topWinners = [...positions].filter(p => (p.pnl || 0) > 0).sort((a, b) => (b.pnl || 0) - (a.pnl || 0)).slice(0, 5);
    const topLosers = [...positions].filter(p => (p.pnl || 0) < 0).sort((a, b) => (a.pnl || 0) - (b.pnl || 0)).slice(0, 5);

    return {
      totalExposedCapital,
      totalHedgedCapital,
      exposurePercent: totalHedgedCapital + totalExposedCapital > 0 
        ? (totalExposedCapital / (totalHedgedCapital + totalExposedCapital)) * 100 
        : 0,
      upExposedShares,
      downExposedShares,
      upExposedValue,
      downExposedValue,
      topExposed,
      totalPnl,
      winningCount: winningPositions.length,
      losingCount: losingPositions.length,
      totalWinning,
      totalLosing,
      topWinners,
      topLosers
    };
  }, [positions]);

  // DCA Analysis - analyze buy patterns by price bucket
  const dcaAnalysis = useMemo(() => {
    if (trades.length === 0) return null;

    const buyTrades = trades.filter(t => t.side === 'buy');
    
    // Price buckets for entry analysis
    const priceBuckets = [
      { label: '< 20¢', min: 0, max: 0.20, count: 0, totalShares: 0, totalValue: 0, avgSize: 0 },
      { label: '20-35¢', min: 0.20, max: 0.35, count: 0, totalShares: 0, totalValue: 0, avgSize: 0 },
      { label: '35-45¢', min: 0.35, max: 0.45, count: 0, totalShares: 0, totalValue: 0, avgSize: 0 },
      { label: '45-50¢', min: 0.45, max: 0.50, count: 0, totalShares: 0, totalValue: 0, avgSize: 0 },
      { label: '50-55¢', min: 0.50, max: 0.55, count: 0, totalShares: 0, totalValue: 0, avgSize: 0 },
      { label: '> 55¢', min: 0.55, max: 1.0, count: 0, totalShares: 0, totalValue: 0, avgSize: 0 },
    ];

    buyTrades.forEach(t => {
      const bucket = priceBuckets.find(b => t.price >= b.min && t.price < b.max);
      if (bucket) {
        bucket.count++;
        bucket.totalShares += t.shares;
        bucket.totalValue += t.total;
      }
    });

    priceBuckets.forEach(b => {
      b.avgSize = b.count > 0 ? b.totalShares / b.count : 0;
    });

    // Share size distribution
    const sizeBuckets = [
      { label: '1-5', min: 1, max: 5, count: 0 },
      { label: '6-10', min: 6, max: 10, count: 0 },
      { label: '11-15', min: 11, max: 15, count: 0 },
      { label: '16-20', min: 16, max: 20, count: 0 },
      { label: '> 20', min: 21, max: Infinity, count: 0 },
    ];

    buyTrades.forEach(t => {
      const bucket = sizeBuckets.find(b => t.shares >= b.min && t.shares <= b.max);
      if (bucket) bucket.count++;
    });

    // Calculate price improvement rate (DCA success)
    // Group by market and check if subsequent buys are at better prices
    const marketBuys = new Map<string, typeof buyTrades>();
    buyTrades.forEach(t => {
      const key = `${t.market}-${t.outcome}`;
      if (!marketBuys.has(key)) marketBuys.set(key, []);
      marketBuys.get(key)!.push(t);
    });

    let improvedBuys = 0;
    let subsequentBuys = 0;
    
    marketBuys.forEach((buys) => {
      if (buys.length < 2) return;
      
      // Sort by timestamp
      const sorted = [...buys].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      const firstPrice = sorted[0].price;
      
      sorted.slice(1).forEach(buy => {
        subsequentBuys++;
        if (buy.price < firstPrice) improvedBuys++;
      });
    });

    const priceImprovementRate = subsequentBuys > 0 ? (improvedBuys / subsequentBuys) * 100 : 0;

    return {
      priceBuckets,
      sizeBuckets,
      priceImprovementRate,
      totalBuys: buyTrades.length,
      avgBuyPrice: buyTrades.reduce((sum, t) => sum + t.price, 0) / buyTrades.length,
      avgShareSize: buyTrades.reduce((sum, t) => sum + t.shares, 0) / buyTrades.length
    };
  }, [trades]);

  // Expiry/Time-to-Resolution Analysis
  const expiryAnalysis = useMemo(() => {
    if (trades.length === 0) return null;

    // Parse expiry time from market name
    // Format examples: "December 22, 3:45PM-4:00PM ET" or "December 22, 3PM ET"
    const parseExpiryFromMarket = (market: string, tradeTimestamp: Date): Date | null => {
      try {
        // Extract date and time pattern
        const dateTimeMatch = market.match(/(\w+)\s+(\d{1,2}),?\s+(\d{1,2}):?(\d{2})?(AM|PM)(?:-(\d{1,2}):?(\d{2})?(AM|PM))?\s*(ET|EST|EDT)?/i);
        
        if (!dateTimeMatch) return null;
        
        const [, month, day, hour1, min1 = '00', ampm1, hour2, min2, ampm2] = dateTimeMatch;
        
        // Use the end time if it's a range, otherwise use the single time
        const targetHour = hour2 ? parseInt(hour2) : parseInt(hour1);
        const targetMin = hour2 ? parseInt(min2 || '00') : parseInt(min1);
        const targetAmPm = ampm2 || ampm1;
        
        // Convert to 24h format
        let hour24 = targetHour;
        if (targetAmPm?.toUpperCase() === 'PM' && targetHour !== 12) hour24 += 12;
        if (targetAmPm?.toUpperCase() === 'AM' && targetHour === 12) hour24 = 0;
        
        // Get month number
        const months: Record<string, number> = {
          'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
          'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11
        };
        const monthNum = months[month.toLowerCase()];
        if (monthNum === undefined) return null;
        
        // Create expiry date (assume same year as trade, ET = UTC-5)
        const expiry = new Date(tradeTimestamp.getFullYear(), monthNum, parseInt(day), hour24, targetMin);
        // Convert ET to UTC (add 5 hours)
        expiry.setHours(expiry.getHours() + 5);
        
        return expiry;
      } catch {
        return null;
      }
    };

    // Analyze each trade for time to expiry
    interface TradeWithExpiry {
      trade: typeof trades[0];
      expiry: Date;
      minutesToExpiry: number;
      category: 'immediate' | 'short' | 'medium' | 'early';
    }

    const tradesWithExpiry: TradeWithExpiry[] = [];
    
    trades.forEach(trade => {
      const expiry = parseExpiryFromMarket(trade.market, trade.timestamp);
      if (expiry && expiry > trade.timestamp) {
        const minutesToExpiry = (expiry.getTime() - trade.timestamp.getTime()) / (1000 * 60);
        
        let category: 'immediate' | 'short' | 'medium' | 'early' = 'early';
        if (minutesToExpiry <= 5) category = 'immediate';
        else if (minutesToExpiry <= 15) category = 'short';
        else if (minutesToExpiry <= 30) category = 'medium';
        
        tradesWithExpiry.push({
          trade,
          expiry,
          minutesToExpiry,
          category
        });
      }
    });

    if (tradesWithExpiry.length === 0) return null;

    // Categorize by time buckets
    const timeBuckets = [
      { label: '0-2 min', min: 0, max: 2, count: 0, trades: [] as TradeWithExpiry[], avgPrice: 0, avgShares: 0 },
      { label: '2-5 min', min: 2, max: 5, count: 0, trades: [] as TradeWithExpiry[], avgPrice: 0, avgShares: 0 },
      { label: '5-10 min', min: 5, max: 10, count: 0, trades: [] as TradeWithExpiry[], avgPrice: 0, avgShares: 0 },
      { label: '10-15 min', min: 10, max: 15, count: 0, trades: [] as TradeWithExpiry[], avgPrice: 0, avgShares: 0 },
      { label: '15-30 min', min: 15, max: 30, count: 0, trades: [] as TradeWithExpiry[], avgPrice: 0, avgShares: 0 },
      { label: '30-60 min', min: 30, max: 60, count: 0, trades: [] as TradeWithExpiry[], avgPrice: 0, avgShares: 0 },
      { label: '>60 min', min: 60, max: Infinity, count: 0, trades: [] as TradeWithExpiry[], avgPrice: 0, avgShares: 0 },
    ];

    tradesWithExpiry.forEach(t => {
      const bucket = timeBuckets.find(b => t.minutesToExpiry >= b.min && t.minutesToExpiry < b.max);
      if (bucket) {
        bucket.count++;
        bucket.trades.push(t);
      }
    });

    // Calculate averages for each bucket
    timeBuckets.forEach(b => {
      if (b.trades.length > 0) {
        b.avgPrice = b.trades.reduce((sum, t) => sum + t.trade.price, 0) / b.trades.length;
        b.avgShares = b.trades.reduce((sum, t) => sum + t.trade.shares, 0) / b.trades.length;
      }
    });

    // Category breakdown
    const immediateCount = tradesWithExpiry.filter(t => t.category === 'immediate').length;
    const shortCount = tradesWithExpiry.filter(t => t.category === 'short').length;
    const mediumCount = tradesWithExpiry.filter(t => t.category === 'medium').length;
    const earlyCount = tradesWithExpiry.filter(t => t.category === 'early').length;

    // Analyze by strategy type
    const analyzeByExpiry = (categoryTrades: TradeWithExpiry[]) => {
      if (categoryTrades.length === 0) return { avgMinutes: 0, distribution: [] as { label: string; percent: number }[] };
      
      const avgMinutes = categoryTrades.reduce((sum, t) => sum + t.minutesToExpiry, 0) / categoryTrades.length;
      const immediatePct = (categoryTrades.filter(t => t.category === 'immediate').length / categoryTrades.length) * 100;
      const shortPct = (categoryTrades.filter(t => t.category === 'short').length / categoryTrades.length) * 100;
      const mediumPct = (categoryTrades.filter(t => t.category === 'medium').length / categoryTrades.length) * 100;
      const earlyPct = (categoryTrades.filter(t => t.category === 'early').length / categoryTrades.length) * 100;
      
      return {
        avgMinutes,
        distribution: [
          { label: '<5 min', percent: immediatePct + shortPct },
          { label: '5-30 min', percent: mediumPct },
          { label: '>30 min', percent: earlyPct }
        ]
      };
    };

    // Price behavior by time to expiry
    const priceByExpiry = timeBuckets.filter(b => b.count > 0).map(b => ({
      label: b.label,
      count: b.count,
      avgPrice: b.avgPrice,
      avgShares: b.avgShares
    }));

    // Overall stats
    const avgMinutesToExpiry = tradesWithExpiry.reduce((sum, t) => sum + t.minutesToExpiry, 0) / tradesWithExpiry.length;
    const medianMinutes = [...tradesWithExpiry].sort((a, b) => a.minutesToExpiry - b.minutesToExpiry)[Math.floor(tradesWithExpiry.length / 2)]?.minutesToExpiry || 0;

    // Trading style classification
    let tradingStyle = 'Mixed';
    if (immediateCount + shortCount > tradesWithExpiry.length * 0.6) tradingStyle = 'Last-Minute Sniper';
    else if (earlyCount > tradesWithExpiry.length * 0.5) tradingStyle = 'Early Bird Accumulator';
    else if (mediumCount > tradesWithExpiry.length * 0.4) tradingStyle = 'Mid-Range Strategist';

    // Insights generation
    const insights: string[] = [];
    
    if (immediateCount + shortCount > tradesWithExpiry.length * 0.5) {
      insights.push(`${((immediateCount + shortCount) / tradesWithExpiry.length * 100).toFixed(0)}% van trades binnen 5 minuten voor expiry - "last minute" strategie`);
    }
    
    const lastMinuteBucket = timeBuckets.find(b => b.label === '0-2 min');
    const earlyBucket = timeBuckets.find(b => b.label === '>60 min');
    if (lastMinuteBucket && earlyBucket && lastMinuteBucket.avgPrice > earlyBucket.avgPrice) {
      insights.push(`Last-minute trades hebben hogere prijzen (${(lastMinuteBucket.avgPrice * 100).toFixed(0)}¢ vs ${(earlyBucket.avgPrice * 100).toFixed(0)}¢) - meer zekerheid = hogere prijs`);
    }
    
    if (medianMinutes < 15) {
      insights.push('Mediaan tijd tot expiry is <15 min - bot wacht tot prijzen stabiliseren');
    }

    // Hypotheses
    const hypotheses: string[] = [];
    if (immediateCount > tradesWithExpiry.length * 0.2) {
      hypotheses.push('Wacht tot laatste moment voor maximale informatie over crypto prijs');
    }
    if (earlyCount > tradesWithExpiry.length * 0.3) {
      hypotheses.push('Bouwt posities op vroeg als prijzen aantrekkelijk zijn (DCA over tijd)');
    }
    hypotheses.push('Combineert mogelijk early entry + late topping up voor beste avg price');
    if (lastMinuteBucket && lastMinuteBucket.avgShares > 10) {
      hypotheses.push('Grote last-minute trades = hoge conviction wanneer uitkomst bijna zeker is');
    }

    return {
      totalAnalyzed: tradesWithExpiry.length,
      avgMinutesToExpiry,
      medianMinutes,
      immediateCount,
      shortCount,
      mediumCount,
      earlyCount,
      timeBuckets: priceByExpiry,
      tradingStyle,
      insights,
      hypotheses,
      categoryBreakdown: [
        { label: '0-5 min (Immediate)', count: immediateCount + shortCount, percent: ((immediateCount + shortCount) / tradesWithExpiry.length) * 100 },
        { label: '5-30 min (Medium)', count: mediumCount, percent: (mediumCount / tradesWithExpiry.length) * 100 },
        { label: '>30 min (Early)', count: earlyCount, percent: (earlyCount / tradesWithExpiry.length) * 100 },
      ]
    };
  }, [trades]);

  const analysis = useMemo(() => {
    if (trades.length === 0) return null;

    // Group trades by market
    const marketGroups = new Map<string, typeof trades>();
    trades.forEach(t => {
      const key = t.market;
      if (!marketGroups.has(key)) marketGroups.set(key, []);
      marketGroups.get(key)!.push(t);
    });

    const hedgePairs: HedgePair[] = [];

    marketGroups.forEach((marketTrades, market) => {
      // Find buys for both outcomes
      const buys = marketTrades.filter(t => t.side === 'buy');
      const upBuys = buys.filter(t => t.outcome === 'Yes' || t.outcome.toLowerCase().includes('up') || t.outcome.toLowerCase().includes('above'));
      const downBuys = buys.filter(t => t.outcome === 'No' || t.outcome.toLowerCase().includes('down') || t.outcome.toLowerCase().includes('below'));

      if (upBuys.length > 0 && downBuys.length > 0) {
        // Match pairs by time proximity
        upBuys.forEach(upBuy => {
          const closestDown = downBuys.reduce((closest, down) => {
            const currentDiff = Math.abs(down.timestamp.getTime() - upBuy.timestamp.getTime());
            const closestDiff = closest ? Math.abs(closest.timestamp.getTime() - upBuy.timestamp.getTime()) : Infinity;
            return currentDiff < closestDiff ? down : closest;
          }, null as typeof downBuys[0] | null);

          if (closestDown) {
            const delayMs = Math.abs(closestDown.timestamp.getTime() - upBuy.timestamp.getTime());
            const delaySeconds = delayMs / 1000;
            const combinedPrice = upBuy.price + closestDown.price;
            const edge = (1 - combinedPrice) * 100;
            
            let category: 'arbitrage' | 'neutral' | 'risk' = 'neutral';
            if (combinedPrice < 0.98) category = 'arbitrage';
            else if (combinedPrice > 1.02) category = 'risk';

            const firstTrade = upBuy.timestamp < closestDown.timestamp ? upBuy : closestDown;
            const secondTrade = upBuy.timestamp < closestDown.timestamp ? closestDown : upBuy;
            const firstSide: 'Up' | 'Down' = firstTrade === upBuy ? 'Up' : 'Down';

            let asset: 'BTC' | 'ETH' | 'Other' = 'Other';
            const marketLower = market.toLowerCase();
            if (marketLower.includes('bitcoin') || marketLower.includes('btc')) asset = 'BTC';
            else if (marketLower.includes('ethereum') || marketLower.includes('eth')) asset = 'ETH';

            hedgePairs.push({
              market,
              trade1: { outcome: firstTrade.outcome, price: firstTrade.price, shares: firstTrade.shares, timestamp: firstTrade.timestamp, side: firstTrade.side },
              trade2: { outcome: secondTrade.outcome, price: secondTrade.price, shares: secondTrade.shares, timestamp: secondTrade.timestamp, side: secondTrade.side },
              delaySeconds,
              combinedPrice,
              edge,
              category,
              firstSide,
              asset,
              hourOfDay: firstTrade.timestamp.getUTCHours()
            });
          }
        });
      }
    });

    // Calculate statistics
    const totalPairs = hedgePairs.length;
    const arbitragePairs = hedgePairs.filter(p => p.category === 'arbitrage');
    const neutralPairs = hedgePairs.filter(p => p.category === 'neutral');
    const riskPairs = hedgePairs.filter(p => p.category === 'risk');

    const avgEdge = hedgePairs.reduce((sum, p) => sum + p.edge, 0) / totalPairs;
    const avgDelay = hedgePairs.reduce((sum, p) => sum + p.delaySeconds, 0) / totalPairs;

    // Delay distribution
    const delayBuckets = [
      { label: '<5s', min: 0, max: 5, count: 0, avgEdge: 0, edges: [] as number[] },
      { label: '5-30s', min: 5, max: 30, count: 0, avgEdge: 0, edges: [] as number[] },
      { label: '30-60s', min: 30, max: 60, count: 0, avgEdge: 0, edges: [] as number[] },
      { label: '1-5m', min: 60, max: 300, count: 0, avgEdge: 0, edges: [] as number[] },
      { label: '>5m', min: 300, max: Infinity, count: 0, avgEdge: 0, edges: [] as number[] },
    ];

    hedgePairs.forEach(p => {
      const bucket = delayBuckets.find(b => p.delaySeconds >= b.min && p.delaySeconds < b.max);
      if (bucket) {
        bucket.count++;
        bucket.edges.push(p.edge);
      }
    });

    delayBuckets.forEach(b => {
      b.avgEdge = b.edges.length > 0 ? b.edges.reduce((a, c) => a + c, 0) / b.edges.length : 0;
    });

    // Entry pattern analysis
    const upFirst = hedgePairs.filter(p => p.firstSide === 'Up');
    const downFirst = hedgePairs.filter(p => p.firstSide === 'Down');
    const avgUpFirstPrice = upFirst.reduce((sum, p) => sum + p.trade1.price, 0) / (upFirst.length || 1);
    const avgDownFirstPrice = downFirst.reduce((sum, p) => sum + p.trade1.price, 0) / (downFirst.length || 1);

    // Asset comparison
    const btcPairs = hedgePairs.filter(p => p.asset === 'BTC');
    const ethPairs = hedgePairs.filter(p => p.asset === 'ETH');
    
    const btcStats = {
      count: btcPairs.length,
      avgDelay: btcPairs.reduce((sum, p) => sum + p.delaySeconds, 0) / (btcPairs.length || 1),
      avgEdge: btcPairs.reduce((sum, p) => sum + p.edge, 0) / (btcPairs.length || 1),
      arbitrageRate: btcPairs.filter(p => p.category === 'arbitrage').length / (btcPairs.length || 1) * 100
    };
    
    const ethStats = {
      count: ethPairs.length,
      avgDelay: ethPairs.reduce((sum, p) => sum + p.delaySeconds, 0) / (ethPairs.length || 1),
      avgEdge: ethPairs.reduce((sum, p) => sum + p.edge, 0) / (ethPairs.length || 1),
      arbitrageRate: ethPairs.filter(p => p.category === 'arbitrage').length / (ethPairs.length || 1) * 100
    };

    // Hourly performance
    const hourlyStats = Array.from({ length: 24 }, (_, hour) => {
      const hourPairs = hedgePairs.filter(p => p.hourOfDay === hour);
      return {
        hour: `${hour.toString().padStart(2, '0')}:00`,
        count: hourPairs.length,
        avgEdge: hourPairs.reduce((sum, p) => sum + p.edge, 0) / (hourPairs.length || 1),
        riskRate: hourPairs.filter(p => p.category === 'risk').length / (hourPairs.length || 1) * 100
      };
    }).filter(h => h.count > 0);

    // Best opportunities (sorted by edge)
    const bestOpportunities = [...hedgePairs]
      .sort((a, b) => b.edge - a.edge)
      .slice(0, 15);

    // Risk trades
    const riskTrades = riskPairs.sort((a, b) => b.combinedPrice - a.combinedPrice);

    // Scatter data for delay vs edge
    const scatterData = hedgePairs.map(p => ({
      delay: Math.min(p.delaySeconds, 300),
      edge: p.edge,
      category: p.category
    }));

    // Deep Strategy Analysis per category
    const analyzeCategory = (pairs: HedgePair[], category: 'arbitrage' | 'neutral' | 'risk'): StrategyAnalysisData => {
      if (pairs.length === 0) {
        return {
          category,
          pairs: [],
          avgCombinedPrice: 0,
          avgEdge: 0,
          avgDelay: 0,
          avgFirstEntryPrice: 0,
          avgSecondEntryPrice: 0,
          avgShareSize: 0,
          upFirstPercent: 0,
          btcPercent: 0,
          ethPercent: 0,
          hourDistribution: [],
          priceSpread: 0,
          avgTotalInvested: 0,
          successIndicators: [],
          riskFactors: [],
          hypotheses: []
        };
      }

      const avgCombinedPrice = pairs.reduce((sum, p) => sum + p.combinedPrice, 0) / pairs.length;
      const avgEdgeCat = pairs.reduce((sum, p) => sum + p.edge, 0) / pairs.length;
      const avgDelayCat = pairs.reduce((sum, p) => sum + p.delaySeconds, 0) / pairs.length;
      const avgFirstEntryPrice = pairs.reduce((sum, p) => sum + p.trade1.price, 0) / pairs.length;
      const avgSecondEntryPrice = pairs.reduce((sum, p) => sum + p.trade2.price, 0) / pairs.length;
      const avgShareSize = pairs.reduce((sum, p) => sum + (p.trade1.shares + p.trade2.shares) / 2, 0) / pairs.length;
      const upFirstCount = pairs.filter(p => p.firstSide === 'Up').length;
      const btcCount = pairs.filter(p => p.asset === 'BTC').length;
      const ethCount = pairs.filter(p => p.asset === 'ETH').length;
      const priceSpread = Math.abs(avgFirstEntryPrice - avgSecondEntryPrice);
      const avgTotalInvested = pairs.reduce((sum, p) => sum + (p.trade1.price * p.trade1.shares) + (p.trade2.price * p.trade2.shares), 0) / pairs.length;

      // Hour distribution
      const hourCounts = new Map<number, number>();
      pairs.forEach(p => {
        hourCounts.set(p.hourOfDay, (hourCounts.get(p.hourOfDay) || 0) + 1);
      });
      const hourDistribution = Array.from(hourCounts.entries())
        .map(([hour, count]) => ({ hour, count }))
        .sort((a, b) => b.count - a.count);

      // Generate insights based on category
      const successIndicators: string[] = [];
      const riskFactors: string[] = [];
      const hypotheses: string[] = [];

      if (category === 'arbitrage') {
        if (avgEdgeCat > 3) successIndicators.push(`Hoge gemiddelde edge van ${avgEdgeCat.toFixed(1)}%`);
        if (avgDelayCat < 30) successIndicators.push(`Snelle hedge executie (${avgDelayCat.toFixed(0)}s)`);
        if (priceSpread < 0.05) successIndicators.push('Goed gebalanceerde entry prijzen');
        
        if (avgDelayCat > 60) riskFactors.push('Langzame hedge verhoogt slippage risico');
        if (priceSpread > 0.10) riskFactors.push('Grote spread tussen entry prijzen');
        
        hypotheses.push('Bot wacht op moment dat BEIDE kanten ondergewaardeerd zijn');
        hypotheses.push(`Prefereert ${btcCount > ethCount ? 'BTC' : 'ETH'} markten voor arbitrage (${Math.max(btcCount, ethCount)} trades)`);
        if (upFirstCount > pairs.length * 0.6) hypotheses.push('Up-side vaak goedkoper → market verwacht bearish');
        if (upFirstCount < pairs.length * 0.4) hypotheses.push('Down-side vaak goedkoper → market verwacht bullish');
      } else if (category === 'neutral') {
        if (avgDelayCat > 60) successIndicators.push('Geduldig wachten op betere prijzen');
        successIndicators.push('Breakeven base om later te DCA\'en');
        
        riskFactors.push('Geen directe winst, alleen risicoreductie');
        if (avgShareSize > 15) riskFactors.push('Grote posities in neutrale trades');
        
        hypotheses.push('Neutral trades = staging area voor latere arbitrage conversie');
        hypotheses.push('Bot koopt nu, verwacht dat combined prijs later daalt naar <98¢');
        hypotheses.push('DCA strategie: spreidt risico over tijd');
      } else if (category === 'risk') {
        if (priceSpread > 0.15) successIndicators.push(`Grote spread (${(priceSpread * 100).toFixed(0)}¢) suggereert sterke directional conviction`);
        
        riskFactors.push(`Combined price >${avgCombinedPrice.toFixed(2)} = gegarandeerd verlies als beide kanten gekocht`);
        riskFactors.push('Exposed naar price movement');
        if (avgShareSize > 10) riskFactors.push('Grote posities verhogen loss potentieel');
        
        const peakHour = hourDistribution[0]?.hour;
        if (peakHour !== undefined) {
          hypotheses.push(`Peak activiteit rond ${peakHour}:00 UTC - mogelijk reagerend op news events`);
        }
        hypotheses.push('Bewuste directional bet op crypto prijsbeweging');
        hypotheses.push('Accepteert overpaying voor één kant als die wint');
        if (btcCount > ethCount * 1.5) hypotheses.push('Sterkere conviction in BTC price movements');
        if (ethCount > btcCount * 1.5) hypotheses.push('Sterkere conviction in ETH price movements');
        hypotheses.push('Mogelijk gebaseerd op technische analyse of market sentiment');
      }

      return {
        category,
        pairs,
        avgCombinedPrice,
        avgEdge: avgEdgeCat,
        avgDelay: avgDelayCat,
        avgFirstEntryPrice,
        avgSecondEntryPrice,
        avgShareSize,
        upFirstPercent: (upFirstCount / pairs.length) * 100,
        btcPercent: (btcCount / pairs.length) * 100,
        ethPercent: (ethCount / pairs.length) * 100,
        hourDistribution,
        priceSpread,
        avgTotalInvested,
        successIndicators,
        riskFactors,
        hypotheses
      };
    };

    const arbitrageAnalysis = analyzeCategory(arbitragePairs, 'arbitrage');
    const neutralAnalysis = analyzeCategory(neutralPairs, 'neutral');
    const riskAnalysis = analyzeCategory(riskPairs, 'risk');

    return {
      totalPairs,
      arbitrageCount: arbitragePairs.length,
      neutralCount: neutralPairs.length,
      riskCount: riskPairs.length,
      avgEdge,
      avgDelay,
      delayBuckets,
      upFirst: upFirst.length,
      downFirst: downFirst.length,
      avgUpFirstPrice,
      avgDownFirstPrice,
      btcStats,
      ethStats,
      hourlyStats,
      bestOpportunities,
      riskTrades,
      scatterData,
      hedgePairs,
      strategyAnalysis: {
        arbitrage: arbitrageAnalysis,
        neutral: neutralAnalysis,
        risk: riskAnalysis
      }
    };
  }, [trades]);

  // Show loading state with progress
  if (isLoading || !analysis) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <Loader2 className="w-8 h-8 animate-spin mx-auto text-primary" />
          <div className="text-muted-foreground">Analyse laden...</div>
          <div className="text-xs text-muted-foreground">
            {trades.length > 0 ? (
              <span>
                {trades.length.toLocaleString()} trades geladen (max {MAX_TRADES_FOR_ANALYSIS.toLocaleString()})
              </span>
            ) : (
              <span>Trades ophalen...</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  const pieData = [
    { name: 'Arbitrage', value: analysis.arbitrageCount, color: 'hsl(var(--success))' },
    { name: 'Neutral', value: analysis.neutralCount, color: 'hsl(var(--chart-4))' },
    { name: 'Risk', value: analysis.riskCount, color: 'hsl(var(--destructive))' },
  ];

  const assetComparisonData = [
    { 
      asset: 'Bitcoin', 
      trades: analysis.btcStats.count, 
      avgDelay: analysis.btcStats.avgDelay,
      avgEdge: analysis.btcStats.avgEdge,
      arbitrageRate: analysis.btcStats.arbitrageRate
    },
    { 
      asset: 'Ethereum', 
      trades: analysis.ethStats.count, 
      avgDelay: analysis.ethStats.avgDelay,
      avgEdge: analysis.ethStats.avgEdge,
      arbitrageRate: analysis.ethStats.arbitrageRate
    },
  ];

  const entryPatternData = [
    { side: 'Up First', count: analysis.upFirst, avgPrice: analysis.avgUpFirstPrice * 100 },
    { side: 'Down First', count: analysis.downFirst, avgPrice: analysis.avgDownFirstPrice * 100 },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center gap-4">
            <Link to="/" className="p-2 hover:bg-secondary rounded-lg transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <h1 className="text-xl font-semibold flex items-center gap-2">
                <GitBranch className="w-5 h-5 text-primary" />
                Strategy Deep Dive
              </h1>
              <p className="text-sm text-muted-foreground">
                Comprehensive analysis of Gabagool22's trading patterns
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Overview Dashboard */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-primary" />
            Overview Dashboard
          </h2>
          
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card className="glass">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Total Hedge Pairs</p>
                    <p className="text-2xl font-mono font-bold">{analysis.totalPairs}</p>
                  </div>
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Target className="w-5 h-5 text-primary" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="glass">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Avg Edge</p>
                    <p className={`text-2xl font-mono font-bold ${analysis.avgEdge > 0 ? 'text-success' : 'text-destructive'}`}>
                      {analysis.avgEdge.toFixed(2)}%
                    </p>
                  </div>
                  <div className="p-2 rounded-lg bg-success/10">
                    <TrendingUp className="w-5 h-5 text-success" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="glass">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Avg Hedge Delay</p>
                    <p className="text-2xl font-mono font-bold">{analysis.avgDelay.toFixed(0)}s</p>
                  </div>
                  <div className="p-2 rounded-lg bg-chart-4/10">
                    <Clock className="w-5 h-5 text-chart-4" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="glass">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Arbitrage Rate</p>
                    <p className="text-2xl font-mono font-bold text-success">
                      {((analysis.arbitrageCount / analysis.totalPairs) * 100).toFixed(0)}%
                    </p>
                  </div>
                  <div className="p-2 rounded-lg bg-success/10">
                    <Zap className="w-5 h-5 text-success" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* TIME TO EXPIRY ANALYSIS - PROMINENT SECTION */}
          <Card className="glass border-2 border-warning/30 bg-gradient-to-br from-warning/5 via-background to-background">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-warning/20 flex items-center justify-center">
                    <Timer className="w-5 h-5 text-warning" />
                  </div>
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      ⏱️ Tijd tot Expiry Analyse
                    </CardTitle>
                    <CardDescription>Wanneer plaatst de bot zijn bets ten opzichte van market expiry?</CardDescription>
                  </div>
                </div>
                {expiryAnalysis && (
                  <Badge variant="outline" className="border-warning text-warning">
                    {expiryAnalysis.totalAnalyzed} trades
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {!expiryAnalysis ? (
                <div className="p-6 rounded-xl bg-muted/30 border border-border text-center">
                  <AlertTriangle className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground mb-2">
                    Geen expiry data beschikbaar
                  </p>
                  <p className="text-xs text-muted-foreground">
                    De marktnamen bevatten geen parseable tijdsinformatie, of de trades zijn nog aan het laden.
                    <br />
                    <span className="text-primary">
                      Geladen: {trades.length.toLocaleString()} trades
                    </span>
                  </p>
                </div>
              ) : (
                <>
                  {/* Trading Style Header */}
                  <div className="p-4 rounded-xl bg-warning/10 border border-warning/20">
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="font-bold text-lg flex items-center gap-2">
                        <Activity className="w-5 h-5 text-warning" />
                        Trading Stijl: {expiryAnalysis.tradingStyle}
                      </h4>
                    </div>

                    {/* Key Metrics Grid */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      <div className="p-3 bg-background/60 rounded-lg text-center border border-border">
                        <p className="text-2xl font-mono font-bold text-warning">{expiryAnalysis.avgMinutesToExpiry.toFixed(1)}</p>
                        <p className="text-xs text-muted-foreground">Gem. Min. tot Expiry</p>
                      </div>
                      <div className="p-3 bg-background/60 rounded-lg text-center border border-border">
                        <p className="text-2xl font-mono font-bold">{expiryAnalysis.medianMinutes.toFixed(1)}</p>
                        <p className="text-xs text-muted-foreground">Mediaan Minuten</p>
                      </div>
                      <div className="p-3 bg-background/60 rounded-lg text-center border border-border">
                        <p className="text-2xl font-mono font-bold text-destructive">{expiryAnalysis.immediateCount + expiryAnalysis.shortCount}</p>
                        <p className="text-xs text-muted-foreground">Last-Minute ({"<"}5min)</p>
                      </div>
                      <div className="p-3 bg-background/60 rounded-lg text-center border border-border">
                        <p className="text-2xl font-mono font-bold text-success">{expiryAnalysis.earlyCount}</p>
                        <p className="text-xs text-muted-foreground">Early Entry ({">"}30min)</p>
                      </div>
                    </div>
                  </div>

                  {/* Distribution Bars */}
                  <div>
                    <p className="text-sm font-medium mb-3">Verdeling Tijd tot Expiry</p>
                    <div className="space-y-2">
                      {expiryAnalysis.categoryBreakdown.map((cat, i) => (
                        <div key={i} className="flex items-center gap-3">
                          <div className="w-28 text-xs text-muted-foreground">{cat.label}</div>
                          <div className="flex-1 bg-secondary/50 rounded-full h-7 overflow-hidden">
                            <div 
                              className={`h-full rounded-full flex items-center justify-end px-2 text-xs font-mono text-white ${
                                i === 0 ? 'bg-destructive' : i === 1 ? 'bg-warning' : 'bg-success'
                              }`}
                              style={{ width: `${Math.max(cat.percent, 5)}%` }}
                            >
                              {cat.percent.toFixed(0)}%
                            </div>
                          </div>
                          <div className="w-20 text-right text-xs font-mono">{cat.count} trades</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Charts Row */}
                  <div className="grid lg:grid-cols-2 gap-4">
                    {/* Time Buckets Bar Chart */}
                    <div className="p-4 bg-secondary/20 rounded-lg border border-border">
                      <h5 className="font-semibold text-sm mb-3">Gedetailleerde Tijd Buckets</h5>
                      <div className="h-[200px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={expiryAnalysis.timeBuckets}>
                            <XAxis dataKey="label" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} />
                            <YAxis tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                            <Tooltip 
                              contentStyle={{ 
                                backgroundColor: 'hsl(var(--card))', 
                                border: '1px solid hsl(var(--border))',
                                borderRadius: '8px'
                              }}
                              formatter={(value: number, name: string) => {
                                if (name === 'count') return [`${value} trades`, 'Aantal'];
                                if (name === 'avgPrice') return [`${(value * 100).toFixed(1)}¢`, 'Gem. Prijs'];
                                return [value, name];
                              }}
                            />
                            <Bar dataKey="count" fill="hsl(var(--warning))" name="Aantal Trades" radius={[4, 4, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    {/* Price by Time Table */}
                    <div className="p-4 bg-secondary/20 rounded-lg border border-border">
                      <h5 className="font-semibold text-sm mb-3 flex items-center gap-2">
                        <DollarSign className="w-4 h-4 text-primary" />
                        Prijs vs Tijd tot Expiry
                      </h5>
                      <div className="overflow-x-auto max-h-[200px]">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-background">
                            <tr className="border-b border-border">
                              <th className="text-left p-2 font-medium">Tijd</th>
                              <th className="text-center p-2 font-medium">Trades</th>
                              <th className="text-center p-2 font-medium">Gem. Prijs</th>
                              <th className="text-center p-2 font-medium">Gem. Shares</th>
                            </tr>
                          </thead>
                          <tbody>
                            {expiryAnalysis.timeBuckets.map((bucket, i) => (
                              <tr key={i} className="border-b border-border/50">
                                <td className="p-2 text-muted-foreground">{bucket.label}</td>
                                <td className="p-2 text-center font-mono">{bucket.count}</td>
                                <td className="p-2 text-center font-mono">{(bucket.avgPrice * 100).toFixed(1)}¢</td>
                                <td className="p-2 text-center font-mono">{bucket.avgShares.toFixed(1)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  {/* Insights & Hypotheses */}
                  <div className="grid lg:grid-cols-2 gap-4">
                    {expiryAnalysis.insights.length > 0 && (
                      <div className="p-4 bg-chart-4/10 rounded-lg border border-chart-4/20">
                        <p className="text-sm font-semibold text-chart-4 mb-3 flex items-center gap-2">
                          <Lightbulb className="w-4 h-4" />
                          Observaties uit de Data
                        </p>
                        <ul className="space-y-2">
                          {expiryAnalysis.insights.map((insight, i) => (
                            <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                              <span className="text-chart-4">•</span>
                              {insight}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="p-4 bg-primary/10 rounded-lg border border-primary/20">
                      <p className="text-sm font-semibold text-primary mb-3 flex items-center gap-2">
                        <Target className="w-4 h-4" />
                        Mogelijke Overwegingen
                      </p>
                      <ul className="space-y-2">
                        {expiryAnalysis.hypotheses.map((hypothesis, i) => (
                          <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                            <span className="text-primary">•</span>
                            {hypothesis}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  {/* Timing Explanation */}
                  <div className="grid lg:grid-cols-3 gap-3 text-sm">
                    <div className="p-3 bg-destructive/10 rounded-lg border border-destructive/20">
                      <p className="font-medium text-destructive mb-1">🎯 Last-Minute ({"<"}5min)</p>
                      <p className="text-xs text-muted-foreground">
                        Maximale informatie. Hogere prijzen maar lager risico. Ideaal voor <strong>confirmation plays</strong>.
                      </p>
                    </div>
                    <div className="p-3 bg-warning/10 rounded-lg border border-warning/20">
                      <p className="font-medium text-warning mb-1">⚖️ Mid-Range (5-30min)</p>
                      <p className="text-xs text-muted-foreground">
                        Balans tussen info en prijs. Ruimte voor DCA. Ideaal voor <strong>position building</strong>.
                      </p>
                    </div>
                    <div className="p-3 bg-success/10 rounded-lg border border-success/20">
                      <p className="font-medium text-success mb-1">🌱 Early Entry ({">"}30min)</p>
                      <p className="text-xs text-muted-foreground">
                        Lagere prijzen, meer onzekerheid. Ideaal voor <strong>value accumulation</strong>.
                      </p>
                    </div>
                  </div>

                  {/* Trading Style Summary */}
                  <div className="p-4 bg-warning/10 rounded-lg border border-warning/20">
                    <h5 className="font-semibold text-sm mb-2 flex items-center gap-2 text-warning">
                      <Activity className="w-4 h-4" />
                      Gabagool22's Timing Profiel
                    </h5>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {expiryAnalysis.tradingStyle === 'Last-Minute Sniper' && (
                        <>
                          De bot wacht tot het laatste moment om te traden. Dit suggereert een strategie gebaseerd op 
                          <strong> maximale zekerheid</strong> - de crypto prijs is bijna bepaald, dus het risico is minimaal.
                        </>
                      )}
                      {expiryAnalysis.tradingStyle === 'Early Bird Accumulator' && (
                        <>
                          De bot bouwt vroeg posities op tegen lagere prijzen. Dit is een <strong>value-focused strategie</strong> - 
                          meer onzekerheid accepteren voor betere prijzen en meer tijd voor DCA.
                        </>
                      )}
                      {expiryAnalysis.tradingStyle === 'Mid-Range Strategist' && (
                        <>
                          De bot opereert vooral in het 5-30 minuten window. Dit is een <strong>balanced approach</strong> - 
                          genoeg informatie om informed decisions te maken, maar nog ruimte voor DCA.
                        </>
                      )}
                      {expiryAnalysis.tradingStyle === 'Mixed' && (
                        <>
                          De bot gebruikt een <strong>gemixte timing strategie</strong> - early entries voor value, 
                          mid-range voor position building, en last-minute voor confirmation.
                        </>
                      )}
                    </p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Distribution Pie Chart */}
          <Card className="glass">
            <CardHeader>
              <CardTitle className="text-sm">Trade Category Distribution</CardTitle>
              <CardDescription>Arbitrage (&lt;0.98) vs Neutral (0.98-1.02) vs Risk (&gt;1.02)</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={90}
                      dataKey="value"
                      label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                    >
                      {pieData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'hsl(var(--card))', 
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px'
                      }}
                    />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Opening Trade Analysis */}
        <OpeningTradeAnalysis trades={trades} />

        {/* Trade Size Evolution - Asset-Specific Sizing */}
        <TradeSizeEvolutionChart trades={trades} />

        {/* NEW: DCA Formula Analysis - Dual-Side Market Making */}
        <DCAFormulaAnalysis trades={trades} />

        {/* DCA & Arbitrage Strategy Analysis */}
        <DCAArbitrageAnalysis trades={trades} />

        {/* Volatility Analysis */}
        <VolatilityAnalysis trades={trades} />

        {/* Strategy Flow Diagram - ENHANCED FOR DEVELOPERS */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-primary" />
            Strategy Decision Flow
          </h2>

          {/* Developer Documentation Card with Accordions */}
          <Card className="glass border-primary/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-primary" />
                Gabagool22 Strategy Documentation
              </CardTitle>
              <CardDescription>
                Klik op een sectie om de volledige technische documentatie te bekijken
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Quick Stats Overview - Always Visible */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4 p-4 rounded-lg bg-secondary/30 border border-border">
                <div className="text-center">
                  <p className="text-2xl font-mono font-bold text-success">{analysis ? Math.round((analysis.arbitrageCount / analysis.totalPairs) * 100) : 0}%</p>
                  <p className="text-xs text-muted-foreground">Arbitrage Success</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-mono font-bold text-chart-4">{analysis?.avgDelay?.toFixed(0) || 0}s</p>
                  <p className="text-xs text-muted-foreground">Avg Hedge Time</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-mono font-bold">{dcaAnalysis ? (dcaAnalysis.avgBuyPrice * 100).toFixed(0) : 0}¢</p>
                  <p className="text-xs text-muted-foreground">Avg Entry Price</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-mono font-bold text-primary">{dcaAnalysis?.priceImprovementRate?.toFixed(0) || 0}%</p>
                  <p className="text-xs text-muted-foreground">DCA Improvement</p>
                </div>
              </div>

              <Accordion type="multiple" className="space-y-2">
                {/* Section 1: Strategy Overview */}
                <AccordionItem value="overview" className="border border-border rounded-lg px-4 bg-card/50">
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                        <Lightbulb className="w-4 h-4 text-primary" />
                      </div>
                      <div className="text-left">
                        <p className="font-semibold text-sm">Wat is deze strategie?</p>
                        <p className="text-xs text-muted-foreground font-normal">DCA Market Making op prediction markets uitgelegd</p>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    <div className="p-4 rounded-lg bg-muted/50 border border-border">
                      <h4 className="font-semibold text-sm mb-3 text-primary">Het Kernprincipe: Hybride Arbitrage + Directional Betting</h4>
                      <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                        Deze bot opereert <strong>exclusief op crypto prediction markets</strong> - specifiek 
                        <strong className="text-chart-4"> Bitcoin (BTC)</strong> en <strong className="text-primary"> Ethereum (ETH)</strong> 
                        Up/Down markten. De strategie combineert twee benaderingen:
                      </p>
                      
                      <div className="grid grid-cols-2 gap-3 mb-4">
                        <div className="p-3 bg-chart-4/10 rounded-lg border border-chart-4/20 text-center">
                          <p className="text-2xl font-bold">₿</p>
                          <p className="text-sm font-medium">Bitcoin Markets</p>
                          <p className="text-xs text-muted-foreground">{analysis?.btcStats.count || 0} trades</p>
                        </div>
                        <div className="p-3 bg-primary/10 rounded-lg border border-primary/20 text-center">
                          <p className="text-2xl font-bold">Ξ</p>
                          <p className="text-sm font-medium">Ethereum Markets</p>
                          <p className="text-xs text-muted-foreground">{analysis?.ethStats.count || 0} trades</p>
                        </div>
                      </div>
                      
                      <div className="p-3 bg-success/10 rounded-lg border border-success/20 mb-4">
                        <p className="text-sm font-medium text-success mb-2">💰 Strategie 1: Arbitrage ({"<"}98¢ combined)</p>
                        <p className="text-sm text-muted-foreground">
                          Koop beide kanten zodat combined {"<"} $0.98. Gegarandeerde 2%+ winst ongeacht uitkomst.
                          <strong className="text-success"> {analysis?.arbitrageCount || 0} trades ({analysis ? Math.round((analysis.arbitrageCount / analysis.totalPairs) * 100) : 0}%)</strong>
                        </p>
                      </div>

                      <div className="p-3 bg-destructive/10 rounded-lg border border-destructive/20 mb-4">
                        <p className="text-sm font-medium text-destructive mb-2">🎯 Strategie 2: Directional Bets ({">"}102¢ combined)</p>
                        <p className="text-sm text-muted-foreground">
                          Bewust risico nemen met ongebalanceerde posities. Als de bot denkt dat één kant waarschijnlijker is, 
                          accepteert hij een combined price {">"} $1.02 voor potentieel hogere returns.
                          <strong className="text-destructive"> {analysis?.riskCount || 0} trades ({analysis ? Math.round((analysis.riskCount / analysis.totalPairs) * 100) : 0}%)</strong>
                        </p>
                      </div>

                      <div className="p-3 bg-chart-4/10 rounded-lg border border-chart-4/20">
                        <p className="text-sm font-medium text-chart-4 mb-2">⚖️ Strategie 3: Neutral (98-102¢)</p>
                        <p className="text-sm text-muted-foreground">
                          Breakeven trades als opstap - wachten op betere prijzen om te converteren naar arbitrage.
                          <strong className="text-chart-4"> {analysis?.neutralCount || 0} trades ({analysis ? Math.round((analysis.neutralCount / analysis.totalPairs) * 100) : 0}%)</strong>
                        </p>
                      </div>
                    </div>

                    <div className="p-4 rounded-lg bg-warning/10 border border-warning/20">
                      <h4 className="font-semibold text-sm mb-2 flex items-center gap-2 text-warning">
                        <AlertTriangle className="w-4 h-4" />
                        Belangrijke Nuance: Dit is GEEN Pure Arbitrage Bot
                      </h4>
                      <p className="text-sm text-muted-foreground mb-3">
                        Anders dan een pure arbitrage bot die alleen {"<"}$1.00 combined trades neemt, neemt Gabagool22 
                        bewust directional risk. De data laat zien:
                      </p>
                      <ul className="space-y-1 text-sm text-muted-foreground">
                        <li>• <strong>{analysis ? Math.round((analysis.riskCount / analysis.totalPairs) * 100) : 0}% van trades zijn "risk trades"</strong> - gecombineerde prijs {">"} $1.02</li>
                        <li>• Dit suggereert <strong>bewuste directional bets</strong> op crypto prijsbewegingen</li>
                        <li>• Mogelijk gebaseerd op <strong>market sentiment of technische analyse</strong></li>
                        <li>• Hogere potentiële returns, maar ook <strong>reëel verliesrisico</strong></li>
                      </ul>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* Section 2: The 4-Step Flow */}
                <AccordionItem value="flow" className="border border-border rounded-lg px-4 bg-card/50">
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-chart-4/20 flex items-center justify-center">
                        <GitBranch className="w-4 h-4 text-chart-4" />
                      </div>
                      <div className="text-left">
                        <p className="font-semibold text-sm">De 4-Stappen Decision Flow</p>
                        <p className="text-xs text-muted-foreground font-normal">Scan → Analyze → Entry → Hedge</p>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    {/* Visual Flow Diagram */}
                    <div className="flex flex-col lg:flex-row items-stretch gap-2">
                      <div className="flex-1 p-3 rounded-lg bg-primary/10 border border-primary/30 text-center">
                        <Target className="w-6 h-6 text-primary mx-auto mb-1" />
                        <p className="text-xs font-bold">1. SCAN</p>
                        <p className="text-xs text-muted-foreground">Monitor markets</p>
                      </div>
                      <ArrowRight className="w-4 h-4 text-muted-foreground self-center hidden lg:block" />
                      <div className="flex-1 p-3 rounded-lg bg-chart-4/10 border border-chart-4/30 text-center">
                        <BarChart3 className="w-6 h-6 text-chart-4 mx-auto mb-1" />
                        <p className="text-xs font-bold">2. ANALYZE</p>
                        <p className="text-xs text-muted-foreground">Check prices</p>
                      </div>
                      <ArrowRight className="w-4 h-4 text-muted-foreground self-center hidden lg:block" />
                      <div className="flex-1 p-3 rounded-lg bg-success/10 border border-success/30 text-center">
                        <TrendingDown className="w-6 h-6 text-success mx-auto mb-1" />
                        <p className="text-xs font-bold">3. ENTRY</p>
                        <p className="text-xs text-muted-foreground">Buy cheap side</p>
                      </div>
                      <ArrowRight className="w-4 h-4 text-muted-foreground self-center hidden lg:block" />
                      <div className="flex-1 p-3 rounded-lg bg-warning/10 border border-warning/30 text-center">
                        <Shield className="w-6 h-6 text-warning mx-auto mb-1" />
                        <p className="text-xs font-bold">4. HEDGE</p>
                        <p className="text-xs text-muted-foreground">Complete arb</p>
                      </div>
                    </div>

                    {/* Detailed Step Explanations */}
                    <div className="space-y-3">
                      <div className="p-4 rounded-lg bg-gradient-to-r from-primary/10 to-transparent border-l-4 border-primary">
                        <h4 className="font-semibold text-sm flex items-center gap-2">
                          <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">1</span>
                          Market Scanning (Alleen BTC & ETH)
                        </h4>
                        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                          De bot focust <strong>exclusief op crypto markten</strong>: Bitcoin en Ethereum Up/Down prediction markets.
                          Geen politiek, geen sports - alleen crypto price action.
                        </p>
                        <div className="mt-3 p-3 bg-background/80 rounded font-mono text-xs overflow-x-auto">
                          <div className="text-muted-foreground">// Market Filter - Crypto Only</div>
                          <div>ALLOWED_MARKETS = [</div>
                          <div className="pl-4"><span className="text-chart-4">"Bitcoin"</span>, <span className="text-chart-4">"BTC"</span>,</div>
                          <div className="pl-4"><span className="text-primary">"Ethereum"</span>, <span className="text-primary">"ETH"</span></div>
                          <div>]</div>
                          <div className="mt-2"><span className="text-primary">for each</span> market <span className="text-primary">in</span> activeMarkets:</div>
                          <div className="pl-4"><span className="text-primary">if not</span> market.name.containsAny(ALLOWED_MARKETS):</div>
                          <div className="pl-8"><span className="text-primary">continue</span> <span className="text-muted-foreground">// Skip non-crypto</span></div>
                          <div className="pl-4"></div>
                          <div className="pl-4">upAsk = orderbook.getLowestAsk(<span className="text-success">"Up"</span>)</div>
                          <div className="pl-4">downAsk = orderbook.getLowestAsk(<span className="text-success">"Down"</span>)</div>
                          <div className="pl-4">combined = upAsk + downAsk</div>
                          <div className="pl-4"></div>
                          <div className="pl-4"><span className="text-muted-foreground">// BELANGRIJK: Bot neemt OOK {">"} 1.02 trades!</span></div>
                          <div className="pl-4"><span className="text-primary">if</span> combined {"<"} <span className="text-success">0.98</span>:</div>
                          <div className="pl-8">action = <span className="text-success">ARBITRAGE</span></div>
                          <div className="pl-4"><span className="text-primary">elif</span> combined {"<"} <span className="text-chart-4">1.02</span>:</div>
                          <div className="pl-8">action = <span className="text-chart-4">NEUTRAL_DCA</span></div>
                          <div className="pl-4"><span className="text-primary">else</span>:</div>
                          <div className="pl-8">action = <span className="text-destructive">DIRECTIONAL_BET</span> <span className="text-muted-foreground">// Intentional risk!</span></div>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <div className="p-2 bg-chart-4/10 rounded text-center">
                            <p className="text-sm font-bold">₿ {analysis?.btcStats.count || 0}</p>
                            <p className="text-xs text-muted-foreground">BTC trades</p>
                          </div>
                          <div className="p-2 bg-primary/10 rounded text-center">
                            <p className="text-sm font-bold">Ξ {analysis?.ethStats.count || 0}</p>
                            <p className="text-xs text-muted-foreground">ETH trades</p>
                          </div>
                        </div>
                      </div>

                      <div className="p-4 rounded-lg bg-gradient-to-r from-chart-4/10 to-transparent border-l-4 border-chart-4">
                        <h4 className="font-semibold text-sm flex items-center gap-2">
                          <span className="w-6 h-6 rounded-full bg-chart-4 text-primary-foreground flex items-center justify-center text-xs font-bold">2</span>
                          Price Analysis & Position Sizing
                        </h4>
                        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                          De agressiviteit van de bot schaalt omgekeerd met de prijs. Bij lagere prijzen is het risico 
                          lager en de potentiële opbrengst hoger, dus worden grotere posities genomen.
                        </p>
                        <div className="mt-3 grid grid-cols-2 lg:grid-cols-4 gap-2">
                          <div className="p-3 bg-success/10 rounded border border-success/20">
                            <div className="text-sm font-mono text-success font-bold">{"<"} 35¢</div>
                            <div className="text-xs text-muted-foreground mt-1">Max: 20 shares</div>
                            <div className="text-xs text-success">AGGRESSIVE</div>
                          </div>
                          <div className="p-3 bg-chart-4/10 rounded border border-chart-4/20">
                            <div className="text-sm font-mono text-chart-4 font-bold">35-50¢</div>
                            <div className="text-xs text-muted-foreground mt-1">10-14 shares</div>
                            <div className="text-xs text-chart-4">STANDARD</div>
                          </div>
                          <div className="p-3 bg-warning/10 rounded border border-warning/20">
                            <div className="text-sm font-mono text-warning font-bold">50-55¢</div>
                            <div className="text-xs text-muted-foreground mt-1">5-8 shares</div>
                            <div className="text-xs text-warning">CAUTIOUS</div>
                          </div>
                          <div className="p-3 bg-destructive/10 rounded border border-destructive/20">
                            <div className="text-sm font-mono text-destructive font-bold">{">"}55¢</div>
                            <div className="text-xs text-muted-foreground mt-1">2-5 shares</div>
                            <div className="text-xs text-destructive">MINIMAL</div>
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground mt-3">
                          <strong>Waarom?</strong> Bij een prijs van 30¢ heb je maximaal $0.30 risico per share maar 
                          $0.70 potentiële winst (als die kant wint). Bij 55¢ is dat $0.55 risico voor $0.45 winst - veel minder aantrekkelijk.
                        </p>
                      </div>

                      <div className="p-4 rounded-lg bg-gradient-to-r from-success/10 to-transparent border-l-4 border-success">
                        <h4 className="font-semibold text-sm flex items-center gap-2">
                          <span className="w-6 h-6 rounded-full bg-success text-success-foreground flex items-center justify-center text-xs font-bold">3</span>
                          Entry: Koop de Goedkoopste Kant Eerst
                        </h4>
                        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                          De bot begint altijd met de kant die het goedkoopst is. Dit maximaliseert de kans om 
                          een profitable hedge te completeren. Als de goedkope kant later duurder wordt, heb je 
                          al een goede entry. Als hij goedkoop blijft, kun je DCA-en.
                        </p>
                        <div className="mt-3 grid grid-cols-2 gap-3">
                          <div className="p-3 bg-background/50 rounded border border-border">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm font-medium">Down First</span>
                              <span className="text-lg font-mono font-bold text-primary">{analysis ? Math.round((analysis.downFirst / analysis.totalPairs) * 100) : '?'}%</span>
                            </div>
                            <p className="text-xs text-muted-foreground">Vaker goedkoper - mogelijk sentiment bias</p>
                          </div>
                          <div className="p-3 bg-background/50 rounded border border-border">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm font-medium">Up First</span>
                              <span className="text-lg font-mono font-bold">{analysis ? Math.round((analysis.upFirst / analysis.totalPairs) * 100) : '?'}%</span>
                            </div>
                            <p className="text-xs text-muted-foreground">Minder vaak de goedkoopste optie</p>
                          </div>
                        </div>
                      </div>

                      <div className="p-4 rounded-lg bg-gradient-to-r from-warning/10 to-transparent border-l-4 border-warning">
                        <h4 className="font-semibold text-sm flex items-center gap-2">
                          <span className="w-6 h-6 rounded-full bg-warning text-warning-foreground flex items-center justify-center text-xs font-bold">4</span>
                          Hedge: Completeer de Arbitrage
                        </h4>
                        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                          Zodra er een positie is op één kant, zoekt de bot naar mogelijkheden om de andere kant 
                          te kopen zodat de gecombineerde prijs onder $1.00 komt. Dit is waar de gegarandeerde winst wordt gelocked.
                        </p>
                        <div className="mt-3 p-3 bg-background/80 rounded font-mono text-xs overflow-x-auto">
                          <div className="text-muted-foreground">// Hedge Decision Tree</div>
                          <div><span className="text-primary">function</span> evaluateHedge(myAvgPrice, otherSideAsk):</div>
                          <div className="pl-4">combined = myAvgPrice + otherSideAsk</div>
                          <div className="pl-4">edge = (1.00 - combined) * 100  <span className="text-muted-foreground">// % profit</span></div>
                          <div className="pl-4"></div>
                          <div className="pl-4"><span className="text-primary">if</span> combined {"<"} <span className="text-success">0.95</span>:</div>
                          <div className="pl-8"><span className="text-primary">return</span> <span className="text-success">EXECUTE_MAX</span>  <span className="text-muted-foreground">// {">"} 5% edge, go all in</span></div>
                          <div className="pl-4"><span className="text-primary">elif</span> combined {"<"} <span className="text-success">0.98</span>:</div>
                          <div className="pl-8"><span className="text-primary">return</span> <span className="text-success">EXECUTE</span>  <span className="text-muted-foreground">// 2-5% edge, solid trade</span></div>
                          <div className="pl-4"><span className="text-primary">elif</span> combined {"<"} <span className="text-chart-4">1.00</span>:</div>
                          <div className="pl-8"><span className="text-primary">return</span> <span className="text-chart-4">PARTIAL</span>  <span className="text-muted-foreground">// Small edge, partial fill</span></div>
                          <div className="pl-4"><span className="text-primary">else</span>:</div>
                          <div className="pl-8"><span className="text-primary">return</span> <span className="text-warning">WAIT</span>  <span className="text-muted-foreground">// No profit, hold position</span></div>
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                          <div className="p-2 bg-success/10 rounded">
                            <div className="text-lg font-mono font-bold text-success">{analysis?.arbitrageCount || 0}</div>
                            <div className="text-xs text-muted-foreground">Profitable ({"<"}98¢)</div>
                          </div>
                          <div className="p-2 bg-chart-4/10 rounded">
                            <div className="text-lg font-mono font-bold text-chart-4">{analysis?.neutralCount || 0}</div>
                            <div className="text-xs text-muted-foreground">Neutral</div>
                          </div>
                          <div className="p-2 bg-destructive/10 rounded">
                            <div className="text-lg font-mono font-bold text-destructive">{analysis?.riskCount || 0}</div>
                            <div className="text-xs text-muted-foreground">At Risk ({">"}102¢)</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* Section 3: DCA Deep Dive */}
                <AccordionItem value="dca" className="border border-border rounded-lg px-4 bg-card/50">
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-success/20 flex items-center justify-center">
                        <Repeat className="w-4 h-4 text-success" />
                      </div>
                      <div className="text-left">
                        <p className="font-semibold text-sm">DCA Mechaniek in Detail</p>
                        <p className="text-xs text-muted-foreground font-normal">Waarom kleine batches beter werken dan grote orders</p>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    <div className="p-4 rounded-lg bg-muted/50 border border-border">
                      <h4 className="font-semibold text-sm mb-3">Het DCA Principe Toegepast op Prediction Markets</h4>
                      <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                        Dollar Cost Averaging is een bekende strategie in traditionele finance: in plaats van al je geld 
                        in één keer te investeren, spreid je je aankopen over tijd. Dit werkt bijzonder goed op prediction 
                        markets omdat prijzen volatiel zijn en er vaak geen duidelijke trend richting is.
                      </p>
                      
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        <div className="p-3 bg-background/50 rounded border border-border">
                          <h5 className="font-medium text-sm mb-2 flex items-center gap-2">
                            <TrendingDown className="w-4 h-4 text-success" />
                            Voordelen van DCA
                          </h5>
                          <ul className="space-y-1 text-xs text-muted-foreground">
                            <li>• Vermindert timing risico</li>
                            <li>• Betere average entry price</li>
                            <li>• Flexibiliteit om te stoppen</li>
                            <li>• Minder marktimpact per trade</li>
                            <li>• Emotie uit de beslissing</li>
                          </ul>
                        </div>
                        <div className="p-3 bg-background/50 rounded border border-border">
                          <h5 className="font-medium text-sm mb-2 flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 text-warning" />
                            Nadelen van DCA
                          </h5>
                          <ul className="space-y-1 text-xs text-muted-foreground">
                            <li>• Meer transacties = meer fees</li>
                            <li>• Kan langzamer zijn dan nodig</li>
                            <li>• Mist soms de beste prijs</li>
                            <li>• Complexere execution logic</li>
                            <li>• Vereist constante monitoring</li>
                          </ul>
                        </div>
                      </div>
                    </div>

                    <div className="p-4 rounded-lg bg-success/10 border border-success/20">
                      <h4 className="font-semibold text-sm mb-2 flex items-center gap-2 text-success">
                        <CheckCircle2 className="w-4 h-4" />
                        DCA Performance van Gabagool22
                      </h4>
                      <div className="grid grid-cols-3 gap-4 mt-3">
                        <div className="text-center">
                          <p className="text-2xl font-mono font-bold text-success">{dcaAnalysis?.priceImprovementRate?.toFixed(0) || '?'}%</p>
                          <p className="text-xs text-muted-foreground">Vervolgkopen goedkoper</p>
                        </div>
                        <div className="text-center">
                          <p className="text-2xl font-mono font-bold">{dcaAnalysis?.avgShareSize?.toFixed(1) || '?'}</p>
                          <p className="text-xs text-muted-foreground">Gem. shares per trade</p>
                        </div>
                        <div className="text-center">
                          <p className="text-2xl font-mono font-bold">{dcaAnalysis?.totalBuys || '?'}</p>
                          <p className="text-xs text-muted-foreground">Totaal buy trades</p>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground mt-3">
                        Dit betekent dat in {dcaAnalysis?.priceImprovementRate?.toFixed(0) || '?'}% van de gevallen waar de bot 
                        een tweede (of latere) aankoop deed, die aankoop goedkoper was dan de eerste entry. 
                        Dit valideert de DCA approach.
                      </p>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* Section 4: Risk Management */}
                <AccordionItem value="risk" className="border border-border rounded-lg px-4 bg-card/50">
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-warning/20 flex items-center justify-center">
                        <Scale className="w-4 h-4 text-warning" />
                      </div>
                      <div className="text-left">
                        <p className="font-semibold text-sm">Risk Management & Exposure</p>
                        <p className="text-xs text-muted-foreground font-normal">Hoe de bot risico beheert en exposure limiteert</p>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    <div className="p-4 rounded-lg bg-muted/50 border border-border">
                      <h4 className="font-semibold text-sm mb-3">Hedged vs Exposed Capital</h4>
                      <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                        Niet alle posities zijn volledig gehedged. Sommige markten hebben een onbalans tussen 
                        Up en Down shares. Dit exposed capital heeft directional risk - als de verkeerde kant wint, 
                        verlies je dat bedrag.
                      </p>
                      
                      {exposureAnalysis && (
                        <div className="grid grid-cols-2 gap-4">
                          <div className="p-3 bg-success/10 rounded border border-success/20 text-center">
                            <Shield className="w-6 h-6 text-success mx-auto mb-2" />
                            <p className="text-xl font-mono font-bold text-success">${exposureAnalysis.totalHedgedCapital.toFixed(0)}</p>
                            <p className="text-xs text-muted-foreground">Hedged Capital</p>
                            <p className="text-xs text-success">{(100 - exposureAnalysis.exposurePercent).toFixed(1)}% beschermd</p>
                          </div>
                          <div className="p-3 bg-warning/10 rounded border border-warning/20 text-center">
                            <ShieldAlert className="w-6 h-6 text-warning mx-auto mb-2" />
                            <p className="text-xl font-mono font-bold text-warning">${exposureAnalysis.totalExposedCapital.toFixed(0)}</p>
                            <p className="text-xs text-muted-foreground">Exposed Capital</p>
                            <p className="text-xs text-warning">{exposureAnalysis.exposurePercent.toFixed(1)}% at risk</p>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="p-4 rounded-lg bg-background/50 border border-border">
                      <h4 className="font-semibold text-sm mb-3">Risk Categorieën</h4>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between p-2 bg-success/10 rounded">
                          <div className="flex items-center gap-2">
                            <CheckCircle2 className="w-4 h-4 text-success" />
                            <span className="text-sm">Arbitrage Trades ({"<"}98¢)</span>
                          </div>
                          <span className="font-mono text-sm text-success">{analysis?.arbitrageCount || 0} trades</span>
                        </div>
                        <p className="text-xs text-muted-foreground px-2">
                          Gegarandeerde winst van 2%+ ongeacht uitkomst. Dit is het doel van de strategie.
                        </p>
                        
                        <div className="flex items-center justify-between p-2 bg-chart-4/10 rounded mt-3">
                          <div className="flex items-center gap-2">
                            <Activity className="w-4 h-4 text-chart-4" />
                            <span className="text-sm">Neutral Trades (98-102¢)</span>
                          </div>
                          <span className="font-mono text-sm text-chart-4">{analysis?.neutralCount || 0} trades</span>
                        </div>
                        <p className="text-xs text-muted-foreground px-2">
                          Breakeven of kleine winst/verlies. Acceptabel als opstap naar betere prijzen.
                        </p>
                        
                        <div className="flex items-center justify-between p-2 bg-destructive/10 rounded mt-3">
                          <div className="flex items-center gap-2">
                            <XCircle className="w-4 h-4 text-destructive" />
                            <span className="text-sm">Risk Trades ({">"}102¢)</span>
                          </div>
                          <span className="font-mono text-sm text-destructive">{analysis?.riskCount || 0} trades</span>
                        </div>
                        <p className="text-xs text-muted-foreground px-2">
                          Gegarandeerd verlies als beide kanten tot expiry worden gehouden. Kan wijzen op 
                          directional bets of timing issues.
                        </p>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* Section 5: Developer Implementation Guide */}
                <AccordionItem value="implementation" className="border border-border rounded-lg px-4 bg-card/50">
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-destructive/20 flex items-center justify-center">
                        <Code2 className="w-4 h-4 text-destructive" />
                      </div>
                      <div className="text-left">
                        <p className="font-semibold text-sm">Developer Implementation Guide</p>
                        <p className="text-xs text-muted-foreground font-normal">Technische details voor het bouwen van vergelijkbare bots</p>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    <div className="p-4 rounded-lg bg-muted/50 border border-border">
                      <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-warning" />
                        Kritieke Implementatie Overwegingen
                      </h4>
                      <div className="space-y-3">
                        <div className="p-3 bg-background/50 rounded border-l-4 border-primary">
                          <h5 className="font-medium text-sm text-primary">1. Latency is Cruciaal</h5>
                          <p className="text-xs text-muted-foreground mt-1">
                            De gemiddelde hedge delay is {analysis?.avgDelay?.toFixed(0) || '?'} seconden. Trades met {"<"}5s delay 
                            hebben significant betere edges. Investeer in snelle API connections en co-location indien mogelijk.
                          </p>
                        </div>
                        
                        <div className="p-3 bg-background/50 rounded border-l-4 border-chart-4">
                          <h5 className="font-medium text-sm text-chart-4">2. Order Book Monitoring</h5>
                          <p className="text-xs text-muted-foreground mt-1">
                            Real-time orderbook data is essentieel. Gebruik WebSocket connections in plaats van REST polling. 
                            Track niet alleen de beste prijzen maar ook de diepte om je order sizing te bepalen.
                          </p>
                        </div>
                        
                        <div className="p-3 bg-background/50 rounded border-l-4 border-success">
                          <h5 className="font-medium text-sm text-success">3. Position Tracking</h5>
                          <p className="text-xs text-muted-foreground mt-1">
                            Houd per markt bij: totale shares per kant, gemiddelde entry prijs, en de unrealized P&L. 
                            Dit bepaalt je hedge sizing en urgentie.
                          </p>
                        </div>
                        
                        <div className="p-3 bg-background/50 rounded border-l-4 border-warning">
                          <h5 className="font-medium text-sm text-warning">4. Error Handling</h5>
                          <p className="text-xs text-muted-foreground mt-1">
                            API failures, partial fills, en rejected orders komen voor. Bouw robuuste retry logic 
                            en zorg dat je nooit in een inconsistente state terechtkomt.
                          </p>
                        </div>
                        
                        <div className="p-3 bg-background/50 rounded border-l-4 border-destructive">
                          <h5 className="font-medium text-sm text-destructive">5. Risk Limits</h5>
                          <p className="text-xs text-muted-foreground mt-1">
                            Implementeer harde limieten: max exposed capital per markt, max totale exposure, 
                            en circuit breakers bij onverwacht gedrag.
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="p-4 rounded-lg bg-primary/10 border border-primary/20">
                      <h4 className="font-semibold text-sm mb-2 flex items-center gap-2 text-primary">
                        <Code2 className="w-4 h-4" />
                        Aanbevolen Tech Stack
                      </h4>
                      <div className="grid grid-cols-2 gap-3 mt-3 text-xs">
                        <div>
                          <p className="font-medium">Language</p>
                          <p className="text-muted-foreground">Python (snelle prototyping) of Rust (productie latency)</p>
                        </div>
                        <div>
                          <p className="font-medium">Data Store</p>
                          <p className="text-muted-foreground">Redis voor real-time state, PostgreSQL voor history</p>
                        </div>
                        <div>
                          <p className="font-medium">Messaging</p>
                          <p className="text-muted-foreground">WebSockets voor orderbook, async queues voor orders</p>
                        </div>
                        <div>
                          <p className="font-medium">Monitoring</p>
                          <p className="text-muted-foreground">Prometheus + Grafana voor real-time metrics</p>
                        </div>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* Section 6: Deep Strategy Analysis per Category */}
                <AccordionItem value="deep-analysis" className="border border-primary/50 rounded-lg px-4 bg-gradient-to-r from-primary/5 to-transparent">
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/30 flex items-center justify-center">
                        <PieChartIcon className="w-4 h-4 text-primary" />
                      </div>
                      <div className="text-left">
                        <p className="font-semibold text-sm">🔬 Diepte-Analyse per Strategie Type</p>
                        <p className="text-xs text-muted-foreground font-normal">Wat zijn de overwegingen achter Arbitrage, Neutral en Directional trades?</p>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-6 pt-4">
                    {/* Strategy 1: Arbitrage Deep Dive */}
                    {analysis?.strategyAnalysis?.arbitrage && (
                      <div className="p-5 rounded-xl bg-gradient-to-br from-success/10 via-success/5 to-transparent border-2 border-success/30">
                        <div className="flex items-center justify-between mb-4">
                          <h4 className="font-bold text-base flex items-center gap-2 text-success">
                            <CheckCircle2 className="w-5 h-5" />
                            Strategie 1: Arbitrage Trades
                          </h4>
                          <Badge variant="outline" className="border-success text-success">
                            {analysis.strategyAnalysis.arbitrage.pairs.length} trades ({Math.round((analysis.strategyAnalysis.arbitrage.pairs.length / analysis.totalPairs) * 100)}%)
                          </Badge>
                        </div>
                        
                        <p className="text-sm text-muted-foreground mb-4">
                          Combined price {"<"} $0.98 = gegarandeerde {">"}2% winst ongeacht welke kant wint.
                        </p>

                        {/* Key Metrics Grid */}
                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                          <div className="p-3 bg-background/50 rounded-lg text-center border border-border">
                            <p className="text-xl font-mono font-bold text-success">{(analysis.strategyAnalysis.arbitrage.avgCombinedPrice * 100).toFixed(1)}¢</p>
                            <p className="text-xs text-muted-foreground">Gem. Combined</p>
                          </div>
                          <div className="p-3 bg-background/50 rounded-lg text-center border border-border">
                            <p className="text-xl font-mono font-bold text-success">+{analysis.strategyAnalysis.arbitrage.avgEdge.toFixed(1)}%</p>
                            <p className="text-xs text-muted-foreground">Gem. Edge</p>
                          </div>
                          <div className="p-3 bg-background/50 rounded-lg text-center border border-border">
                            <p className="text-xl font-mono font-bold">{analysis.strategyAnalysis.arbitrage.avgDelay.toFixed(0)}s</p>
                            <p className="text-xs text-muted-foreground">Gem. Hedge Delay</p>
                          </div>
                          <div className="p-3 bg-background/50 rounded-lg text-center border border-border">
                            <p className="text-xl font-mono font-bold">${analysis.strategyAnalysis.arbitrage.avgTotalInvested.toFixed(2)}</p>
                            <p className="text-xs text-muted-foreground">Gem. Investering</p>
                          </div>
                        </div>

                        {/* Entry Pattern Analysis */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
                          <div className="p-4 bg-background/30 rounded-lg border border-border">
                            <h5 className="font-semibold text-sm mb-3 flex items-center gap-2">
                              <Target className="w-4 h-4 text-success" />
                              Entry Patroon
                            </h5>
                            <div className="space-y-2 text-sm">
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">First entry prijs:</span>
                                <span className="font-mono">{(analysis.strategyAnalysis.arbitrage.avgFirstEntryPrice * 100).toFixed(1)}¢</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Second entry prijs:</span>
                                <span className="font-mono">{(analysis.strategyAnalysis.arbitrage.avgSecondEntryPrice * 100).toFixed(1)}¢</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Price spread:</span>
                                <span className="font-mono">{(analysis.strategyAnalysis.arbitrage.priceSpread * 100).toFixed(1)}¢</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Gem. share size:</span>
                                <span className="font-mono">{analysis.strategyAnalysis.arbitrage.avgShareSize.toFixed(1)} shares</span>
                              </div>
                            </div>
                          </div>

                          <div className="p-4 bg-background/30 rounded-lg border border-border">
                            <h5 className="font-semibold text-sm mb-3 flex items-center gap-2">
                              <BarChart3 className="w-4 h-4 text-success" />
                              Asset & Side Verdeling
                            </h5>
                            <div className="space-y-2 text-sm">
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Up eerst gekocht:</span>
                                <span className="font-mono">{analysis.strategyAnalysis.arbitrage.upFirstPercent.toFixed(0)}%</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Down eerst gekocht:</span>
                                <span className="font-mono">{(100 - analysis.strategyAnalysis.arbitrage.upFirstPercent).toFixed(0)}%</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Bitcoin (BTC):</span>
                                <span className="font-mono text-chart-4">{analysis.strategyAnalysis.arbitrage.btcPercent.toFixed(0)}%</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Ethereum (ETH):</span>
                                <span className="font-mono text-primary">{analysis.strategyAnalysis.arbitrage.ethPercent.toFixed(0)}%</span>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Hypotheses & Insights */}
                        <div className="space-y-3">
                          {analysis.strategyAnalysis.arbitrage.successIndicators.length > 0 && (
                            <div className="p-3 bg-success/10 rounded-lg border border-success/20">
                              <p className="text-xs font-semibold text-success mb-2">✅ Waarom dit werkt:</p>
                              <ul className="space-y-1">
                                {analysis.strategyAnalysis.arbitrage.successIndicators.map((indicator, i) => (
                                  <li key={i} className="text-xs text-muted-foreground">• {indicator}</li>
                                ))}
                              </ul>
                            </div>
                          )}

                          <div className="p-3 bg-primary/10 rounded-lg border border-primary/20">
                            <p className="text-xs font-semibold text-primary mb-2">🧠 Mogelijke Overwegingen/Hypotheses:</p>
                            <ul className="space-y-1">
                              {analysis.strategyAnalysis.arbitrage.hypotheses.map((hypothesis, i) => (
                                <li key={i} className="text-xs text-muted-foreground">• {hypothesis}</li>
                              ))}
                            </ul>
                          </div>

                          {analysis.strategyAnalysis.arbitrage.riskFactors.length > 0 && (
                            <div className="p-3 bg-warning/10 rounded-lg border border-warning/20">
                              <p className="text-xs font-semibold text-warning mb-2">⚠️ Aandachtspunten:</p>
                              <ul className="space-y-1">
                                {analysis.strategyAnalysis.arbitrage.riskFactors.map((risk, i) => (
                                  <li key={i} className="text-xs text-muted-foreground">• {risk}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>

                        {/* Peak Hours */}
                        {analysis.strategyAnalysis.arbitrage.hourDistribution.length > 0 && (
                          <div className="mt-4 p-3 bg-background/30 rounded-lg border border-border">
                            <p className="text-xs font-semibold mb-2">⏰ Piek Trading Uren (UTC):</p>
                            <div className="flex flex-wrap gap-2">
                              {analysis.strategyAnalysis.arbitrage.hourDistribution.slice(0, 5).map((h, i) => (
                                <Badge key={i} variant="secondary" className="font-mono">
                                  {h.hour.toString().padStart(2, '0')}:00 ({h.count}x)
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Strategy 2: Neutral Deep Dive */}
                    {analysis?.strategyAnalysis?.neutral && (
                      <div className="p-5 rounded-xl bg-gradient-to-br from-chart-4/10 via-chart-4/5 to-transparent border-2 border-chart-4/30">
                        <div className="flex items-center justify-between mb-4">
                          <h4 className="font-bold text-base flex items-center gap-2 text-chart-4">
                            <Activity className="w-5 h-5" />
                            Strategie 2: Neutral Trades
                          </h4>
                          <Badge variant="outline" className="border-chart-4 text-chart-4">
                            {analysis.strategyAnalysis.neutral.pairs.length} trades ({Math.round((analysis.strategyAnalysis.neutral.pairs.length / analysis.totalPairs) * 100)}%)
                          </Badge>
                        </div>
                        
                        <p className="text-sm text-muted-foreground mb-4">
                          Combined price 98-102¢ = breakeven zone. Dient als opstap voor latere DCA naar arbitrage.
                        </p>

                        {/* Key Metrics Grid */}
                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                          <div className="p-3 bg-background/50 rounded-lg text-center border border-border">
                            <p className="text-xl font-mono font-bold text-chart-4">{(analysis.strategyAnalysis.neutral.avgCombinedPrice * 100).toFixed(1)}¢</p>
                            <p className="text-xs text-muted-foreground">Gem. Combined</p>
                          </div>
                          <div className="p-3 bg-background/50 rounded-lg text-center border border-border">
                            <p className="text-xl font-mono font-bold text-chart-4">{analysis.strategyAnalysis.neutral.avgEdge >= 0 ? '+' : ''}{analysis.strategyAnalysis.neutral.avgEdge.toFixed(1)}%</p>
                            <p className="text-xs text-muted-foreground">Gem. Edge</p>
                          </div>
                          <div className="p-3 bg-background/50 rounded-lg text-center border border-border">
                            <p className="text-xl font-mono font-bold">{analysis.strategyAnalysis.neutral.avgDelay.toFixed(0)}s</p>
                            <p className="text-xs text-muted-foreground">Gem. Hedge Delay</p>
                          </div>
                          <div className="p-3 bg-background/50 rounded-lg text-center border border-border">
                            <p className="text-xl font-mono font-bold">${analysis.strategyAnalysis.neutral.avgTotalInvested.toFixed(2)}</p>
                            <p className="text-xs text-muted-foreground">Gem. Investering</p>
                          </div>
                        </div>

                        {/* Entry Pattern Analysis */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
                          <div className="p-4 bg-background/30 rounded-lg border border-border">
                            <h5 className="font-semibold text-sm mb-3 flex items-center gap-2">
                              <Target className="w-4 h-4 text-chart-4" />
                              Entry Patroon
                            </h5>
                            <div className="space-y-2 text-sm">
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">First entry prijs:</span>
                                <span className="font-mono">{(analysis.strategyAnalysis.neutral.avgFirstEntryPrice * 100).toFixed(1)}¢</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Second entry prijs:</span>
                                <span className="font-mono">{(analysis.strategyAnalysis.neutral.avgSecondEntryPrice * 100).toFixed(1)}¢</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Price spread:</span>
                                <span className="font-mono">{(analysis.strategyAnalysis.neutral.priceSpread * 100).toFixed(1)}¢</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Gem. share size:</span>
                                <span className="font-mono">{analysis.strategyAnalysis.neutral.avgShareSize.toFixed(1)} shares</span>
                              </div>
                            </div>
                          </div>

                          <div className="p-4 bg-background/30 rounded-lg border border-border">
                            <h5 className="font-semibold text-sm mb-3 flex items-center gap-2">
                              <BarChart3 className="w-4 h-4 text-chart-4" />
                              Asset & Side Verdeling
                            </h5>
                            <div className="space-y-2 text-sm">
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Up eerst gekocht:</span>
                                <span className="font-mono">{analysis.strategyAnalysis.neutral.upFirstPercent.toFixed(0)}%</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Down eerst gekocht:</span>
                                <span className="font-mono">{(100 - analysis.strategyAnalysis.neutral.upFirstPercent).toFixed(0)}%</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Bitcoin (BTC):</span>
                                <span className="font-mono text-chart-4">{analysis.strategyAnalysis.neutral.btcPercent.toFixed(0)}%</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Ethereum (ETH):</span>
                                <span className="font-mono text-primary">{analysis.strategyAnalysis.neutral.ethPercent.toFixed(0)}%</span>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Hypotheses & Insights */}
                        <div className="space-y-3">
                          {analysis.strategyAnalysis.neutral.successIndicators.length > 0 && (
                            <div className="p-3 bg-chart-4/10 rounded-lg border border-chart-4/20">
                              <p className="text-xs font-semibold text-chart-4 mb-2">✅ Waarom dit gedaan wordt:</p>
                              <ul className="space-y-1">
                                {analysis.strategyAnalysis.neutral.successIndicators.map((indicator, i) => (
                                  <li key={i} className="text-xs text-muted-foreground">• {indicator}</li>
                                ))}
                              </ul>
                            </div>
                          )}

                          <div className="p-3 bg-primary/10 rounded-lg border border-primary/20">
                            <p className="text-xs font-semibold text-primary mb-2">🧠 Mogelijke Overwegingen/Hypotheses:</p>
                            <ul className="space-y-1">
                              {analysis.strategyAnalysis.neutral.hypotheses.map((hypothesis, i) => (
                                <li key={i} className="text-xs text-muted-foreground">• {hypothesis}</li>
                              ))}
                            </ul>
                          </div>

                          {analysis.strategyAnalysis.neutral.riskFactors.length > 0 && (
                            <div className="p-3 bg-warning/10 rounded-lg border border-warning/20">
                              <p className="text-xs font-semibold text-warning mb-2">⚠️ Aandachtspunten:</p>
                              <ul className="space-y-1">
                                {analysis.strategyAnalysis.neutral.riskFactors.map((risk, i) => (
                                  <li key={i} className="text-xs text-muted-foreground">• {risk}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>

                        {/* Peak Hours */}
                        {analysis.strategyAnalysis.neutral.hourDistribution.length > 0 && (
                          <div className="mt-4 p-3 bg-background/30 rounded-lg border border-border">
                            <p className="text-xs font-semibold mb-2">⏰ Piek Trading Uren (UTC):</p>
                            <div className="flex flex-wrap gap-2">
                              {analysis.strategyAnalysis.neutral.hourDistribution.slice(0, 5).map((h, i) => (
                                <Badge key={i} variant="secondary" className="font-mono">
                                  {h.hour.toString().padStart(2, '0')}:00 ({h.count}x)
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Strategy 3: Directional/Risk Deep Dive */}
                    {analysis?.strategyAnalysis?.risk && (
                      <div className="p-5 rounded-xl bg-gradient-to-br from-destructive/10 via-destructive/5 to-transparent border-2 border-destructive/30">
                        <div className="flex items-center justify-between mb-4">
                          <h4 className="font-bold text-base flex items-center gap-2 text-destructive">
                            <TrendingUp className="w-5 h-5" />
                            Strategie 3: Directional Bets (Risk Trades)
                          </h4>
                          <Badge variant="outline" className="border-destructive text-destructive">
                            {analysis.strategyAnalysis.risk.pairs.length} trades ({Math.round((analysis.strategyAnalysis.risk.pairs.length / analysis.totalPairs) * 100)}%)
                          </Badge>
                        </div>
                        
                        <p className="text-sm text-muted-foreground mb-4">
                          Combined price {">"} $1.02 = bewust risico nemen. De bot accepteert een gegarandeerd verlies 
                          als beide kanten worden gehouden, maar gokt op een specifieke uitkomst.
                        </p>

                        {/* Key Metrics Grid */}
                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                          <div className="p-3 bg-background/50 rounded-lg text-center border border-border">
                            <p className="text-xl font-mono font-bold text-destructive">{(analysis.strategyAnalysis.risk.avgCombinedPrice * 100).toFixed(1)}¢</p>
                            <p className="text-xs text-muted-foreground">Gem. Combined</p>
                          </div>
                          <div className="p-3 bg-background/50 rounded-lg text-center border border-border">
                            <p className="text-xl font-mono font-bold text-destructive">{analysis.strategyAnalysis.risk.avgEdge.toFixed(1)}%</p>
                            <p className="text-xs text-muted-foreground">Gem. "Loss" Rate</p>
                          </div>
                          <div className="p-3 bg-background/50 rounded-lg text-center border border-border">
                            <p className="text-xl font-mono font-bold">{analysis.strategyAnalysis.risk.avgDelay.toFixed(0)}s</p>
                            <p className="text-xs text-muted-foreground">Gem. Hedge Delay</p>
                          </div>
                          <div className="p-3 bg-background/50 rounded-lg text-center border border-border">
                            <p className="text-xl font-mono font-bold">${analysis.strategyAnalysis.risk.avgTotalInvested.toFixed(2)}</p>
                            <p className="text-xs text-muted-foreground">Gem. Investering</p>
                          </div>
                        </div>

                        {/* Entry Pattern Analysis */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
                          <div className="p-4 bg-background/30 rounded-lg border border-border">
                            <h5 className="font-semibold text-sm mb-3 flex items-center gap-2">
                              <Target className="w-4 h-4 text-destructive" />
                              Entry Patroon
                            </h5>
                            <div className="space-y-2 text-sm">
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">First entry prijs:</span>
                                <span className="font-mono">{(analysis.strategyAnalysis.risk.avgFirstEntryPrice * 100).toFixed(1)}¢</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Second entry prijs:</span>
                                <span className="font-mono">{(analysis.strategyAnalysis.risk.avgSecondEntryPrice * 100).toFixed(1)}¢</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Price spread:</span>
                                <span className="font-mono font-bold text-destructive">{(analysis.strategyAnalysis.risk.priceSpread * 100).toFixed(1)}¢</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Gem. share size:</span>
                                <span className="font-mono">{analysis.strategyAnalysis.risk.avgShareSize.toFixed(1)} shares</span>
                              </div>
                            </div>
                            <p className="text-xs text-muted-foreground mt-3 p-2 bg-destructive/10 rounded">
                              💡 Hoge price spread = sterke conviction over richting
                            </p>
                          </div>

                          <div className="p-4 bg-background/30 rounded-lg border border-border">
                            <h5 className="font-semibold text-sm mb-3 flex items-center gap-2">
                              <BarChart3 className="w-4 h-4 text-destructive" />
                              Asset & Side Verdeling
                            </h5>
                            <div className="space-y-2 text-sm">
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Up eerst gekocht:</span>
                                <span className="font-mono">{analysis.strategyAnalysis.risk.upFirstPercent.toFixed(0)}%</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Down eerst gekocht:</span>
                                <span className="font-mono">{(100 - analysis.strategyAnalysis.risk.upFirstPercent).toFixed(0)}%</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Bitcoin (BTC):</span>
                                <span className="font-mono text-chart-4">{analysis.strategyAnalysis.risk.btcPercent.toFixed(0)}%</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Ethereum (ETH):</span>
                                <span className="font-mono text-primary">{analysis.strategyAnalysis.risk.ethPercent.toFixed(0)}%</span>
                              </div>
                            </div>
                            <p className="text-xs text-muted-foreground mt-3 p-2 bg-primary/10 rounded">
                              💡 {analysis.strategyAnalysis.risk.upFirstPercent > 50 
                                ? 'Voorkeur voor Up-side = bullish sentiment'
                                : 'Voorkeur voor Down-side = bearish sentiment'}
                            </p>
                          </div>
                        </div>

                        {/* Hypotheses & Insights */}
                        <div className="space-y-3">
                          {analysis.strategyAnalysis.risk.successIndicators.length > 0 && (
                            <div className="p-3 bg-success/10 rounded-lg border border-success/20">
                              <p className="text-xs font-semibold text-success mb-2">📈 Potentiële upside:</p>
                              <ul className="space-y-1">
                                {analysis.strategyAnalysis.risk.successIndicators.map((indicator, i) => (
                                  <li key={i} className="text-xs text-muted-foreground">• {indicator}</li>
                                ))}
                              </ul>
                            </div>
                          )}

                          <div className="p-3 bg-primary/10 rounded-lg border border-primary/20">
                            <p className="text-xs font-semibold text-primary mb-2">🧠 Mogelijke Overwegingen/Hypotheses:</p>
                            <ul className="space-y-1">
                              {analysis.strategyAnalysis.risk.hypotheses.map((hypothesis, i) => (
                                <li key={i} className="text-xs text-muted-foreground">• {hypothesis}</li>
                              ))}
                            </ul>
                          </div>

                          {analysis.strategyAnalysis.risk.riskFactors.length > 0 && (
                            <div className="p-3 bg-destructive/10 rounded-lg border border-destructive/20">
                              <p className="text-xs font-semibold text-destructive mb-2">🚨 Risico's:</p>
                              <ul className="space-y-1">
                                {analysis.strategyAnalysis.risk.riskFactors.map((risk, i) => (
                                  <li key={i} className="text-xs text-muted-foreground">• {risk}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>

                        {/* Peak Hours */}
                        {analysis.strategyAnalysis.risk.hourDistribution.length > 0 && (
                          <div className="mt-4 p-3 bg-background/30 rounded-lg border border-border">
                            <p className="text-xs font-semibold mb-2">⏰ Piek Trading Uren (UTC) - Mogelijk gekoppeld aan news events:</p>
                            <div className="flex flex-wrap gap-2">
                              {analysis.strategyAnalysis.risk.hourDistribution.slice(0, 5).map((h, i) => (
                                <Badge key={i} variant="secondary" className="font-mono">
                                  {h.hour.toString().padStart(2, '0')}:00 ({h.count}x)
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Why take these risks? */}
                        <div className="mt-4 p-4 bg-warning/10 rounded-lg border border-warning/20">
                          <h5 className="font-semibold text-sm mb-2 flex items-center gap-2 text-warning">
                            <Lightbulb className="w-4 h-4" />
                            Waarom neemt de bot deze risico's?
                          </h5>
                          <p className="text-sm text-muted-foreground leading-relaxed">
                            De data suggereert dat dit <strong>geen fout is</strong>, maar een bewuste keuze. 
                            Mogelijke redenen:
                          </p>
                          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                            <li>• <strong>Information edge:</strong> Bot heeft mogelijk betere informatie/analyse over crypto prijsbewegingen</li>
                            <li>• <strong>Portfolio balancing:</strong> Risk trades compenseren mogelijk voor verloren posities elders</li>
                            <li>• <strong>Market timing:</strong> Pieken rond specifieke uren suggereren reactie op news/events</li>
                            <li>• <strong>Expected value:</strong> Als de bot {">"}50% van deze trades wint, is het netto positief</li>
                          </ul>
                        </div>
                      </div>
                    )}

                    {/* Comparison Summary */}
                    <div className="p-5 rounded-xl bg-gradient-to-br from-secondary/50 to-transparent border border-border">
                      <h4 className="font-bold text-base flex items-center gap-2 mb-4">
                        <Scale className="w-5 h-5 text-primary" />
                        Strategie Vergelijking
                      </h4>
                      
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border">
                              <th className="text-left p-2 font-medium">Metric</th>
                              <th className="text-center p-2 font-medium text-success">Arbitrage</th>
                              <th className="text-center p-2 font-medium text-chart-4">Neutral</th>
                              <th className="text-center p-2 font-medium text-destructive">Directional</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr className="border-b border-border/50">
                              <td className="p-2 text-muted-foreground">Aantal trades</td>
                              <td className="p-2 text-center font-mono">{analysis?.strategyAnalysis?.arbitrage?.pairs.length || 0}</td>
                              <td className="p-2 text-center font-mono">{analysis?.strategyAnalysis?.neutral?.pairs.length || 0}</td>
                              <td className="p-2 text-center font-mono">{analysis?.strategyAnalysis?.risk?.pairs.length || 0}</td>
                            </tr>
                            <tr className="border-b border-border/50">
                              <td className="p-2 text-muted-foreground">Gem. Combined Price</td>
                              <td className="p-2 text-center font-mono text-success">{((analysis?.strategyAnalysis?.arbitrage?.avgCombinedPrice || 0) * 100).toFixed(1)}¢</td>
                              <td className="p-2 text-center font-mono text-chart-4">{((analysis?.strategyAnalysis?.neutral?.avgCombinedPrice || 0) * 100).toFixed(1)}¢</td>
                              <td className="p-2 text-center font-mono text-destructive">{((analysis?.strategyAnalysis?.risk?.avgCombinedPrice || 0) * 100).toFixed(1)}¢</td>
                            </tr>
                            <tr className="border-b border-border/50">
                              <td className="p-2 text-muted-foreground">Gem. Hedge Delay</td>
                              <td className="p-2 text-center font-mono">{(analysis?.strategyAnalysis?.arbitrage?.avgDelay || 0).toFixed(0)}s</td>
                              <td className="p-2 text-center font-mono">{(analysis?.strategyAnalysis?.neutral?.avgDelay || 0).toFixed(0)}s</td>
                              <td className="p-2 text-center font-mono">{(analysis?.strategyAnalysis?.risk?.avgDelay || 0).toFixed(0)}s</td>
                            </tr>
                            <tr className="border-b border-border/50">
                              <td className="p-2 text-muted-foreground">Gem. Share Size</td>
                              <td className="p-2 text-center font-mono">{(analysis?.strategyAnalysis?.arbitrage?.avgShareSize || 0).toFixed(1)}</td>
                              <td className="p-2 text-center font-mono">{(analysis?.strategyAnalysis?.neutral?.avgShareSize || 0).toFixed(1)}</td>
                              <td className="p-2 text-center font-mono">{(analysis?.strategyAnalysis?.risk?.avgShareSize || 0).toFixed(1)}</td>
                            </tr>
                            <tr className="border-b border-border/50">
                              <td className="p-2 text-muted-foreground">Up First %</td>
                              <td className="p-2 text-center font-mono">{(analysis?.strategyAnalysis?.arbitrage?.upFirstPercent || 0).toFixed(0)}%</td>
                              <td className="p-2 text-center font-mono">{(analysis?.strategyAnalysis?.neutral?.upFirstPercent || 0).toFixed(0)}%</td>
                              <td className="p-2 text-center font-mono">{(analysis?.strategyAnalysis?.risk?.upFirstPercent || 0).toFixed(0)}%</td>
                            </tr>
                            <tr>
                              <td className="p-2 text-muted-foreground">BTC vs ETH</td>
                              <td className="p-2 text-center font-mono text-xs">
                                <span className="text-chart-4">{(analysis?.strategyAnalysis?.arbitrage?.btcPercent || 0).toFixed(0)}%</span>
                                {' / '}
                                <span className="text-primary">{(analysis?.strategyAnalysis?.arbitrage?.ethPercent || 0).toFixed(0)}%</span>
                              </td>
                              <td className="p-2 text-center font-mono text-xs">
                                <span className="text-chart-4">{(analysis?.strategyAnalysis?.neutral?.btcPercent || 0).toFixed(0)}%</span>
                                {' / '}
                                <span className="text-primary">{(analysis?.strategyAnalysis?.neutral?.ethPercent || 0).toFixed(0)}%</span>
                              </td>
                              <td className="p-2 text-center font-mono text-xs">
                                <span className="text-chart-4">{(analysis?.strategyAnalysis?.risk?.btcPercent || 0).toFixed(0)}%</span>
                                {' / '}
                                <span className="text-primary">{(analysis?.strategyAnalysis?.risk?.ethPercent || 0).toFixed(0)}%</span>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

              </Accordion>
            </CardContent>
          </Card>
        </section>

        {/* DCA & Sizing Analysis */}
        {dcaAnalysis && (
          <section className="space-y-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Layers className="w-5 h-5 text-primary" />
              DCA & Sizing Analysis
            </h2>

            <div className="grid lg:grid-cols-2 gap-4">
              {/* Price Bucket Distribution */}
              <Card className="glass">
                <CardHeader>
                  <CardTitle className="text-sm">Entry Price Distribution</CardTitle>
                  <CardDescription>Buy volume by price range</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[250px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dcaAnalysis.priceBuckets}>
                        <XAxis dataKey="label" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
                        <YAxis tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                        <Tooltip 
                          contentStyle={{ 
                            backgroundColor: 'hsl(var(--card))', 
                            border: '1px solid hsl(var(--border))',
                            borderRadius: '8px'
                          }}
                          formatter={(value: number, name: string) => {
                            if (name === 'count') return [`${value} trades`, 'Trades'];
                            if (name === 'totalValue') return [`$${value.toFixed(2)}`, 'Volume'];
                            return [value, name];
                          }}
                        />
                        <Legend />
                        <Bar dataKey="count" fill="hsl(var(--primary))" name="Trades" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-4 p-3 rounded-lg bg-secondary/50">
                    <p className="text-xs text-muted-foreground">
                      <strong>Pattern:</strong> {dcaAnalysis.priceBuckets[0].count + dcaAnalysis.priceBuckets[1].count > dcaAnalysis.priceBuckets[4].count + dcaAnalysis.priceBuckets[5].count
                        ? 'More aggressive buying at lower prices (<35¢)'
                        : 'Conservative approach with buys spread across price ranges'
                      }
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* Share Size Distribution */}
              <Card className="glass">
                <CardHeader>
                  <CardTitle className="text-sm">Position Sizing Strategy</CardTitle>
                  <CardDescription>Share size per trade</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[250px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dcaAnalysis.sizeBuckets} layout="vertical">
                        <XAxis type="number" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                        <YAxis type="category" dataKey="label" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} width={50} />
                        <Tooltip 
                          contentStyle={{ 
                            backgroundColor: 'hsl(var(--card))', 
                            border: '1px solid hsl(var(--border))',
                            borderRadius: '8px'
                          }}
                          formatter={(value: number) => [`${value} trades`, 'Count']}
                        />
                        <Bar dataKey="count" fill="hsl(var(--chart-4))" name="Trades" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-4 text-center">
                    <div className="p-3 rounded-lg bg-secondary/50">
                      <p className="text-xs text-muted-foreground">Avg Size</p>
                      <p className="text-lg font-mono font-bold">{dcaAnalysis.avgShareSize.toFixed(1)}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-secondary/50">
                      <p className="text-xs text-muted-foreground">Total Buys</p>
                      <p className="text-lg font-mono font-bold">{dcaAnalysis.totalBuys.toLocaleString()}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* DCA Performance */}
            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-sm">DCA Price Improvement</CardTitle>
                <CardDescription>How often does averaging down result in better entry prices?</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-6">
                  <div className="relative w-32 h-32">
                    <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                      <circle
                        cx="50"
                        cy="50"
                        r="40"
                        fill="none"
                        stroke="hsl(var(--secondary))"
                        strokeWidth="12"
                      />
                      <circle
                        cx="50"
                        cy="50"
                        r="40"
                        fill="none"
                        stroke="hsl(var(--success))"
                        strokeWidth="12"
                        strokeDasharray={`${dcaAnalysis.priceImprovementRate * 2.51} 251`}
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-2xl font-mono font-bold">{dcaAnalysis.priceImprovementRate.toFixed(0)}%</span>
                    </div>
                  </div>
                  <div className="flex-1 space-y-4">
                    <div>
                      <p className="text-sm font-medium">Price Improvement Rate</p>
                      <p className="text-xs text-muted-foreground">
                        {dcaAnalysis.priceImprovementRate.toFixed(0)}% of subsequent DCA buys are at a better price than the initial entry
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="p-3 rounded-lg bg-success/10 border border-success/20">
                        <p className="text-xs text-muted-foreground">Avg Entry</p>
                        <p className="text-lg font-mono font-bold text-success">{(dcaAnalysis.avgBuyPrice * 100).toFixed(1)}¢</p>
                      </div>
                      <div className="p-3 rounded-lg bg-chart-4/10 border border-chart-4/20">
                        <p className="text-xs text-muted-foreground">Entry Target</p>
                        <p className="text-lg font-mono font-bold text-chart-4">&lt; 50¢</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Sizing Rules */}
                <div className="mt-6 p-4 rounded-lg bg-secondary/30 border border-border/50">
                  <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                    <Coins className="w-4 h-4 text-primary" />
                    Inferred Sizing Rules
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                    <div className="flex items-center gap-2 p-2 rounded bg-success/10">
                      <div className="w-2 h-2 rounded-full bg-success" />
                      <span>&lt; 35¢: Max batch (~{dcaAnalysis.priceBuckets[0].avgSize.toFixed(0)}-{dcaAnalysis.priceBuckets[1].avgSize.toFixed(0)} shares)</span>
                    </div>
                    <div className="flex items-center gap-2 p-2 rounded bg-chart-4/10">
                      <div className="w-2 h-2 rounded-full bg-chart-4" />
                      <span>35-50¢: Medium (~{dcaAnalysis.priceBuckets[2].avgSize.toFixed(0)}-{dcaAnalysis.priceBuckets[3].avgSize.toFixed(0)} shares)</span>
                    </div>
                    <div className="flex items-center gap-2 p-2 rounded bg-warning/10">
                      <div className="w-2 h-2 rounded-full bg-warning" />
                      <span>&gt; 50¢: Small (~{dcaAnalysis.priceBuckets[4].avgSize.toFixed(0)}-{dcaAnalysis.priceBuckets[5].avgSize.toFixed(0)} shares)</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </section>
        )}

        {/* Timing Analysis */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Timer className="w-5 h-5 text-primary" />
            Timing Analysis
          </h2>

          <div className="grid lg:grid-cols-2 gap-4">
            {/* Delay Distribution */}
            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-sm">Hedge Delay Distribution</CardTitle>
                <CardDescription>Time between buying both sides</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[250px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analysis.delayBuckets}>
                      <XAxis dataKey="label" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                      <YAxis tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--card))', 
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px'
                        }}
                        formatter={(value: number, name: string) => [
                          name === 'count' ? `${value} trades` : `${value.toFixed(2)}%`,
                          name === 'count' ? 'Count' : 'Avg Edge'
                        ]}
                      />
                      <Legend />
                      <Bar dataKey="count" fill="hsl(var(--primary))" name="Count" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Edge vs Delay Scatter */}
            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-sm">Edge vs Delay Correlation</CardTitle>
                <CardDescription>Does waiting longer improve edge?</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[250px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart>
                      <XAxis 
                        dataKey="delay" 
                        name="Delay (s)" 
                        tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                        label={{ value: 'Delay (seconds)', position: 'bottom', fill: 'hsl(var(--muted-foreground))' }}
                      />
                      <YAxis 
                        dataKey="edge" 
                        name="Edge %" 
                        tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                        label={{ value: 'Edge %', angle: -90, position: 'insideLeft', fill: 'hsl(var(--muted-foreground))' }}
                      />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--card))', 
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px'
                        }}
                        formatter={(value: number) => value.toFixed(2)}
                      />
                      <Scatter 
                        data={analysis.scatterData} 
                        fill="hsl(var(--primary))"
                        opacity={0.6}
                      />
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Delay Bucket Edge */}
            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-sm">Average Edge by Delay Bucket</CardTitle>
                <CardDescription>Which delay range yields best results?</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[250px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analysis.delayBuckets}>
                      <XAxis dataKey="label" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                      <YAxis tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--card))', 
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px'
                        }}
                        formatter={(value: number) => [`${value.toFixed(2)}%`, 'Avg Edge']}
                      />
                      <Bar dataKey="avgEdge" fill="hsl(var(--success))" name="Avg Edge %" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Hourly Performance */}
            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-sm">Performance by Hour (UTC)</CardTitle>
                <CardDescription>When does the bot perform best?</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[250px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={analysis.hourlyStats}>
                      <XAxis dataKey="hour" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} />
                      <YAxis tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--card))', 
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px'
                        }}
                      />
                      <Legend />
                      <Area type="monotone" dataKey="avgEdge" stroke="hsl(var(--success))" fill="hsl(var(--success))" fillOpacity={0.3} name="Avg Edge %" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Entry Strategy Analysis */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            Entry Strategy Analysis
          </h2>

          <div className="grid lg:grid-cols-2 gap-4">
            {/* First Side Bought */}
            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-sm">Which Side is Bought First?</CardTitle>
                <CardDescription>Entry order pattern</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={entryPatternData} layout="vertical">
                      <XAxis type="number" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                      <YAxis type="category" dataKey="side" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} width={80} />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--card))', 
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px'
                        }}
                      />
                      <Bar dataKey="count" fill="hsl(var(--chart-4))" name="Count" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-4 text-center">
                  <div className="p-3 rounded-lg bg-secondary/50">
                    <p className="text-xs text-muted-foreground">Up First Avg Price</p>
                    <p className="text-lg font-mono font-bold">{(analysis.avgUpFirstPrice * 100).toFixed(1)}¢</p>
                  </div>
                  <div className="p-3 rounded-lg bg-secondary/50">
                    <p className="text-xs text-muted-foreground">Down First Avg Price</p>
                    <p className="text-lg font-mono font-bold">{(analysis.avgDownFirstPrice * 100).toFixed(1)}¢</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Entry Decision Logic */}
            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-sm">Entry Decision Criteria</CardTitle>
                <CardDescription>Inferred from trading patterns</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-start gap-3 p-3 rounded-lg bg-secondary/50">
                  <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-mono text-primary">1</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium">Buy the Cheaper Side First</p>
                    <p className="text-xs text-muted-foreground">
                      {analysis.downFirst > analysis.upFirst ? 'Down' : 'Up'} is bought first {Math.max(analysis.downFirst, analysis.upFirst)} times 
                      ({((Math.max(analysis.downFirst, analysis.upFirst) / analysis.totalPairs) * 100).toFixed(0)}%)
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg bg-secondary/50">
                  <div className="w-6 h-6 rounded-full bg-success/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-mono text-success">2</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium">Target Entry Price &lt; 50¢</p>
                    <p className="text-xs text-muted-foreground">
                      Average first entry: {(Math.min(analysis.avgUpFirstPrice, analysis.avgDownFirstPrice) * 100).toFixed(1)}¢
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg bg-secondary/50">
                  <div className="w-6 h-6 rounded-full bg-chart-4/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-mono text-chart-4">3</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium">Hedge Within 30 Seconds</p>
                    <p className="text-xs text-muted-foreground">
                      {((analysis.delayBuckets[0].count + analysis.delayBuckets[1].count) / analysis.totalPairs * 100).toFixed(0)}% 
                      of hedges complete within 30s
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg bg-secondary/50">
                  <div className="w-6 h-6 rounded-full bg-warning/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-mono text-warning">4</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium">Accept Risk If Edge Not Available</p>
                    <p className="text-xs text-muted-foreground">
                      {((analysis.riskCount / analysis.totalPairs) * 100).toFixed(0)}% of trades are risk-exposed (combined &gt; 1.02)
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Asset Comparison */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Coins className="w-5 h-5 text-primary" />
            Asset Comparison
          </h2>

          <Card className="glass">
            <CardContent className="pt-6">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left p-3 font-medium text-muted-foreground">Asset</th>
                      <th className="text-right p-3 font-medium text-muted-foreground">Trades</th>
                      <th className="text-right p-3 font-medium text-muted-foreground">Avg Delay</th>
                      <th className="text-right p-3 font-medium text-muted-foreground">Avg Edge</th>
                      <th className="text-right p-3 font-medium text-muted-foreground">Arbitrage Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assetComparisonData.map((row) => (
                      <tr key={row.asset} className="border-b border-border/50 hover:bg-secondary/30">
                        <td className="p-3 font-mono">{row.asset}</td>
                        <td className="p-3 text-right font-mono">{row.trades}</td>
                        <td className="p-3 text-right font-mono">{row.avgDelay.toFixed(1)}s</td>
                        <td className={`p-3 text-right font-mono ${row.avgEdge > 0 ? 'text-success' : 'text-destructive'}`}>
                          {row.avgEdge.toFixed(2)}%
                        </td>
                        <td className="p-3 text-right font-mono text-success">{row.arbitrageRate.toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 p-3 rounded-lg bg-secondary/50">
                <p className="text-xs text-muted-foreground">
                  <strong>Insight:</strong> {analysis.ethStats.avgEdge > analysis.btcStats.avgEdge 
                    ? `Ethereum markets show better average edge (${analysis.ethStats.avgEdge.toFixed(2)}% vs ${analysis.btcStats.avgEdge.toFixed(2)}%) despite longer delays, suggesting more pricing inefficiencies.`
                    : `Bitcoin markets show better average edge (${analysis.btcStats.avgEdge.toFixed(2)}% vs ${analysis.ethStats.avgEdge.toFixed(2)}%) with faster execution.`
                  }
                </p>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Risk Analysis */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-warning" />
            Risk Analysis
          </h2>

          <Card className="glass">
            <CardHeader>
              <CardTitle className="text-sm">Risk-Exposed Trades (Combined &gt; 1.02)</CardTitle>
              <CardDescription>Trades where hedging resulted in net exposure</CardDescription>
            </CardHeader>
            <CardContent>
              {analysis.riskTrades.length > 0 ? (
                <div className="overflow-x-auto max-h-[300px]">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-card">
                      <tr className="border-b border-border">
                        <th className="text-left p-2 font-medium text-muted-foreground">Market</th>
                        <th className="text-right p-2 font-medium text-muted-foreground">Combined</th>
                        <th className="text-right p-2 font-medium text-muted-foreground">Exposure</th>
                        <th className="text-right p-2 font-medium text-muted-foreground">Delay</th>
                        <th className="text-right p-2 font-medium text-muted-foreground">Hour</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.riskTrades.slice(0, 10).map((trade, i) => (
                        <tr key={i} className="border-b border-border/50 hover:bg-secondary/30">
                          <td className="p-2 font-mono truncate max-w-[200px]">{trade.market}</td>
                          <td className="p-2 text-right font-mono text-destructive">
                            {(trade.combinedPrice * 100).toFixed(1)}¢
                          </td>
                          <td className="p-2 text-right font-mono text-destructive">
                            {((trade.combinedPrice - 1) * 100).toFixed(2)}%
                          </td>
                          <td className="p-2 text-right font-mono">{trade.delaySeconds.toFixed(0)}s</td>
                          <td className="p-2 text-right font-mono">{trade.hourOfDay}:00</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-muted-foreground text-center py-4">No risk-exposed trades found</p>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Best Opportunities */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Zap className="w-5 h-5 text-success" />
            Best Arbitrage Opportunities
          </h2>

          <Card className="glass">
            <CardHeader>
              <CardTitle className="text-sm">Top 15 Best Edges Captured</CardTitle>
              <CardDescription>Highest profit opportunities successfully hedged</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto max-h-[400px]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b border-border">
                      <th className="text-left p-2 font-medium text-muted-foreground">Market</th>
                      <th className="text-right p-2 font-medium text-muted-foreground">Combined</th>
                      <th className="text-right p-2 font-medium text-muted-foreground">Edge</th>
                      <th className="text-right p-2 font-medium text-muted-foreground">Delay</th>
                      <th className="text-right p-2 font-medium text-muted-foreground">Side 1</th>
                      <th className="text-right p-2 font-medium text-muted-foreground">Side 2</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.bestOpportunities.map((opp, i) => (
                      <tr key={i} className="border-b border-border/50 hover:bg-secondary/30">
                        <td className="p-2 font-mono truncate max-w-[200px]">{opp.market}</td>
                        <td className="p-2 text-right font-mono text-success">
                          {(opp.combinedPrice * 100).toFixed(1)}¢
                        </td>
                        <td className="p-2 text-right font-mono text-success font-bold">
                          +{opp.edge.toFixed(2)}%
                        </td>
                        <td className="p-2 text-right font-mono">{opp.delaySeconds.toFixed(0)}s</td>
                        <td className="p-2 text-right font-mono">
                          <Badge variant="outline" className="text-[10px]">
                            {opp.trade1.outcome} @ {(opp.trade1.price * 100).toFixed(0)}¢
                          </Badge>
                        </td>
                        <td className="p-2 text-right font-mono">
                          <Badge variant="outline" className="text-[10px]">
                            {opp.trade2.outcome} @ {(opp.trade2.price * 100).toFixed(0)}¢
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Decision Flow Diagram */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-primary" />
            Inferred Decision Flow
          </h2>

          <Card className="glass">
            <CardContent className="pt-6">
              <div className="space-y-4">
                <div className="flex items-center gap-4 p-4 rounded-lg bg-gradient-to-r from-primary/10 to-transparent border-l-4 border-primary">
                  <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                    <span className="text-lg font-bold text-primary">1</span>
                  </div>
                  <div>
                    <p className="font-medium">Scan Markets</p>
                    <p className="text-sm text-muted-foreground">Monitor binary markets for pricing inefficiencies</p>
                  </div>
                </div>

                <div className="flex items-center gap-4 p-4 rounded-lg bg-gradient-to-r from-chart-4/10 to-transparent border-l-4 border-chart-4">
                  <div className="w-10 h-10 rounded-full bg-chart-4/20 flex items-center justify-center">
                    <span className="text-lg font-bold text-chart-4">2</span>
                  </div>
                  <div>
                    <p className="font-medium">Entry: Buy Cheaper Side First (&lt;50¢)</p>
                    <p className="text-sm text-muted-foreground">
                      Preference for {analysis.downFirst > analysis.upFirst ? 'Down' : 'Up'} side 
                      (avg entry: {(Math.min(analysis.avgUpFirstPrice, analysis.avgDownFirstPrice) * 100).toFixed(1)}¢)
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-4 p-4 rounded-lg bg-gradient-to-r from-success/10 to-transparent border-l-4 border-success">
                  <div className="w-10 h-10 rounded-full bg-success/20 flex items-center justify-center">
                    <span className="text-lg font-bold text-success">3</span>
                  </div>
                  <div>
                    <p className="font-medium">Hedge: Target Combined &lt; 0.98</p>
                    <p className="text-sm text-muted-foreground">
                      {((analysis.arbitrageCount / analysis.totalPairs) * 100).toFixed(0)}% success rate achieving arbitrage edge
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-4 p-4 rounded-lg bg-gradient-to-r from-warning/10 to-transparent border-l-4 border-warning">
                  <div className="w-10 h-10 rounded-full bg-warning/20 flex items-center justify-center">
                    <span className="text-lg font-bold text-warning">4</span>
                  </div>
                  <div>
                    <p className="font-medium">Timing: Complete within 30 seconds</p>
                    <p className="text-sm text-muted-foreground">
                      {((analysis.delayBuckets[0].count + analysis.delayBuckets[1].count) / analysis.totalPairs * 100).toFixed(0)}% 
                      of trades hedged within 30s, avg delay {analysis.avgDelay.toFixed(0)}s
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-4 p-4 rounded-lg bg-gradient-to-r from-destructive/10 to-transparent border-l-4 border-destructive">
                  <div className="w-10 h-10 rounded-full bg-destructive/20 flex items-center justify-center">
                    <span className="text-lg font-bold text-destructive">5</span>
                  </div>
                  <div>
                    <p className="font-medium">Risk Tolerance: Accept up to ~5% exposure</p>
                    <p className="text-sm text-muted-foreground">
                      {analysis.riskCount} trades ({((analysis.riskCount / analysis.totalPairs) * 100).toFixed(0)}%) 
                      ended with combined &gt; 1.02 when hedge wasn't available at target price
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Real-Time Signals Section */}
        <RealTimeSignals />

        {/* Gabagool Correlation Analysis */}
        <GabagoolCorrelationAnalysis trades={trades} />
      </main>
    </div>
  );
};

export default StrategyDeepDive;
