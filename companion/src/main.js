const { InstanceBase, runEntrypoint, InstanceStatus, combineRgb } = require('@companion-module/base')

/**
 * Light It — Companion module.
 *
 * Talks to a running Light It server over its HTTP API:
 *   GET  /api/companion/state  — desk, hold, fade, scenes and sequences (polled)
 *   POST /api/command          — { address, args }: the same command set as OSC
 *
 * It declares the variables (so they exist automatically), actions with scene and
 * sequence dropdowns filled live from Light It, feedbacks (button colours from
 * scene / sequence / desk state) and drag-on presets.
 */

const POLL_MS = 250 // quick enough for fade countdowns on buttons

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const DARK = combineRgb(28, 28, 30)
const GREEN = combineRgb(30, 150, 60)
const AMBER = combineRgb(210, 140, 0)
const RED = combineRgb(200, 30, 30)
const BLUE = combineRgb(40, 90, 200)
const TEAL = combineRgb(20, 130, 130)

const STATE_NAME = ['off', 'on', 'fading']

class LightItInstance extends InstanceBase {
  async init(config) {
    this.config = config
    this.data = { desk: {}, fade: {}, scenes: [], sequences: [] }
    this._sig = null // scene/sequence ids + names: rebuild definitions when it changes
    this.updateStatus(InstanceStatus.Connecting)
    this.rebuild()
    this.startPolling()
  }

  async configUpdated(config) {
    this.config = config
    this._sig = null
    this.startPolling()
  }

  async destroy() {
    if (this.poll) clearTimeout(this.poll)
    this.poll = null
  }

  getConfigFields() {
    return [
      { type: 'static-text', id: 'info', label: 'Light It', width: 12, value: 'The IP address and web port of the Light It server (the address you open the web UI on).' },
      { type: 'textinput', id: 'host', label: 'IP address', width: 6, default: '127.0.0.1' },
      { type: 'number', id: 'port', label: 'Web port', width: 6, default: 8080, min: 1, max: 65535 },
      { type: 'number', id: 'fade', label: 'Default fade (seconds)', width: 6, default: 2, min: 0, max: 600, step: 0.1 },
    ]
  }

  base() {
    return `http://${this.config?.host || '127.0.0.1'}:${this.config?.port || 8080}`
  }

  startPolling() {
    if (this.poll) clearTimeout(this.poll)
    const tick = async () => {
      await this.fetchState()
      this.poll = setTimeout(tick, POLL_MS)
    }
    tick()
  }

