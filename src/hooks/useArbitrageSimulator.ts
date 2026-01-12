import { useState, useEffect, useCallback, useRef } from 'react';
import { usePriceLatencyComparison, Asset } from './usePriceLatencyComparison';
import { usePolymarketPrices } from './usePolymarketPrices';
import { supabase } from '@/integrations/supabase/client';

export interface ArbitrageSignal {
  id: string;
  timestamp: number;
  asset: Asset;
  direction: 'UP' | 'DOWN';
  binancePrice: number;
  binanceDelta: number;
  sharePrice: number;
  chainlinkPrice: number;
  status: 'pending' | 'filled' | 'sold' | 'expired' | 'failed';
  entryPrice?: number;
  exitPrice?: number;
  pnl?: number;
  fillTime?: number;
  sellTime?: number;
  notes?: string;
  // New fields for fees and order type
  orderType?: 'maker' | 'taker';
  entryFee?: number;
  exitFee?: number;
  totalFees?: number;
  grossPnl?: number;
  netPnl?: number;
  // Market context
  marketSlug?: string;
  strikePrice?: number;
  // Take-profit limit order
  takeProfitPrice?: number;
  takeProfitStatus?: 'pending' | 'filled' | 'cancelled';
  // Stop-loss order
  stopLossPrice?: number;
  stopLossStatus?: 'pending' | 'filled' | 'cancelled';
  exitType?: 'tp' | 'sl' | 'timeout'; // How the trade exited
}

export interface SimulatorConfig {
  enabled: boolean;
  minDeltaUsd: number;        // Minimum Binance delta to trigger
  minSharePrice: number;      // 0.35
  maxSharePrice: number;      // 0.65
  holdTimeMs: number;         // 15000 (15 seconds)
  maxFillTimeMs: number;      // 1000 (must fill within 1 second)
  tradeSize: number;          // $25 notional
  persistTrades: boolean;     // Save trades to database
  takeProfitCents: number;    // Take-profit offset in cents (e.g., 3 = entry + 3¢)
  takeProfitEnabled: boolean; // Enable take-profit limit orders
  stopLossCents: number;      // Stop-loss offset in cents (e.g., 3 = entry - 3¢)
  stopLossEnabled: boolean;   // Enable stop-loss orders
}

// Session ID for grouping trades
const SESSION_ID = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Helper to save trade to database
async function saveTradeToDb(signal: ArbitrageSignal, config: SimulatorConfig) {
  if (!config.persistTrades) return;
  
  try {
    // Use insert for new trades, ignoring duplicates
    const tradeData = {
      session_id: SESSION_ID,
      asset: signal.asset,
      market_slug: signal.marketSlug || null,
      strike_price: signal.strikePrice || null,
      direction: signal.direction,
      order_type: signal.orderType || null,
      status: signal.status,
      binance_price: signal.binancePrice,
      chainlink_price: signal.chainlinkPrice,
      delta_usd: signal.binanceDelta,
      share_price: signal.sharePrice,
      entry_price: signal.entryPrice || null,
      exit_price: signal.exitPrice || null,
      signal_ts: signal.timestamp,
      fill_ts: signal.fillTime || null,
      sell_ts: signal.sellTime || null,
      fill_time_ms: signal.fillTime ? signal.fillTime - signal.timestamp : null,
      hold_time_ms: signal.sellTime && signal.fillTime ? signal.sellTime - signal.fillTime : null,
      gross_pnl: signal.grossPnl || null,
      entry_fee: signal.entryFee || null,
      exit_fee: signal.exitFee || null,
      total_fees: signal.totalFees || null,
      net_pnl: signal.netPnl || null,
      reason: signal.notes || null,
      config_snapshot: config as unknown as Record<string, unknown>,
    };

    // Only save when status is 'sold' (trade complete) to avoid duplicates
    if (signal.status === 'sold') {
      const { error } = await supabase
        .from('arbitrage_paper_trades')
        .insert(tradeData as never);
      
      if (error) {
        console.warn('[ArbitrageSimulator] Failed to save trade:', error.message);
      } else {
        console.log('[ArbitrageSimulator] Trade saved to DB:', signal.id);
      }
    }
  } catch (err) {
    console.warn('[ArbitrageSimulator] Error saving trade:', err);
  }
}

