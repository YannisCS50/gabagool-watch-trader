import { config } from './config.js';

/**
 * VPN Verification Module
 *
 * Ensures all bot traffic goes through VPN before starting.
 * If VPN is not active, the process exits immediately (fail-closed).
 */

interface VpnCheckResult {
  passed: boolean;
  ip: string;
  provider: string | null;
  error?: string;
}

interface MullvadApiResponse {
  ip: string;
  mullvad_exit_ip: boolean;
  mullvad_exit_ip_hostname?: string;
  blacklisted?: {
    blacklisted: boolean;
  };
}

const KNOWN_MULLVAD_RANGES = [
  '45.83.220.',
  '45.83.221.',
  '45.83.222.',
  '45.83.223.',
  '141.98.252.',
  '141.98.253.',
  '141.98.254.',
  '141.98.255.',
  '185.195.232.',
  '185.195.233.',
  '185.213.154.',
  '185.213.155.',
  '193.27.12.',
  '193.27.13.',
  '194.127.199.',
  '194.127.200.',
  '198.54.128.',
  '198.54.129.',
  '199.229.248.',
  '199.229.249.',
  // Add more Mullvad ranges as needed
];

/**
 * Check if an IP appears to be from Mullvad based on known ranges
 */
function looksLikeMullvadIp(ip: string): boolean {
  return KNOWN_MULLVAD_RANGES.some(range => ip.startsWith(range));
}

/**
 * Verify that we're connected through Mullvad VPN
 * Uses multiple verification methods for reliability
 */
export async function verifyVpnConnection(): Promise<VpnCheckResult> {
  console.log('🔐 Starting VPN verification...');
  
  // Method 1: Use Mullvad's official check API
  try {
    const mullvadResponse = await fetch('https://am.i.mullvad.net/json', {
      signal: AbortSignal.timeout(10000),
    });
    
    if (mullvadResponse.ok) {
      const data: MullvadApiResponse = await mullvadResponse.json();
      
      if (data.mullvad_exit_ip) {
        return {
          passed: true,
          ip: data.ip,
          provider: `Mullvad (${data.mullvad_exit_ip_hostname || 'unknown server'})`,
        };
      }
      
      // Not a Mullvad IP
      return {
        passed: false,
        ip: data.ip,
        provider: null,
        error: 'IP is not a Mullvad exit node',
      };
    }
  } catch (error) {
    console.warn('⚠️ Mullvad API check failed, trying fallback...');
  }
  
  // Method 2: Fallback to ipify + heuristic check
  try {
    const ipifyResponse = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(10000),
    });
    
    if (ipifyResponse.ok) {
      const { ip } = await ipifyResponse.json();
      
      if (looksLikeMullvadIp(ip)) {
        return {
          passed: true,
          ip,
          provider: 'Mullvad (detected by IP range)',
        };
      }
      
      return {
        passed: false,
        ip,
        provider: null,
        error: 'IP does not match known Mullvad ranges',
      };
    }
  } catch (error) {
    console.error('❌ All IP checks failed');
  }
  
  return {
    passed: false,
    ip: 'unknown',
    provider: null,
    error: 'Could not determine external IP - network may be down',
  };
}

/**
 * Run VPN check and exit if not connected
 * This is the main entry point called at bot startup
 */
export async function enforceVpnOrExit(): Promise<void> {
  // Default ON: only disable explicitly with VPN_REQUIRED=false
  if (!config.vpn.required) {
    console.log('⚠️ VPN check disabled (VPN_REQUIRED=false)');
    return;
  }

  const result = await verifyVpnConnection();

  const expected = config.vpn.expectedEgressIp;
  const expectedMismatch = !!expected && result.ip !== 'unknown' && result.ip !== expected;

  if (result.passed && !expectedMismatch) {
    console.log(`✅ VPN verification passed: IP ${result.ip} (${result.provider})`);
    console.log('🔒 All traffic will route through VPN');
    return;
  }

  const extra = expectedMismatch ? ` (expected ${expected})` : '';

  console.error('');
  console.error('╔══════════════════════════════════════════════════════════════╗');
  console.error('║  ❌ VPN VERIFICATION FAILED - EXITING TO PREVENT IP LEAK     ║');
  console.error('╠══════════════════════════════════════════════════════════════╣');
  console.error(`║  Detected IP: ${(`${result.ip}${extra}`).padEnd(46)}║`);
  console.error(`║  Error: ${(result.error || 'Unknown').padEnd(51)}║`);
  console.error('║                                                              ║');
  console.error('║  The trading bot requires VPN to be active.                  ║');
  console.error('║  Fix WireGuard routing before starting the runner.           ║');
  console.error('╚══════════════════════════════════════════════════════════════╝');
  console.error('');

  process.exit(1);
}

