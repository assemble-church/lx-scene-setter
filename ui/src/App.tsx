import { BrowserRouter, Routes, Route } from "react-router-dom";
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

function Shell() {
  return (
    <AppShell>
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
          {/* Scenes are edited via the Fixtures programmer (see Scenes → Edit). */}
          <Route path="*" element={<Shell />} />
        </Routes>
      </BrowserRouter>
      </LayoutProvider>
    </EngineProvider>
  );
}
