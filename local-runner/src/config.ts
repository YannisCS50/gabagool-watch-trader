import 'dotenv/config';

export const config = {
  supabase: {
    url: process.env.SUPABASE_URL!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  },
  polymarket: {
    apiKey: process.env.POLYMARKET_API_KEY!,
    apiSecret: process.env.POLYMARKET_API_SECRET!,
    passphrase: process.env.POLYMARKET_PASSPHRASE!,
    privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
  },
  trading: {
    assets: (process.env.TRADE_ASSETS || 'BTC').split(','),
    maxNotionalPerTrade: parseFloat(process.env.MAX_NOTIONAL_PER_TRADE || '5'),
    openingMaxPrice: parseFloat(process.env.OPENING_MAX_PRICE || '0.52'),
  },
};

// Validate required config
const required = [
  ['SUPABASE_URL', config.supabase.url],
  ['SUPABASE_SERVICE_ROLE_KEY', config.supabase.serviceRoleKey],
  ['POLYMARKET_API_KEY', config.polymarket.apiKey],
  ['POLYMARKET_API_SECRET', config.polymarket.apiSecret],
  ['POLYMARKET_PASSPHRASE', config.polymarket.passphrase],
  ['POLYMARKET_PRIVATE_KEY', config.polymarket.privateKey],
];

for (const [name, value] of required) {
  if (!value || value.includes('your_')) {
    console.error(`❌ Missing or invalid config: ${name}`);
    process.exit(1);
  }
}

console.log('✅ Config loaded successfully');
