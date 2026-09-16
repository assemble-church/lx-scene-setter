import { useEffect } from "react";
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from "react-router-dom";
import { EngineProvider } from "@/lib/useEngine";
import { LayoutProvider } from "@/lib/layout";
import { AppShell } from "@/components/layout/AppShell";
import { Dashboard } from "@/pages/Dashboard";
import { Scenes } from "@/pages/Scenes";
import { Sequences } from "@/pages/Sequences";
import { Companion } from "@/pages/Companion";
import { Fixtures } from "@/pages/Fixtures";
import { Universes } from "@/pages/Universes";
import { Patch } from "@/pages/Patch";
import { ConfigPage } from "@/pages/ConfigPage";
import { Mobile, DESKTOP_KEY } from "@/pages/Mobile";

// A phone landing on the desktop dashboard goes to the mobile view instead, unless
// it has asked for the desktop this session (the "Desktop" link on the mobile view).
function PhoneRedirect() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (pathname !== "/" || sessionStorage.getItem(DESKTOP_KEY)) return;
    if (window.matchMedia("(max-width: 767px) and (pointer: coarse)").matches) navigate("/m", { replace: true });
  }, [pathname, navigate]);
  return null;
}

function Shell() {
  return (
    <AppShell>
      <PhoneRedirect />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/scenes" element={<Scenes />} />
        <Route path="/sequences" element={<Sequences />} />
        <Route path="/fixtures" element={<Fixtures />} />
        <Route path="/universes" element={<Universes />} />
        <Route path="/patch" element={<Patch />} />
        <Route path="/companion" element={<Companion />} />
        <Route path="/config" element={<ConfigPage />} />
      </Routes>
    </AppShell>
  );
}

export default function App() {
  return (
    <EngineProvider>
      <LayoutProvider>
      <BrowserRouter>
        <Routes>
          {/* Phone / tablet view: its own shell, no sidebar. */}
          <Route path="/m" element={<Mobile />} />
          {/* Scenes are edited via the Fixtures programmer (see Scenes → Edit). */}
          <Route path="*" element={<Shell />} />
        </Routes>
      </BrowserRouter>
      </LayoutProvider>
    </EngineProvider>
  );
}
