// Shape of the snapshot the engine exposes over /api/state and the /ws feed.

export type SceneState = 0 | 1 | 2; // off | on | fading

export interface SceneStatus {
  id: string;
  label: string;
  favourite: boolean; // pinned to the dashboard console
  on: boolean; // intent (target > 0) — drives the Activate/Deactivate label
  state: SceneState;
  level: number; // 0..1 live output level
  target: number; // 0..1 where the level is heading (the fader position)
  fadeRemaining: number; // seconds left in this scene's fade
}

// A recorded chase/effect, looped by the engine.
export interface SequenceStatus {
  id: string;
  label: string;
  created: number; // epoch ms
  on: boolean;
  state: SceneState;
  level: number;
  fadeRemaining: number;
  groups: number;
  periods: number[]; // seconds, one per repeating group
  movingChannels: number;
  stillLit: number; // lit still channels it brings with it
  universes: number[];
  irregular: boolean; // has channels that loop the whole take
  elapsedMs: number | null; // position in its loops (ms since it started); null when not playing
}

// Effect shapes for the loop dials: per effect, its period and a few channels'
// shapes over one pass (0..1).
export interface SequencePreview {
  groups: { key: string; period: number; traces: number[][] }[];
}

// One effect found in a recording: channels sharing a period.
export interface SequenceGroup {
  key: string; // "p0", "p1"… or "irregular"
  period: number | null; // seconds; null for irregular
  channels: number;
  wide: number; // 16-bit pairs among them
  layered: number; // channels with more than one shape layered
  universes: number[];
  score: number; // 0..1, how well it predicts frames it wasn't fitted on
  passes: number; // times the slowest shape was seen
}

export interface SequenceMover {
  universe: number;
  channel: number; // 1-based (coarse byte for 16-bit)
  wide: boolean;
  group: string;
  periods: number[];
}

export interface SequenceAnalysisSummary {
  durationMs: number;
  groups: SequenceGroup[];
  stillCount: number;
  stillLit: number;
  longestPeriod: number;
  ready: boolean;
  locked: boolean; // every repeating group seen enough and predicting well
  movers: SequenceMover[];
}

export interface RecordingStatus {
  state: "idle" | "recording" | "analysing" | "review";
  elapsedMs: number;
  maxMs: number;
  autoStop: boolean;
  stoppedBy: "manual" | "auto" | "limit" | null;
  universes: { universe: number; frames: number }[];
  analysing: boolean;
  progress: SequenceAnalysisSummary | null;
  draft: SequenceAnalysisSummary | null;
  error: string | null;
}

export interface ActivityEvent {
  t: number; // epoch ms
  type: string; // scene | console | override | record | scenes
  message: string;
}

export interface FixturesStatus {
  sevenZip: boolean;
  sevenZipHint: string | null;
  libraryCount: number;
  import: { running: boolean; phase: string | null; done: number; total: number; error: string | null };
}

export interface EngineState {
  universes: number;
  channels: number;
  editing?: string | null;
  programmerActive?: boolean;
  programmerFrom?: string[]; // scenes that were live when the programmer took over
  fixtures?: FixturesStatus;
  consoleActive: boolean;
  consoleOverride: "auto" | "on" | "off";
  controllerOutput: boolean;
  holding: boolean; // desk went away; its last look is being held until a scene is pressed
  desk: DeskStatus;
  artnetSenders: { ip: string; isConsole: boolean; universes: number[]; agoMs: number }[];
  activeScenes: string[];
  scenes: SceneStatus[];
  activeSequences: string[];
  sequences: SequenceStatus[];
  recording: RecordingStatus | null;
  fade: { active: boolean; remaining: number; total: number };
  log: ActivityEvent[];
}

export interface DeskStatus {
  ip: string; // configured console IP — only Art-Net from this address counts as the desk
  timeoutMs: number;
  detected: boolean; // desk packets arriving (before any override)
  lastPacketAgoMs: number | null; // null = never heard
  packetsPerSec: number;
  packets: number;
  universes: { universe: number; agoMs: number }[];
}

export async function getState(): Promise<EngineState> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`GET /api/state → ${res.status}`);
  return res.json();
}

// Drive the engine over the same address space as OSC, e.g.
//   command("/scene/3/on", [2])   command("/scene/3/play", [2])
export async function command(address: string, args: (number | string)[] = []) {
  const res = await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, args }),
  });
  if (!res.ok) throw new Error(`command ${address} → ${res.status}`);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `POST ${url} → ${res.status}`);
  }
  return res.json();
}

// ---- Companion ----

