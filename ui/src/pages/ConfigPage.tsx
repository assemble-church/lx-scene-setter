import { useEffect, useState, type ReactNode } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2 } from "lucide-react";
import {
  getConfigForm,
  saveConfigForm,
  getConfig,
  saveConfig,
  restartService,
  type ConfigShape,
} from "@/lib/api";
import { cn } from "@/lib/utils";

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[200px_1fr] items-center gap-3 py-1.5">
      <div className="text-sm">
        {label}
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function NumInput({
  value,
  onChange,
  className,
}: {
  value: number;
  onChange: (n: number) => void;
  className?: string;
}) {
  return (
    <Input
      type="number"
      className={cn("max-w-40", className)}
      value={Number.isFinite(value) ? value : ""}
      onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
    />
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">{children}</CardContent>
    </Card>
  );
}

export function ConfigPage() {
  const [mode, setMode] = useState<"form" | "raw">("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedNeedsRestart, setSavedNeedsRestart] = useState(false);

  // form state
  const [cfg, setCfg] = useState<ConfigShape | null>(null);
  // raw state
  const [raw, setRaw] = useState<string>("");
  const [rawLoaded, setRawLoaded] = useState(false);

  useEffect(() => {
    getConfigForm()
      .then(setCfg)
      .catch((e) => setError(e.message));
  }, []);

  async function switchTo(next: "form" | "raw") {
    setMode(next);
    setError(null);
    setNotice(null);
    if (next === "raw" && !rawLoaded) {
      try {
        const c = await getConfig();
        setRaw(c.text);
        setRawLoaded(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    if (next === "form") {
      // re-pull so the form reflects whatever was last saved (incl. raw edits)
      try {
        setCfg(await getConfigForm());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "form") {
        if (!cfg) return;
        await saveConfigForm(cfg);
      } else {
        await saveConfig(raw);
        setRawLoaded(false); // re-fetch next time (it was re-serialised on form path)
      }
      setSavedNeedsRestart(true);
      setNotice("Saved. Restart to apply.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function restart() {
    setBusy(true);
    setError(null);
    try {
      const r = await restartService();
      setNotice(
        r.restarting
          ? "Restarting the service… this page will reconnect shortly."
          : "Saved. In development, restart `npm run dev` to apply."
      );
      setSavedNeedsRestart(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // ---- form update helpers ----
  type SectionKey = "console" | "artnet" | "companion" | "web" | "timing";
  const patch = <K extends SectionKey>(k: K, p: Partial<ConfigShape[K]>) =>
    setCfg((c) => (c ? { ...c, [k]: { ...c[k], ...p } } : c));
  const setCV = (p: Partial<ConfigShape["companion"]["customVariables"]>) =>
    setCfg((c) =>
      c
        ? {
            ...c,
            companion: {
              ...c.companion,
              customVariables: { ...c.companion.customVariables, ...p },
            },
          }
        : c
    );

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Config</h1>
        <div className="flex items-center gap-2">
          <div className="mr-2 flex rounded-md border border-border p-0.5 text-sm">
            {(["form", "raw"] as const).map((m) => (
              <button
                key={m}
                onClick={() => switchTo(m)}
                className={cn(
                  "rounded px-3 py-1 capitalize",
                  mode === m ? "bg-accent text-accent-foreground" : "text-muted-foreground"
                )}
              >
                {m}
              </button>
            ))}
          </div>
          <Button variant="outline" onClick={restart} disabled={busy}>
            Restart service
          </Button>
          <Button onClick={save} disabled={busy}>
            Save
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && !error && (
        <div className="flex items-center gap-3 rounded-md border border-border bg-accent/40 px-3 py-2 text-sm">
          {notice}
          {savedNeedsRestart && (
            <Button size="sm" onClick={restart} disabled={busy}>
              Restart now
            </Button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "raw" ? (
          <Textarea
            value={rawLoaded ? raw : "Loading…"}
            onChange={(e) => {
              setRaw(e.target.value);
              setSavedNeedsRestart(false);
            }}
            spellCheck={false}
            disabled={!rawLoaded}
            className="h-full min-h-[60vh] w-full resize-none font-mono text-xs leading-relaxed"
          />
        ) : !cfg ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Console">
              <Row label="IP address" hint="the desk we fail over from">
                <Input
                  value={cfg.console.ip}
                  onChange={(e) => patch("console", { ip: e.target.value })}
                  className="max-w-52"
                />
              </Row>
              <Row label="Timeout (ms)" hint="silence before 'lost'">
                <NumInput
                  value={cfg.console.timeoutMs}
                  onChange={(v) => patch("console", { timeoutMs: v })}
                />
              </Row>
              <Row label="Default scene" hint="recalled on handoff">
                <Input
                  value={cfg.console.defaultScene}
                  onChange={(e) => patch("console", { defaultScene: e.target.value })}
                  className="max-w-24"
                />
              </Row>
              <Row label="Default fade (s)">
                <NumInput
                  value={cfg.console.defaultFade}
                  onChange={(v) => patch("console", { defaultFade: v })}
                />
              </Row>
            </Section>

            <Section title="Web / Timing">
              <Row label="Web UI port">
                <NumInput value={cfg.web.port} onChange={(v) => patch("web", { port: v })} />
              </Row>
              <Row label="Fade frame (ms)">
                <NumInput
                  value={cfg.timing.fadeFrameMs}
                  onChange={(v) => patch("timing", { fadeFrameMs: v })}
                />
              </Row>
              <Row label="Keep-alive (ms)">
                <NumInput
                  value={cfg.timing.keepAliveMs}
                  onChange={(v) => patch("timing", { keepAliveMs: v })}
                />
              </Row>
              <Row label="Startup grace (ms)">
                <NumInput
                  value={cfg.timing.startupGraceMs}
                  onChange={(v) => patch("timing", { startupGraceMs: v })}
                />
              </Row>
              <Row label="Feedback heartbeat (ms)">
                <NumInput
                  value={cfg.timing.feedbackHeartbeatMs}
                  onChange={(v) => patch("timing", { feedbackHeartbeatMs: v })}
                />
              </Row>
            </Section>

            <Section title="Art-Net">
              <Row label="Port">
                <NumInput value={cfg.artnet.port} onChange={(v) => patch("artnet", { port: v })} />
              </Row>
              <Row label="Local IP" hint="ArtPoll; blank = auto">
                <Input
                  value={cfg.artnet.localIp}
                  onChange={(e) => patch("artnet", { localIp: e.target.value })}
                  className="max-w-52"
                  placeholder="auto-detect"
                />
              </Row>
              <Row label="Universes">
                <NumInput
                  value={cfg.artnet.universes}
                  onChange={(v) => patch("artnet", { universes: v })}
                />
              </Row>
              <Row label="Channels">
                <NumInput
                  value={cfg.artnet.channels}
                  onChange={(v) => patch("artnet", { channels: v })}
                />
              </Row>
              <div className="pt-2">
                <div className="mb-1 text-sm">Output nodes</div>
                <div className="space-y-2">
                  {cfg.artnet.outputs.map((o, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Input
                        placeholder="Name"
                        value={o.name}
                        onChange={(e) =>
                          patch("artnet", {
                            outputs: cfg.artnet.outputs.map((x, idx) =>
                              idx === i ? { ...x, name: e.target.value } : x
                            ),
                          })
                        }
                        className="h-8 w-36"
                      />
                      <Input
                        placeholder="IP"
                        value={o.ip}
                        onChange={(e) =>
                          patch("artnet", {
                            outputs: cfg.artnet.outputs.map((x, idx) =>
                              idx === i ? { ...x, ip: e.target.value } : x
                            ),
                          })
                        }
                        className="h-8 w-32"
                      />
                      <Input
                        type="number"
                        placeholder="Port"
                        value={o.port ?? cfg.artnet.port}
                        onChange={(e) =>
                          patch("artnet", {
                            outputs: cfg.artnet.outputs.map((x, idx) =>
                              idx === i ? { ...x, port: Number(e.target.value) } : x
                            ),
                          })
                        }
                        className="h-8 w-24"
                      />
                      <Input
                        placeholder="Universes e.g. 2,3,4"
                        value={o.universes.join(", ")}
                        onChange={(e) =>
                          patch("artnet", {
                            outputs: cfg.artnet.outputs.map((x, idx) =>
                              idx === i
                                ? {
                                    ...x,
                                    universes: e.target.value
                                      .split(",")
                                      .map((s) => Number(s.trim()))
                                      .filter((n) => Number.isFinite(n)),
                                  }
                                : x
                            ),
                          })
                        }
                        className="h-8 w-44"
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          patch("artnet", {
                            outputs: cfg.artnet.outputs.filter((_, idx) => idx !== i),
                          })
                        }
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      patch("artnet", {
                        outputs: [
                          ...cfg.artnet.outputs,
                          { name: "", ip: "", port: cfg.artnet.port, universes: [] },
                        ],
                      })
                    }
                  >
                    <Plus className="h-4 w-4" /> Add node
                  </Button>
                </div>
              </div>
            </Section>

            <Section title="Companion / OSC">
              <Row label="Listen port" hint="Companion sends here">
                <NumInput
                  value={cfg.companion.listenPort}
                  onChange={(v) => patch("companion", { listenPort: v })}
                />
              </Row>
              <div className="pt-1">
                <div className="mb-1 text-sm">Feedback targets</div>
                <div className="space-y-2">
                  {cfg.companion.feedbackTargets.map((t, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        placeholder="IP"
                        value={t.ip}
                        onChange={(e) =>
                          patch("companion", {
                            feedbackTargets: cfg.companion.feedbackTargets.map((x, idx) =>
                              idx === i ? { ...x, ip: e.target.value } : x
                            ),
                          })
                        }
                        className="h-8 w-40"
                      />
                      <Input
                        type="number"
                        placeholder="Port"
                        value={t.port}
                        onChange={(e) =>
                          patch("companion", {
                            feedbackTargets: cfg.companion.feedbackTargets.map((x, idx) =>
                              idx === i ? { ...x, port: Number(e.target.value) } : x
                            ),
                          })
                        }
                        className="h-8 w-24"
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          patch("companion", {
                            feedbackTargets: cfg.companion.feedbackTargets.filter(
                              (_, idx) => idx !== i
                            ),
                          })
                        }
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      patch("companion", {
                        feedbackTargets: [...cfg.companion.feedbackTargets, { ip: "", port: 9001 }],
                      })
                    }
                  >
                    <Plus className="h-4 w-4" /> Add target
                  </Button>
                </div>
              </div>
              <div className="mt-3 space-y-1 border-t border-border/60 pt-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={cfg.companion.customVariables.enabled}
                    onChange={(e) => setCV({ enabled: e.target.checked })}
                  />
                  Push values into Companion custom variables
                </label>
                {cfg.companion.customVariables.enabled && (
                  <>
                    <Row label="API IP">
                      <Input
                        value={cfg.companion.customVariables.ip}
                        onChange={(e) => setCV({ ip: e.target.value })}
                        className="max-w-52"
                      />
                    </Row>
                    <Row label="API port" hint="Companion OSC listener">
                      <NumInput
                        value={cfg.companion.customVariables.port}
                        onChange={(v) => setCV({ port: v })}
                      />
                    </Row>
                    <Row label="Variable prefix">
                      <Input
                        value={cfg.companion.customVariables.prefix}
                        onChange={(e) => setCV({ prefix: e.target.value })}
                        className="max-w-52"
                      />
                    </Row>
                  </>
                )}
              </div>
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}
