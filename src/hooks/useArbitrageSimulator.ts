import { useState, useEffect, useCallback, useRef } from 'react';
import { usePriceLatencyComparison, Asset } from './usePriceLatencyComparison';
import { usePolymarketPrices } from './usePolymarketPrices';

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
}

export interface SimulatorConfig {
  enabled: boolean;
  minDeltaUsd: number;        // Minimum Binance delta to trigger
  minSharePrice: number;      // 0.35
  maxSharePrice: number;      // 0.65
  holdTimeMs: number;         // 15000 (15 seconds)
  maxFillTimeMs: number;      // 1000 (must fill within 1 second)
  tradeSize: number;          // $25 notional
}

const DEFAULT_CONFIG: SimulatorConfig = {
  enabled: true,
  minDeltaUsd: 10,            // $10 minimum move
  minSharePrice: 0.35,
  maxSharePrice: 0.65,
  holdTimeMs: 15000,
  maxFillTimeMs: 1000,
  tradeSize: 25,
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

        setSignals(prev => prev.map(s => 
          s.id === signalId 
            ? { 
                ...s, 
                status: 'filled', 
                entryPrice, 
                fillTime, 
                orderType,
                entryFee,
                notes: `Filled @ ${(entryPrice * 100).toFixed(1)}¢ (${orderType}) in ${fillLatency}ms` 
              }
            : s
        ));

        // Schedule sell after holdTime
        const sellTimer = setTimeout(() => {
          const sellTime = Date.now();
          
          // Get REAL exit price from CLOB if available
          const realExitPrice = getSellPrice(asset, direction);
          
          // Use real price or simulate based on direction
          let exitPrice: number;
          if (realExitPrice !== null) {
            exitPrice = realExitPrice;
          } else {
            // Fallback: simulate based on Binance movement
            const pricesAtSell = getAllPrices();
            const binanceAtSell = pricesAtSell[asset].binance || currentBinance;
            const binanceChange = binanceAtSell - currentBinance;
            const correctDirection = (direction === 'UP' && binanceChange > 0) || 
                                    (direction === 'DOWN' && binanceChange < 0);
            exitPrice = entryPrice + (correctDirection ? 0.02 : -0.02);
          }
          
          // Calculate PnL with fees
          const exitFee = shares * 0.02; // Exit is usually taker
          const totalFees = entryFee + exitFee;
          const grossPnl = (exitPrice - entryPrice) * shares;
          const netPnl = grossPnl - totalFees;

          setSignals(prev => prev.map(s => 
            s.id === signalId 
              ? { 
                  ...s, 
                  status: 'sold', 
                  exitPrice, 
                  sellTime,
                  exitFee,
                  totalFees,
                  grossPnl,
                  netPnl,
                  pnl: netPnl,
                  notes: `Exit @ ${(exitPrice * 100).toFixed(1)}¢ | Gross: $${grossPnl.toFixed(2)} | Net: $${netPnl.toFixed(2)}` 
                }
              : s
          ));

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

      setSignals(prev => prev.map(s => 
        s.id === signalId 
          ? { 
              ...s, 
              status: 'filled', 
              entryPrice, 
              fillTime, 
              orderType,
              entryFee,
              notes: `Filled @ ${(entryPrice * 100).toFixed(1)}¢ (${orderType}) in ${fillLatency.toFixed(0)}ms` 
            }
          : s
      ));

      // Schedule sell after holdTime
      const sellTimer = setTimeout(() => {
        const sellTime = Date.now();
        
        // Get REAL exit price from CLOB if available
        const realExitPrice = getSellPrice(asset, direction);
        
        let exitPrice: number;
        if (realExitPrice !== null) {
          exitPrice = realExitPrice;
        } else {
          // Fallback: simulate random outcome (60% win rate)
          const isWin = Math.random() < 0.6;
          const priceMove = isWin ? (0.015 + Math.random() * 0.02) : -(0.01 + Math.random() * 0.015);
          exitPrice = entryPrice + priceMove;
        }
        
        // Exit is usually taker (market order to close)
        const exitFee = shares * 0.02;
        const totalFees = entryFee + exitFee;
        
        const grossPnl = (exitPrice - entryPrice) * shares;
        const netPnl = grossPnl - totalFees;

        setSignals(prev => prev.map(s => 
          s.id === signalId 
            ? { 
                ...s, 
                status: 'sold', 
                exitPrice, 
                sellTime, 
                exitFee,
                totalFees,
                grossPnl,
                netPnl,
                pnl: netPnl,
                notes: `Exit @ ${(exitPrice * 100).toFixed(1)}¢ | Gross: $${grossPnl.toFixed(2)} | Net: $${netPnl.toFixed(2)}` 
              }
            : s
        ));

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
