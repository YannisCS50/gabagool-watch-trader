import 'dotenv/config';

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
  trading: {
    assets: (process.env.TRADE_ASSETS || 'BTC').split(','),
    maxNotionalPerTrade: parseFloat(process.env.MAX_NOTIONAL_PER_TRADE || '5'),
    openingMaxPrice: parseFloat(process.env.OPENING_MAX_PRICE || '0.52'),
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