const DEFAULT_CONFIG: SimulatorConfig = {
  enabled: true,
  minDeltaUsd: 10,            // $10 minimum move
  minSharePrice: 0.35,
  maxSharePrice: 0.65,
  holdTimeMs: 15000,
  maxFillTimeMs: 1000,
  tradeSize: 25,
  persistTrades: true,
  takeProfitCents: 3,         // Default: take profit at entry + 3¢
  takeProfitEnabled: true,    // Enable by default
  stopLossCents: 3,           // Default: stop loss at entry - 3¢
  stopLossEnabled: true,      // Enable by default
};

export function useArbitrageSimulator() {
  const [config, setConfig] = useState<SimulatorConfig>(DEFAULT_CONFIG);
  const [signals, setSignals] = useState<ArbitrageSignal[]>([]);
  const [isAutoConnected, setIsAutoConnected] = useState(false);
  
  const {
    binancePrice,
    chainlinkPrice,
    connectionStatus,
    binanceWsStatus,
    chainlinkWsStatus,
    connect,
    disconnect,
    getAllPrices,
    selectedAsset,
    setSelectedAsset,
    eventLog,
    stats,
    getChartData,
    getLatencyHistogram,
    binanceLastUpdate,
    chainlinkLastUpdate,
    lastError,
    resetSession,
  } = usePriceLatencyComparison();

  // Real Polymarket CLOB prices
  const { 
    prices: polymarketPrices, 
    getSharePrice, 
    getSellPrice,
    loading: polymarketLoading,
    error: polymarketError,
  } = usePolymarketPrices();

  // Track previous prices for delta calculation
  const prevPricesRef = useRef<Record<Asset, number>>({
    BTC: 0,
    ETH: 0,
    SOL: 0,
    XRP: 0,
  });
  
  // Track pending trades for sell scheduling
  const pendingTradesRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Auto-connect on mount and reconnect on disconnect
  useEffect(() => {
    if (connectionStatus === 'disconnected' && !isAutoConnected) {
      console.log('[ArbitrageSimulator] Auto-connecting...');
      connect();
      setIsAutoConnected(true);
    }
  }, [connectionStatus, connect, isAutoConnected]);

  // Reconnect logic
  useEffect(() => {
    if (connectionStatus === 'disconnected' && isAutoConnected) {
      console.log('[ArbitrageSimulator] Connection lost, reconnecting in 2s...');
      const timer = setTimeout(() => {
        connect();
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [connectionStatus, connect, isAutoConnected]);

  // Monitor Binance price changes for all assets
  useEffect(() => {
    if (!config.enabled) return;
    if (connectionStatus !== 'connected') return;

    const prices = getAllPrices();
    const now = Date.now();

    for (const asset of ['BTC', 'ETH', 'SOL', 'XRP'] as Asset[]) {
      const currentBinance = prices[asset].binance;
      const currentChainlink = prices[asset].chainlink;
      const prevBinance = prevPricesRef.current[asset];

      if (!currentBinance || !prevBinance || prevBinance === 0) {
        if (currentBinance) prevPricesRef.current[asset] = currentBinance;
        continue;
      }

      const delta = currentBinance - prevBinance;
      prevPricesRef.current[asset] = currentBinance;

      // Check if delta is significant
      if (Math.abs(delta) < config.minDeltaUsd) continue;

      const direction: 'UP' | 'DOWN' = delta > 0 ? 'UP' : 'DOWN';

      // Get REAL share price from Polymarket CLOB
      const realSharePrice = getSharePrice(asset, direction);
      const marketInfo = polymarketPrices[asset];
      
      // Use real price if available, otherwise skip
      if (realSharePrice === null) {
        console.log(`[ArbitrageSimulator] No CLOB price available for ${asset} ${direction}, skipping`);
        continue;
      }

      // Check share price bounds
      if (realSharePrice < config.minSharePrice || realSharePrice > config.maxSharePrice) {
        console.log(`[ArbitrageSimulator] ${asset} ${direction} share price ${realSharePrice.toFixed(2)} outside bounds [${config.minSharePrice}-${config.maxSharePrice}]`);
        continue;
      }

      // Check if we already have a pending signal for this asset
      const hasPending = signals.some(
        s => s.asset === asset && s.status === 'pending'
      );
      if (hasPending) continue;

      // Create new signal with REAL share price
      const signalId = `${asset}-${now}`;
      const signal: ArbitrageSignal = {
        id: signalId,
        timestamp: now,
        asset,
        direction,
        binancePrice: currentBinance,
        binanceDelta: delta,
        sharePrice: realSharePrice,
        chainlinkPrice: currentChainlink || 0,
        status: 'pending',
        notes: `Detected ${direction} signal: Binance Δ$${Math.abs(delta).toFixed(2)}, Share ${(realSharePrice * 100).toFixed(1)}¢`,
        marketSlug: marketInfo?.marketSlug,
        strikePrice: marketInfo?.strikePrice,
      };

      console.log('[ArbitrageSimulator] Signal detected:', signal);

      setSignals(prev => [signal, ...prev].slice(0, 100));

      // Simulate fill (instant for paper trading) - capture realSharePrice in closure
      const entrySharePrice = realSharePrice;
      setTimeout(() => {
        const fillTime = Date.now();
        const fillLatency = fillTime - now;
        
        if (fillLatency > config.maxFillTimeMs) {
          // Fill took too long
          setSignals(prev => prev.map(s => 
            s.id === signalId 
              ? { ...s, status: 'failed', fillTime, notes: `Fill too slow: ${fillLatency}ms` }
              : s
          ));
          return;
        }

        // Filled successfully with slight slippage
        const slippage = (Math.random() - 0.5) * 0.005;
        const entryPrice = entrySharePrice + slippage;
        
        // Determine order type: maker if fill > 100ms, taker if fast
        const orderType: 'maker' | 'taker' = fillLatency > 100 ? 'maker' : 'taker';
        const shares = config.tradeSize / entryPrice;
        const entryFee = orderType === 'taker' ? shares * 0.02 : -shares * 0.005;

        // Calculate take-profit price (entry + X cents)
        const takeProfitPrice = config.takeProfitEnabled 
          ? entryPrice + (config.takeProfitCents / 100)
          : undefined;

        // Calculate stop-loss price (entry - X cents)
        const stopLossPrice = config.stopLossEnabled
          ? entryPrice - (config.stopLossCents / 100)
          : undefined;

        setSignals(prev => prev.map(s => 
          s.id === signalId 
            ? { 
                ...s, 
                status: 'filled', 
                entryPrice, 
                fillTime, 
                orderType,
                entryFee,
                takeProfitPrice,
                takeProfitStatus: takeProfitPrice ? 'pending' as const : undefined,
                stopLossPrice,
                stopLossStatus: stopLossPrice ? 'pending' as const : undefined,
                notes: `Filled @ ${(entryPrice * 100).toFixed(1)}¢ | TP: ${takeProfitPrice ? (takeProfitPrice * 100).toFixed(1) : '-'}¢ | SL: ${stopLossPrice ? (stopLossPrice * 100).toFixed(1) : '-'}¢`
              }
            : s
        ));

        // Log TP/SL orders
        setTimeout(() => {
          if (takeProfitPrice) {
            console.log(`[ArbitrageSimulator] TP limit: SELL @ ${(takeProfitPrice * 100).toFixed(1)}¢`);
          }
          if (stopLossPrice) {
            console.log(`[ArbitrageSimulator] SL order: SELL @ ${(stopLossPrice * 100).toFixed(1)}¢`);
          }
        }, 300);

        // Check for TP/SL fills periodically
        const checkInterval = 500;
        let exitTriggered = false;
        
        const tpSlChecker = (takeProfitPrice || stopLossPrice) ? setInterval(() => {
          if (exitTriggered) return;
          
          const currentBid = getSellPrice(asset, direction);
          if (currentBid === null) return;

          // Check Take-Profit: bid >= TP price
          if (takeProfitPrice && currentBid >= takeProfitPrice) {
            exitTriggered = true;
            clearInterval(tpSlChecker);
            
            const sellTime = Date.now();
            const exitPrice = takeProfitPrice;
            const exitFee = -shares * 0.005; // Maker rebate
            const totalFees = entryFee + exitFee;
            const grossPnl = (exitPrice - entryPrice) * shares;
            const netPnl = grossPnl - totalFees;

            console.log(`[ArbitrageSimulator] ✅ TP filled! ${asset} ${direction} @ ${(exitPrice * 100).toFixed(1)}¢`);

            const completedSignal: ArbitrageSignal = {
              ...signal,
              status: 'sold',
              entryPrice,
              exitPrice,
              sellTime,
              fillTime,
              orderType,
              entryFee,
              exitFee,
              totalFees,
              grossPnl,
              netPnl,
              pnl: netPnl,
              takeProfitPrice,
              takeProfitStatus: 'filled',
              stopLossPrice,
              stopLossStatus: stopLossPrice ? 'cancelled' : undefined,
              exitType: 'tp',
              notes: `✅ TP @ ${(exitPrice * 100).toFixed(1)}¢ | +${config.takeProfitCents}¢ | Net: $${netPnl.toFixed(2)}`
            };

            setSignals(prev => prev.map(s => 
              s.id === signalId ? completedSignal : s
            ));

            saveTradeToDb(completedSignal, config);
            pendingTradesRef.current.delete(signalId);
            return;
          }

          // Check Stop-Loss: bid <= SL price
          if (stopLossPrice && currentBid <= stopLossPrice) {
            exitTriggered = true;
            clearInterval(tpSlChecker);
            
            const sellTime = Date.now();
            const exitPrice = stopLossPrice;
            const exitFee = shares * 0.02; // Taker fee (market order to exit)
            const totalFees = entryFee + exitFee;
            const grossPnl = (exitPrice - entryPrice) * shares;
            const netPnl = grossPnl - totalFees;

            console.log(`[ArbitrageSimulator] ❌ SL triggered! ${asset} ${direction} @ ${(exitPrice * 100).toFixed(1)}¢`);

            const completedSignal: ArbitrageSignal = {
              ...signal,
              status: 'sold',
              entryPrice,
              exitPrice,
              sellTime,
              fillTime,
              orderType,
              entryFee,
              exitFee,
              totalFees,
              grossPnl,
              netPnl,
              pnl: netPnl,
              takeProfitPrice,
              takeProfitStatus: takeProfitPrice ? 'cancelled' : undefined,
              stopLossPrice,
              stopLossStatus: 'filled',
              exitType: 'sl',
              notes: `❌ SL @ ${(exitPrice * 100).toFixed(1)}¢ | -${config.stopLossCents}¢ | Net: $${netPnl.toFixed(2)}`
            };

            setSignals(prev => prev.map(s => 
              s.id === signalId ? completedSignal : s
            ));

            saveTradeToDb(completedSignal, config);
            pendingTradesRef.current.delete(signalId);
            return;
          }
        }, checkInterval) : null;

        // Fallback sell after holdTime (if neither TP nor SL hit)
        const sellTimer = setTimeout(() => {
          if (exitTriggered) return;
          if (tpSlChecker) clearInterval(tpSlChecker);
          
          const sellTime = Date.now();
          const realExitPrice = getSellPrice(asset, direction);
          
          let exitPrice: number;
          if (realExitPrice !== null) {
            exitPrice = realExitPrice;
          } else {
            const pricesAtSell = getAllPrices();
            const binanceAtSell = pricesAtSell[asset].binance || currentBinance;
            const binanceChange = binanceAtSell - currentBinance;
            const correctDirection = (direction === 'UP' && binanceChange > 0) || 
                                    (direction === 'DOWN' && binanceChange < 0);
            exitPrice = entryPrice + (correctDirection ? 0.02 : -0.02);
          }
          
          const exitFee = shares * 0.02;
          const totalFees = entryFee + exitFee;
          const grossPnl = (exitPrice - entryPrice) * shares;
          const netPnl = grossPnl - totalFees;

          const completedSignal: ArbitrageSignal = {
            ...signal,
            status: 'sold',
            entryPrice,
            exitPrice,
            sellTime,
            fillTime,
            orderType,
            entryFee,
            exitFee,
            totalFees,
            grossPnl,
            netPnl,
            pnl: netPnl,
            takeProfitPrice,
            takeProfitStatus: takeProfitPrice ? 'cancelled' : undefined,
            stopLossPrice,
            stopLossStatus: stopLossPrice ? 'cancelled' : undefined,
            exitType: 'timeout',
            notes: `⏱️ Timeout → Exit @ ${(exitPrice * 100).toFixed(1)}¢ | Net: $${netPnl.toFixed(2)}`
          };

          setSignals(prev => prev.map(s => 
            s.id === signalId ? completedSignal : s
          ));

          saveTradeToDb(completedSignal, config);
          pendingTradesRef.current.delete(signalId);
        }, config.holdTimeMs);

        pendingTradesRef.current.set(signalId, sellTimer);
      }, 50); // Simulate 50ms fill time
    }
  }, [eventLog, config, connectionStatus, getAllPrices, signals, getSharePrice, getSellPrice, polymarketPrices]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      pendingTradesRef.current.forEach(timer => clearTimeout(timer));
    };
  }, []);

  // Calculate stats
  const simulatorStats = {
    totalSignals: signals.length,
    filled: signals.filter(s => s.status === 'filled' || s.status === 'sold').length,
    sold: signals.filter(s => s.status === 'sold').length,
    failed: signals.filter(s => s.status === 'failed').length,
    pending: signals.filter(s => s.status === 'pending' || s.status === 'filled').length,
    totalPnl: signals.reduce((sum, s) => sum + (s.pnl || 0), 0),
    avgPnl: signals.filter(s => s.pnl !== undefined).length > 0
      ? signals.reduce((sum, s) => sum + (s.pnl || 0), 0) / signals.filter(s => s.pnl !== undefined).length
      : 0,
    winRate: signals.filter(s => s.pnl !== undefined).length > 0
      ? signals.filter(s => (s.pnl || 0) > 0).length / signals.filter(s => s.pnl !== undefined).length
      : 0,
  };

  const clearSignals = useCallback(() => {
    pendingTradesRef.current.forEach(timer => clearTimeout(timer));
    pendingTradesRef.current.clear();
    setSignals([]);
  }, []);

  const updateConfig = useCallback((updates: Partial<SimulatorConfig>) => {
    setConfig(prev => ({ ...prev, ...updates }));
  }, []);

  // Manual test trade function - uses REAL CLOB prices
  const placeTestTrade = useCallback((asset: Asset, direction: 'UP' | 'DOWN') => {
    const now = Date.now();
    const signalId = `TEST-${asset}-${now}`;
    const prices = getAllPrices();
    const currentBinance = prices[asset].binance || 100000;
    const currentChainlink = prices[asset].chainlink || currentBinance;
    
    // Get REAL share price from Polymarket CLOB
    const realSharePrice = getSharePrice(asset, direction);
    const marketInfo = polymarketPrices[asset];
    const sharePrice = realSharePrice ?? 0.50; // Fallback if no CLOB data

    const signal: ArbitrageSignal = {
      id: signalId,
      timestamp: now,
      asset,
      direction,
      binancePrice: currentBinance,
      binanceDelta: direction === 'UP' ? 15 : -15,
      sharePrice,
      chainlinkPrice: currentChainlink,
      status: 'pending',
      notes: realSharePrice 
        ? `TEST: ${direction} @ ${(sharePrice * 100).toFixed(1)}¢ (LIVE)` 
        : `TEST: ${direction} @ ${(sharePrice * 100).toFixed(1)}¢ (no CLOB)`,
      marketSlug: marketInfo?.marketSlug,
      strikePrice: marketInfo?.strikePrice,
    };

    console.log('[ArbitrageSimulator] Test trade placed:', signal);
    setSignals(prev => [signal, ...prev].slice(0, 100));

    // Simulate fill after 50-200ms
    const fillDelay = 50 + Math.random() * 150;
    const entrySharePrice = sharePrice; // Capture in closure
    
    setTimeout(() => {
      const fillTime = Date.now();
      const fillLatency = fillTime - now;
      // Simulate entry price with slight slippage
      const slippage = (Math.random() - 0.5) * 0.005;
      const entryPrice = entrySharePrice + slippage;
      
      // Determine order type: maker if fill > 100ms (limit order filled), taker if fast
      const orderType: 'maker' | 'taker' = fillLatency > 100 ? 'maker' : 'taker';
      const shares = config.tradeSize / entryPrice;
      const entryFee = orderType === 'taker' ? shares * 0.02 : -shares * 0.005;

      // Calculate take-profit price
      const takeProfitPrice = config.takeProfitEnabled 
        ? entryPrice + (config.takeProfitCents / 100)
        : undefined;

      // Calculate stop-loss price
      const stopLossPrice = config.stopLossEnabled
        ? entryPrice - (config.stopLossCents / 100)
        : undefined;

      setSignals(prev => prev.map(s => 
        s.id === signalId 
          ? { 
              ...s, 
              status: 'filled', 
              entryPrice, 
              fillTime, 
              orderType,
              entryFee,
              takeProfitPrice,
              takeProfitStatus: takeProfitPrice ? 'pending' as const : undefined,
              stopLossPrice,
              stopLossStatus: stopLossPrice ? 'pending' as const : undefined,
              notes: `TEST: Filled @ ${(entryPrice * 100).toFixed(1)}¢ | TP: ${takeProfitPrice ? (takeProfitPrice * 100).toFixed(1) : '-'}¢ | SL: ${stopLossPrice ? (stopLossPrice * 100).toFixed(1) : '-'}¢`
            }
          : s
      ));

      // Log TP/SL orders
      setTimeout(() => {
        if (takeProfitPrice) console.log(`[ArbitrageSimulator] TEST TP: SELL @ ${(takeProfitPrice * 100).toFixed(1)}¢`);
        if (stopLossPrice) console.log(`[ArbitrageSimulator] TEST SL: SELL @ ${(stopLossPrice * 100).toFixed(1)}¢`);
      }, 300);

      // Check for TP/SL fills
      let exitTriggered = false;
      const tpSlChecker = (takeProfitPrice || stopLossPrice) ? setInterval(() => {
        if (exitTriggered) return;
        
        const currentBid = getSellPrice(asset, direction);
        if (currentBid === null) return;

        // Check Take-Profit
        if (takeProfitPrice && currentBid >= takeProfitPrice) {
          exitTriggered = true;
          clearInterval(tpSlChecker);
          
          const sellTime = Date.now();
          const exitPrice = takeProfitPrice;
          const exitFee = -shares * 0.005;
          const totalFees = entryFee + exitFee;
          const grossPnl = (exitPrice - entryPrice) * shares;
          const netPnl = grossPnl - totalFees;

          const completedTestSignal: ArbitrageSignal = {
            id: signalId, timestamp: now, asset, direction,
            binancePrice: currentBinance, binanceDelta: direction === 'UP' ? 15 : -15,
            sharePrice, chainlinkPrice: currentChainlink, status: 'sold',
            entryPrice, exitPrice, sellTime, fillTime, orderType,
            entryFee, exitFee, totalFees, grossPnl, netPnl, pnl: netPnl,
            marketSlug: marketInfo?.marketSlug, strikePrice: marketInfo?.strikePrice,
            takeProfitPrice, takeProfitStatus: 'filled',
            stopLossPrice, stopLossStatus: stopLossPrice ? 'cancelled' : undefined,
            exitType: 'tp',
            notes: `✅ TEST TP @ ${(exitPrice * 100).toFixed(1)}¢ | +${config.takeProfitCents}¢ | Net: $${netPnl.toFixed(2)}`
          };

          setSignals(prev => prev.map(s => s.id === signalId ? completedTestSignal : s));
          saveTradeToDb(completedTestSignal, config);
          pendingTradesRef.current.delete(signalId);
          return;
        }

        // Check Stop-Loss
        if (stopLossPrice && currentBid <= stopLossPrice) {
          exitTriggered = true;
          clearInterval(tpSlChecker);
          
          const sellTime = Date.now();
          const exitPrice = stopLossPrice;
          const exitFee = shares * 0.02;
          const totalFees = entryFee + exitFee;
          const grossPnl = (exitPrice - entryPrice) * shares;
          const netPnl = grossPnl - totalFees;

          const completedTestSignal: ArbitrageSignal = {
            id: signalId, timestamp: now, asset, direction,
            binancePrice: currentBinance, binanceDelta: direction === 'UP' ? 15 : -15,
            sharePrice, chainlinkPrice: currentChainlink, status: 'sold',
            entryPrice, exitPrice, sellTime, fillTime, orderType,
            entryFee, exitFee, totalFees, grossPnl, netPnl, pnl: netPnl,
            marketSlug: marketInfo?.marketSlug, strikePrice: marketInfo?.strikePrice,
            takeProfitPrice, takeProfitStatus: takeProfitPrice ? 'cancelled' : undefined,
            stopLossPrice, stopLossStatus: 'filled',
            exitType: 'sl',
            notes: `❌ TEST SL @ ${(exitPrice * 100).toFixed(1)}¢ | -${config.stopLossCents}¢ | Net: $${netPnl.toFixed(2)}`
          };

          setSignals(prev => prev.map(s => s.id === signalId ? completedTestSignal : s));
          saveTradeToDb(completedTestSignal, config);
          pendingTradesRef.current.delete(signalId);
          return;
        }
      }, 500) : null;

      // Fallback sell after holdTime
      const sellTimer = setTimeout(() => {
        if (exitTriggered) return;
        if (tpSlChecker) clearInterval(tpSlChecker);
        
        const sellTime = Date.now();
        const realExitPrice = getSellPrice(asset, direction);
        
        let exitPrice: number;
        if (realExitPrice !== null) {
          exitPrice = realExitPrice;
        } else {
          const isWin = Math.random() < 0.6;
          const priceMove = isWin ? (0.015 + Math.random() * 0.02) : -(0.01 + Math.random() * 0.015);
          exitPrice = entryPrice + priceMove;
        }
        
        const exitFee = shares * 0.02;
        const totalFees = entryFee + exitFee;
        const grossPnl = (exitPrice - entryPrice) * shares;
        const netPnl = grossPnl - totalFees;

        const completedTestSignal: ArbitrageSignal = {
          id: signalId, timestamp: now, asset, direction,
          binancePrice: currentBinance, binanceDelta: direction === 'UP' ? 15 : -15,
          sharePrice, chainlinkPrice: currentChainlink, status: 'sold',
          entryPrice, exitPrice, sellTime, fillTime, orderType,
          entryFee, exitFee, totalFees, grossPnl, netPnl, pnl: netPnl,
          marketSlug: marketInfo?.marketSlug, strikePrice: marketInfo?.strikePrice,
          takeProfitPrice, takeProfitStatus: takeProfitPrice ? 'cancelled' : undefined,
          stopLossPrice, stopLossStatus: stopLossPrice ? 'cancelled' : undefined,
          exitType: 'timeout',
          notes: `⏱️ TEST timeout → Exit @ ${(exitPrice * 100).toFixed(1)}¢ | Net: $${netPnl.toFixed(2)}`
        };

        setSignals(prev => prev.map(s => s.id === signalId ? completedTestSignal : s));
        saveTradeToDb(completedTestSignal, config);
        pendingTradesRef.current.delete(signalId);
      }, config.holdTimeMs);

      pendingTradesRef.current.set(signalId, sellTimer);
    }, fillDelay);
  }, [getAllPrices, config.tradeSize, config.holdTimeMs, getSharePrice, getSellPrice, polymarketPrices]);


  return {
    // Simulator state
    config,
    updateConfig,
    signals,
    clearSignals,
    simulatorStats,
    placeTestTrade,
    
    // Polymarket CLOB prices
    polymarketPrices,
    polymarketLoading,
    polymarketError,
    getSharePrice,
    getSellPrice,
    
    // WebSocket state (pass through)
    binancePrice,
    chainlinkPrice,
    connectionStatus,
    binanceWsStatus,
    chainlinkWsStatus,
    connect,
    disconnect,
    getAllPrices,
    selectedAsset,
    setSelectedAsset,
    eventLog,
    stats,
    getChartData,
    getLatencyHistogram,
    binanceLastUpdate,
    chainlinkLastUpdate,
    lastError,
    resetSession,
  };
}
