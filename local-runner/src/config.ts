import * as dotenv from 'dotenv';
import fs from 'node:fs';

// Ensure we load the same env file in all run modes (docker + manual npm start).
// Priority:
// 1) DOTENV_CONFIG_PATH (dotenv convention)
// 2) ENV_FILE (our convenience)
// 3) /home/deploy/secrets/local-runner.env (default server path)
// 4) .env (project default)
const envCandidates = [
  process.env.DOTENV_CONFIG_PATH,
  process.env.ENV_FILE,
  '/home/deploy/secrets/local-runner.env',
  '.env',
].filter(Boolean) as string[];

let loadedEnvPath: string | null = null;
for (const p of envCandidates) {
  try {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p });
      loadedEnvPath = p;
      break;
    }
  } catch {
    // ignore
  }
}

if (!loadedEnvPath) {
  // Fall back to default dotenv behavior (current working directory)
  dotenv.config();
  loadedEnvPath = 'default';
}

console.log(`✅ Loaded env from: ${loadedEnvPath}`);

export const config = {
  backend: {
    url: process.env.BACKEND_URL!,
    secret: process.env.RUNNER_SHARED_SECRET!,
  },
  polymarket: {
    apiKey: process.env.POLYMARKET_API_KEY!,
    apiSecret: process.env.POLYMARKET_API_SECRET!,
    passphrase: process.env.POLYMARKET_PASSPHRASE!,
    privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
    address: process.env.POLYMARKET_ADDRESS!,
  },
  vpn: {
    // Default ON: only disable explicitly with VPN_REQUIRED=false
    required: (process.env.VPN_REQUIRED ?? 'true') !== 'false',
    // Optional: hard-pin expected egress IP (e.g. Mullvad exit IP)
    expectedEgressIp: process.env.EXPECTED_EGRESS_IP || null,
  },
  trading: {
    assets: (process.env.TRADE_ASSETS || 'BTC').split(','),
    maxNotionalPerTrade: parseFloat(process.env.MAX_NOTIONAL_PER_TRADE || '5'),
    openingMaxPrice: parseFloat(process.env.OPENING_MAX_PRICE || '0.52'),
    // Rate limiting / backoff
    minOrderIntervalMs: parseInt(process.env.MIN_ORDER_INTERVAL_MS || '1500', 10),
    cloudflareBackoffMs: parseInt(process.env.CLOUDFLARE_BACKOFF_MS || '60000', 10),
  },
};

// Validate required config
const required = [
  ['BACKEND_URL', config.backend.url],
  ['RUNNER_SHARED_SECRET', config.backend.secret],
  ['POLYMARKET_API_KEY', config.polymarket.apiKey],
  ['POLYMARKET_API_SECRET', config.polymarket.apiSecret],
  ['POLYMARKET_PASSPHRASE', config.polymarket.passphrase],
  ['POLYMARKET_PRIVATE_KEY', config.polymarket.privateKey],
  ['POLYMARKET_ADDRESS', config.polymarket.address],
];

for (const [name, value] of required) {
  if (!value || value.includes('your_')) {
    console.error(`❌ Missing or invalid config: ${name}`);
    process.exit(1);
  }
}

console.log('✅ Config loaded successfully');