  async fetchState() {
    try {
      const r = await fetch(`${this.base()}/api/companion/state`, { signal: AbortSignal.timeout(2000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const s = await r.json()
      this.data = {
        desk: s.desk ?? {},
        output: !!s.output,
        fade: s.fade ?? {},
        locked: s.locked ?? null,
        scenes: s.scenes ?? [],
        sequences: s.sequences ?? [],
      }
      this.updateStatus(InstanceStatus.Ok)
      const sig = JSON.stringify([this.data.scenes.map((x) => [x.id, x.label]), this.data.sequences.map((x) => [x.id, x.label]), this.config?.fade])
      if (sig !== this._sig) {
        this._sig = sig
        this.rebuild()
      }
      this.pushValues()
      this.checkFeedbacks('scene_state', 'sequence_state', 'desk_live', 'holding', 'console_override', 'fade_active', 'locked')
    } catch (e) {
      this.updateStatus(InstanceStatus.ConnectionFailure, e.message)
    }
  }

  rebuild() {
    this.initVariables()
    this.initActions()
    this.initFeedbacks()
    this.initPresets()
  }

  command(address, args = []) {
    return fetch(`${this.base()}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, args }),
      signal: AbortSignal.timeout(2000),
    }).catch((e) => this.log('warn', `${address} failed: ${e.message}`))
  }

  fadeOf(options) {
    const n = Number(options?.fade)
    return Number.isFinite(n) && n >= 0 ? n : Number(this.config?.fade) || 0
  }

  sceneLabel(s) {
    return s.label || `Scene ${s.id}`
  }

  seqLabel(s) {
    return s.label || `Sequence ${s.id}`
  }

  // ------------------------------------------------------------- variables
  initVariables() {
    const defs = [
      { variableId: 'desk', name: 'Desk: status (Desk live / Holding / House)' },
      { variableId: 'desk_live', name: 'Desk: in control (true/false)' },
      { variableId: 'holding', name: 'Desk: last look held (true/false)' },
      { variableId: 'console_override', name: 'Desk: override (auto/on/off)' },
      { variableId: 'fade_remaining', name: 'Fade: seconds remaining (longest fade)' },
      { variableId: 'active_scenes', name: 'Scenes: on (names)' },
      { variableId: 'active_sequences', name: 'Sequences: running (names)' },
    ]
    for (const s of this.data.scenes) {
      defs.push({ variableId: `scene_${s.id}_name`, name: `Scene ${s.id}: name` })
      defs.push({ variableId: `scene_${s.id}_state`, name: `Scene ${s.id}: state (off/on/fading)` })
      defs.push({ variableId: `scene_${s.id}_level`, name: `Scene ${s.id}: level %` })
    }
    for (const s of this.data.sequences) {
      defs.push({ variableId: `seq_${s.id}_name`, name: `Sequence ${s.id}: name` })
      defs.push({ variableId: `seq_${s.id}_state`, name: `Sequence ${s.id}: state (off/on/fading)` })
    }
    this.setVariableDefinitions(defs)
  }

  pushValues() {
    const d = this.data.desk
    const vals = {
      desk: d.live ? 'Desk live' : d.holding ? 'Holding' : 'House',
      desk_live: d.live ? 'true' : 'false',
      holding: d.holding ? 'true' : 'false',
      console_override: d.override ?? 'auto',
      fade_remaining: (this.data.fade.remaining ?? 0).toFixed(1),
      active_scenes: this.data.scenes.filter((s) => s.on).map((s) => this.sceneLabel(s)).join(', '),
      active_sequences: this.data.sequences.filter((s) => s.on).map((s) => this.seqLabel(s)).join(', '),
    }
    for (const s of this.data.scenes) {
      vals[`scene_${s.id}_name`] = this.sceneLabel(s)
      vals[`scene_${s.id}_state`] = STATE_NAME[s.state] ?? 'off'
      vals[`scene_${s.id}_level`] = String(Math.round((s.level ?? 0) * 100))
    }
    for (const s of this.data.sequences) {
      vals[`seq_${s.id}_name`] = this.seqLabel(s)
      vals[`seq_${s.id}_state`] = STATE_NAME[s.state] ?? 'off'
    }
    this.setVariableValues(vals)
  }

  // --------------------------------------------------------------- actions
  initActions() {
    const scenes = this.data.scenes.map((s) => ({ id: s.id, label: `#${s.id} ${this.sceneLabel(s)}` }))
    const seqs = this.data.sequences.map((s) => ({ id: s.id, label: `#${s.id} ${this.seqLabel(s)}` }))
    const fadeDefault = Number(this.config?.fade) || 0
    const fade = { type: 'number', id: 'fade', label: 'Fade (seconds)', default: fadeDefault, min: 0, max: 600, step: 0.1 }
    const scene = { type: 'dropdown', id: 'scene', label: 'Scene', choices: scenes, default: scenes[0]?.id ?? '', allowCustom: true }
    const seq = { type: 'dropdown', id: 'sequence', label: 'Sequence', choices: seqs, default: seqs[0]?.id ?? '', allowCustom: true }

    this.setActionDefinitions({
      scene_on: { name: 'Scene: on', options: [scene, fade], callback: (a) => this.command(`/scene/${a.options.scene}/on`, [this.fadeOf(a.options)]) },
      scene_off: { name: 'Scene: off', options: [scene, fade], callback: (a) => this.command(`/scene/${a.options.scene}/off`, [this.fadeOf(a.options)]) },
      scene_toggle: { name: 'Scene: toggle', options: [scene, fade], callback: (a) => this.command(`/scene/${a.options.scene}/toggle`, [this.fadeOf(a.options)]) },
      scene_solo: {
        name: 'Scene: solo (this on, everything else off)',
        options: [scene, fade],
        callback: (a) => this.command(`/scene/${a.options.scene}/play`, [this.fadeOf(a.options)]),
      },
      scene_solo_toggle: {
        name: 'Scene: solo toggle (solo, or off if it is already on)',
        options: [scene, fade],
        callback: (a) => {
          const s = this.data.scenes.find((x) => x.id === String(a.options.scene))
          const verb = s && s.on ? 'off' : 'play'
          return this.command(`/scene/${a.options.scene}/${verb}`, [this.fadeOf(a.options)])
        },
      },
      scene_level: {
        name: 'Scene: set level',
        options: [scene, { type: 'number', id: 'level', label: 'Level %', default: 50, min: 0, max: 100 }, fade],
        callback: (a) => this.command(`/scene/${a.options.scene}/level`, [Math.max(0, Math.min(100, Number(a.options.level) || 0)) / 100, this.fadeOf(a.options)]),
      },
      scene_record: {
        name: 'Scene: record (snapshot the current output)',
        options: [scene],
        callback: (a) => this.command(`/scene/${a.options.scene}/rec`),
      },
      scenes_off: { name: 'All off (scenes and sequences)', options: [fade], callback: (a) => this.command('/scenes/off', [this.fadeOf(a.options)]) },
      sequence_on: { name: 'Sequence: run', options: [seq, fade], callback: (a) => this.command(`/sequence/${a.options.sequence}/on`, [this.fadeOf(a.options)]) },
      sequence_off: { name: 'Sequence: stop', options: [seq, fade], callback: (a) => this.command(`/sequence/${a.options.sequence}/off`, [this.fadeOf(a.options)]) },
      sequence_toggle: { name: 'Sequence: toggle', options: [seq, fade], callback: (a) => this.command(`/sequence/${a.options.sequence}/toggle`, [this.fadeOf(a.options)]) },
      sequences_off: { name: 'Sequences: stop all', options: [fade], callback: (a) => this.command('/sequences/off', [this.fadeOf(a.options)]) },
      hold_release: { name: 'Desk: release held look', options: [fade], callback: (a) => this.command('/hold/release', [this.fadeOf(a.options)]) },
      console_override: {
        name: 'Desk: override',
        options: [{ type: 'dropdown', id: 'mode', label: 'Mode', default: 'auto', choices: [{ id: 'auto', label: 'Auto (detect the desk)' }, { id: 'on', label: 'On (desk in control)' }, { id: 'off', label: 'Off (ignore the desk)' }] }],
        callback: (a) => this.command('/scene-setter/console-override', [{ auto: 2, on: 1, off: 0 }[a.options.mode] ?? 2]),
      },
      output: {
        name: 'Output: enable / disable',
        options: [{ type: 'dropdown', id: 'on', label: 'Output', default: 'on', choices: [{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }] }],
        callback: (a) => this.command(`/output/${a.options.on === 'off' ? 'off' : 'on'}`),
      },
    })
  }

  // ------------------------------------------------------------- feedbacks
  initFeedbacks() {
    const scenes = this.data.scenes.map((s) => ({ id: s.id, label: `#${s.id} ${this.sceneLabel(s)}` }))
    const seqs = this.data.sequences.map((s) => ({ id: s.id, label: `#${s.id} ${this.seqLabel(s)}` }))
    const stateChoice = { type: 'dropdown', id: 'state', label: 'State', default: 'on', choices: [{ id: 'on', label: 'On' }, { id: 'fading', label: 'Fading' }, { id: 'active', label: 'On or fading' }, { id: 'off', label: 'Off' }] }
    const matches = (item, want) => {
      const st = STATE_NAME[item?.state ?? 0]
      return want === 'active' ? st !== 'off' : st === want
    }
    this.setFeedbackDefinitions({
      scene_state: {
        type: 'boolean',
        name: 'Scene is…',
        description: 'Colour a button when a scene is on, fading or off.',
        defaultStyle: { bgcolor: GREEN, color: WHITE },
        options: [{ type: 'dropdown', id: 'scene', label: 'Scene', choices: scenes, default: scenes[0]?.id ?? '', allowCustom: true }, stateChoice],
        callback: (fb) => matches(this.data.scenes.find((s) => s.id === String(fb.options.scene)), fb.options.state),
      },
      sequence_state: {
        type: 'boolean',
        name: 'Sequence is…',
        description: 'Colour a button when a sequence is running, fading or off.',
        defaultStyle: { bgcolor: TEAL, color: WHITE },
        options: [{ type: 'dropdown', id: 'sequence', label: 'Sequence', choices: seqs, default: seqs[0]?.id ?? '', allowCustom: true }, stateChoice],
        callback: (fb) => matches(this.data.sequences.find((s) => s.id === String(fb.options.sequence)), fb.options.state),
      },
      desk_live: {
        type: 'boolean',
        name: 'Desk is in control',
        description: 'The lighting desk is sending Art-Net (or forced on): scene control is locked.',
        defaultStyle: { bgcolor: RED, color: WHITE },
        options: [],
        callback: () => !!this.data.desk.live,
      },
      holding: {
        type: 'boolean',
        name: "Desk's last look is held",
        description: 'The desk went away and its last look is being held until a scene is pressed.',
        defaultStyle: { bgcolor: AMBER, color: BLACK },
        options: [],
        callback: () => !!this.data.desk.holding,
      },
      console_override: {
        type: 'boolean',
        name: 'Desk override is…',
        defaultStyle: { bgcolor: BLUE, color: WHITE },
        options: [{ type: 'dropdown', id: 'mode', label: 'Mode', default: 'auto', choices: [{ id: 'auto', label: 'Auto' }, { id: 'on', label: 'On' }, { id: 'off', label: 'Off' }] }],
        callback: (fb) => (this.data.desk.override ?? 'auto') === fb.options.mode,
      },
      fade_active: {
        type: 'boolean',
        name: 'A fade is running',
        defaultStyle: { bgcolor: AMBER, color: BLACK },
        options: [],
        callback: () => !!this.data.fade.active,
      },
      locked: {
        type: 'boolean',
        name: 'Controls are locked',
        description: 'The desk is live, or a scene is being edited in the web UI: commands are ignored.',
        defaultStyle: { bgcolor: combineRgb(90, 20, 20), color: WHITE },
        options: [],
        callback: () => !!this.data.locked,
      },
    })
  }

  // --------------------------------------------------------------- presets
  initPresets() {
    const presets = {}
    const onOff = (feedbackId, key, id) => [
      { feedbackId, options: { [key]: id, state: 'fading' }, style: { bgcolor: AMBER, color: BLACK } },
      { feedbackId, options: { [key]: id, state: 'on' }, style: { bgcolor: feedbackId === 'scene_state' ? GREEN : TEAL, color: WHITE } },
    ]
    for (const s of this.data.scenes) {
      presets[`scene_toggle_${s.id}`] = {
        type: 'button',
        category: 'Scenes',
        name: `${this.sceneLabel(s)}: toggle`,
        style: { text: `$(lightit:scene_${s.id}_name)\\n$(lightit:scene_${s.id}_level)%`, size: '12', color: WHITE, bgcolor: DARK },
        steps: [{ down: [{ actionId: 'scene_toggle', options: { scene: s.id, fade: Number(this.config?.fade) || 0 } }], up: [] }],
        feedbacks: onOff('scene_state', 'scene', s.id),
      }
      presets[`scene_solo_${s.id}`] = {
        type: 'button',
        category: 'Scenes: solo (full look)',
        name: `${this.sceneLabel(s)}: solo`,
        style: { text: `SOLO\\n$(lightit:scene_${s.id}_name)`, size: '12', color: WHITE, bgcolor: DARK },
        steps: [{ down: [{ actionId: 'scene_solo_toggle', options: { scene: s.id, fade: Number(this.config?.fade) || 0 } }], up: [] }],
        feedbacks: onOff('scene_state', 'scene', s.id),
      }
    }
    // Sequences: its own submenu, always present.
    if (!this.data.sequences.length) {
      presets.sequences_none = {
        type: 'text',
        category: 'Sequences',
        name: 'No sequences yet',
        text: 'Record a sequence in Light It (Sequences → New sequence) and a toggle button for it appears here.',
      }
    }
    for (const s of this.data.sequences) {
      presets[`sequence_toggle_${s.id}`] = {
        type: 'button',
        category: 'Sequences',
        name: `${this.seqLabel(s)}: toggle`,
        style: { text: `$(lightit:seq_${s.id}_name)`, size: '12', color: WHITE, bgcolor: DARK },
        steps: [{ down: [{ actionId: 'sequence_toggle', options: { sequence: s.id, fade: Number(this.config?.fade) || 0 } }], up: [] }],
        feedbacks: onOff('sequence_state', 'sequence', s.id),
      }
    }
    const fade = Number(this.config?.fade) || 0
    presets.all_off = {
      type: 'button',
      category: 'Control',
      name: 'All off',
      style: { text: 'ALL OFF', size: '14', color: WHITE, bgcolor: combineRgb(60, 20, 20) },
      steps: [{ down: [{ actionId: 'scenes_off', options: { fade } }], up: [] }],
      feedbacks: [{ feedbackId: 'fade_active', options: {}, style: { bgcolor: AMBER, color: BLACK } }],
    }
    presets.sequences_off = {
      type: 'button',
      category: 'Sequences',
      name: 'Stop all sequences',
      style: { text: 'STOP\\nSEQUENCES', size: '12', color: WHITE, bgcolor: DARK },
      steps: [{ down: [{ actionId: 'sequences_off', options: { fade } }], up: [] }],
      feedbacks: [],
    }
    presets.desk_status = {
      type: 'button',
      category: 'Desk',
      name: 'Desk status (press to release a held look)',
      style: { text: 'DESK\\n$(lightit:desk)', size: '12', color: WHITE, bgcolor: GREEN },
      steps: [{ down: [{ actionId: 'hold_release', options: { fade } }], up: [] }],
      feedbacks: [
        { feedbackId: 'holding', options: {}, style: { bgcolor: AMBER, color: BLACK } },
        { feedbackId: 'desk_live', options: {}, style: { bgcolor: RED, color: WHITE } },
      ],
    }
    presets.fade_remaining = {
      type: 'button',
      category: 'Desk',
      name: 'Fade countdown',
      style: { text: 'FADE\\n$(lightit:fade_remaining)s', size: '12', color: WHITE, bgcolor: DARK },
      steps: [{ down: [], up: [] }],
      feedbacks: [{ feedbackId: 'fade_active', options: {}, style: { bgcolor: AMBER, color: BLACK } }],
    }
    for (const mode of ['auto', 'on', 'off']) {
      presets[`override_${mode}`] = {
        type: 'button',
        category: 'Desk',
        name: `Override: ${mode}`,
        style: { text: `OVERRIDE\\n${mode.toUpperCase()}`, size: '12', color: WHITE, bgcolor: DARK },
        steps: [{ down: [{ actionId: 'console_override', options: { mode } }], up: [] }],
        feedbacks: [{ feedbackId: 'console_override', options: { mode }, style: { bgcolor: BLUE, color: WHITE } }],
      }
    }
    this.setPresetDefinitions(presets)
  }
}

runEntrypoint(LightItInstance, [])
