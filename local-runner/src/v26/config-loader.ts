// ============================================================
// V26 CONFIG LOADER - Fetches config from database
// ============================================================

import { V26_CONFIG } from './defaults.js';

export interface V26DbConfig {
  id: string;
  enabled: boolean;
  max_lead_time_sec: number;
  min_lead_time_sec: number;
  cancel_after_start_sec: number;
  config_version: number;
  updated_at: string;
}

export interface V26AssetConfig {
  asset: string;
  enabled: boolean;
  shares: number;
  price: number;
  side: 'UP' | 'DOWN';
}

// Runtime config - starts with defaults, updated from DB
export const runtimeConfig = {
  enabled: V26_CONFIG.enabled,
  maxLeadTimeSec: V26_CONFIG.maxLeadTimeSec,
  minLeadTimeSec: V26_CONFIG.minLeadTimeSec,
  cancelAfterStartSec: V26_CONFIG.cancelAfterStartSec,
  configVersion: 0,
  // Per-asset config
  assetConfigs: new Map<string, V26AssetConfig>(),
};

// Initialize with defaults
for (const asset of V26_CONFIG.assets) {
  runtimeConfig.assetConfigs.set(asset, {
    asset,
    enabled: true,
    shares: V26_CONFIG.shares,
    price: V26_CONFIG.price,
    side: V26_CONFIG.side as 'UP' | 'DOWN',
  });
}

// Track current version for hot-reload detection
let currentConfigVersion = 0;

/**
 * Fetch config from database via runner-proxy
 */
export async function fetchV26Config(): Promise<{ global: V26DbConfig; assets: V26AssetConfig[] } | null> {
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
      return {
        global: json.data as V26DbConfig,
        assets: json.assetConfigs || [],
      };
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
  const result = await fetchV26Config();

  if (result) {
    const { global: dbConfig, assets } = result;
    
    runtimeConfig.enabled = dbConfig.enabled;
    runtimeConfig.maxLeadTimeSec = dbConfig.max_lead_time_sec;
    runtimeConfig.minLeadTimeSec = dbConfig.min_lead_time_sec;
    runtimeConfig.cancelAfterStartSec = dbConfig.cancel_after_start_sec;
    runtimeConfig.configVersion = dbConfig.config_version;
    currentConfigVersion = dbConfig.config_version;

    // Load per-asset configs
    for (const asset of assets) {
      runtimeConfig.assetConfigs.set(asset.asset, {
        asset: asset.asset,
        enabled: asset.enabled,
        shares: asset.shares,
        price: Number(asset.price),
        side: asset.side,
      });
    }

    console.log('[V26 Config] Loaded from database:');
    console.log(`  - Global Enabled: ${runtimeConfig.enabled}`);
    console.log(`  - Timing: place ${runtimeConfig.maxLeadTimeSec}s-${runtimeConfig.minLeadTimeSec}s before, cancel ${runtimeConfig.cancelAfterStartSec}s after`);
    console.log(`  - Config Version: ${runtimeConfig.configVersion}`);
    console.log(`  - Per-asset configs:`);
    for (const [asset, cfg] of runtimeConfig.assetConfigs) {
      console.log(`    ${asset}: ${cfg.enabled ? '✅' : '❌'} ${cfg.side} ${cfg.shares} shares @ $${cfg.price}`);
    }
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
  const result = await fetchV26Config();
  
  if (!result) return false;
  
  // Check if version changed
  if (result.global.config_version === currentConfigVersion) {
    return false; // No change
  }

  // Version changed - reload!
  console.log('');
  console.log('🔄 ═══════════════════════════════════════════════════════════');
  console.log(`   CONFIG CHANGED! v${currentConfigVersion} → v${result.global.config_version}`);
  console.log('═══════════════════════════════════════════════════════════════');
  
  await loadV26Config();
  
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  📊 NEW ACTIVE CONFIGURATION                                  ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Global:   ${runtimeConfig.enabled ? 'ENABLED ✅' : 'DISABLED ❌'}`.padEnd(66) + '║');
  for (const [asset, cfg] of runtimeConfig.assetConfigs) {
    const line = `║  ${asset}:       ${cfg.enabled ? '✅' : '❌'} ${cfg.side.padEnd(4)} ${String(cfg.shares).padStart(2)} shares @ $${cfg.price.toFixed(2)}`;
    console.log(line.padEnd(66) + '║');
  }
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
 * Get asset-specific config
 */
export function getAssetConfig(asset: string): V26AssetConfig | undefined {
  return runtimeConfig.assetConfigs.get(asset);
}

/**
 * Get list of enabled assets
 */
export function getEnabledAssets(): string[] {
  return Array.from(runtimeConfig.assetConfigs.entries())
    .filter(([_, cfg]) => cfg.enabled)
    .map(([asset, _]) => asset);
}

/**
 * Get current config version
 */
export function getConfigVersion(): number {
  return currentConfigVersion;
}
