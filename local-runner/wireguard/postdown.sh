#!/bin/bash
set -euo pipefail

WG_IF="wg0"

# Remove split default routes (ignore errors)
ip route del 0.0.0.0/1 dev "$WG_IF" 2>/dev/null || true
ip route del 128.0.0.0/1 dev "$WG_IF" 2>/dev/null || true
ip -6 route del ::/1 dev "$WG_IF" 2>/dev/null || true
ip -6 route del 8000::/1 dev "$WG_IF" 2>/dev/null || true

# Reset iptables policies to allow traffic (container is stopping)
iptables -P OUTPUT ACCEPT
iptables -P FORWARD ACCEPT
iptables -P INPUT ACCEPT

# Best-effort cleanup of NAT
iptables -t nat -D POSTROUTING -o "$WG_IF" -j MASQUERADE 2>/dev/null || true

echo "[postdown] Routing + kill-switch removed."