export interface CompanionModuleInfo {
  version: string | null;
  available: boolean; // a package has been built and can be downloaded
  size: number;
  file: string; // download filename
}
export async function getCompanionModule(): Promise<CompanionModuleInfo> {
  const res = await fetch("/api/companion/module");
  if (!res.ok) throw new Error(`companion module → ${res.status}`);
  return res.json();
}

// ---- Sequences ----

export function sequenceRecordStart(autoStop = true) {
  return postJson<{ ok: boolean }>("/api/sequences/record/start", { autoStop });
}
export function sequenceRecordStop() {
  return postJson<{ ok: boolean; draft: SequenceAnalysisSummary }>("/api/sequences/record/stop", {});
}
export function sequenceRecordAutoStop(autoStop: boolean) {
  return postJson<{ ok: boolean }>("/api/sequences/record/auto-stop", { autoStop });
}
export function sequenceRecordDiscard() {
  return postJson<{ ok: boolean }>("/api/sequences/record/discard", {});
}
// Save the reviewed recording. `groups`: keys to keep; `includeStill`: bring the still look.
export function saveSequence(body: { label: string; groups: string[]; includeStill: boolean }) {
  return postJson<{ ok: boolean; id: string }>("/api/sequences", body);
}
export async function getSequencePreview(id: string): Promise<SequencePreview> {
  const res = await fetch(`/api/sequences/${encodeURIComponent(id)}/preview`);
  if (!res.ok) throw new Error(`preview ${id} → ${res.status}`);
  return res.json();
}
export function setSequenceLabel(id: string, label: string) {
  return postJson<{ ok: boolean }>(`/api/sequences/${encodeURIComponent(id)}/label`, { label });
}
export async function deleteSequence(id: string): Promise<void> {
  const res = await fetch(`/api/sequences/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE sequence ${id} → ${res.status}`);
}

export function createScene(label: string) {
  return postJson<{ ok: boolean; id: string }>("/api/scenes", { label });
}

export function setLabel(id: string, label: string) {
  return postJson<{ ok: boolean }>(`/api/scenes/${encodeURIComponent(id)}/label`, { label });
}

export function setFavourite(id: string, favourite: boolean) {
  return postJson<{ ok: boolean }>(`/api/scenes/${encodeURIComponent(id)}/favourite`, { favourite });
}

// Set a scene's level directly (0..1). 0 = off. Fire-and-forget: used while
// dragging a fader, so a lost request is simply superseded by the next one.
export function setSceneLevel(id: string, level: number, fade = 0) {
  return fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: `/scene/${id}/level`, args: [level, fade] }),
  }).catch(() => {});
}

export interface RawScene {
  label: string;
  data: number[][];
}

export async function getSceneRaw(id: string): Promise<RawScene> {
  const res = await fetch(`/api/scenes/${encodeURIComponent(id)}/raw`);
  if (!res.ok) throw new Error(`GET raw ${id} → ${res.status}`);
  return res.json();
}

// Save raw JSON text. Resolves on success, throws with the server's validation
// message on failure.
export async function setSceneRaw(id: string, raw: string): Promise<void> {
  const res = await fetch(`/api/scenes/${encodeURIComponent(id)}/raw`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `save failed (${res.status})`);
}

export async function deleteScene(id: string): Promise<void> {
  const res = await fetch(`/api/scenes/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE ${id} → ${res.status}`);
}

export async function getConfig(): Promise<{ text: string; path: string }> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(`GET /api/config → ${res.status}`);
  return res.json();
}

// Validate + save config text. Throws with the server's validation message.
export async function saveConfig(text: string): Promise<void> {
  const res = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `save failed (${res.status})`);
}

export async function restartService(): Promise<{ restarting: boolean }> {
  const res = await fetch("/api/restart", { method: "POST" });
  if (!res.ok) throw new Error(`restart → ${res.status}`);
  return res.json();
}

// ---- Grouped config (form editor) ----

export interface OutputNode {
  name: string;
  ip: string;
  source?: string; // send only from this local address (one packet); blank = automatic
  port?: number;
  universes: number[];
}
export interface FeedbackTarget {
  ip: string;
  port: number;
}
export interface ConfigShape {
  console: { ip: string; timeoutMs: number; defaultScene: string; defaultFade: number };
  artnet: {
    port: number;
    localIp: string;
    universes: number;
    channels: number;
    outputs: OutputNode[];
  };
  companion: {
    listenPort: number;
    feedbackTargets: FeedbackTarget[];
    customVariables: { enabled: boolean; ip: string; port: number; prefix: string };
  };
  web: { port: number };
  timing: {
    fadeFrameMs: number;
    keepAliveMs: number;
    startupGraceMs: number;
    feedbackHeartbeatMs: number;
  };
  dataDir: string;
}

