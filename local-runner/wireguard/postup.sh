#!/bin/bash
set -euo pipefail

WG_IF="wg0"

# Detect default WAN route (Docker bridge)
WAN_GW="$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')"
WAN_IF="$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')"

# Detect endpoint from wireguard runtime state
ENDPOINT="$(wg show "$WG_IF" endpoints 2>/dev/null | awk 'NR==1 {print $2}')"
ENDPOINT_HOST="${ENDPOINT%:*}"
ENDPOINT_PORT="${ENDPOINT##*:}"

# Resolve endpoint to IP if needed
ENDPOINT_IP="$ENDPOINT_HOST"
if [[ -n "${ENDPOINT_HOST:-}" ]] && ! [[ "$ENDPOINT_HOST" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  ENDPOINT_IP="$(getent ahostsv4 "$ENDPOINT_HOST" 2>/dev/null | awk 'NR==1 {print $1}')"
fi

DNS_IP="10.64.0.1"

echo "[postup] WG_IF=$WG_IF WAN_IF=${WAN_IF:-?} WAN_GW=${WAN_GW:-?} ENDPOINT=${ENDPOINT:-?} ENDPOINT_IP=${ENDPOINT_IP:-?}" 

# Route endpoint over WAN so the tunnel can stay up
if [[ -n "${ENDPOINT_IP:-}" ]] && [[ -n "${WAN_GW:-}" ]] && [[ -n "${WAN_IF:-}" ]]; then
  ip route replace "$ENDPOINT_IP/32" via "$WAN_GW" dev "$WAN_IF" || true
fi

# Route all other IPv4 traffic via wg0 (wg-quick style split default)
ip route replace 0.0.0.0/1 dev "$WG_IF"
ip route replace 128.0.0.0/1 dev "$WG_IF"

# (Optional) IPv6 split default if the interface has v6
if ip -6 addr show dev "$WG_IF" | grep -q "inet6"; then
  ip -6 route replace ::/1 dev "$WG_IF" || true
  ip -6 route replace 8000::/1 dev "$WG_IF" || true
fi

# Kill-switch rules (idempotent)
iptables -P OUTPUT DROP
iptables -P FORWARD DROP
iptables -P INPUT ACCEPT

iptables -C OUTPUT -o lo -j ACCEPT 2>/dev/null || iptables -A OUTPUT -o lo -j ACCEPT
iptables -C OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Allow all egress via the tunnel
iptables -C OUTPUT -o "$WG_IF" -j ACCEPT 2>/dev/null || iptables -A OUTPUT -o "$WG_IF" -j ACCEPT

# Allow WireGuard handshake traffic to endpoint over WAN
if [[ -n "${ENDPOINT_IP:-}" ]] && [[ -n "${ENDPOINT_PORT:-}" ]] && [[ -n "${WAN_IF:-}" ]]; then
  iptables -C OUTPUT -o "$WAN_IF" -p udp -d "$ENDPOINT_IP" --dport "$ENDPOINT_PORT" -j ACCEPT 2>/dev/null \
    || iptables -A OUTPUT -o "$WAN_IF" -p udp -d "$ENDPOINT_IP" --dport "$ENDPOINT_PORT" -j ACCEPT
fi

# Allow DNS via tunnel
iptables -C OUTPUT -o "$WG_IF" -p udp -d "$DNS_IP" --dport 53 -j ACCEPT 2>/dev/null || iptables -A OUTPUT -o "$WG_IF" -p udp -d "$DNS_IP" --dport 53 -j ACCEPT
iptables -C OUTPUT -o "$WG_IF" -p tcp -d "$DNS_IP" --dport 53 -j ACCEPT 2>/dev/null || iptables -A OUTPUT -o "$WG_IF" -p tcp -d "$DNS_IP" --dport 53 -j ACCEPT

# NAT
iptables -t nat -D POSTROUTING -o "$WG_IF" -j MASQUERADE 2>/dev/null || true
iptables -t nat -A POSTROUTING -o "$WG_IF" -j MASQUERADE

echo "[postup] Routing + kill-switch applied."
