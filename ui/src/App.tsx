import { BrowserRouter, Routes, Route } from "react-router-dom";
import { EngineProvider } from "@/lib/useEngine";
import { AppShell } from "@/components/layout/AppShell";
import { Dashboard } from "@/pages/Dashboard";
import { Scenes } from "@/pages/Scenes";
import { Universes } from "@/pages/Universes";
import { Patch } from "@/pages/Patch";
import { ConfigPage } from "@/pages/ConfigPage";

export default function App() {
  return (
    <EngineProvider>
      <BrowserRouter>
        <AppShell>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/scenes" element={<Scenes />} />
            <Route path="/universes" element={<Universes />} />
            <Route path="/patch" element={<Patch />} />
            <Route path="/config" element={<ConfigPage />} />
          </Routes>
        </AppShell>
      </BrowserRouter>
    </EngineProvider>
  );
}
