# Polymarket Live Trader - Local/VPS Runner

Deze standalone Node.js applicatie voert live trades uit op Polymarket vanaf je eigen machine of VPS. Dit omzeilt de Cloudflare blokkade die optreedt bij requests vanuit cloud servers.

## ⚠️ Waarschuwing

**Dit is een LIVE trading bot die ECHT geld gebruikt!** Test eerst met kleine bedragen.

## Vereisten

- Node.js 18+ of Bun
- Polymarket account met API credentials
- Supabase service role key (uit je Lovable project)

## Installatie

```bash
cd local-runner
npm install
```

## Configuratie

1. Kopieer `.env.example` naar `.env`:
```bash
cp .env.example .env
```

2. Vul je credentials in:

### Supabase credentials
- `SUPABASE_URL`: Al ingevuld (je project URL)
- `SUPABASE_SERVICE_ROLE_KEY`: Vind je in Lovable → Settings → Cloud → Advanced

### Polymarket credentials
Haal deze op via de Polymarket developer portal of je bestaande setup:
- `POLYMARKET_API_KEY`
- `POLYMARKET_API_SECRET`  
- `POLYMARKET_PASSPHRASE`
- `POLYMARKET_PRIVATE_KEY` (je wallet private key)

### Trading settings (optioneel)
- `TRADE_ASSETS`: Welke assets te traden (default: `BTC`)
- `MAX_NOTIONAL_PER_TRADE`: Max $ per trade (default: `5`)
- `OPENING_MAX_PRICE`: Max prijs voor opening trade (default: `0.52`)

## Starten

```bash
# Productie
npm start

# Development (auto-reload)
npm run dev
```

## Wat doet de runner?

1. **Haalt actieve markten op** via je Supabase edge function
2. **Verbindt met Polymarket CLOB WebSocket** voor real-time prijzen
3. **Evalueert trade opportunities** met dezelfde strategie als de cloud bot
4. **Voert trades uit** direct naar Polymarket (vanaf jouw IP)
5. **Slaat trades op** in je Supabase database

## Draaien op VPS

### Met PM2 (aanbevolen)
```bash
npm install -g pm2
pm2 start npm --name "poly-trader" -- start
pm2 save
pm2 startup
```

### Met systemd
Maak `/etc/systemd/system/poly-trader.service`:
```ini
[Unit]
Description=Polymarket Live Trader
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/local-runner
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable poly-trader
sudo systemctl start poly-trader
```

## Logs bekijken

```bash
# PM2
pm2 logs poly-trader

# systemd
journalctl -u poly-trader -f
```

## Stoppen

```bash
# Direct
Ctrl+C

# PM2
pm2 stop poly-trader

# systemd
sudo systemctl stop poly-trader
```

## Troubleshooting

### "Cloudflare blocked"
Je IP wordt nog steeds geblokkeerd. Probeer:
- VPN uitschakelen
- Andere VPS provider
- Wacht 24 uur en probeer opnieuw

### "Connection failed"
Check je API credentials in `.env`

### Geen trades
Bekijk de console output - de bot logt waarom hij trades skipt (bijv. "too close to expiry", "price too high")
