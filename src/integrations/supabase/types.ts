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
