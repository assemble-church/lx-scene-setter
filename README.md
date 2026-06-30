# Art-Net Scene Setter

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
- **Desk goes away →** within a second it **takes over** and runs your recorded
  scenes, crossfading smoothly from whatever the desk left on stage (no flash to
  black).

Crucially it sits **alongside** the desk, never inline — so if the Pi ever fails,
the desk still controls the rig directly. The Pi is purely additive insurance.

## Features

- **Automatic console failover** with a configurable timeout.
- **Seamless crossfade** from the desk's last look into the house scenes on handoff.
- **Record scenes** straight from the live desk output, persisted to disk.
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

## How it works

```
                 ┌───────────── Art-Net ─────────────┐
   Lighting  ────┤  desk live: drives the rig         │────► DMX nodes
   console       │  (Pi watches & records)            │      (Chauvet, dimmers…)
                 └────────────────────────────────────┘
                                  │  desk goes silent (timeout)
                                  ▼
   Pi Scene  ─── takes over, crossfades to recorded house scenes ───► DMX nodes
   Setter         (recall / toggle scenes from a Stream Deck via OSC)
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
      { "name": "Botex Dimmer",     "ip": "10.10.20.2", "universes": [1] }
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
| `/scenes/off` `[fade]` | fade every scene out |
| `/output/on` · `/output/off` | enable / disable Pi output |
| `/scene-setter/console-override` `<0\|1\|2>` | force console **0**=off · **1**=on · **2**=auto (default) |
| `/state` | push all feedback to the targets now |

### Feedback — sent to `companion.feedbackTargets`

Pushed on change, on startup, and on a slow heartbeat so Companion always converges.

| Address | Value |
| --- | --- |
| `/scene-setter/scene/<id>/active` | int `0`/`1`/`2` = off / on / fading (one per recorded scene) |
| `/scene-setter/scene/<id>/fade-remaining` | float — seconds left in *that scene's* fade |
| `/scene-setter/console-active` | int `0/1` — effective console-in-control state (override applied) |
| `/scene-setter/console-override` | string `off` / `on` / `auto` |
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

The included [Generic OSC](https://bitfocus.io/connections/generic-osc) module is
all you need.

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
| `<prefix>active_scenes` | comma-separated on-scene ids |
| `<prefix>scene_<id>_fade_remaining` | that scene's own fade, 1 d.p. |

## Network / Art-Net topology

The Pi sits **alongside** the desk, never inline. Patch each node to accept
Art-Net from **both** the desk and the Pi (any node does this; only one source is
active at a time).

```
Console ──┬──────────────► Node A  (e.g. universes 2-5)
          ├──────────────► Node B  (e.g. universe 1)
          └──────────────► Pi Scene Setter  (records all universes)

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

## Troubleshooting

- **Companion connection shows red** — its Source/listen port clashes with
  something (often `12321`, Companion's own listener). Use a free port like `9001`.
- **No feedback in Companion** — check OSC is reaching `companion.listenPort`, and
  for custom variables that they exist and OSC is enabled in Companion settings.
- **Scene recall does nothing** — the desk is considered live; check
  `/scene-setter/console-active`, or force `console-override` to `0` for testing.
- **A node won't light on failover** — confirm it accepts Art-Net from the Pi's IP
  and the universe numbers match; watch `journalctl -u scene-setter -f`.

## Notes & limitations

- Designed for **intensity** channels (dimmers) using HTP merging. It's not a
  moving-light console — there's no per-attribute LTP/colour logic.
- It never blacks out on exit, so a service restart won't drop a live venue.
- Scenes are full snapshots stored as JSON (`data/scenes.json`); small and
  human-inspectable, written atomically.

## License

MIT — provided as-is, no warranty. Lighting is safety-relevant in some venues;
test your failover before relying on it.
