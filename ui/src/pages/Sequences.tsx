import { useEffect, useState } from "react";
import { Plus, Trash2, Waves, Sun } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SequenceRecorder } from "@/components/SequenceRecorder";
import { SequenceDials } from "@/components/SequenceDials";
import { useEngine } from "@/lib/useEngine";
import { command, deleteSequence, setSequenceLabel, type SequenceStatus } from "@/lib/api";

const FADE = 2;

function LabelInput({ s }: { s: SequenceStatus }) {
  const [val, setVal] = useState(s.label);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setVal(s.label);
  }, [s.label, editing]);
  return (
    <Input
      value={val}
      placeholder={`Sequence ${s.id}`}
      onFocus={() => setEditing(true)}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (val.trim() !== s.label) setSequenceLabel(s.id, val.trim()).catch(() => setVal(s.label));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setVal(s.label);
          e.currentTarget.blur();
        }
      }}
      className="h-8 max-w-xs"
    />
  );
}

export function Sequences() {
  const { state } = useEngine();
  const sequences = state?.sequences ?? [];
  const recording = state?.recording?.state ?? "idle";
  const [recorderOpen, setRecorderOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const locked = !!state && (state.consoleActive || !!state.editing || !!state.programmerActive);

  // A take in progress (e.g. started from another screen) reopens the recorder.
  useEffect(() => {
    if (recording !== "idle") setRecorderOpen(true);
  }, [recording]);

  const doomed = sequences.find((s) => s.id === deleteId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Sequences</h1>
        <Button onClick={() => setRecorderOpen(true)}>
          <Plus className="h-4 w-4" /> New sequence
        </Button>
      </div>

      <Card className="glow-live">
        <CardContent className="p-0">
          {sequences.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Label</th>
                  <th className="px-4 py-2 font-medium">Content</th>
                  <th className="w-36 px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sequences.map((s) => (
                  <tr key={s.id} className="border-b border-white/[0.04] transition-colors last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <span className="w-8 shrink-0 text-xs text-muted-foreground">#{s.id}</span>
                        <LabelInput s={s} />
                      </div>
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      <div className="flex items-center gap-4">
                      <div className="h-12 w-52 shrink-0">
                        <SequenceDials id={s.id} created={s.created} elapsedMs={s.elapsedMs} level={s.level} />
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="flex items-center gap-1.5">
                          <Waves className="h-3.5 w-3.5" />
                          {s.periods.length ? s.periods.map((p) => `${p.toFixed(2)}s`).join(" + ") : "no repeating effects"}
                          {s.irregular && " + take loop"}
                        </span>
                        <span>{s.movingChannels} moving ch</span>
                        {s.stillLit > 0 && (
                          <span className="flex items-center gap-1">
                            <Sun className="h-3 w-3" /> {s.stillLit} still
                          </span>
                        )}
                        <span>U{s.universes.join(", U")}</span>
                      </div>
                      </div>
                    </td>
                    <td className="w-36 whitespace-nowrap px-4 py-2">
                      {s.state === 2 ? (
                        <Badge variant="warning" className="tabular-nums">
                          fading {s.fadeRemaining.toFixed(1)}s
                        </Badge>
                      ) : s.on ? (
                        <Badge variant="success">running</Badge>
                      ) : (
                        <Badge variant="outline">off</Badge>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant={s.on ? "secondary" : "default"}
                          className="w-20"
                          disabled={locked}
                          onClick={() => command(`/sequence/${s.id}/${s.on ? "off" : "on"}`, [FADE])}
                        >
                          {s.on ? "Stop" : "Run"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleteId(s.id)} title="Delete sequence">
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              No sequences yet. Play a chase or effect on the desk, then press New sequence to record it.
            </p>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Companion: <code className="font-mono">/sequence/&lt;id&gt;/on</code>, <code className="font-mono">/off</code> or{" "}
        <code className="font-mono">/toggle</code> with an optional fade in seconds;{" "}
        <code className="font-mono">/sequences/off</code> stops them all. Feedback on{" "}
        <code className="font-mono">/scene-setter/sequence/&lt;id&gt;/active</code> (0 off, 1 running, 2 fading).
      </p>

      <SequenceRecorder open={recorderOpen} onOpenChange={setRecorderOpen} />

      <Dialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{doomed?.label || `Sequence ${deleteId}`}”?</DialogTitle>
            <DialogDescription>This permanently removes the sequence. This can't be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (deleteId) await deleteSequence(deleteId).catch(() => {});
                setDeleteId(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
