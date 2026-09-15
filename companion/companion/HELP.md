# Light It

Run the house lighting from a Stream Deck (or any Companion surface): scenes,
sequences and the desk hand-over, with live button colours.

## Setup
1. Note the address you open Light It's web UI on (e.g. `http://10.10.20.30:8080`).
2. Add this connection and enter that **IP address** and **Web port**, plus the
   **default fade** your buttons should use.
3. The status goes green once it can reach Light It.

Every variable is created automatically, and scene and sequence lists update
live: new scenes appear in the dropdowns and presets without restarting anything.

## Actions
- **Scene: on / off / toggle** — with a fade.
- **Scene: solo** — this scene on, everything else off (a full look).
- **Scene: solo toggle** — solo, or turn the scene off if it's already on.
- **Scene: set level** — 0–100%, with a fade.
- **Scene: record** — snapshot the current output into a scene.
- **All off** — every scene and sequence fades out.
- **Sequence: run / stop / toggle**, **Sequences: stop all**.
- **Desk: release held look** — after the desk goes away, its last look is held until you take over.
- **Desk: override** — Auto (detect the desk), On (desk in control), Off (ignore the desk).
- **Output: enable / disable**.

While the desk is live (or a scene is being edited in the web UI), scene and
sequence commands are ignored; the **Controls are locked** feedback shows it.

## Feedbacks
- **Scene is… / Sequence is…** — on, fading, on-or-fading, or off.
- **Desk is in control**, **Desk's last look is held**, **Desk override is…**
- **A fade is running**, **Controls are locked**.

## Presets
One toggle and one solo toggle per scene (green when on, amber while fading, with
the level); a **Sequences** submenu with one toggle per sequence and **Stop all
sequences**; **All off**; a **Desk
status** button (green house / amber holding / red desk live; press to release a
held look), a fade countdown and the three override modes.

## Variables
`desk`, `desk_live`, `holding`, `console_override`, `fade_remaining`,
`active_scenes`, `active_sequences`; per scene `scene_<id>_name`,
`scene_<id>_state`, `scene_<id>_level`; per sequence `seq_<id>_name`, `seq_<id>_state`.
