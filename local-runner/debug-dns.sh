#!/bin/sh
set -eu

echo "---- /etc/resolv.conf ----"
cat /etc/resolv.conf || true

echo "---- /etc/hosts ----"
cat /etc/hosts || true

echo "---- ip route ----"
ip route || true

echo "---- getent hosts clob.polymarket.com ----"
getent hosts clob.polymarket.com || true

echo "---- nslookup clob.polymarket.com (1.1.1.1) ----"
nslookup clob.polymarket.com 1.1.1.1 || true

echo "---- curl -I https://clob.polymarket.com/auth/api-keys ----"
curl -sS -I --max-time 10 https://clob.polymarket.com/auth/api-keys || true

echo "---- curl https://api.ipify.org ----"
curl -sS --max-time 10 https://api.ipify.org && echo
