# Assembly Rooms: how it's set up

The live setup of Light It at the venue (as of September 2026), and how to check
and change it.

## Network (UniFi)

| Network | VLAN | Range | What's on it |
| --- | --- | --- | --- |
| Production | 10 | 10.10.10.0/24, router 10.10.10.1 | the Pi (10.10.10.30), Companion, web UI |
| Production ArtNet | 20 | 10.10.20.0/24 (DHCP) | the Botex dimmer, the Pi's Art-Net interface, later the Avo's Art-Net port |

Switch ports:

| Port | Native VLAN | Tagged VLANs |
| --- | --- | --- |
| Pi | Production (10) | Production ArtNet (20) allowed |
| Botex | Production ArtNet (20) | Block All |
| Ordinary devices | their network | Block All |
| Uplinks, access points | as needed | keep the VLANs they carry |

Art-Net broadcasts don't cross VLANs or the router. Anything that sends or receives
them must be on VLAN 20.

## The Pi

- **Hostname:** `ac-production-pi-1`, reach it at `pi@10.10.10.30`. The `.local`
  name may not resolve from other networks.
- **`eth0`:** Production, 10.10.10.30 by DHCP. This is its only default route.
- **`eth0.20`:** NetworkManager connection `artnet-vlan20`, on VLAN 20.
  - It gets a DHCP address (10.10.20.50), set never-default.
  - It also has **169.254.50.51/16**, the address the Botex needs packets to come from.
- **Services:** Light It is the `scene-setter` systemd service, web UI on
  http://10.10.10.30:8080. Companion runs on the same Pi, on port 8000.
- **Config:** `/opt/scene-setter/shared/config.jsonc`
- **Data:** `/opt/scene-setter/shared/data/`
- **Logs:** `journalctl -u scene-setter -f`

Recreate the VLAN interface if the Pi is rebuilt:

```bash
sudo nmcli connection add type vlan con-name artnet-vlan20 ifname eth0.20 dev eth0 id 20 \
  ipv4.method auto ipv4.never-default yes ipv4.ignore-auto-dns yes \
  ipv4.addresses 169.254.50.51/16 ipv6.method disabled connection.autoconnect yes
sudo nmcli connection up artnet-vlan20
```

## The Botex dimmer

The Botex DPX-1210T NET is set to Art-Net SubNet 0 / Universe 0, with its channels
assigned to protocol A. It has **no IP address**. It only responds to
`255.255.255.255` sent from a 169.254.x.x address. This was proven on 2026-09-15:
with the app stopped, that one packet form alone took the lamps to full and back to
off. Every other form was ignored. The README has the full table.

Its output in the config:

```jsonc
{ "name": "Botex", "ip": "255.255.255.255", "source": "169.254.50.51", "port": 6454, "universes": [0] }
```

That's one packet per update, out of `eth0.20` only. Check it on the Pi:

```bash
sudo tcpdump -n -i any udp port 6454
# eth0.20 Out IP 169.254.50.51.6454 > 255.255.255.255.6454: UDP, length 530
```

Nothing should appear on `eth0`.

## The desk (not installed yet)

- **Config:** the desk IP is `10.10.20.10`, on the Art-Net VLAN. Set the Avo to
  that address, or change **Config → Console IP** to whatever it uses.
- **Network:** its Art-Net port must be on VLAN 20. To drive the Botex directly, the
  desk must also send `255.255.255.255` from a 169.254.x.x address.
- **Check:** with the desk outputting, the Dashboard shows **Desk live**. Switch it
  off, and after about 1 second the Dashboard shows **Holding desk look**.

## Companion

1. In the web UI, open **Companion** → **Download module**.
2. In Companion (http://10.10.10.30:8000), go to **Modules** → **Import module
   package**. A newer package replaces the old one.
3. Add a **Light It** connection with IP `127.0.0.1` and port `8080`.

## Deploying an update

From a laptop that can reach the Pi, on a clean, committed checkout:

```bash
scripts/deploy.sh pi@10.10.10.30
```

The SSH and sudo password is `raspberry`. The deploy:

- builds the UI and the Companion module
- backs up the database
- installs, restarts and checks health, and rolls back if unhealthy

Config and data are never touched. It won't add a second 169.254 address, because
the Pi already has one on `eth0.20`.

The release name shows the git commit it came from, with `-dirty` if there were
uncommitted changes. See what's live:

```bash
ssh pi@10.10.10.30 readlink /opt/scene-setter/current
```
