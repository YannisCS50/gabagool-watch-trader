// ============================================================
// V26 CONFIG LOADER - Fetches config from database
// ============================================================

import { V26_CONFIG } from './index.js';

export interface V26DbConfig {
  id: string;
  shares: number;
  price: number;
  side: 'UP' | 'DOWN';
  assets: string[];
  enabled: boolean;
  max_lead_time_sec: number;
  min_lead_time_sec: number;
  cancel_after_start_sec: number;
  config_version: number;
  updated_at: string;
}

// Runtime config - starts with defaults, updated from DB
export const runtimeConfig = {
  shares: V26_CONFIG.shares,
  price: V26_CONFIG.price,
  side: V26_CONFIG.side as 'UP' | 'DOWN',
  assets: [...V26_CONFIG.assets] as string[],
  enabled: V26_CONFIG.enabled,
  maxLeadTimeSec: V26_CONFIG.maxLeadTimeSec,
  minLeadTimeSec: V26_CONFIG.minLeadTimeSec,
  cancelAfterStartSec: V26_CONFIG.cancelAfterStartSec,
  configVersion: 0,
};

// Track current version for hot-reload detection
let currentConfigVersion = 0;

/**
 * Fetch config from database via runner-proxy
 */
export async function fetchV26Config(): Promise<V26DbConfig | null> {
  const runnerProxyUrl = process.env.RUNNER_PROXY_URL;
  const runnerSecret = process.env.RUNNER_SECRET;

  if (!runnerProxyUrl || !runnerSecret) {
    console.log('[V26 Config] No RUNNER_PROXY_URL or RUNNER_SECRET, using defaults');
    return null;
  }

  try {
    const res = await fetch(runnerProxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-runner-secret': runnerSecret,
      },
      body: JSON.stringify({ action: 'get-v26-config' }),
    });

    if (!res.ok) {
      console.error('[V26 Config] Failed to fetch:', res.status, res.statusText);
      return null;
    }

    const json = await res.json();
    if (json.success && json.data) {
      return json.data as V26DbConfig;
    }

    console.log('[V26 Config] No config found in database');
    return null;
  } catch (err) {
    console.error('[V26 Config] Error fetching config:', err);
    return null;
  }
}

/**
 * Load config from database and update runtime config
 */
export async function loadV26Config(): Promise<boolean> {
  const dbConfig = await fetchV26Config();

  if (dbConfig) {
    runtimeConfig.shares = dbConfig.shares;
    runtimeConfig.price = Number(dbConfig.price);
    runtimeConfig.side = dbConfig.side;
    runtimeConfig.assets = dbConfig.assets;
    runtimeConfig.enabled = dbConfig.enabled;
    runtimeConfig.maxLeadTimeSec = dbConfig.max_lead_time_sec;
    runtimeConfig.minLeadTimeSec = dbConfig.min_lead_time_sec;
    runtimeConfig.cancelAfterStartSec = dbConfig.cancel_after_start_sec;
    runtimeConfig.configVersion = dbConfig.config_version;
    currentConfigVersion = dbConfig.config_version;

    console.log('[V26 Config] Loaded from database:');
    console.log(`  - Enabled: ${runtimeConfig.enabled}`);
    console.log(`  - Side: ${runtimeConfig.side}`);
    console.log(`  - Shares: ${runtimeConfig.shares}`);
    console.log(`  - Price: $${runtimeConfig.price}`);
    console.log(`  - Assets: ${runtimeConfig.assets.join(', ')}`);
    console.log(`  - Timing: place ${runtimeConfig.maxLeadTimeSec}s-${runtimeConfig.minLeadTimeSec}s before, cancel ${runtimeConfig.cancelAfterStartSec}s after`);
    console.log(`  - Config Version: ${runtimeConfig.configVersion}`);
    return true;
  } else {
    console.log('[V26 Config] Using hardcoded defaults');
    return false;
  }
}

/**
 * Check if config has changed and reload if needed
 * Returns true if config was reloaded
 */
export async function checkAndReloadConfig(): Promise<boolean> {
  const dbConfig = await fetchV26Config();
  
  if (!dbConfig) return false;
  
  // Check if version changed
  if (dbConfig.config_version === currentConfigVersion) {
    return false; // No change
  }

  // Version changed - reload!
  console.log('');
  console.log('🔄 ═══════════════════════════════════════════════════════════');
  console.log(`   CONFIG CHANGED! v${currentConfigVersion} → v${dbConfig.config_version}`);
  console.log('═══════════════════════════════════════════════════════════════');
  
  await loadV26Config();
  
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  📊 NEW ACTIVE CONFIGURATION                                  ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Enabled:  ${runtimeConfig.enabled ? 'YES ✅' : 'NO ❌'}`.padEnd(66) + '║');
  console.log(`║  Side:     ${runtimeConfig.side} @ $${runtimeConfig.price}`.padEnd(66) + '║');
  console.log(`║  Shares:   ${runtimeConfig.shares} per trade`.padEnd(66) + '║');
  console.log(`║  Assets:   ${runtimeConfig.assets.join(', ')}`.padEnd(66) + '║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  
  return true;
}

/**
 * Get current runtime config
 */
export function getV26Config() {
  return runtimeConfig;
}

/**
 * Get current config version
 */
export function getConfigVersion(): number {
  return currentConfigVersion;
}
