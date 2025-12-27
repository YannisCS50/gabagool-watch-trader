# WireGuard Configuration for Mullvad VPN

## Setup Instructions

1. **Get your Mullvad WireGuard config**
   - Log into https://mullvad.net/account
   - Go to WireGuard configuration
   - Generate/download a config for your chosen location

2. **Place the config file in this repo folder on your VPS**
   This docker-compose mounts `local-runner/wireguard` into the VPN container at `/config`.

   Create:
   - `local-runner/wireguard/wg_confs/wg0.conf`

3. **Enable kill-switch + routing via PostUp/PostDown**
   Your `wg0.conf` should include:

   ```ini
   [Interface]
   PostUp = /config/postup.sh
   PostDown = /config/postdown.sh
   ```

   These scripts are included here:
   - `local-runner/wireguard/postup.sh`
   - `local-runner/wireguard/postdown.sh`

## Example wg0.conf (from Mullvad)

```ini
[Interface]
PrivateKey = YOUR_PRIVATE_KEY_HERE
Address = 10.x.x.x/32,fc00:bbbb:bbbb:bb01::x:xxxx/128
DNS = 10.64.0.1
PostUp = /config/postup.sh
PostDown = /config/postdown.sh

[Peer]
PublicKey = MULLVAD_SERVER_PUBLIC_KEY
AllowedIPs = 0.0.0.0/0,::0/0
Endpoint = MULLVAD_SERVER:51820
```

## Important Notes

- **Never commit** your actual `wg0.conf` with private keys!
- `AllowedIPs = 0.0.0.0/0` means we *intend* to route all traffic via the VPN.
- The `postup.sh` script enforces this at the network level (routes + kill-switch).

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
