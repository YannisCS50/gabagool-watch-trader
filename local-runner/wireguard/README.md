# WireGuard Configuration for Mullvad VPN

## Setup Instructions

1. **Get your Mullvad WireGuard config:**
   - Log into https://mullvad.net/account
   - Go to WireGuard configuration
   - Generate a new key or download an existing config

2. **Place the config file:**
   Copy your Mullvad `.conf` file to `/home/deploy/wireguard/wg0.conf` on your VPS.

## Example wg0.conf (from Mullvad)

```ini
[Interface]
PrivateKey = YOUR_PRIVATE_KEY_HERE
Address = 10.x.x.x/32,fc00:bbbb:bbbb:bb01::x:xxxx/128
DNS = 10.64.0.1

[Peer]
PublicKey = MULLVAD_SERVER_PUBLIC_KEY
AllowedIPs = 0.0.0.0/0,::0/0
Endpoint = MULLVAD_SERVER:51820
```

## Important Notes

- **Never commit** your actual `wg0.conf` with private keys!
- The `AllowedIPs = 0.0.0.0/0` routes ALL traffic through the VPN
- The trading bot uses `network_mode: container:wg` so it shares the WireGuard network namespace

## Verification

After starting, check the bot logs for:
```
✅ VPN verification passed: IP xxx.xxx.xxx.xxx (Mullvad)
```

If you see:
```
❌ VPN verification FAILED
```
The bot will exit immediately to prevent IP leaks.

## Troubleshooting

1. **Check WireGuard is connected:**
   ```bash
   docker exec wg wg show
   ```

2. **Verify external IP from WireGuard:**
   ```bash
   docker exec wg curl https://api.ipify.org
   ```

3. **Check if IP is Mullvad:**
   ```bash
   docker exec wg curl https://am.i.mullvad.net/json
   ```
