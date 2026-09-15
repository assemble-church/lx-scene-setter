import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

// Shell layout state: sidebar collapsed (persisted) and browser fullscreen.

interface LayoutCtx {
  collapsed: boolean;
  toggleSidebar: () => void;
  fullscreen: boolean;
  toggleFullscreen: () => void;
}

const Ctx = createContext<LayoutCtx>({
  collapsed: false,
  toggleSidebar: () => {},
  fullscreen: false,
  toggleFullscreen: () => {},
});

const KEY = "lx.sidebarCollapsed";

export function LayoutProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(KEY) === "1");
  const [fullscreen, setFullscreen] = useState(() => !!document.fullscreenElement);

  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      localStorage.setItem(KEY, c ? "0" : "1");
      return !c;
    });
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }, []);

  return <Ctx.Provider value={{ collapsed, toggleSidebar, fullscreen, toggleFullscreen }}>{children}</Ctx.Provider>;
}

export function useLayout() {
  return useContext(Ctx);
}
