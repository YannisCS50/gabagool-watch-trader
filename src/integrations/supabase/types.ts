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
      account_position_snapshots: {
        Row: {
          account_avg_down: number | null
          account_avg_up: number | null
          account_down_shares: number
          account_up_shares: number
          created_at: string
          id: string
          market_id: string
          run_id: string | null
          source_endpoint: string | null
          source_version: string | null
          ts: number
          wallet_address: string | null
        }
        Insert: {
          account_avg_down?: number | null
          account_avg_up?: number | null
          account_down_shares?: number
          account_up_shares?: number
          created_at?: string
          id?: string
          market_id: string
          run_id?: string | null
          source_endpoint?: string | null
          source_version?: string | null
          ts: number
          wallet_address?: string | null
        }
        Update: {
          account_avg_down?: number | null
          account_avg_up?: number | null
          account_down_shares?: number
          account_up_shares?: number
          created_at?: string
          id?: string
          market_id?: string
          run_id?: string | null
          source_endpoint?: string | null
          source_version?: string | null
          ts?: number
          wallet_address?: string | null
        }
        Relationships: []
      }
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
      bot_events: {
        Row: {
          asset: string
          correlation_id: string | null
          created_at: string
          data: Json | null
          event_type: string
          id: string
          market_id: string | null
          reason_code: string | null
          run_id: string | null
          ts: number
        }
        Insert: {
          asset: string
          correlation_id?: string | null
          created_at?: string
          data?: Json | null
          event_type: string
          id?: string
          market_id?: string | null
          reason_code?: string | null
          run_id?: string | null
          ts: number
        }
        Update: {
          asset?: string
          correlation_id?: string | null
          created_at?: string
          data?: Json | null
          event_type?: string
          id?: string
          market_id?: string | null
          reason_code?: string | null
          run_id?: string | null
          ts?: number
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
      canonical_positions: {
        Row: {
          avg_cost: number | null
          created_at: string | null
          id: string
          last_fill_at: string | null
          market_id: string
          outcome: string
          realized_pnl: number
          shares_held: number
          state: string
          total_cost_usd: number
          unrealized_pnl: number | null
          updated_at: string | null
          wallet: string
        }
        Insert: {
          avg_cost?: number | null
          created_at?: string | null
          id: string
          last_fill_at?: string | null
          market_id: string
          outcome: string
          realized_pnl?: number
          shares_held?: number
          state?: string
          total_cost_usd?: number
          unrealized_pnl?: number | null
          updated_at?: string | null
          wallet: string
        }
        Update: {
          avg_cost?: number | null
          created_at?: string | null
          id?: string
          last_fill_at?: string | null
          market_id?: string
          outcome?: string
          realized_pnl?: number
          shares_held?: number
          state?: string
          total_cost_usd?: number
          unrealized_pnl?: number | null
          updated_at?: string | null
          wallet?: string
        }
        Relationships: []
      }
      cashflow_ledger: {
        Row: {
          amount_usd: number
          category: string
          created_at: string | null
          direction: string
          id: string
          market_id: string
          outcome: string | null
          shares_delta: number
          source_event_id: string | null
          timestamp: string
          wallet: string
        }
        Insert: {
          amount_usd?: number
          category: string
          created_at?: string | null
          direction: string
          id: string
          market_id: string
          outcome?: string | null
          shares_delta?: number
          source_event_id?: string | null
          timestamp: string
          wallet: string
        }
        Update: {
          amount_usd?: number
          category?: string
          created_at?: string | null
          direction?: string
          id?: string
          market_id?: string
          outcome?: string | null
          shares_delta?: number
          source_event_id?: string | null
          timestamp?: string
          wallet?: string
        }
        Relationships: [
          {
            foreignKeyName: "cashflow_ledger_source_event_id_fkey"
            columns: ["source_event_id"]
            isOneToOne: false
            referencedRelation: "raw_subgraph_events"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_logs: {
        Row: {
          block_number: number | null
          condition_id: string
          confirmed_at: string | null
          created_at: string
          error_message: string | null
          gas_price_gwei: number | null
          gas_used: number | null
          id: string
          market_id: string | null
          market_title: string | null
          outcome: string | null
          retry_count: number | null
          shares_redeemed: number
          status: string
          tx_hash: string | null
          usdc_received: number
          wallet_address: string
          wallet_type: string | null
        }
        Insert: {
          block_number?: number | null
          condition_id: string
          confirmed_at?: string | null
          created_at?: string
          error_message?: string | null
          gas_price_gwei?: number | null
          gas_used?: number | null
          id?: string
          market_id?: string | null
          market_title?: string | null
          outcome?: string | null
          retry_count?: number | null
          shares_redeemed?: number
          status?: string
          tx_hash?: string | null
          usdc_received?: number
          wallet_address: string
          wallet_type?: string | null
        }
        Update: {
          block_number?: number | null
          condition_id?: string
          confirmed_at?: string | null
          created_at?: string
          error_message?: string | null
          gas_price_gwei?: number | null
          gas_used?: number | null
          id?: string
          market_id?: string | null
          market_title?: string | null
          outcome?: string | null
          retry_count?: number | null
          shares_redeemed?: number
          status?: string
          tx_hash?: string | null
          usdc_received?: number
          wallet_address?: string
          wallet_type?: string | null
        }
        Relationships: []
      }
      decision_snapshots: {
        Row: {
          asset: string
          avg_down: number | null
          avg_up: number | null
          best_ask_down: number | null
          best_ask_up: number | null
          best_bid_down: number | null
          best_bid_up: number | null
          book_ready_down: boolean
          book_ready_up: boolean
          chosen_side: string | null
          correlation_id: string | null
          cpp_paired_only: number | null
          created_at: string
          depth_summary_down: Json | null
          depth_summary_up: Json | null
          down_shares: number
          guards_evaluated: Json
          id: string
          intent: string
          market_id: string
          paired_shares: number
          projected_cpp_maker: number | null
          projected_cpp_taker: number | null
          reason_code: string
          run_id: string | null
          seconds_remaining: number
          state: string
          ts: number
          unpaired_shares: number
          up_shares: number
          window_start: string | null
        }
        Insert: {
          asset: string
          avg_down?: number | null
          avg_up?: number | null
          best_ask_down?: number | null
          best_ask_up?: number | null
          best_bid_down?: number | null
          best_bid_up?: number | null
          book_ready_down?: boolean
          book_ready_up?: boolean
          chosen_side?: string | null
          correlation_id?: string | null
          cpp_paired_only?: number | null
          created_at?: string
          depth_summary_down?: Json | null
          depth_summary_up?: Json | null
          down_shares?: number
          guards_evaluated?: Json
          id?: string
          intent: string
          market_id: string
          paired_shares?: number
          projected_cpp_maker?: number | null
          projected_cpp_taker?: number | null
          reason_code: string
          run_id?: string | null
          seconds_remaining: number
          state: string
          ts: number
          unpaired_shares?: number
          up_shares?: number
          window_start?: string | null
        }
        Update: {
          asset?: string
          avg_down?: number | null
          avg_up?: number | null
          best_ask_down?: number | null
          best_ask_up?: number | null
          best_bid_down?: number | null
          best_bid_up?: number | null
          book_ready_down?: boolean
          book_ready_up?: boolean
          chosen_side?: string | null
          correlation_id?: string | null
          cpp_paired_only?: number | null
          created_at?: string
          depth_summary_down?: Json | null
          depth_summary_up?: Json | null
          down_shares?: number
          guards_evaluated?: Json
          id?: string
          intent?: string
          market_id?: string
          paired_shares?: number
          projected_cpp_maker?: number | null
          projected_cpp_taker?: number | null
          reason_code?: string
          run_id?: string | null
          seconds_remaining?: number
          state?: string
          ts?: number
          unpaired_shares?: number
          up_shares?: number
          window_start?: string | null
        }
        Relationships: []
      }
      fill_attributions: {
        Row: {
          asset: string
          correlation_id: string | null
          created_at: string
          fee_paid: number
          fill_cost_gross: number
          fill_cost_net: number
          id: string
          liquidity: string
          market_id: string
          order_id: string
          price: number
          rebate_expected: number
          run_id: string | null
          side: string
          size: number
          ts: number
          updated_avg_down: number | null
          updated_avg_up: number | null
          updated_cpp_gross: number | null
          updated_cpp_net_expected: number | null
        }
        Insert: {
          asset: string
          correlation_id?: string | null
          created_at?: string
          fee_paid?: number
          fill_cost_gross: number
          fill_cost_net: number
          id?: string
          liquidity: string
          market_id: string
          order_id: string
          price: number
          rebate_expected?: number
          run_id?: string | null
          side: string
          size: number
          ts: number
          updated_avg_down?: number | null
          updated_avg_up?: number | null
          updated_cpp_gross?: number | null
          updated_cpp_net_expected?: number | null
        }
        Update: {
          asset?: string
          correlation_id?: string | null
          created_at?: string
          fee_paid?: number
          fill_cost_gross?: number
          fill_cost_net?: number
          id?: string
          liquidity?: string
          market_id?: string
          order_id?: string
          price?: number
          rebate_expected?: number
          run_id?: string | null
          side?: string
          size?: number
          ts?: number
          updated_avg_down?: number | null
          updated_avg_up?: number | null
          updated_cpp_gross?: number | null
          updated_cpp_net_expected?: number | null
        }
        Relationships: []
      }
      fill_logs: {
        Row: {
          asset: string
          client_order_id: string | null
          correlation_id: string | null
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
          run_id: string | null
          seconds_remaining: number
          side: string
          spot_price: number | null
          strike_price: number | null
          ts: number
        }
        Insert: {
          asset: string
          client_order_id?: string | null
          correlation_id?: string | null
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
          run_id?: string | null
          seconds_remaining: number
          side: string
          spot_price?: number | null
          strike_price?: number | null
          ts: number
        }
        Update: {
          asset?: string
          client_order_id?: string | null
          correlation_id?: string | null
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
          run_id?: string | null
          seconds_remaining?: number
          side?: string
          spot_price?: number | null
          strike_price?: number | null
          ts?: number
        }
        Relationships: []
      }
      funding_snapshots: {
        Row: {
          allowance_remaining: number | null
          balance_available: number
          balance_total: number
          blocked_reason: string | null
          created_at: string
          id: string
          reserved_by_market: Json | null
          reserved_total: number
          spendable: number | null
          trigger_type: string | null
          ts: number
        }
        Insert: {
          allowance_remaining?: number | null
          balance_available: number
          balance_total: number
          blocked_reason?: string | null
          created_at?: string
          id?: string
          reserved_by_market?: Json | null
          reserved_total?: number
          spendable?: number | null
          trigger_type?: string | null
          ts: number
        }
        Update: {
          allowance_remaining?: number | null
          balance_available?: number
          balance_total?: number
          blocked_reason?: string | null
          created_at?: string
          id?: string
          reserved_by_market?: Json | null
          reserved_total?: number
          spendable?: number | null
          trigger_type?: string | null
          ts?: number
        }
        Relationships: []
      }
      gabagool_metrics: {
        Row: {
          cpp_distribution: Json | null
          created_at: string
          high_cpp_trade_count: number
          id: string
          invariant_status: Json | null
          maker_fill_ratio: number | null
          maker_fills: number
          paired_cpp_under_100_pct: number | null
          paired_cpp_under_100_shares: number
          run_id: string | null
          taker_fills: number
          total_paired_shares: number
          ts: number
        }
        Insert: {
          cpp_distribution?: Json | null
          created_at?: string
          high_cpp_trade_count?: number
          id?: string
          invariant_status?: Json | null
          maker_fill_ratio?: number | null
          maker_fills?: number
          paired_cpp_under_100_pct?: number | null
          paired_cpp_under_100_shares?: number
          run_id?: string | null
          taker_fills?: number
          total_paired_shares?: number
          ts: number
        }
        Update: {
          cpp_distribution?: Json | null
          created_at?: string
          high_cpp_trade_count?: number
          id?: string
          invariant_status?: Json | null
          maker_fill_ratio?: number | null
          maker_fills?: number
          paired_cpp_under_100_pct?: number | null
          paired_cpp_under_100_shares?: number
          run_id?: string | null
          taker_fills?: number
          total_paired_shares?: number
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
      hedge_intents: {
        Row: {
          abort_reason: string | null
          asset: string
          correlation_id: string | null
          created_at: string
          filled_qty: number | null
          id: string
          intended_qty: number
          intent_type: string
          market_id: string
          price_at_intent: number | null
          price_at_resolution: number | null
          resolution_ts: number | null
          run_id: string | null
          side: string
          status: string
          ts: number
        }
        Insert: {
          abort_reason?: string | null
          asset: string
          correlation_id?: string | null
          created_at?: string
          filled_qty?: number | null
          id?: string
          intended_qty: number
          intent_type: string
          market_id: string
          price_at_intent?: number | null
          price_at_resolution?: number | null
          resolution_ts?: number | null
          run_id?: string | null
          side: string
          status?: string
          ts: number
        }
        Update: {
          abort_reason?: string | null
          asset?: string
          correlation_id?: string | null
          created_at?: string
          filled_qty?: number | null
          id?: string
          intended_qty?: number
          intent_type?: string
          market_id?: string
          price_at_intent?: number | null
          price_at_resolution?: number | null
          resolution_ts?: number | null
          run_id?: string | null
          side?: string
          status?: string
          ts?: number
        }
        Relationships: []
      }
      hedge_skip_logs: {
        Row: {
          asset: string
          best_ask: number | null
          best_bid: number | null
          correlation_id: string | null
          created_at: string
          id: string
          market_id: string
          projected_cpp: number | null
          reason_code: string
          run_id: string | null
          seconds_remaining: number | null
          side_not_hedged: string
          ts: number
          unpaired_shares: number | null
        }
        Insert: {
          asset: string
          best_ask?: number | null
          best_bid?: number | null
          correlation_id?: string | null
          created_at?: string
          id?: string
          market_id: string
          projected_cpp?: number | null
          reason_code: string
          run_id?: string | null
          seconds_remaining?: number | null
          side_not_hedged: string
          ts: number
          unpaired_shares?: number | null
        }
        Update: {
          asset?: string
          best_ask?: number | null
          best_bid?: number | null
          correlation_id?: string | null
          created_at?: string
          id?: string
          market_id?: string
          projected_cpp?: number | null
          reason_code?: string
          run_id?: string | null
          seconds_remaining?: number | null
          side_not_hedged?: string
          ts?: number
          unpaired_shares?: number | null
        }
        Relationships: []
      }
      inventory_snapshots: {
        Row: {
          asset: string
          avg_down_cost: number | null
          avg_up_cost: number | null
          created_at: string
          down_shares: number
          hedge_lag_ms: number | null
          id: string
          market_id: string
          pair_cost: number | null
          paired_delay_sec: number | null
          paired_shares: number | null
          skew_allowed_reason: string | null
          state: string
          state_age_ms: number | null
          trigger_type: string | null
          ts: number
          unpaired_notional_usd: number | null
          unpaired_shares: number | null
          up_shares: number
        }
        Insert: {
          asset: string
          avg_down_cost?: number | null
          avg_up_cost?: number | null
          created_at?: string
          down_shares?: number
          hedge_lag_ms?: number | null
          id?: string
          market_id: string
          pair_cost?: number | null
          paired_delay_sec?: number | null
          paired_shares?: number | null
          skew_allowed_reason?: string | null
          state: string
          state_age_ms?: number | null
          trigger_type?: string | null
          ts: number
          unpaired_notional_usd?: number | null
          unpaired_shares?: number | null
          up_shares?: number
        }
        Update: {
          asset?: string
          avg_down_cost?: number | null
          avg_up_cost?: number | null
          created_at?: string
          down_shares?: number
          hedge_lag_ms?: number | null
          id?: string
          market_id?: string
          pair_cost?: number | null
          paired_delay_sec?: number | null
          paired_shares?: number | null
          skew_allowed_reason?: string | null
          state?: string
          state_age_ms?: number | null
          trigger_type?: string | null
          ts?: number
          unpaired_notional_usd?: number | null
          unpaired_shares?: number | null
          up_shares?: number
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
          claim_status: string | null
          claim_tx_hash: string | null
          claim_usdc: number | null
          claimed_at: string | null
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
          claim_status?: string | null
          claim_tx_hash?: string | null
          claim_usdc?: number | null
          claimed_at?: string | null
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
          claim_status?: string | null
          claim_tx_hash?: string | null
          claim_usdc?: number | null
          claimed_at?: string | null
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
      market_lifecycle: {
        Row: {
          created_at: string | null
          has_buy: boolean | null
          has_redeem: boolean | null
          has_sell: boolean | null
          id: string
          is_claimed: boolean | null
          is_lost: boolean | null
          market_id: string
          market_slug: string | null
          realized_pnl: number
          resolved_outcome: string | null
          settlement_ts: string | null
          state: string
          total_cost: number
          total_payout: number
          updated_at: string | null
          wallet: string
        }
        Insert: {
          created_at?: string | null
          has_buy?: boolean | null
          has_redeem?: boolean | null
          has_sell?: boolean | null
          id: string
          is_claimed?: boolean | null
          is_lost?: boolean | null
          market_id: string
          market_slug?: string | null
          realized_pnl?: number
          resolved_outcome?: string | null
          settlement_ts?: string | null
          state?: string
          total_cost?: number
          total_payout?: number
          updated_at?: string | null
          wallet: string
        }
        Update: {
          created_at?: string | null
          has_buy?: boolean | null
          has_redeem?: boolean | null
          has_sell?: boolean | null
          id?: string
          is_claimed?: boolean | null
          is_lost?: boolean | null
          market_id?: string
          market_slug?: string | null
          realized_pnl?: number
          resolved_outcome?: string | null
          settlement_ts?: string | null
          state?: string
          total_cost?: number
          total_payout?: number
          updated_at?: string | null
          wallet?: string
        }
        Relationships: []
      }
      mtm_snapshots: {
        Row: {
          asset: string
          book_ready_down: boolean
          book_ready_up: boolean
          combined_mid: number | null
          confidence: string
          created_at: string
          down_mid: number | null
          fallback_used: string | null
          id: string
          market_id: string
          run_id: string | null
          ts: number
          unrealized_pnl: number | null
          up_mid: number | null
        }
        Insert: {
          asset: string
          book_ready_down?: boolean
          book_ready_up?: boolean
          combined_mid?: number | null
          confidence?: string
          created_at?: string
          down_mid?: number | null
          fallback_used?: string | null
          id?: string
          market_id: string
          run_id?: string | null
          ts: number
          unrealized_pnl?: number | null
          up_mid?: number | null
        }
        Update: {
          asset?: string
          book_ready_down?: boolean
          book_ready_up?: boolean
          combined_mid?: number | null
          confidence?: string
          created_at?: string
          down_mid?: number | null
          fallback_used?: string | null
          id?: string
          market_id?: string
          run_id?: string | null
          ts?: number
          unrealized_pnl?: number | null
          up_mid?: number | null
        }
        Relationships: []
      }
      order_queue: {
        Row: {
          asset: string
          avg_fill_price: number | null
          correlation_id: string | null
          created_at: string
          error_message: string | null
          event_end_time: string | null
          event_start_time: string | null
          executed_at: string | null
          id: string
          intent_type: string | null
          market_slug: string
          order_id: string | null
          order_type: string
          outcome: string
          price: number
          reasoning: string | null
          run_id: string | null
          shares: number
          status: string
          token_id: string
        }
        Insert: {
          asset: string
          avg_fill_price?: number | null
          correlation_id?: string | null
          created_at?: string
          error_message?: string | null
          event_end_time?: string | null
          event_start_time?: string | null
          executed_at?: string | null
          id?: string
          intent_type?: string | null
          market_slug: string
          order_id?: string | null
          order_type?: string
          outcome: string
          price: number
          reasoning?: string | null
          run_id?: string | null
          shares: number
          status?: string
          token_id: string
        }
        Update: {
          asset?: string
          avg_fill_price?: number | null
          correlation_id?: string | null
          created_at?: string
          error_message?: string | null
          event_end_time?: string | null
          event_start_time?: string | null
          executed_at?: string | null
          id?: string
          intent_type?: string | null
          market_slug?: string
          order_id?: string | null
          order_type?: string
          outcome?: string
          price?: number
          reasoning?: string | null
          run_id?: string | null
          shares?: number
          status?: string
          token_id?: string
        }
        Relationships: []
      }
      orders: {
        Row: {
          asset: string
          avg_fill_price: number | null
          client_order_id: string
          correlation_id: string | null
          created_at: string
          created_ts: number
          exchange_order_id: string | null
          filled_qty: number | null
          id: string
          intent_type: string
          last_update_ts: number
          market_id: string
          price: number
          qty: number
          released_notional: number | null
          reserved_notional: number | null
          side: string
          status: string
        }
        Insert: {
          asset: string
          avg_fill_price?: number | null
          client_order_id: string
          correlation_id?: string | null
          created_at?: string
          created_ts: number
          exchange_order_id?: string | null
          filled_qty?: number | null
          id?: string
          intent_type: string
          last_update_ts: number
          market_id: string
          price: number
          qty: number
          released_notional?: number | null
          reserved_notional?: number | null
          side: string
          status?: string
        }
        Update: {
          asset?: string
          avg_fill_price?: number | null
          client_order_id?: string
          correlation_id?: string | null
          created_at?: string
          created_ts?: number
          exchange_order_id?: string | null
          filled_qty?: number | null
          id?: string
          intent_type?: string
          last_update_ts?: number
          market_id?: string
          price?: number
          qty?: number
          released_notional?: number | null
          reserved_notional?: number | null
          side?: string
          status?: string
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
      pnl_snapshots: {
        Row: {
          claimed_markets: number
          created_at: string | null
          id: string
          lost_markets: number
          open_markets: number
          realized_pnl: number
          settled_markets: number
          total_cost: number
          total_fees: number
          total_markets: number
          total_pnl: number
          ts: string
          unrealized_pnl: number
          wallet: string
        }
        Insert: {
          claimed_markets?: number
          created_at?: string | null
          id: string
          lost_markets?: number
          open_markets?: number
          realized_pnl?: number
          settled_markets?: number
          total_cost?: number
          total_fees?: number
          total_markets?: number
          total_pnl?: number
          ts?: string
          unrealized_pnl?: number
          wallet: string
        }
        Update: {
          claimed_markets?: number
          created_at?: string | null
          id?: string
          lost_markets?: number
          open_markets?: number
          realized_pnl?: number
          settled_markets?: number
          total_cost?: number
          total_fees?: number
          total_markets?: number
          total_pnl?: number
          ts?: string
          unrealized_pnl?: number
          wallet?: string
        }
        Relationships: []
      }
      polymarket_cashflows: {
        Row: {
          amount_usd: number
          condition_id: string | null
          created_at: string | null
          fee_known: boolean | null
          fee_usd: number | null
          id: string
          ingested_at: string | null
          market_id: string | null
          outcome_side: string | null
          price: number | null
          raw_json: Json | null
          shares: number | null
          source: string
          token_id: string | null
          ts: string
          type: string
          wallet: string
        }
        Insert: {
          amount_usd?: number
          condition_id?: string | null
          created_at?: string | null
          fee_known?: boolean | null
          fee_usd?: number | null
          id: string
          ingested_at?: string | null
          market_id?: string | null
          outcome_side?: string | null
          price?: number | null
          raw_json?: Json | null
          shares?: number | null
          source: string
          token_id?: string | null
          ts: string
          type: string
          wallet: string
        }
        Update: {
          amount_usd?: number
          condition_id?: string | null
          created_at?: string | null
          fee_known?: boolean | null
          fee_usd?: number | null
          id?: string
          ingested_at?: string | null
          market_id?: string | null
          outcome_side?: string | null
          price?: number | null
          raw_json?: Json | null
          shares?: number | null
          source?: string
          token_id?: string | null
          ts?: string
          type?: string
          wallet?: string
        }
        Relationships: []
      }
      polymarket_market_resolution: {
        Row: {
          condition_id: string
          created_at: string | null
          id: string
          is_resolved: boolean | null
          market_slug: string | null
          payout_per_share_down: number | null
          payout_per_share_up: number | null
          raw_json: Json | null
          resolution_source: string | null
          resolved_at: string | null
          updated_at: string | null
          winning_outcome: string | null
          winning_token_id: string | null
        }
        Insert: {
          condition_id: string
          created_at?: string | null
          id: string
          is_resolved?: boolean | null
          market_slug?: string | null
          payout_per_share_down?: number | null
          payout_per_share_up?: number | null
          raw_json?: Json | null
          resolution_source?: string | null
          resolved_at?: string | null
          updated_at?: string | null
          winning_outcome?: string | null
          winning_token_id?: string | null
        }
        Update: {
          condition_id?: string
          created_at?: string | null
          id?: string
          is_resolved?: boolean | null
          market_slug?: string | null
          payout_per_share_down?: number | null
          payout_per_share_up?: number | null
          raw_json?: Json | null
          resolution_source?: string | null
          resolved_at?: string | null
          updated_at?: string | null
          winning_outcome?: string | null
          winning_token_id?: string | null
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
      raw_subgraph_events: {
        Row: {
          amount_usd: number
          created_at: string | null
          event_type: string
          fee_usd: number | null
          id: string
          ingested_at: string | null
          market_id: string
          outcome: string | null
          price: number | null
          raw_json: Json | null
          shares: number
          timestamp: string
          tx_hash: string | null
          wallet: string
        }
        Insert: {
          amount_usd?: number
          created_at?: string | null
          event_type: string
          fee_usd?: number | null
          id: string
          ingested_at?: string | null
          market_id: string
          outcome?: string | null
          price?: number | null
          raw_json?: Json | null
          shares?: number
          timestamp: string
          tx_hash?: string | null
          wallet: string
        }
        Update: {
          amount_usd?: number
          created_at?: string | null
          event_type?: string
          fee_usd?: number | null
          id?: string
          ingested_at?: string | null
          market_id?: string
          outcome?: string | null
          price?: number | null
          raw_json?: Json | null
          shares?: number
          timestamp?: string
          tx_hash?: string | null
          wallet?: string
        }
        Relationships: []
      }
      reconcile_reports: {
        Row: {
          coverage_pct: number | null
          created_at: string
          csv_filename: string | null
          csv_storage_path: string | null
          error_message: string | null
          fully_covered_count: number | null
          id: string
          not_covered_count: number | null
          partially_covered_count: number | null
          processed_at: string | null
          processing_time_ms: number | null
          report_data: Json | null
          status: string
          total_bot_fills: number | null
          total_csv_transactions: number | null
          unexplained_count: number | null
          zip_filename: string | null
          zip_storage_path: string | null
        }
        Insert: {
          coverage_pct?: number | null
          created_at?: string
          csv_filename?: string | null
          csv_storage_path?: string | null
          error_message?: string | null
          fully_covered_count?: number | null
          id?: string
          not_covered_count?: number | null
          partially_covered_count?: number | null
          processed_at?: string | null
          processing_time_ms?: number | null
          report_data?: Json | null
          status?: string
          total_bot_fills?: number | null
          total_csv_transactions?: number | null
          unexplained_count?: number | null
          zip_filename?: string | null
          zip_storage_path?: string | null
        }
        Update: {
          coverage_pct?: number | null
          created_at?: string
          csv_filename?: string | null
          csv_storage_path?: string | null
          error_message?: string | null
          fully_covered_count?: number | null
          id?: string
          not_covered_count?: number | null
          partially_covered_count?: number | null
          processed_at?: string | null
          processing_time_ms?: number | null
          report_data?: Json | null
          status?: string
          total_bot_fills?: number | null
          total_csv_transactions?: number | null
          unexplained_count?: number | null
          zip_filename?: string | null
          zip_storage_path?: string | null
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
      runner_lease: {
        Row: {
          created_at: string
          id: string
          locked_until: string
          runner_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          locked_until?: string
          runner_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          locked_until?: string
          runner_id?: string
          updated_at?: string
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
          correlation_id: string | null
          count_dislocation_95: number
          count_dislocation_97: number
          created_at: string
          failure_flag: string | null
          fees: number | null
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
          run_id: string | null
          theoretical_pnl: number | null
          time_in_high: number
          time_in_low: number
          time_in_mid: number
          total_payout_usd: number | null
          ts: number
          winning_side: string | null
        }
        Insert: {
          asset: string
          avg_down_cost?: number | null
          avg_up_cost?: number | null
          close_ts: number
          correlation_id?: string | null
          count_dislocation_95?: number
          count_dislocation_97?: number
          created_at?: string
          failure_flag?: string | null
          fees?: number | null
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
          run_id?: string | null
          theoretical_pnl?: number | null
          time_in_high?: number
          time_in_low?: number
          time_in_mid?: number
          total_payout_usd?: number | null
          ts: number
          winning_side?: string | null
        }
        Update: {
          asset?: string
          avg_down_cost?: number | null
          avg_up_cost?: number | null
          close_ts?: number
          correlation_id?: string | null
          count_dislocation_95?: number
          count_dislocation_97?: number
          created_at?: string
          failure_flag?: string | null
          fees?: number | null
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
          run_id?: string | null
          theoretical_pnl?: number | null
          time_in_high?: number
          time_in_low?: number
          time_in_mid?: number
          total_payout_usd?: number | null
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
          correlation_id: string | null
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
          orderbook_ready: boolean | null
          pair_cost: number | null
          reason_code: string | null
          run_id: string | null
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
          correlation_id?: string | null
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
          orderbook_ready?: boolean | null
          pair_cost?: number | null
          reason_code?: string | null
          run_id?: string | null
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
          correlation_id?: string | null
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
          orderbook_ready?: boolean | null
          pair_cost?: number | null
          reason_code?: string | null
          run_id?: string | null
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
      state_reconciliation_results: {
        Row: {
          account_down: number
          account_up: number
          action_taken: string | null
          created_at: string
          delta_invested: number | null
          delta_shares: number
          id: string
          local_down: number
          local_up: number
          market_id: string
          reconciliation_result: string
          run_id: string | null
          ts: number
        }
        Insert: {
          account_down?: number
          account_up?: number
          action_taken?: string | null
          created_at?: string
          delta_invested?: number | null
          delta_shares?: number
          id?: string
          local_down?: number
          local_up?: number
          market_id: string
          reconciliation_result: string
          run_id?: string | null
          ts: number
        }
        Update: {
          account_down?: number
          account_up?: number
          action_taken?: string | null
          created_at?: string
          delta_invested?: number | null
          delta_shares?: number
          id?: string
          local_down?: number
          local_up?: number
          market_id?: string
          reconciliation_result?: string
          run_id?: string | null
          ts?: number
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
      subgraph_fills: {
        Row: {
          block_number: number | null
          created_at: string | null
          fee_known: boolean | null
          fee_usd: number | null
          id: string
          ingested_at: string | null
          liquidity: string | null
          log_index: number | null
          market_id: string | null
          notional: number
          outcome_side: string | null
          price: number
          raw_json: Json | null
          side: string
          size: number
          timestamp: string
          token_id: string | null
          tx_hash: string | null
          wallet: string
        }
        Insert: {
          block_number?: number | null
          created_at?: string | null
          fee_known?: boolean | null
          fee_usd?: number | null
          id: string
          ingested_at?: string | null
          liquidity?: string | null
          log_index?: number | null
          market_id?: string | null
          notional: number
          outcome_side?: string | null
          price: number
          raw_json?: Json | null
          side: string
          size: number
          timestamp: string
          token_id?: string | null
          tx_hash?: string | null
          wallet: string
        }
        Update: {
          block_number?: number | null
          created_at?: string | null
          fee_known?: boolean | null
          fee_usd?: number | null
          id?: string
          ingested_at?: string | null
          liquidity?: string | null
          log_index?: number | null
          market_id?: string | null
          notional?: number
          outcome_side?: string | null
          price?: number
          raw_json?: Json | null
          side?: string
          size?: number
          timestamp?: string
          token_id?: string | null
          tx_hash?: string | null
          wallet?: string
        }
        Relationships: []
      }
      subgraph_pnl_markets: {
        Row: {
          avg_down_cost: number | null
          avg_up_cost: number | null
          confidence: string | null
          created_at: string | null
          down_shares: number | null
          drift_flags: Json | null
          fees_known_usd: number | null
          fees_unknown_count: number | null
          id: string
          is_settled: boolean | null
          last_reconciled_at: string | null
          lifecycle_bought: boolean | null
          lifecycle_claimed: boolean | null
          lifecycle_lost: boolean | null
          lifecycle_sold: boolean | null
          lifecycle_state: string | null
          mark_price_down: number | null
          mark_price_up: number | null
          mark_source: string | null
          mark_timestamp: string | null
          market_id: string
          market_slug: string | null
          missing_payout_reason: string | null
          payout_amount_usd: number | null
          payout_ingested: boolean | null
          payout_source: string | null
          payout_ts: string | null
          payout_tx_hash: string | null
          realized_confidence: string | null
          realized_pnl_usd: number | null
          resolution_fetched_at: string | null
          resolution_winning_outcome: string | null
          settled_at: string | null
          settlement_outcome: string | null
          settlement_payout: number | null
          synthetic_closure_created: boolean | null
          synthetic_closure_reason: string | null
          total_cost: number | null
          unrealized_confidence: string | null
          unrealized_pnl_usd: number | null
          up_shares: number | null
          updated_at: string | null
          wallet: string
        }
        Insert: {
          avg_down_cost?: number | null
          avg_up_cost?: number | null
          confidence?: string | null
          created_at?: string | null
          down_shares?: number | null
          drift_flags?: Json | null
          fees_known_usd?: number | null
          fees_unknown_count?: number | null
          id: string
          is_settled?: boolean | null
          last_reconciled_at?: string | null
          lifecycle_bought?: boolean | null
          lifecycle_claimed?: boolean | null
          lifecycle_lost?: boolean | null
          lifecycle_sold?: boolean | null
          lifecycle_state?: string | null
          mark_price_down?: number | null
          mark_price_up?: number | null
          mark_source?: string | null
          mark_timestamp?: string | null
          market_id: string
          market_slug?: string | null
          missing_payout_reason?: string | null
          payout_amount_usd?: number | null
          payout_ingested?: boolean | null
          payout_source?: string | null
          payout_ts?: string | null
          payout_tx_hash?: string | null
          realized_confidence?: string | null
          realized_pnl_usd?: number | null
          resolution_fetched_at?: string | null
          resolution_winning_outcome?: string | null
          settled_at?: string | null
          settlement_outcome?: string | null
          settlement_payout?: number | null
          synthetic_closure_created?: boolean | null
          synthetic_closure_reason?: string | null
          total_cost?: number | null
          unrealized_confidence?: string | null
          unrealized_pnl_usd?: number | null
          up_shares?: number | null
          updated_at?: string | null
          wallet: string
        }
        Update: {
          avg_down_cost?: number | null
          avg_up_cost?: number | null
          confidence?: string | null
          created_at?: string | null
          down_shares?: number | null
          drift_flags?: Json | null
          fees_known_usd?: number | null
          fees_unknown_count?: number | null
          id?: string
          is_settled?: boolean | null
          last_reconciled_at?: string | null
          lifecycle_bought?: boolean | null
          lifecycle_claimed?: boolean | null
          lifecycle_lost?: boolean | null
          lifecycle_sold?: boolean | null
          lifecycle_state?: string | null
          mark_price_down?: number | null
          mark_price_up?: number | null
          mark_source?: string | null
          mark_timestamp?: string | null
          market_id?: string
          market_slug?: string | null
          missing_payout_reason?: string | null
          payout_amount_usd?: number | null
          payout_ingested?: boolean | null
          payout_source?: string | null
          payout_ts?: string | null
          payout_tx_hash?: string | null
          realized_confidence?: string | null
          realized_pnl_usd?: number | null
          resolution_fetched_at?: string | null
          resolution_winning_outcome?: string | null
          settled_at?: string | null
          settlement_outcome?: string | null
          settlement_payout?: number | null
          synthetic_closure_created?: boolean | null
          synthetic_closure_reason?: string | null
          total_cost?: number | null
          unrealized_confidence?: string | null
          unrealized_pnl_usd?: number | null
          up_shares?: number | null
          updated_at?: string | null
          wallet?: string
        }
        Relationships: []
      }
      subgraph_pnl_summary: {
        Row: {
          drift_count: number | null
          first_trade_at: string | null
          last_reconciled_at: string | null
          last_trade_at: string | null
          markets_bought: number | null
          markets_claimed: number | null
          markets_lost: number | null
          markets_sold: number | null
          open_markets: number | null
          overall_confidence: string | null
          realized_confidence: string | null
          resolution_fetch_count: number | null
          settled_markets: number | null
          synthetic_closures_count: number | null
          total_fees_known: number | null
          total_fees_unknown_count: number | null
          total_fills: number | null
          total_markets: number | null
          total_pnl: number | null
          total_realized_pnl: number | null
          total_unrealized_pnl: number | null
          unrealized_confidence: string | null
          updated_at: string | null
          wallet: string
        }
        Insert: {
          drift_count?: number | null
          first_trade_at?: string | null
          last_reconciled_at?: string | null
          last_trade_at?: string | null
          markets_bought?: number | null
          markets_claimed?: number | null
          markets_lost?: number | null
          markets_sold?: number | null
          open_markets?: number | null
          overall_confidence?: string | null
          realized_confidence?: string | null
          resolution_fetch_count?: number | null
          settled_markets?: number | null
          synthetic_closures_count?: number | null
          total_fees_known?: number | null
          total_fees_unknown_count?: number | null
          total_fills?: number | null
          total_markets?: number | null
          total_pnl?: number | null
          total_realized_pnl?: number | null
          total_unrealized_pnl?: number | null
          unrealized_confidence?: string | null
          updated_at?: string | null
          wallet: string
        }
        Update: {
          drift_count?: number | null
          first_trade_at?: string | null
          last_reconciled_at?: string | null
          last_trade_at?: string | null
          markets_bought?: number | null
          markets_claimed?: number | null
          markets_lost?: number | null
          markets_sold?: number | null
          open_markets?: number | null
          overall_confidence?: string | null
          realized_confidence?: string | null
          resolution_fetch_count?: number | null
          settled_markets?: number | null
          synthetic_closures_count?: number | null
          total_fees_known?: number | null
          total_fees_unknown_count?: number | null
          total_fills?: number | null
          total_markets?: number | null
          total_pnl?: number | null
          total_realized_pnl?: number | null
          total_unrealized_pnl?: number | null
          unrealized_confidence?: string | null
          updated_at?: string | null
          wallet?: string
        }
        Relationships: []
      }
      subgraph_positions: {
        Row: {
          avg_cost: number | null
          created_at: string | null
          id: string
          market_id: string | null
          outcome_side: string | null
          raw_json: Json | null
          shares: number
          snapshot_id: string | null
          timestamp: string
          token_id: string
          updated_at: string | null
          wallet: string
        }
        Insert: {
          avg_cost?: number | null
          created_at?: string | null
          id: string
          market_id?: string | null
          outcome_side?: string | null
          raw_json?: Json | null
          shares: number
          snapshot_id?: string | null
          timestamp: string
          token_id: string
          updated_at?: string | null
          wallet: string
        }
        Update: {
          avg_cost?: number | null
          created_at?: string | null
          id?: string
          market_id?: string | null
          outcome_side?: string | null
          raw_json?: Json | null
          shares?: number
          snapshot_id?: string | null
          timestamp?: string
          token_id?: string
          updated_at?: string | null
          wallet?: string
        }
        Relationships: []
      }
      subgraph_reconciliation: {
        Row: {
          created_at: string | null
          delta_shares_down: number | null
          delta_shares_up: number | null
          id: string
          local_shares_down: number | null
          local_shares_up: number | null
          local_source: string | null
          market_id: string | null
          notes: string | null
          severity: string
          status: string | null
          subgraph_shares_down: number | null
          subgraph_shares_up: number | null
          subgraph_source: string | null
          timestamp: string | null
          wallet: string
        }
        Insert: {
          created_at?: string | null
          delta_shares_down?: number | null
          delta_shares_up?: number | null
          id?: string
          local_shares_down?: number | null
          local_shares_up?: number | null
          local_source?: string | null
          market_id?: string | null
          notes?: string | null
          severity: string
          status?: string | null
          subgraph_shares_down?: number | null
          subgraph_shares_up?: number | null
          subgraph_source?: string | null
          timestamp?: string | null
          wallet: string
        }
        Update: {
          created_at?: string | null
          delta_shares_down?: number | null
          delta_shares_up?: number | null
          id?: string
          local_shares_down?: number | null
          local_shares_up?: number | null
          local_source?: string | null
          market_id?: string | null
          notes?: string | null
          severity?: string
          status?: string | null
          subgraph_shares_down?: number | null
          subgraph_shares_up?: number | null
          subgraph_source?: string | null
          timestamp?: string | null
          wallet?: string
        }
        Relationships: []
      }
      subgraph_sync_state: {
        Row: {
          created_at: string | null
          errors_count: number | null
          id: string
          last_block_number: number | null
          last_error: string | null
          last_sync_at: string | null
          last_timestamp: string | null
          payout_error: string | null
          payout_records_synced: number | null
          payout_sync_at: string | null
          records_synced: number | null
          updated_at: string | null
          wallet: string
        }
        Insert: {
          created_at?: string | null
          errors_count?: number | null
          id: string
          last_block_number?: number | null
          last_error?: string | null
          last_sync_at?: string | null
          last_timestamp?: string | null
          payout_error?: string | null
          payout_records_synced?: number | null
          payout_sync_at?: string | null
          records_synced?: number | null
          updated_at?: string | null
          wallet: string
        }
        Update: {
          created_at?: string | null
          errors_count?: number | null
          id?: string
          last_block_number?: number | null
          last_error?: string | null
          last_sync_at?: string | null
          last_timestamp?: string | null
          payout_error?: string | null
          payout_records_synced?: number | null
          payout_sync_at?: string | null
          records_synced?: number | null
          updated_at?: string | null
          wallet?: string
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
      v26_asset_config: {
        Row: {
          asset: string
          created_at: string
          enabled: boolean
          id: string
          price: number
          shares: number
          side: string
          updated_at: string
        }
        Insert: {
          asset: string
          created_at?: string
          enabled?: boolean
          id?: string
          price?: number
          shares?: number
          side?: string
          updated_at?: string
        }
        Update: {
          asset?: string
          created_at?: string
          enabled?: boolean
          id?: string
          price?: number
          shares?: number
          side?: string
          updated_at?: string
        }
        Relationships: []
      }
      v26_config: {
        Row: {
          assets: string[]
          cancel_after_start_sec: number
          config_version: number
          created_at: string
          enabled: boolean
          id: string
          max_lead_time_sec: number
          min_lead_time_sec: number
          price: number
          shares: number
          side: string
          updated_at: string
        }
        Insert: {
          assets?: string[]
          cancel_after_start_sec?: number
          config_version?: number
          created_at?: string
          enabled?: boolean
          id?: string
          max_lead_time_sec?: number
          min_lead_time_sec?: number
          price?: number
          shares?: number
          side?: string
          updated_at?: string
        }
        Update: {
          assets?: string[]
          cancel_after_start_sec?: number
          config_version?: number
          created_at?: string
          enabled?: boolean
          id?: string
          max_lead_time_sec?: number
          min_lead_time_sec?: number
          price?: number
          shares?: number
          side?: string
          updated_at?: string
        }
        Relationships: []
      }
      v26_trades: {
        Row: {
          asset: string
          avg_fill_price: number | null
          created_at: string
          error_message: string | null
          event_end_time: string
          event_start_time: string
          fill_matched_at: string | null
          fill_time_ms: number | null
          filled_shares: number | null
          id: string
          market_id: string
          market_slug: string
          notional: number | null
          order_id: string | null
          placed_at: string | null
          pnl: number | null
          price: number
          result: string | null
          run_id: string | null
          settled_at: string | null
          shares: number
          side: string
          status: string
        }
        Insert: {
          asset: string
          avg_fill_price?: number | null
          created_at?: string
          error_message?: string | null
          event_end_time: string
          event_start_time: string
          fill_matched_at?: string | null
          fill_time_ms?: number | null
          filled_shares?: number | null
          id?: string
          market_id: string
          market_slug: string
          notional?: number | null
          order_id?: string | null
          placed_at?: string | null
          pnl?: number | null
          price?: number
          result?: string | null
          run_id?: string | null
          settled_at?: string | null
          shares?: number
          side?: string
          status?: string
        }
        Update: {
          asset?: string
          avg_fill_price?: number | null
          created_at?: string
          error_message?: string | null
          event_end_time?: string
          event_start_time?: string
          fill_matched_at?: string | null
          fill_time_ms?: number | null
          filled_shares?: number | null
          id?: string
          market_id?: string
          market_slug?: string
          notional?: number | null
          order_id?: string | null
          placed_at?: string | null
          pnl?: number | null
          price?: number
          result?: string | null
          run_id?: string | null
          settled_at?: string | null
          shares?: number
          side?: string
          status?: string
        }
        Relationships: []
      }
    }
    Views: {
      v_dashboard_pnl_summary: {
        Row: {
          claimed_markets: number | null
          last_updated: string | null
          lost_markets: number | null
          markets_bought: number | null
          markets_sold: number | null
          open_markets: number | null
          settled_markets: number | null
          total_cost: number | null
          total_markets: number | null
          total_payout: number | null
          total_realized_pnl: number | null
          wallet: string | null
        }
        Relationships: []
      }
      v_market_pnl: {
        Row: {
          avg_down_cost: number | null
          avg_up_cost: number | null
          confidence: string | null
          down_shares: number | null
          has_buy: boolean | null
          has_redeem: boolean | null
          has_sell: boolean | null
          id: string | null
          is_claimed: boolean | null
          is_lost: boolean | null
          market_id: string | null
          market_slug: string | null
          realized_pnl: number | null
          resolved_outcome: string | null
          settlement_ts: string | null
          state: string | null
          total_cost: number | null
          total_payout: number | null
          up_shares: number | null
          updated_at: string | null
          wallet: string | null
        }
        Relationships: []
      }
      v26_stats: {
        Row: {
          filled_trades: number | null
          last_trade_at: string | null
          losses: number | null
          settled_trades: number | null
          total_invested: number | null
          total_pnl: number | null
          total_trades: number | null
          win_rate_pct: number | null
          wins: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      cleanup_old_logs: { Args: never; Returns: undefined }
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
