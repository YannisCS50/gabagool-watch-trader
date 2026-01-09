import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Subgraph Health Check Endpoint
 * 
 * Returns comprehensive diagnostics:
 * - Wallet configuration
 * - API endpoint status
 * - DB row counts
 * - Sync state per endpoint
 * - Probe results
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DATA_API_BASE = 'https://data-api.polymarket.com';

interface EndpointHealth {
  endpoint: string;
  lastSyncAt: string | null;
  lastSyncOk: boolean;
  lastErrorMessage: string | null;
  lastResponseRowCount: number;
  probeResult: 'success' | 'failed' | 'not_tested';
  probeError?: string;
}

interface HealthReport {
  timestamp: string;
  wallet: {
    configured: boolean;
    address: string | null;
    addressLowercase: string | null;
  };
  endpoints: {
    activity: EndpointHealth;
    positions: EndpointHealth;
  };
  dbCounts: {
    subgraph_fills: number;
    subgraph_positions: number;
    subgraph_pnl_markets: number;
    subgraph_sync_state: number;
  };
  diagnostics: {
    walletMissing: boolean;
    syncNeverRun: boolean;
    syncFailing: boolean;
    noDataIngested: boolean;
    rlsBlocking: boolean;
  };
  recommendations: string[];
}

async function probeEndpoint(
  endpoint: string, 
  wallet: string
): Promise<{ ok: boolean; rowCount: number; error?: string }> {
  try {
    const url = `${DATA_API_BASE}/${endpoint}?user=${wallet}&limit=1`;
    const response = await fetch(url);
    
    if (!response.ok) {
      return { ok: false, rowCount: 0, error: `HTTP ${response.status}: ${response.statusText}` };
    }
    
    const data = await response.json();
    const rowCount = Array.isArray(data) ? data.length : 0;
    
    return { ok: true, rowCount };
  } catch (error) {
    return { ok: false, rowCount: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

// deno-lint-ignore no-explicit-any
async function getDbCount(supabase: any, table: string): Promise<number> {
  try {
    const { count, error } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true });
    
    if (error) {
      console.error(`[health] Count error for ${table}:`, error);
      return -1;
    }
    return count ?? 0;
  } catch {
    return -1;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get wallet configuration
    const { data: config, error: configError } = await supabase
      .from('bot_config')
      .select('polymarket_address')
      .single();

    const wallet = config?.polymarket_address || null;
    const walletLower = wallet?.toLowerCase() || null;

    // Initialize health report
    const report: HealthReport = {
      timestamp: new Date().toISOString(),
      wallet: {
        configured: !!wallet,
        address: wallet,
        addressLowercase: walletLower,
      },
      endpoints: {
        activity: {
          endpoint: `${DATA_API_BASE}/activity`,
          lastSyncAt: null,
          lastSyncOk: false,
          lastErrorMessage: null,
          lastResponseRowCount: 0,
          probeResult: 'not_tested',
        },
        positions: {
          endpoint: `${DATA_API_BASE}/positions`,
          lastSyncAt: null,
          lastSyncOk: false,
          lastErrorMessage: null,
          lastResponseRowCount: 0,
          probeResult: 'not_tested',
        },
      },
      dbCounts: {
        subgraph_fills: 0,
        subgraph_positions: 0,
        subgraph_pnl_markets: 0,
        subgraph_sync_state: 0,
      },
      diagnostics: {
        walletMissing: !wallet,
        syncNeverRun: true,
        syncFailing: false,
        noDataIngested: true,
        rlsBlocking: false,
      },
      recommendations: [],
    };

    // Probe endpoints if wallet is configured
    if (wallet) {
      console.log('[health] Probing activity endpoint...');
      const activityProbe = await probeEndpoint('activity', wallet);
      report.endpoints.activity.probeResult = activityProbe.ok ? 'success' : 'failed';
      report.endpoints.activity.probeError = activityProbe.error;
      report.endpoints.activity.lastResponseRowCount = activityProbe.rowCount;

      console.log('[health] Probing positions endpoint...');
      const positionsProbe = await probeEndpoint('positions', wallet);
      report.endpoints.positions.probeResult = positionsProbe.ok ? 'success' : 'failed';
      report.endpoints.positions.probeError = positionsProbe.error;
      report.endpoints.positions.lastResponseRowCount = positionsProbe.rowCount;
    }

    // Get DB counts
    console.log('[health] Fetching DB counts...');
    report.dbCounts.subgraph_fills = await getDbCount(supabase, 'subgraph_fills');
    report.dbCounts.subgraph_positions = await getDbCount(supabase, 'subgraph_positions');
    report.dbCounts.subgraph_pnl_markets = await getDbCount(supabase, 'subgraph_pnl_markets');
    report.dbCounts.subgraph_sync_state = await getDbCount(supabase, 'subgraph_sync_state');

    // Get sync state
    if (walletLower) {
      const { data: syncStates } = await supabase
        .from('subgraph_sync_state')
        .select('*')
        .ilike('wallet', walletLower);

      if (syncStates && syncStates.length > 0) {
        report.diagnostics.syncNeverRun = false;

        for (const state of syncStates) {
          const type = state.id.includes('fills') ? 'activity' : 'positions';
          const endpoint = report.endpoints[type as keyof typeof report.endpoints];
          
          endpoint.lastSyncAt = state.last_sync_at;
          endpoint.lastSyncOk = !state.last_error;
          endpoint.lastErrorMessage = state.last_error;
          
          if (state.last_error) {
            report.diagnostics.syncFailing = true;
          }
        }
      }
    }

    // Update diagnostics
    report.diagnostics.noDataIngested = 
      report.dbCounts.subgraph_fills === 0 && 
      report.dbCounts.subgraph_positions === 0;

    // Check for RLS blocking (negative count means error)
    if (report.dbCounts.subgraph_fills === -1 || report.dbCounts.subgraph_positions === -1) {
      report.diagnostics.rlsBlocking = true;
    }

    // Generate recommendations
    if (report.diagnostics.walletMissing) {
      report.recommendations.push('Configure wallet address in bot_config table');
    }
    if (report.diagnostics.syncNeverRun) {
      report.recommendations.push('Click "Sync Now" to trigger initial data fetch');
    }
    if (report.diagnostics.syncFailing) {
      report.recommendations.push('Check sync errors - API may be unreachable or wallet format incorrect');
    }
    if (report.diagnostics.noDataIngested && !report.diagnostics.syncNeverRun) {
      report.recommendations.push('Sync ran but no data ingested - check if wallet has trading activity');
    }
    if (report.diagnostics.rlsBlocking) {
      report.recommendations.push('Database access error - check RLS policies or service role key');
    }
    if (report.endpoints.activity.probeResult === 'failed') {
      report.recommendations.push(`Activity API probe failed: ${report.endpoints.activity.probeError}`);
    }
    if (report.endpoints.positions.probeResult === 'failed') {
      report.recommendations.push(`Positions API probe failed: ${report.endpoints.positions.probeError}`);
    }

    console.log('[health] Health check complete:', JSON.stringify(report.diagnostics));

    return new Response(
      JSON.stringify(report),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[health] Error:', error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
