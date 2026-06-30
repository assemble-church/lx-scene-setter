// Shape of the snapshot the engine exposes over /api/state and the /ws feed.

export type SceneState = 0 | 1 | 2; // off | on | fading

export interface SceneStatus {
  id: string;
  label: string;
  on: boolean; // intent (target on) — drives the Activate/Deactivate label
  state: SceneState;
  level: number; // 0..1 live output level
  fadeRemaining: number; // seconds left in this scene's fade
}

export interface ActivityEvent {
  t: number; // epoch ms
  type: string; // scene | console | override | record | scenes
  message: string;
}

export interface EngineState {
  universes: number;
  channels: number;
  consoleActive: boolean;
  consoleOverride: "auto" | "on" | "off";
  controllerOutput: boolean;
  activeScenes: string[];
  scenes: SceneStatus[];
  fade: { active: boolean; remaining: number; total: number };
  log: ActivityEvent[];
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
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}`);
  return res.json();
}

export function createScene(label: string) {
  return postJson<{ ok: boolean; id: string }>("/api/scenes", { label });
}

export function setLabel(id: string, label: string) {
  return postJson<{ ok: boolean }>(`/api/scenes/${encodeURIComponent(id)}/label`, { label });
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