// ---- Art-Net network ----

// Universe numbers are 15-bit Art-Net Port-Addresses: net*256 + subnet*16 + universe.
export function portAddress(u: number) {
  return { net: (u >> 8) & 0x7f, subnet: (u >> 4) & 0x0f, universe: u & 0x0f };
}
export function portAddressLabel(u: number) {
  const p = portAddress(u);
  return `Net ${p.net} · Subnet ${p.subnet} · Universe ${p.universe}`;
}
export const BROADCAST_IP = "255.255.255.255";

export interface ArtnetNode {
  ip: string;
  from: string; // address the reply came from (can differ from ip, e.g. behind NAT)
  shortName: string;
  longName: string;
  report: string;
  mac: string;
  bindIndex: number;
  outputs: number[]; // universes it outputs to DMX (i.e. receives from us)
  inputs: number[];
  lastSeen: number;
}
export interface ArtnetSender {
  ip: string;
  universes: number[];
  packets: number;
  isConsole: boolean;
  lastSeen: number;
}
// How a saved output is actually leaving the machine.
export interface ArtnetOutputRoute {
  name: string;
  ip: string;
  universes: number[];
  mode: "unicast" | "subnet-broadcast" | "broadcast" | "routed" | "fixed";
  via: string[];
  packetsPerUpdate: number;
  warning?: string;
}
export interface ArtnetNetwork {
  nodes: ArtnetNode[];
  senders: ArtnetSender[];
  interfaces: { name: string; address: string; netmask: string; broadcast: string }[];
  outputs: ArtnetOutputRoute[];
  polled?: string[];
}

export async function getArtnetNetwork(): Promise<ArtnetNetwork> {
  const r = await fetch("/api/artnet/nodes");
  if (!r.ok) throw new Error(`artnet nodes → ${r.status}`);
  return r.json();
}
// Broadcasts ArtPoll and resolves ~3s later with everything that answered.
export function discoverArtnet() {
  return postJson<ArtnetNetwork>("/api/artnet/discover", {});
}

export async function getConfigForm(): Promise<ConfigShape> {
  const res = await fetch("/api/config/form");
  if (!res.ok) throw new Error(`GET /api/config/form → ${res.status}`);
  return res.json();
}

export async function saveConfigForm(config: ConfigShape): Promise<void> {
  const res = await fetch("/api/config/form", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `save failed (${res.status})`);
}

// ---- Fixtures & patch ----

export interface FixtureAttr {
  id: string;
  name: string;
  group: string;
  size: number;
  fade: boolean;
  offsets: number[];
  functions?: { name: string; min: number; max: number }[];
  switch?: boolean; // on/off channel (non-dim / hot power) — from the patch, not the library
}
export interface FixtureMode {
  name: string;
  channels: number;
  attrs: FixtureAttr[];
}
export interface Fixture {
  id: number;
  manufacturer: string;
  name: string;
  short: string;
  modes: FixtureMode[];
}
export interface FixtureHit {
  id: number;
  manufacturer: string;
  name: string;
  short: string;
}
export type FixtureKind = "par" | "chandelier" | "beam" | "wash" | "led-tape" | "led-panel" | "power";

// level = normal channel (fades, or snaps if marked snap); switch = on/off only
// (non-dim / hot power): output is always 0 or 255.
export type ChannelType = "level" | "switch";

// A "head" is one physical light within a patch entry (dimmer packs have many).
export interface FixtureHead {
  offset: number; // 1-based channel offset within the fixture
  span: number; // channels this head covers
  label: string;
  icon: FixtureKind;
}

export interface PatchFixture {
  id: string;
  libId: number | null; // null for built-in fixtures (e.g. a generic dimmer pack)
  manufacturer: string;
  name: string;
  label: string;
  mode: string;
  channels: number;
  universe: number;
  address: number;
  fade: boolean[];
  types: ChannelType[];
  names: string[]; // per-channel name ("" = use the personality's)
  letters?: string[];
  icon?: FixtureKind; // used when the fixture is a single head
  heads?: FixtureHead[]; // present for multi-dimmers / dimmer packs
}

