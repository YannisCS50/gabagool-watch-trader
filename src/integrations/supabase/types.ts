export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      bot_config: {
        Row: {
          backend_url: string | null
          cloudflare_backoff_ms: number | null
          created_at: string | null
          id: string
          max_notional_per_trade: number | null
          max_position_size: number | null
          min_edge_threshold: number | null
          min_order_interval_ms: number | null
          opening_max_price: number | null
          polymarket_address: string | null
          strategy_enabled: boolean | null
          trade_assets: string[] | null
          updated_at: string | null
          vpn_endpoint: string | null
          vpn_required: boolean | null
        }
        Insert: {
          backend_url?: string | null
          cloudflare_backoff_ms?: number | null
          created_at?: string | null
          id?: string
          max_notional_per_trade?: number | null
          max_position_size?: number | null
          min_edge_threshold?: number | null
          min_order_interval_ms?: number | null
          opening_max_price?: number | null
          polymarket_address?: string | null
          strategy_enabled?: boolean | null
          trade_assets?: string[] | null
          updated_at?: string | null
          vpn_endpoint?: string | null
          vpn_required?: boolean | null
        }
        Update: {
          backend_url?: string | null
          cloudflare_backoff_ms?: number | null
          created_at?: string | null
          id?: string
          max_notional_per_trade?: number | null
          max_position_size?: number | null
          min_edge_threshold?: number | null
          min_order_interval_ms?: number | null
          opening_max_price?: number | null
          polymarket_address?: string | null
          strategy_enabled?: boolean | null
          trade_assets?: string[] | null
          updated_at?: string | null
          vpn_endpoint?: string | null
          vpn_required?: boolean | null
        }
        Relationships: []
      }
      bot_positions: {
        Row: {
          avg_price: number
          cost: number | null
          created_at: string
          current_price: number | null
          id: string
          market_slug: string
          outcome: string
          pnl: number | null
          pnl_percent: number | null
          shares: number
          synced_at: string
          token_id: string | null
          value: number | null
          wallet_address: string
        }
        Insert: {
          avg_price?: number
          cost?: number | null
          created_at?: string
          current_price?: number | null
          id?: string
          market_slug: string
          outcome: string
          pnl?: number | null
          pnl_percent?: number | null
          shares?: number
          synced_at?: string
          token_id?: string | null
          value?: number | null
          wallet_address: string
        }
        Update: {
          avg_price?: number
          cost?: number | null
          created_at?: string
          current_price?: number | null
          id?: string
          market_slug?: string
          outcome?: string
          pnl?: number | null
          pnl_percent?: number | null
          shares?: number
          synced_at?: string
          token_id?: string | null
          value?: number | null
          wallet_address?: string
        }
        Relationships: []
      }
      fill_logs: {
        Row: {
          asset: string
          client_order_id: string | null
          created_at: string
          delta: number | null
          fill_notional: number
          fill_price: number
          fill_qty: number
          hedge_lag_ms: number | null
          id: string
          intent: string
          iso: string
          market_id: string
          order_id: string | null
          seconds_remaining: number
          side: string
          spot_price: number | null
          strike_price: number | null
          ts: number
        }
        Insert: {
          asset: string
          client_order_id?: string | null
          created_at?: string
          delta?: number | null
          fill_notional: number
          fill_price: number
          fill_qty: number
          hedge_lag_ms?: number | null
          id?: string
          intent: string
          iso: string
          market_id: string
          order_id?: string | null
          seconds_remaining: number
          side: string
          spot_price?: number | null
          strike_price?: number | null
          ts: number
        }
        Update: {
          asset?: string
          client_order_id?: string | null
          created_at?: string
          delta?: number | null
          fill_notional?: number
          fill_price?: number
          fill_qty?: number
          hedge_lag_ms?: number | null
          id?: string
          intent?: string
          iso?: string
          market_id?: string
          order_id?: string | null
          seconds_remaining?: number
          side?: string
          spot_price?: number | null
          strike_price?: number | null
          ts?: number
        }
        Relationships: []
      }
      hedge_feasibility: {
        Row: {
          actual_hedge_at: string | null
          actual_hedge_price: number | null
          asset: string
          created_at: string
          event_end_time: string | null
          hedge_side: string
          hedge_was_possible: boolean
          hedge_was_profitable: boolean
          hedge_window_seconds: number | null
          id: string
          market_id: string
          max_hedge_price: number
          min_hedge_ask_at: string | null
          min_hedge_ask_seen: number | null
          opening_at: string
          opening_price: number
          opening_shares: number
          opening_side: string
          was_hedged: boolean
        }
        Insert: {
          actual_hedge_at?: string | null
          actual_hedge_price?: number | null
          asset: string
          created_at?: string
          event_end_time?: string | null
          hedge_side: string
          hedge_was_possible?: boolean
          hedge_was_profitable?: boolean
          hedge_window_seconds?: number | null
          id?: string
          market_id: string
          max_hedge_price: number
          min_hedge_ask_at?: string | null
          min_hedge_ask_seen?: number | null
          opening_at: string
          opening_price: number
          opening_shares: number
          opening_side: string
          was_hedged?: boolean
        }
        Update: {
          actual_hedge_at?: string | null
          actual_hedge_price?: number | null
          asset?: string
          created_at?: string
          event_end_time?: string | null
          hedge_side?: string
          hedge_was_possible?: boolean
          hedge_was_profitable?: boolean
          hedge_window_seconds?: number | null
          id?: string
          market_id?: string
          max_hedge_price?: number
          min_hedge_ask_at?: string | null
          min_hedge_ask_seen?: number | null
          opening_at?: string
          opening_price?: number
          opening_shares?: number
          opening_side?: string
          was_hedged?: boolean
        }
        Relationships: []
      }
      live_bot_settings: {
        Row: {
          id: string
          is_enabled: boolean | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          is_enabled?: boolean | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          is_enabled?: boolean | null
          updated_at?: string | null
        }
        Relationships: []
      }
      live_trade_results: {
        Row: {
          asset: string
          created_at: string | null
          down_avg_price: number | null
          down_cost: number | null
          down_shares: number | null
          event_end_time: string | null
          id: string
          market_slug: string
          payout: number | null
          profit_loss: number | null
          profit_loss_percent: number | null
          result: string | null
          settled_at: string | null
          total_invested: number | null
          up_avg_price: number | null
          up_cost: number | null
          up_shares: number | null
          wallet_address: string | null
        }
        Insert: {
          asset: string
          created_at?: string | null
          down_avg_price?: number | null
          down_cost?: number | null
          down_shares?: number | null
          event_end_time?: string | null
          id?: string
          market_slug: string
          payout?: number | null
          profit_loss?: number | null
          profit_loss_percent?: number | null
          result?: string | null
          settled_at?: string | null
          total_invested?: number | null
          up_avg_price?: number | null
          up_cost?: number | null
          up_shares?: number | null
          wallet_address?: string | null
        }
        Update: {
          asset?: string
          created_at?: string | null
          down_avg_price?: number | null
          down_cost?: number | null
          down_shares?: number | null
          event_end_time?: string | null
          id?: string
          market_slug?: string
          payout?: number | null
          profit_loss?: number | null
          profit_loss_percent?: number | null
          result?: string | null
          settled_at?: string | null
          total_invested?: number | null
          up_avg_price?: number | null
          up_cost?: number | null
          up_shares?: number | null
          wallet_address?: string | null
        }
        Relationships: []
      }
      live_trades: {
        Row: {
          arbitrage_edge: number | null
          asset: string
          avg_fill_price: number | null
          created_at: string | null
          estimated_slippage: number | null
          event_end_time: string | null
          event_start_time: string | null
          id: string
          market_slug: string
          order_id: string | null
          outcome: string
          price: number
          reasoning: string | null
          shares: number
          status: string | null
          total: number
          wallet_address: string | null
        }
        Insert: {
          arbitrage_edge?: number | null
          asset: string
          avg_fill_price?: number | null
          created_at?: string | null
          estimated_slippage?: number | null
          event_end_time?: string | null
          event_start_time?: string | null
          id?: string
          market_slug: string
          order_id?: string | null
          outcome: string
          price: number
          reasoning?: string | null
          shares: number
          status?: string | null
          total: number
          wallet_address?: string | null
        }
        Update: {
          arbitrage_edge?: number | null
          asset?: string
          avg_fill_price?: number | null
          created_at?: string | null
          estimated_slippage?: number | null
          event_end_time?: string | null
          event_start_time?: string | null
          id?: string
          market_slug?: string
          order_id?: string | null
          outcome?: string
          price?: number
          reasoning?: string | null
          shares?: number
          status?: string | null
          total?: number
          wallet_address?: string | null
        }
        Relationships: []
      }
      market_history: {
        Row: {
          asset: string
          close_price: number | null
          close_timestamp: number | null
          created_at: string
          down_price_at_close: number | null
          down_token_id: string | null
          event_end_time: string
          event_start_time: string
          id: string
          open_price: number | null
          open_timestamp: number | null
          question: string | null
          result: string | null
          slug: string
          strike_price: number | null
          up_price_at_close: number | null
          up_token_id: string | null
          updated_at: string
        }
        Insert: {
          asset: string
          close_price?: number | null
          close_timestamp?: number | null
          created_at?: string
          down_price_at_close?: number | null
          down_token_id?: string | null
          event_end_time: string
          event_start_time: string
          id?: string
          open_price?: number | null
          open_timestamp?: number | null
          question?: string | null
          result?: string | null
          slug: string
          strike_price?: number | null
          up_price_at_close?: number | null
          up_token_id?: string | null
          updated_at?: string
        }
        Update: {
          asset?: string
          close_price?: number | null
          close_timestamp?: number | null
          created_at?: string
          down_price_at_close?: number | null
          down_token_id?: string | null
          event_end_time?: string
          event_start_time?: string
          id?: string
          open_price?: number | null
          open_timestamp?: number | null
          question?: string | null
          result?: string | null
          slug?: string
          strike_price?: number | null
          up_price_at_close?: number | null
          up_token_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      order_queue: {
        Row: {
          asset: string
          avg_fill_price: number | null
          created_at: string
          error_message: string | null
          event_end_time: string | null
          event_start_time: string | null
          executed_at: string | null
          id: string
          market_slug: string
          order_id: string | null
          order_type: string
          outcome: string
          price: number
          reasoning: string | null
          shares: number
          status: string
          token_id: string
        }
        Insert: {
          asset: string
          avg_fill_price?: number | null
          created_at?: string
          error_message?: string | null
          event_end_time?: string | null
          event_start_time?: string | null
          executed_at?: string | null
          id?: string
          market_slug: string
          order_id?: string | null
          order_type?: string
          outcome: string
          price: number
          reasoning?: string | null
          shares: number
          status?: string
          token_id: string
        }
        Update: {
          asset?: string
          avg_fill_price?: number | null
          created_at?: string
          error_message?: string | null
          event_end_time?: string | null
          event_start_time?: string | null
          executed_at?: string | null
          id?: string
          market_slug?: string
          order_id?: string | null
          order_type?: string
          outcome?: string
          price?: number
          reasoning?: string | null
          shares?: number
          status?: string
          token_id?: string
        }
        Relationships: []
      }
      paper_bot_settings: {
        Row: {
          id: string
          is_enabled: boolean | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          is_enabled?: boolean | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          is_enabled?: boolean | null
          updated_at?: string | null
        }
        Relationships: []
      }
      paper_trade_results: {
        Row: {
          asset: string
          created_at: string | null
          down_avg_price: number | null
          down_cost: number | null
          down_shares: number | null
          event_end_time: string | null
          id: string
          market_slug: string
          payout: number | null
          profit_loss: number | null
          profit_loss_percent: number | null
          result: string | null
          settled_at: string | null
          total_invested: number | null
          up_avg_price: number | null
          up_cost: number | null
          up_shares: number | null
        }
        Insert: {
          asset: string
          created_at?: string | null
          down_avg_price?: number | null
          down_cost?: number | null
          down_shares?: number | null
          event_end_time?: string | null
          id?: string
          market_slug: string
          payout?: number | null
          profit_loss?: number | null
          profit_loss_percent?: number | null
          result?: string | null
          settled_at?: string | null
          total_invested?: number | null
          up_avg_price?: number | null
          up_cost?: number | null
          up_shares?: number | null
        }
        Update: {
          asset?: string
          created_at?: string | null
          down_avg_price?: number | null
          down_cost?: number | null
          down_shares?: number | null
          event_end_time?: string | null
          id?: string
          market_slug?: string
          payout?: number | null
          profit_loss?: number | null
          profit_loss_percent?: number | null
          result?: string | null
          settled_at?: string | null
          total_invested?: number | null
          up_avg_price?: number | null
          up_cost?: number | null
          up_shares?: number | null
        }
        Relationships: []
      }
      paper_trades: {
        Row: {
          arbitrage_edge: number | null
          asset: string
          available_liquidity: number | null
          avg_fill_price: number | null
          best_ask: number | null
          best_bid: number | null
          combined_price: number | null
          created_at: string | null
          crypto_price: number | null
          estimated_slippage: number | null
          event_end_time: string | null
          event_start_time: string | null
          id: string
          market_slug: string
          open_price: number | null
          outcome: string
          price: number
          price_delta: number | null
          price_delta_percent: number | null
          reasoning: string | null
          remaining_seconds: number | null
          shares: number
          total: number
          trade_type: string | null
        }
        Insert: {
          arbitrage_edge?: number | null
          asset: string
          available_liquidity?: number | null
          avg_fill_price?: number | null
          best_ask?: number | null
          best_bid?: number | null
          combined_price?: number | null
          created_at?: string | null
          crypto_price?: number | null
          estimated_slippage?: number | null
          event_end_time?: string | null
          event_start_time?: string | null
          id?: string
          market_slug: string
          open_price?: number | null
          outcome: string
          price: number
          price_delta?: number | null
          price_delta_percent?: number | null
          reasoning?: string | null
          remaining_seconds?: number | null
          shares: number
          total: number
          trade_type?: string | null
        }
        Update: {
          arbitrage_edge?: number | null
          asset?: string
          available_liquidity?: number | null
          avg_fill_price?: number | null
          best_ask?: number | null
          best_bid?: number | null
          combined_price?: number | null
          created_at?: string | null
          crypto_price?: number | null
          estimated_slippage?: number | null
          event_end_time?: string | null
          event_start_time?: string | null
          id?: string
          market_slug?: string
          open_price?: number | null
          outcome?: string
          price?: number
          price_delta?: number | null
          price_delta_percent?: number | null
          reasoning?: string | null
          remaining_seconds?: number | null
          shares?: number
          total?: number
          trade_type?: string | null
        }
        Relationships: []
      }
      position_snapshots: {
        Row: {
          avg_price: number
          created_at: string
          current_price: number | null
          id: string
          is_closed: boolean | null
          market_slug: string
          market_title: string | null
          outcome: string
          pnl: number | null
          pnl_percent: number | null
          shares: number
          snapshot_at: string
          trader_username: string
          value: number | null
        }
        Insert: {
          avg_price: number
          created_at?: string
          current_price?: number | null
          id?: string
          is_closed?: boolean | null
          market_slug: string
          market_title?: string | null
          outcome: string
          pnl?: number | null
          pnl_percent?: number | null
          shares: number
          snapshot_at?: string
          trader_username?: string
          value?: number | null
        }
        Update: {
          avg_price?: number
          created_at?: string
          current_price?: number | null
          id?: string
          is_closed?: boolean | null
          market_slug?: string
          market_title?: string | null
          outcome?: string
          pnl?: number | null
          pnl_percent?: number | null
          shares?: number
          snapshot_at?: string
          trader_username?: string
          value?: number | null
        }
        Relationships: []
      }
      positions: {
        Row: {
          avg_price: number
          created_at: string
          current_price: number | null
          id: string
          market: string
          market_slug: string | null
          outcome: string
          pnl: number | null
          pnl_percent: number | null
          shares: number
          trader_username: string
          updated_at: string
        }
        Insert: {
          avg_price: number
          created_at?: string
          current_price?: number | null
          id?: string
          market: string
          market_slug?: string | null
          outcome: string
          pnl?: number | null
          pnl_percent?: number | null
          shares: number
          trader_username?: string
          updated_at?: string
        }
        Update: {
          avg_price?: number
          created_at?: string
          current_price?: number | null
          id?: string
          market?: string
          market_slug?: string | null
          outcome?: string
          pnl?: number | null
          pnl_percent?: number | null
          shares?: number
          trader_username?: string
          updated_at?: string
        }
        Relationships: []
      }
      price_ticks: {
        Row: {
          asset: string
          created_at: string
          delta: number | null
          delta_percent: number | null
          id: string
          price: number
          source: string | null
        }
        Insert: {
          asset: string
          created_at?: string
          delta?: number | null
          delta_percent?: number | null
          id?: string
          price: number
          source?: string | null
        }
        Update: {
          asset?: string
          created_at?: string
          delta?: number | null
          delta_percent?: number | null
          id?: string
          price?: number
          source?: string | null
        }
        Relationships: []
      }
      runner_heartbeats: {
        Row: {
          balance: number | null
          created_at: string
          id: string
          ip_address: string | null
          last_heartbeat: string
          markets_count: number | null
          positions_count: number | null
          runner_id: string
          runner_type: string
          status: string
          trades_count: number | null
          version: string | null
        }
        Insert: {
          balance?: number | null
          created_at?: string
          id?: string
          ip_address?: string | null
          last_heartbeat?: string
          markets_count?: number | null
          positions_count?: number | null
          runner_id: string
          runner_type?: string
          status?: string
          trades_count?: number | null
          version?: string | null
        }
        Update: {
          balance?: number | null
          created_at?: string
          id?: string
          ip_address?: string | null
          last_heartbeat?: string
          markets_count?: number | null
          positions_count?: number | null
          runner_id?: string
          runner_type?: string
          status?: string
          trades_count?: number | null
          version?: string | null
        }
        Relationships: []
      }
      settlement_failures: {
        Row: {
          asset: string
          created_at: string
          down_cost: number
          down_shares: number
          id: string
          lost_cost: number
          lost_side: string
          market_slug: string
          panic_hedge_attempted: boolean
          reason: string
          seconds_remaining: number
          up_cost: number
          up_shares: number
          wallet_address: string | null
        }
        Insert: {
          asset: string
          created_at?: string
          down_cost?: number
          down_shares?: number
          id?: string
          lost_cost: number
          lost_side: string
          market_slug: string
          panic_hedge_attempted?: boolean
          reason: string
          seconds_remaining: number
          up_cost?: number
          up_shares?: number
          wallet_address?: string | null
        }
        Update: {
          asset?: string
          created_at?: string
          down_cost?: number
          down_shares?: number
          id?: string
          lost_cost?: number
          lost_side?: string
          market_slug?: string
          panic_hedge_attempted?: boolean
          reason?: string
          seconds_remaining?: number
          up_cost?: number
          up_shares?: number
          wallet_address?: string | null
        }
        Relationships: []
      }
      settlement_logs: {
        Row: {
          asset: string
          avg_down_cost: number | null
          avg_up_cost: number | null
          close_ts: number
          count_dislocation_95: number
          count_dislocation_97: number
          created_at: string
          final_down_shares: number
          final_up_shares: number
          id: string
          iso: string
          last_180s_dislocation_95: number
          market_id: string
          max_delta: number | null
          min_delta: number | null
          open_ts: number | null
          pair_cost: number | null
          realized_pnl: number | null
          time_in_high: number
          time_in_low: number
          time_in_mid: number
          ts: number
          winning_side: string | null
        }
        Insert: {
          asset: string
          avg_down_cost?: number | null
          avg_up_cost?: number | null
          close_ts: number
          count_dislocation_95?: number
          count_dislocation_97?: number
          created_at?: string
          final_down_shares?: number
          final_up_shares?: number
          id?: string
          iso: string
          last_180s_dislocation_95?: number
          market_id: string
          max_delta?: number | null
          min_delta?: number | null
          open_ts?: number | null
          pair_cost?: number | null
          realized_pnl?: number | null
          time_in_high?: number
          time_in_low?: number
          time_in_mid?: number
          ts: number
          winning_side?: string | null
        }
        Update: {
          asset?: string
          avg_down_cost?: number | null
          avg_up_cost?: number | null
          close_ts?: number
          count_dislocation_95?: number
          count_dislocation_97?: number
          created_at?: string
          final_down_shares?: number
          final_up_shares?: number
          id?: string
          iso?: string
          last_180s_dislocation_95?: number
          market_id?: string
          max_delta?: number | null
          min_delta?: number | null
          open_ts?: number | null
          pair_cost?: number | null
          realized_pnl?: number | null
          time_in_high?: number
          time_in_low?: number
          time_in_mid?: number
          ts?: number
          winning_side?: string | null
        }
        Relationships: []
      }
      snapshot_logs: {
        Row: {
          adverse_streak: number
          asset: string
          avg_down_cost: number | null
          avg_up_cost: number | null
          bot_state: string
          cheapest_ask_plus_other_mid: number | null
          combined_ask: number | null
          combined_mid: number | null
          created_at: string
          delta: number | null
          down_ask: number | null
          down_bid: number | null
          down_mid: number | null
          down_shares: number
          id: string
          iso: string
          market_id: string
          no_liquidity_streak: number
          pair_cost: number | null
          seconds_remaining: number
          skew: number | null
          spot_price: number | null
          spread_down: number | null
          spread_up: number | null
          strike_price: number | null
          ts: number
          up_ask: number | null
          up_bid: number | null
          up_mid: number | null
          up_shares: number
        }
        Insert: {
          adverse_streak?: number
          asset: string
          avg_down_cost?: number | null
          avg_up_cost?: number | null
          bot_state: string
          cheapest_ask_plus_other_mid?: number | null
          combined_ask?: number | null
          combined_mid?: number | null
          created_at?: string
          delta?: number | null
          down_ask?: number | null
          down_bid?: number | null
          down_mid?: number | null
          down_shares?: number
          id?: string
          iso: string
          market_id: string
          no_liquidity_streak?: number
          pair_cost?: number | null
          seconds_remaining: number
          skew?: number | null
          spot_price?: number | null
          spread_down?: number | null
          spread_up?: number | null
          strike_price?: number | null
          ts: number
          up_ask?: number | null
          up_bid?: number | null
          up_mid?: number | null
          up_shares?: number
        }
        Update: {
          adverse_streak?: number
          asset?: string
          avg_down_cost?: number | null
          avg_up_cost?: number | null
          bot_state?: string
          cheapest_ask_plus_other_mid?: number | null
          combined_ask?: number | null
          combined_mid?: number | null
          created_at?: string
          delta?: number | null
          down_ask?: number | null
          down_bid?: number | null
          down_mid?: number | null
          down_shares?: number
          id?: string
          iso?: string
          market_id?: string
          no_liquidity_streak?: number
          pair_cost?: number | null
          seconds_remaining?: number
          skew?: number | null
          spot_price?: number | null
          spread_down?: number | null
          spread_up?: number | null
          strike_price?: number | null
          ts?: number
          up_ask?: number | null
          up_bid?: number | null
          up_mid?: number | null
          up_shares?: number
        }
        Relationships: []
      }
      strike_prices: {
        Row: {
          asset: string
          chainlink_timestamp: number
          close_price: number | null
          close_timestamp: number | null
          created_at: string | null
          event_start_time: string
          id: string
          market_slug: string
          open_price: number | null
          open_timestamp: number | null
          quality: string | null
          source: string | null
          strike_price: number
        }
        Insert: {
          asset: string
          chainlink_timestamp: number
          close_price?: number | null
          close_timestamp?: number | null
          created_at?: string | null
          event_start_time: string
          id?: string
          market_slug: string
          open_price?: number | null
          open_timestamp?: number | null
          quality?: string | null
          source?: string | null
          strike_price: number
        }
        Update: {
          asset?: string
          chainlink_timestamp?: number
          close_price?: number | null
          close_timestamp?: number | null
          created_at?: string | null
          event_start_time?: string
          id?: string
          market_slug?: string
          open_price?: number | null
          open_timestamp?: number | null
          quality?: string | null
          source?: string | null
          strike_price?: number
        }
        Relationships: []
      }
      trader_stats: {
        Row: {
          active_since: string | null
          avg_trade_size: number | null
          id: string
          last_active: string | null
          total_trades: number | null
          total_volume: number | null
          trader_username: string
          updated_at: string
          win_rate: number | null
        }
        Insert: {
          active_since?: string | null
          avg_trade_size?: number | null
          id?: string
          last_active?: string | null
          total_trades?: number | null
          total_volume?: number | null
          trader_username?: string
          updated_at?: string
          win_rate?: number | null
        }
        Update: {
          active_since?: string | null
          avg_trade_size?: number | null
          id?: string
          last_active?: string | null
          total_trades?: number | null
          total_volume?: number | null
          trader_username?: string
          updated_at?: string
          win_rate?: number | null
        }
        Relationships: []
      }
      trades: {
        Row: {
          created_at: string
          external_id: string | null
          id: string
          market: string
          market_slug: string | null
          outcome: string
          price: number
          shares: number
          side: string
          status: string | null
          timestamp: string
          total: number
          trader_username: string
        }
        Insert: {
          created_at?: string
          external_id?: string | null
          id?: string
          market: string
          market_slug?: string | null
          outcome: string
          price: number
          shares: number
          side: string
          status?: string | null
          timestamp: string
          total: number
          trader_username?: string
        }
        Update: {
          created_at?: string
          external_id?: string | null
          id?: string
          market?: string
          market_slug?: string | null
          outcome?: string
          price?: number
          shares?: number
          side?: string
          status?: string | null
          timestamp?: string
          total?: number
          trader_username?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
