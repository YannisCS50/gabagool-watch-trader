# Polymarket BTC 15m CLOB Bot

Production-ready Polymarket CLOB trading bot for BTC Up/Down 15-minute markets. The bot waits until a market is tradable, preflights the order book, places a limit order, and persists state so each slug is traded only once.

## Checklist
- [ ] Create `.env` from `.env.example`
- [ ] Set GitHub Secrets for deployment
- [ ] Run `docker compose up -d --build` on the VPS once
- [ ] Push to `main` to auto-deploy

## Local run

```bash
cp .env.example .env
npm install
npm start
```

## VPS setup (one-time)

1) Clone the repo on the VPS:
```bash
git clone <YOUR_GITHUB_REPO_URL> /opt/polymarket-bot
cd /opt/polymarket-bot/polymarket-bot
```

2) Create `.env` from the template:
```bash
cp .env.example .env
nano .env
```

3) Start the bot:
```bash
docker compose up -d --build
```

## GitHub Actions secrets

Set these in your GitHub repo settings:
- `VPS_HOST`
- `VPS_USER`
- `VPS_SSH_KEY` (private key PEM)
- `VPS_PATH` (e.g. `/opt/polymarket-bot`)

## Deploy flow

1) Commit and push to `main`.
2) GitHub Actions connects to the VPS, pulls the latest `main`, and runs `docker compose up -d --build`.

## Environment variables

See `.env.example` for required values:
- `PK`: wallet private key
- `CLOB_API_KEY`: CLOB API key
- `CLOB_API_SECRET`: CLOB API secret
- `CLOB_API_PASSPHRASE`: CLOB API passphrase
- `SIGNATURE_TYPE`: default `0`
- `DESIRED_OUTCOME`: `Up` or `Down`
- `SIDE`: `BUY` or `SELL`
- `PRICE`: limit price
- `SIZE`: size
- `POLL_MS`: polling interval (default 1500)
- `MAX_WAIT_MS`: maximum wait for new event (default 300000)
- `STATE_FILE`: state file path (default `/data/state.json`)

## Notes

- The bot will **not** place an order until `getOrderBook(tokenId)` succeeds.
- If the orderbook does not exist, it retries every 750ms.
- State is persisted in `/data/state.json` using atomic writes.
