import { useEffect } from "react";

// One shared binary DMX feed (/ws/dmx) for every live universe view on screen.
// The socket is only open while something is subscribed, so the engine only
// streams frames when a grid or mini-viz is actually visible.
//
// A frame is every universe concatenated: byte index = universe * channels + ch.

type Listener = (frame: Uint8Array) => void;

const listeners = new Set<Listener>();
let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let idleClose: ReturnType<typeof setTimeout> | null = null;
let last: Uint8Array | null = null;

function connect() {
  if (ws || listeners.size === 0) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/ws/dmx`);
  sock.binaryType = "arraybuffer";
  ws = sock;
  sock.onmessage = (e) => {
    last = new Uint8Array(e.data as ArrayBuffer);
    for (const l of listeners) l(last);
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    if (listeners.size) retry = setTimeout(connect, 1000);
  };
  sock.onerror = () => sock.close();
}

function subscribe(l: Listener) {
  listeners.add(l);
  if (idleClose) {
    clearTimeout(idleClose);
    idleClose = null;
  }
  if (last) l(last);
  connect();
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) {
      // Linger briefly so route changes between two live views don't reconnect.
      idleClose = setTimeout(() => {
        if (listeners.size) return;
        if (retry) clearTimeout(retry);
        retry = null;
        ws?.close();
        ws = null;
        last = null;
      }, 1500);
    }
  };
}

/** Run `onFrame` for every DMX frame while mounted. Keep the callback cheap —
 *  it runs at ~20 Hz outside React's render cycle. */
export function useDmxFrames(onFrame: Listener | null) {
  useEffect(() => {
    if (!onFrame) return;
    return subscribe(onFrame);
  }, [onFrame]);
}