export async function searchFixtures(q: string): Promise<FixtureHit[]> {
  const r = await fetch(`/api/fixtures/search?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(`search → ${r.status}`);
  return (await r.json()).results;
}

// Library fixtures don't change until a re-import, so cache the lookups (the
// Fixtures page resolves the same personality for every patched instance).
const fixtureCache = new Map<number, Promise<Fixture>>();
export function getFixture(id: number): Promise<Fixture> {
  let p = fixtureCache.get(id);
  if (!p) {
    p = fetch(`/api/fixtures/${id}`).then((r) => {
      if (!r.ok) throw new Error(`fixture ${id} → ${r.status}`);
      return r.json();
    });
    p.catch(() => fixtureCache.delete(id));
    fixtureCache.set(id, p);
  }
  return p;
}
export function clearFixtureCache() {
  fixtureCache.clear();
}

export async function getPatch(): Promise<{ fixtures: PatchFixture[] }> {
  const r = await fetch("/api/patch");
  if (!r.ok) throw new Error(`patch → ${r.status}`);
  return r.json();
}

// Fixture map — layout of fixtures/heads onto the Fixtures grid.
// `cells` maps an item key → 0-based cell index (row * cols + col).
export interface FixtureMap {
  cols: number;
  rows: number;
  cells: Record<string, number>;
}

export async function getFixtureMap(): Promise<FixtureMap> {
  const r = await fetch("/api/fixture-map");
  if (!r.ok) throw new Error(`fixture-map → ${r.status}`);
  return r.json();
}

export function setFixtureMap(map: FixtureMap) {
  return postJson<FixtureMap>("/api/fixture-map", map);
}

// Programmer — live ad-hoc control from the Fixtures page.
export function programmerSet(updates: { universe: number; channel: number; value: number }[]) {
  return fetch("/api/programmer/set", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  }).catch(() => {});
}
export function programmerClear() {
  return fetch("/api/programmer/clear", { method: "POST" }).catch(() => {});
}
// Load a scene into the programmer for editing.
export function programmerLoadScene(sceneId: string) {
  return postJson<{ ok: boolean }>("/api/programmer/load", { sceneId });
}
// Save the current programmer look to a scene: pass { sceneId } to update, or
// { label } to create a new scene.
export function programmerSaveScene(opts: { sceneId?: string; label?: string }) {
  return postJson<{ ok: boolean; id: string }>("/api/programmer/save", opts);
}

// Add from the library ({ libId, mode }) or a built-in dimmer pack
// ({ builtin: "dimmer", channels, switched? } — the last `switched` channels are hot power).
export function patchAdd(
  body: ({ libId: number; mode: string } | { builtin: "dimmer"; channels: number; switched?: number }) & {
    universe: number;
    address: number;
    label?: string;
    count?: number;
  }
) {
  return postJson<{ fixtures: PatchFixture[]; added: number }>("/api/patch/add", body);
}

export function patchUpdate(
  id: string,
  body: Partial<{
    universe: number;
    address: number;
    label: string;
    fade: boolean[];
    channels: { type: ChannelType; fade: boolean; name: string }[];
    icon: FixtureKind;
    heads: FixtureHead[] | null; // null merges back to a single head
  }>
) {
  return postJson<{ fixtures: PatchFixture[] }>(`/api/patch/${encodeURIComponent(id)}`, body);
}

export async function patchDelete(id: string): Promise<void> {
  const r = await fetch(`/api/patch/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`delete → ${r.status}`);
}

// Upload the library .exe with upload-progress (parse progress comes via the WS
// snapshot's fixtures.import). `onUploaded` fires once the file has been sent and
// the server is importing; the promise resolves when the import completes.
export function importLibraryUpload(
  file: File,
  onUpload: (pct: number) => void,
  onUploaded: () => void
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/fixtures/import");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onUpload(Math.round((e.loaded / e.total) * 100));
    };
    xhr.upload.onload = onUploaded;
    xhr.onload = () => {
      let body: { ok?: boolean; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch (_) {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.ok !== false) resolve(body);
      else reject(new Error(body.error || `import failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("network error during upload"));
    xhr.send(file);
  });
}

// ---- Scene editor (live programmer) ----

export function sceneEditBegin(sceneId: string) {
  return postJson<{ ok: boolean }>("/api/scene-edit/begin", { sceneId });
}
export function sceneEditSet(updates: { universe: number; channel: number; value: number }[]) {
  // Fire-and-forget for live dragging.
  return fetch("/api/scene-edit/set", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  }).catch(() => {});
}
export function sceneEditSave() {
  return postJson<{ ok: boolean }>("/api/scene-edit/save", {});
}
export function sceneEditEnd() {
  return fetch("/api/scene-edit/end", { method: "POST" }).catch(() => {});
}
