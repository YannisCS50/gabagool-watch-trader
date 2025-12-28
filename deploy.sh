#!/bin/bash
# deploy.sh - Update en herstart de trading bot (WireGuard blijft draaien)

set -e

cd /home/deploy/app

echo "📥 Pulling latest code..."
git pull

echo "🔨 Building runner..."
docker compose build runner

echo "🔄 Restarting runner (WireGuard stays up)..."
docker compose up -d --no-deps runner

echo "✅ Done! Showing logs..."
docker logs -f trading-bot
