# Light It

A small, reliable **house-lighting controller with automatic console failover**,
for buildings that use a proper lighting desk *sometimes* but need simple,
dependable wall/button control the rest of the time — churches, halls, theatres,
multi-purpose rooms.

It runs on a Raspberry Pi, speaks **Art-Net**, and is driven over **OSC** (built
for [Bitfocus Companion](https://bitfocus.io/companion) / Stream Deck).

## The problem it solves

A typical venue has a lighting console (an Avolites desk, etc.) that's only fired
up for services or events. The rest of the week — cleaners, meetings, setup,
kids' groups — someone just needs "lights on" from a wall panel, without booting
a desk or knowing how to drive it.

This box sits on the lighting network and does both, automatically:

- **Desk is live →** it gets out of the way and lets the console run the rig,
  while quietly watching so it can *record* looks straight off the desk.
- **Desk goes away →** within a second it **takes over and holds the desk's last
  look** — nothing changes on stage. When you're ready, press a scene and it
  crossfades out of the held look (hold on fail).

Crucially it sits **alongside** the desk, never inline — so if the Pi ever fails,
the desk still controls the rig directly. The Pi is purely additive insurance.

## Features

- **Automatic console failover** with a configurable timeout.
- **Hold on fail** — the desk's last look stays up (and survives a Pi restart) until
  a scene is pressed, which crossfades out of it.
- **Desk detection on the dashboard** — desk live / holding / house control, packet
  rate, universes heard, and a warning if Art-Net arrives from a different IP.
- **Record scenes** straight from the live desk output — every universe the desk
  sends (0–255) — persisted to disk.
- **HTP scene layers** — scenes stack like submasters: turn one off and it only
  drops the channels it alone was holding up. Each layer toggles independently
  with its own fade time.
- **Rich OSC feedback** for Companion: per-scene on/off/fading state, live fade
  countdowns, console status — as both OSC feedbacks and (optionally) Companion
  custom variables.
- **Manual console override** (force on/off/auto) for testing or special cases.
- **Art-Net discovery** (answers ArtPoll) so a unicasting desk will send it the
  universes it needs, and it shows up in tools like DMX Workshop.
- **Production-ready**: atomic crash-safe writes, runs as a systemd service with
  auto-restart and boot start, never blacks out on restart.
- **Fixture library & patching** — import Avolites personalities, patch fixtures
  (with counts, auto-addressing and per-channel snap/fade), and give each an icon.
- **Web-based moving-light programmer** — an Avolites-style fixture grid and a
  live programmer for building looks (intensity, colour, pan/tilt, gobo…) and
  saving them straight to scenes, all in the browser.
- **Sequences** — record a chase or effect straight off the desk; Light It works out
  the loop by itself (layered shape generators included, no patch needed), then plays
  it back with fades from the Dashboard or Companion, alongside scenes.
- **Dashboard console** — favourite scenes as fader strips, live scenes, sequence
  pads with loop dials, live universe grids and an activity log.
- **Companion module** — served by the app itself (Companion page → Download), with
  live scene/sequence dropdowns, feedbacks, variables and presets.
- **Terminal Art-Net monitor** — a standalone CLI to visualise any Art-Net stream.

## How it works

```
                 ┌───────────── Art-Net ─────────────┐
   Lighting  ────┤  desk live: drives the rig         │────► DMX nodes
   console       │  (Pi watches & records)            │      (Chauvet, dimmers…)
                 └────────────────────────────────────┘
                                  │  desk goes silent (timeout)
                                  ▼
   Pi:       ─── takes over, HOLDS the desk's last look ───► DMX nodes
   Light It       press a scene (Stream Deck via OSC) → crossfade out of the hold
```

Scenes are **HTP layers**. The output of each DMX channel is the highest value
across all active layers, so layers stack cleanly and a scene storing `0` on a
channel never pulls another scene down.

## Requirements

- A Raspberry Pi (tested on **Pi 5 running Raspberry Pi OS Lite**, Bookworm).
  Anything that runs Node 18+ on the lighting network will do.
- **Node.js 18+**.
- Art-Net nodes (any brand) and, optionally, a lighting console that outputs Art-Net.
- A machine running Bitfocus Companion (or any OSC controller).

## Installation

### Deploying from a dev machine (recommended)

From a checkout on your laptop:

```bash
scripts/deploy.sh                       # → pi@ac-production-pi-1.local
scripts/deploy.sh pi@10.10.10.30        # or any user@host (the venue Pi)
```

The same command does the first install and every update. It builds the UI and the
Companion module locally, copies the app over SSH, and on the Pi (via `sudo`):

1. installs Node 22 and 7-Zip if missing, and creates a `scene-setter` system user,
2. unpacks a new release into `/opt/scene-setter/releases/<id>` and installs
   production deps (reused from the previous release when the lockfile is unchanged),
3. checks the new code loads and the existing config validates — before touching
   the running service,
4. backs up `config.jsonc` + `scene-setter.db` to `/opt/scene-setter/backups/<id>`,
5. runs `npm run migrate` if the package defines one,
6. switches `/opt/scene-setter/current` to the new release, restarts the service,
   and **rolls back automatically** if it isn't healthy within ~30s.

Config and data live outside the releases and are never overwritten by a deploy:

| Path | Contents |
| --- | --- |
| `/opt/scene-setter/shared/config.jsonc` | venue config (created from the example on first install only) |
| `/opt/scene-setter/shared/data/` | `scene-setter.db` (scenes, patch, layout, state), `fixtures.db` (library) |
| `/opt/scene-setter/current` | symlink to the live release (last 5 kept) |

The `scene-setter` systemd service starts on boot, restarts on any crash
(`Restart=always`, no rate limit) and can only write to `shared/`. Manual
rollback: `sudo ln -sfn /opt/scene-setter/releases/<id> /opt/scene-setter/current && sudo systemctl restart scene-setter`.

### Installing from a git clone on the Pi

On the Pi:

```bash
# 1. Dependencies (Pi OS Lite is minimal)
sudo apt update
sudo apt install -y git
# Node 20 LTS (the distro's node may be too old):
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 2. Get the code
git clone https://github.com/assemble-church/lx-scene-setter.git /opt/scene-setter
cd /opt/scene-setter

# 3. Install (deps + config + systemd service)
./scripts/install.sh
```

The installer:

1. checks for Node,
2. installs production dependencies,
3. creates `config.jsonc` from the example (if missing) — **edit it for your network**,
4. creates the `data/` directory,
5. installs and enables a `scene-setter` **systemd** service (auto-restart, starts on boot).

Then set your network details and restart:

```bash
sudo nano /opt/scene-setter/config.jsonc
sudo systemctl restart scene-setter
journalctl -u scene-setter -f          # watch the logs
```

### Updating

```bash
cd /opt/scene-setter
git pull
./scripts/install.sh                    # idempotent; re-runs deps + service
```

Once running, the **web control panel** is at `http://<pi-ip>:8080`.

### Running manually (development)

```bash
npm install            # engine deps
npm install --prefix ui   # UI deps (first time only)

npm run dev            # runs BOTH: the engine (DMX/OSC/WS, auto-restart) and the
                       # Vite UI dev server with hot-reload, in one terminal
```
Then open the **Vite URL it prints** (`http://localhost:5173`) for the hot-reloading
UI — it proxies `/api` and `/ws` to the engine on `:8080`. The engine's own port
(`:8080`) serves the *built* UI in production.

Production build + run (what the Pi does):
```bash
npm run build          # builds ui/ → ui/dist (served by the engine)
npm start              # engine only; UI served at :8080
```

## Web UI

The control panel at `http://<pi-ip>:8080` (or the Vite dev URL) is a dark,
single-page app; every page shares one live WebSocket to the engine.

### Dashboard
At-a-glance state: desk detection, the scene console (favourites and live
scenes as fader strips), sequence pads, live universe grids and a rolling
activity log.

### Companion
Download the Light It Companion module (with setup steps), plus the full reference
of OSC commands, OSC feedback paths and custom variables, and the scene/sequence ids.

### Scenes
All recorded scenes with inline label editing. Per scene: **Activate / Deactivate**
(with fade), **Record** (snapshot the current output), **Edit** (opens the fixture
programmer with that scene loaded — see below), raw-JSON edit, and delete.

### Sequences
Chases and effects recorded from the desk, looped by the Pi. No patch needed.

1. Play the chase on the desk, press **New sequence**, then **Record**. A live scope
   shows what the recorder is learning: a dial per effect where each pass lands on
   the last once the period is right, an XY trail for anything that looks like
   pan/tilt (16-bit channels two apart), and swatches for anything that looks like
   RGB.
2. Recording **stops by itself** once every effect has come round about three times,
   predicts frames it wasn't fitted on, and two analyses in a row agree. You can
   stop sooner, or turn auto stop off. Takes are capped at 5 minutes.
3. **Review**: keep or drop each effect, and choose whether the **still look**
   (lit channels that didn't move, e.g. blue house lights) comes with it. Name it
   and save.

How it's analysed: each moving channel is modelled as one or more repeating
shapes, so layered shape generators with unrelated speeds keep looping correctly
however long they run. 16-bit pairs are detected from the data. Channels that
never repeat loop the whole take.

How it plays: press a Dashboard pad (or send OSC). It fades in and out. Its moving
channels override scenes on those channels (latest started sequence wins where two
overlap); its still look joins the HTP merge like a scene. Several can run at once.
All off stops sequences too; solo recalls stop them.

### Fixtures — the programmer
An Avolites-style grid where each patched fixture (or dimmer-pack **head**) is a cell:

- **Live icons** — each cell shows a fixture-type icon (par, moving-head beam /
  wash, chandelier, LED tape, LED panel) **tinted by that fixture's live output**
  (colour + dim level), updating in real time.
- **Hover** a cell for a card with manufacturer, model, mode, universe, start
  address and channel range.
- **Right-click → Move** (then click another cell to place; swaps if occupied) to
  arrange the grid to match the room. The layout is saved in the database;
  with no map yet, fixtures are laid out in patch order.
- **Right-click → Locate** to throw a fixture into a known, visible state
  (intensity full, pan/tilt centred, open white, shutter open).
- **Click a fixture** to open the **programmer** — an editor sweeps up from the
  bottom with purpose-built controls per attribute: a vertical **dimmer** fader,
  an HSV **colour mixer** (or colour-wheel swatches), a **pan/tilt XY pad**, and
  tile/radio pickers for gobo / prism / shutter / etc. (with a **rate slider** when
  a slot is a continuous scale such as strobe or spin speed) — plus a **raw
  per-channel fader bank**.
- **Shift-click several** fixtures (or heads) and release Shift → the editor opens
  on the whole selection. Controls are unified **by role**, so one Dimmer drives
  every intensity channel across mixed fixture types, one colour control drives them
  all — including **cross-model** (a colour-wheel pick tints RGB fixtures; an RGB
  mix snaps colour wheels to their nearest slot).

**How the programmer behaves:** starting to edit **captures the current live look**,
stops the underlying scenes (stashing which were up), and takes over output — OSC
scene commands are locked while it's live. **Save scene** stores the look (update an
existing scene — the one you were editing is offered first — or create a new one),
then releases the programmer and restores whatever was playing. **Clear programmer**
discards and restores.

### Universes
Live DMX grids for every universe (colour-mapped by value) — exactly what's on the
wire, desk or house.

### Patch & Personalities
- **Import a fixture library** by uploading Avolites' personality `.exe`; the Pi
  extracts and parses it (~21k fixtures) into a local SQLite database, searchable by
  manufacturer / name. *You supply your own file — no library is distributed.*
- **Patch** fixtures to a universe / address, with a **count** for consecutive
  patching and a smart next-free-address suggestion (wraps universes when full).
- **Dimmer packs** without a library — *+ Dimmer pack* adds a generic N-channel
  dimmer (one head per channel), optionally with the last channels switched, e.g. a
  Botex 12-channel with 1–10 dimmed and 11–12 as hot power.
- **Per-channel type** (*Channels*):
  - **Level** — normal; ramps with crossfades, or **snaps** (auto-derived from the
    personality, overridable) so shutters and control channels jump.
  - **Switch** — on/off only, for non-dim loads and hot power. Output is always 0 or
    255 (≥50% = on); it comes on the moment a scene starts fading in and only goes off
    once the scene has fully faded out, so power is never cut under a fading lamp. In
    the programmer it's an ON/OFF control and never follows a dimmer fader.
- **Assign an icon** per fixture and **split dimmer packs into heads** so each
  channel shows as its own light on the Fixtures grid.
- A live **patch grid** visualises the addressing.

### Config
Edit `config.jsonc` from the browser — a **form** (console, Art-Net + output nodes,
Companion feedback / variables, timing) or the **raw** annotated file, both validated
on save, with a restart button (in production).

## Configuration (`config.jsonc`)

Config is **grouped by concern** and supports `//` and `/* */` **comments**.
`config.jsonc` is gitignored, so upgrades never overwrite your settings. Full
annotated template: [`config.example.jsonc`](config.example.jsonc).

```jsonc
{
  // The lighting console we fail over from
  "console": {
    "ip": "10.10.20.10",        // desk's IP — also the source filter for recording
    "timeoutMs": 1000,          // silence before the desk is considered "lost"
    "defaultScene": "1",        // scene recalled on handoff if nothing else is on
    "defaultFade": 3            // crossfade seconds on handoff / startup
  },

  // Art-Net / DMX network
  "artnet": {
    "port": 6454,               // listen + send port (standard Art-Net)
    "localIp": "",              // IP advertised in ArtPollReply; blank = auto-detect
    "universes": 6,             // universe count (valid numbers 0..universes-1)
    "channels": 512,
    "outputs": [                // nodes the Pi drives on failover ("port" optional)
      { "name": "Chauvet Net-X II", "ip": "10.10.20.1", "universes": [2, 3, 4, 5] },
      // "source": send ONE packet per update from this Pi address (see Botex below)
      { "name": "Botex", "ip": "255.255.255.255", "source": "169.254.50.51", "universes": [0] }
    ]
  },

  // Companion / OSC control surface
  "companion": {
    "listenPort": 9000,         // we listen here for OSC commands (Companion "send" target)
    "feedbackTargets": [        // where we push /scene-setter/* feedback
      { "ip": "10.10.20.50", "port": 9001 }
    ],
    "customVariables": {        // optional: set Companion custom variables via its OSC API
      "enabled": false,
      "ip": "10.10.20.50",
      "port": 12321,            // Companion's OSC listener
      "prefix": "house_"        // prepended to variable names
    }
  },

  // Engine timing (rarely changed)
  "timing": {
    "fadeFrameMs": 40,
    "keepAliveMs": 1000,
    "startupGraceMs": 1500,
    "feedbackHeartbeatMs": 5000
  },

  "dataDir": "./data"
}
```

## OSC reference

Fade times are the **first OSC argument** (e.g. `3`), the trailing address
segment (legacy), or `0`.

### Control — send to `companion.listenPort` (default `9000`)

| Address | Action |
| --- | --- |
| `/scene/<id>/rec` | record current output as scene `<id>` (allowed even while the desk is live) |
| `/scene/<id>/on` `[fade]` | turn scene `<id>` on |
| `/scene/<id>/off` `[fade]` | turn scene `<id>` off (other layers hold their channels) |
| `/scene/<id>/toggle` `[fade]` | flip scene `<id>` |
| `/scene/<id>/play` `[fade]` | **solo** `<id>` — turn it on and all others off (full-look button) |
| `/scene/<id>/level` `<0–1 or 0–100>` `[fade]` | set scene `<id>` to a partial level (0 = off); what the dashboard faders send |
| `/scenes/off` `[fade]` | fade every scene out (and any held desk look) |
| `/sequence/<id>/on` · `/off` · `/toggle` `[fade]` | run / stop sequence `<id>` |
| `/sequences/off` `[fade]` | stop every sequence (scenes untouched) |
| `/hold/release` `[fade]` | crossfade out of the held desk look to whatever scenes are on |
| `/output/on` · `/output/off` | enable / disable Pi output |
| `/scene-setter/console-override` `<0\|1\|2>` | force console **0**=off · **1**=on · **2**=auto (default) |
| `/state` | push all feedback to the targets now |

### Feedback — sent to `companion.feedbackTargets`

Pushed on change, on startup, and on a slow heartbeat so Companion always converges.

| Address | Value |
| --- | --- |
| `/scene-setter/scene/<id>/active` | int `0`/`1`/`2` = off / on / fading (one per recorded scene) |
| `/scene-setter/scene/<id>/fade-remaining` | float — seconds left in *that scene's* fade |
| `/scene-setter/sequence/<id>/active` | int `0`/`1`/`2` = off / running / fading |
| `/scene-setter/active-sequences` | comma-separated running sequence ids |
| `/scene-setter/console-active` | int `0/1` — effective console-in-control state (override applied) |
| `/scene-setter/console-override` | string `off` / `on` / `auto` |
| `/scene-setter/holding` | int `0/1` — the desk went away and its last look is being held |
| `/scene-setter/status` | `PRODUCTION_CONSOLE_ACTIVE` / `BUILDING_CONTROL_ACTIVE` |
| `/scene-setter/active-scenes` | comma-separated on-scene ids |
| `/scene-setter/pi-output` | int `0/1` |
| `/scene-setter/fade-active` | int `0/1` (any fade running) |
| `/scene-setter/fade-remaining` · `/fade-total` | float — longest active fade |
| `/scene-setter/recorded` | string scene id (one-shot on record) |
| `/scene-setter/error` | string message |

> **Record tip:** record each scene with the other layers **down**, so it only
> captures its own channels (a record snapshots the *current merged output*).

## Companion setup

### The Light It module (recommended)

The app serves its own Companion module: open **Companion** in the web UI and
press **Download module**, then in Companion choose **Modules → Import module
package** and add a **Light It** connection with the Pi's IP and web port (8080).
It brings actions with live scene/sequence dropdowns, feedbacks (on / fading /
desk live / holding), its own variables (fade countdown, levels, names) and
ready-made presets: per scene a toggle and a **solo toggle** (solo, or off if it's
already on), a **Sequences** submenu, All off, desk status and override buttons. The
same page lists every OSC command and feedback path. Importing a newer module
package in Companion replaces the old one; existing buttons keep their actions.

The module lives in `companion/`. `npm run build` (and the deploy script) builds
`companion/lightit.tgz`, bumping the module's patch version whenever its source
has changed since the last build (tracked in `companion/.build-fingerprint`);
bump minor/major by hand in `companion/package.json`. Commit the version bump.

### Raw OSC (Generic OSC module)

Without the module, the included [Generic OSC](https://bitfocus.io/connections/generic-osc)
module works too.

1. **Connection** → *Generic: OSC* → Target `=` the Pi's IP, Target port `9000`,
   *Listen for Feedback* on, Source port `9001`.
   > Don't use `12321` for the source port — that's Companion's own OSC listener.

2. **Buttons (control)** — action *Send float* (the float is the fade time), e.g.
   - Toggle a scene: `/scene/1/toggle` value `3`
   - All off: `/scenes/off` value `2`
   - Record (no args): *Send message without arguments* → `/scene/1/rec`

3. **Button feedback (no variables needed)** — *Listen for OSC messages (Integer)*:
   - Scene button colour: path `/scene-setter/scene/1/active`, Equal `1` → green
     (on), `2` → amber (fading), `0` → red (off).
   - Console indicator: path `/scene-setter/console-active`, Equal `1` → "DESK LIVE".

4. **Numbers as text (needs a variable)** — a generic-OSC feedback can't render a
   received value as text, so to show a fade countdown either:
   - enable `companion.customVariables` and create matching Companion custom
     variables (see below) — then show `$(custom:<prefix>fade_remaining)`; or
   - drive a custom variable from a Companion trigger watching the OSC path.

### Optional: Companion custom variables

With `companion.customVariables.enabled`, the app pushes values straight into
Companion custom variables via its OSC API (enable **OSC** in Companion settings,
and **create the variables first** — Companion ignores a set to a non-existent
variable). Names are `prefix` + the key below:

| Variable | Value |
| --- | --- |
| `<prefix>fade_remaining` | longest active fade, 1 d.p. |
| `<prefix>fade_active` | `0` / `1` |
| `<prefix>console_active` | `0` / `1` |
| `<prefix>console_override` | `off` / `on` / `auto` |
| `<prefix>holding` | `0` / `1` — desk look held after the desk went away |
| `<prefix>active_scenes` | comma-separated on-scene ids |
| `<prefix>scene_<id>_fade_remaining` | that scene's own fade, 1 d.p. |

## Network / Art-Net topology

The Pi sits **alongside** the desk, never inline. Patch each node to accept
Art-Net from **both** the desk and the Pi (any node does this; only one source is
active at a time).

```
Console ──┬──────────────► Node A  (e.g. universes 2-5)
          ├──────────────► Node B  (e.g. universe 1)
          └──────────────► Pi: Light It     (records all universes)

Pi (on console loss) ────► Node A + Node B   (unicast, takes over)
```

**Getting all universes to the Pi for recording** — either:

- **Unicast + ArtPoll (preferred):** the Pi answers ArtPoll advertising itself as
  an output node for the universes in `outputs`; a unicasting console then sends
  those universes to it too. No broadcast.
- **Broadcast (fallback):** set the console to broadcast Art-Net.

On startup the Pi logs `Art-Net: receiving universe N from desk …` the first time
it sees each universe — use that to confirm the numbering matches your patch (some
consoles are 0-based, some 1-based).

### How outputs are sent

Each output's `ip` (and optional `source`) decides who receives the traffic —
**Config → Art-Net → How outputs are sent** shows exactly how each saved output
leaves the machine:

| Output | Mode | What goes on the wire |
| --- | --- | --- |
| `ip` = the node's own IP | direct (unicast) | one packet, only that node receives it — **use this whenever you can** |
| `ip` = a network's broadcast, e.g. `10.10.20.255` | subnet broadcast | one packet to every device on that network |
| `ip` blank or `255.255.255.255` | broadcast | from **every** Pi address, to both `255.255.255.255` and that address's subnet broadcast — the widest net, for finding out what a node accepts |
| `ip` + `source` (a Pi address) | one packet | exactly one packet from that address to `ip`, nothing else — for nodes that only accept one form |

Updates go once a second when idle, ~25/s during fades and ~50/s while a sequence
runs (530 bytes each). All Art-Net is sent from port 6454.

### Art-Net on its own VLAN

A node with no IP (like the Botex below) can only be reached by broadcast, so keep
that broadcast off the production network with a VLAN rather than fighting it:

- **Art-Net VLAN** (e.g. VLAN 20): the node's switch port has it as the native
  (untagged) network, with tagged VLANs blocked. The desk's Art-Net port joins it too.
- **The Pi's switch port**: native = the production network (for the web UI and
  Companion), plus the Art-Net VLAN **tagged**. On the Pi that's a VLAN interface
  (NetworkManager, e.g. `eth0.20`) — broadcasts sent from it stay on the Art-Net VLAN.
- On other device ports, set tagged VLANs to **Block All**, but keep them allowed on
  uplinks between switches, access points and the Pi's port.

Broadcasts never cross VLANs or routers: every sender and receiver of Art-Net
broadcast has to be on the same VLAN. See [`docs/VENUE.md`](docs/VENUE.md) for the
Assembly Rooms setup.

### Botex DPX NET dimmers (no IP address)

The Botex DPX-1210T NET has no IP settings and, in testing, **no usable IP address**:
it never answers ArtPoll, doesn't announce an address when it powers up, doesn't
answer ARP anywhere in `169.254.0.0/16`, and isn't on DHCP. It is driven purely by
broadcast, and it's picky about the form. Tested one packet form at a time with the
app stopped, watching the lamps (Sep 2026):

| Sender → destination | Botex |
| --- | --- |
| a 169.254.x.x address → `255.255.255.255` | **responds** |
| a 169.254.x.x address → `169.254.255.255` | ignored |
| a normal LAN address → `255.255.255.255` | ignored |
| a normal LAN address → its subnet broadcast | ignored |

So it takes the limited broadcast, but only from a sender with a link-local
(169.254) address, from port 6454. To drive one:

1. On the dimmer: set its Art-Net SubNet/Universe, and **SETUP → Protocol Assign**
   each channel to **A** — confirm with ENTER; ESC or a 5 s timeout discards.
2. Give the Pi a `169.254.x.x/16` address on the network the Botex is on — ideally a
   VLAN interface on an Art-Net VLAN (above). Without one, `scripts/deploy.sh` adds
   `169.254.50.50/16` to the Pi's main port (saved in NetworkManager; skipped if the
   Pi already has a 169.254 address anywhere; override with
   `LINK_LOCAL_ADDR=169.254.x.y/16`, disable with `LINK_LOCAL_ADDR=none`).
3. Output: `ip` `255.255.255.255`, `source` = that 169.254 address, universe as set
   on the dimmer. One packet per update, on that network only.

`scripts/find-devices.js` finds nodes that answer ARP (a range sweep) or announce
themselves at power-up (`--listen`, needs tcpdump + sudo) — useful for other kit, but
it can't find a Botex, which does neither.

The lighting desk has the same constraint: to reach a Botex it must also send
`255.255.255.255` from a 169.254.x.x address on the Art-Net network.

## Terminal Art-Net monitor

`artnet-monitor.js` is a standalone, dependency-free CLI that turns any terminal
into an Art-Net receiver / visualiser — handy for confirming what this controller
(or a desk) is actually putting on the wire.

```bash
node artnet-monitor.js --u 6          # visualise 6 universes (0..5)
node artnet-monitor.js --u 2 --port 6455
./artnet-monitor.js --u 4             # it's executable too
```

Flags: `--u` universe count (default 4), `--port` (default 6454), `--host`
(default 0.0.0.0). It goes full-screen and draws every channel as a live `[000]`
grid — one block per universe with an **alternating dark / grey background** and a
`● live / ○ idle` header — values colour-graded by level. Ctrl-C to quit.

Because the controller already listens on 6454, to watch it on the **same machine**
run the monitor on another port and add a matching **Art-Net output** in Config
(e.g. `ip 127.0.0.1, port 6455`). On a different machine, use the default 6454 and
point an output at its IP.

## Troubleshooting

- **Companion connection shows red** — its Source/listen port clashes with
  something (often `12321`, Companion's own listener). Use a free port like `9001`.
- **No feedback in Companion** — check OSC is reaching `companion.listenPort`, and
  for custom variables that they exist and OSC is enabled in Companion settings.
- **Scene recall does nothing** — the desk is considered live; check
  `/scene-setter/console-active`, or force `console-override` to `0` for testing.
- **A node won't light on failover** — confirm it accepts Art-Net from the Pi's IP
  and the universe numbers match; watch `journalctl -u scene-setter -f`.
- **See exactly what the Pi sends** — `sudo tcpdump -n -i any udp port 6454` on the Pi
  (interface, source → destination per packet).
- **Botex stopped responding** — it needs `255.255.255.255` from a 169.254.x.x source
  on the network it's plugged into: check the output's `source` exists on the Pi
  (`ip -4 addr`) and that the dimmer's switch port is on the same VLAN as that
  interface. Config → Art-Net warns when the `source` address isn't on the Pi.

## Notes & limitations

- **Scene playback is HTP** — scenes are full-output snapshots merged
  highest-takes-precedence, ideal for intensity / house looks. The **programmer**
  (Fixtures page) adds per-fixture, per-attribute editing (colour, pan/tilt, gobo…)
  for *building* looks, but live scene **layering** is still HTP — it's not a full
  tracking moving-light console.
- It never blacks out on exit, so a service restart won't drop a live venue.
- Scenes, the patch, the Fixtures-grid layout and which scenes are on live in one
  SQLite database, `data/scene-setter.db` (WAL, fully synced writes). Schema changes
  are numbered migrations applied automatically on start. The first start after
  upgrading imports the old `scenes.json` / `state.json` / `patch.json` /
  `fixture-map.json` and renames them to `*.migrated`. The imported fixture library
  stays in its own `data/fixtures.db`; config stays in `config.jsonc`.

## License

MIT — provided as-is, no warranty. Lighting is safety-relevant in some venues;
test your failover before relying on it.
