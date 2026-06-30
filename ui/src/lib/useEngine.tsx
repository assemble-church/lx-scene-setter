import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { EngineState } from "./api";

type Status = "connecting" | "open" | "closed";

interface EngineCtx {
  state: EngineState | null;
  status: Status;
}

const Ctx = createContext<EngineCtx>({ state: null, status: "connecting" });

// Single shared WebSocket to the engine, auto-reconnecting.
export function EngineProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<EngineState | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    let retry: ReturnType<typeof setTimeout>;
    let ws: WebSocket;

    function connect() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      setStatus("connecting");
      ws.onopen = () => setStatus("open");
      ws.onmessage = (e) => {
        try {
          setState(JSON.parse(e.data));
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = () => {
        setStatus("closed");
        if (!stopped.current) retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      stopped.current = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return <Ctx.Provider value={{ state, status }}>{children}</Ctx.Provider>;
}

export function useEngine() {
  return useContext(Ctx);
}
