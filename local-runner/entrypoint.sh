#!/bin/sh
set -eu

if [ "${SKIP_DNS_CHECK:-0}" = "1" ]; then
  echo "[startup] SKIP_DNS_CHECK=1 -> skipping DNS preflight"
  exec "$@"
fi

TARGET="${DNS_CHECK_HOST:-clob.polymarket.com}"
TIMEOUT_SECONDS="${DNS_CHECK_TIMEOUT_SECONDS:-30}"
INTERVAL_SECONDS="${DNS_CHECK_INTERVAL_SECONDS:-2}"

echo "[startup] DNS preflight: resolving ${TARGET} (timeout ${TIMEOUT_SECONDS}s)"

end=$(( $(date +%s) + TIMEOUT_SECONDS ))

while true; do
  if getent hosts "$TARGET" >/dev/null 2>&1; then
    echo "[startup] DNS OK: $(getent hosts "$TARGET" | head -n 1)"
    break
  fi

  now="$(date +%s)"
  if [ "$now" -ge "$end" ]; then
    echo "[startup] DNS FAILED after ${TIMEOUT_SECONDS}s: ${TARGET}" >&2
    echo "---- /etc/resolv.conf ----" >&2
    cat /etc/resolv.conf >&2 || true
    echo "---- /etc/hosts ----" >&2
    cat /etc/hosts >&2 || true
    echo "---- ip route ----" >&2
    ip route >&2 || true
    echo "---- nslookup (1.1.1.1) ----" >&2
    nslookup "$TARGET" 1.1.1.1 >&2 || true
    echo "---- nslookup (8.8.8.8) ----" >&2
    nslookup "$TARGET" 8.8.8.8 >&2 || true
    exit 1
  fi

  sleep "$INTERVAL_SECONDS"
done

exec "$@"
