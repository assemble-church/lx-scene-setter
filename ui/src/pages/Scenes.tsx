import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Plus, Code2, Trash2, SlidersHorizontal } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useEngine } from "@/lib/useEngine";
import {
  command,
  createScene,
  setLabel,
  getSceneRaw,
  setSceneRaw,
  deleteScene,
  type SceneStatus,
} from "@/lib/api";

const FADE = 2;

function StatusBadge({ s }: { s: SceneStatus }) {
  if (s.state === 2)
    return (
      <Badge variant="warning" className="tabular-nums">
        fading {s.fadeRemaining.toFixed(1)}s
      </Badge>
    );
  if (s.state === 1) return <Badge variant="success">on</Badge>;
  return <Badge variant="outline">off</Badge>;
}

function LabelInput({ id, label }: { id: string; label: string }) {
  const [val, setVal] = useState(label);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setVal(label);
  }, [label, editing]);

  async function commit() {
    setEditing(false);
    const v = val.trim();
    if (v !== label) {
      try {
        await setLabel(id, v);
      } catch {
        setVal(label);
      }
    }
  }

  return (
    <Input
      value={val}
      placeholder={`Scene ${id}`}
      onFocus={() => setEditing(true)}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setVal(label);
          e.currentTarget.blur();
        }
      }}
      className="h-8 max-w-xs"
    />
  );
}

export function Scenes() {
  const { state } = useEngine();
  const scenes = state?.scenes ?? [];
  const navigate = useNavigate();

  const [createOpen, setCreateOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [recordId, setRecordId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Raw JSON editor
  const [rawId, setRawId] = useState<string | null>(null);
  const [rawText, setRawText] = useState("");
  const [rawError, setRawError] = useState<string | null>(null);
  const [rawLoading, setRawLoading] = useState(false);

  const sceneOf = (id: string | null) => (id ? scenes.find((s) => s.id === id) : null);
  const labelOf = (id: string | null) => sceneOf(id)?.label || (id ? `Scene ${id}` : "scene");

  async function doCreate() {
    setBusy(true);
    try {
      await createScene(newLabel.trim());
      setNewLabel("");
      setCreateOpen(false);
    } finally {
      setBusy(false);
    }
  }

  async function doRecord() {
    if (!recordId) return;
    setBusy(true);
    try {
      await command(`/scene/${recordId}/rec`);
      setRecordId(null);
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (!deleteId) return;
    setBusy(true);
    try {
      await deleteScene(deleteId);
      setDeleteId(null);
    } finally {
      setBusy(false);
    }
  }

  async function openRaw(id: string) {
    setRawId(id);
    setRawError(null);
    setRawText("");
    setRawLoading(true);
    try {
      const raw = await getSceneRaw(id);
      setRawText(JSON.stringify(raw, null, 2));
    } catch (err) {
      setRawError(err instanceof Error ? err.message : String(err));
    } finally {
      setRawLoading(false);
    }
  }

  async function saveRaw() {
    if (!rawId) return;
    setBusy(true);
    setRawError(null);
    try {
      await setSceneRaw(rawId, rawText);
      setRawId(null);
    } catch (err) {
      setRawError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Scenes</h1>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" /> New scene
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {scenes.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Label</th>
                  <th className="w-32 px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {scenes.map((s) => (
                  <tr key={s.id} className="border-b border-border/40 last:border-0">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <span className="w-8 shrink-0 text-xs text-muted-foreground">#{s.id}</span>
                        <LabelInput id={s.id} label={s.label} />
                      </div>
                    </td>
                    <td className="w-32 px-4 py-2">
                      <StatusBadge s={s} />
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant={s.on ? "secondary" : "default"}
                          className="w-24"
                          onClick={() => command(`/scene/${s.id}/${s.on ? "off" : "on"}`, [FADE])}
                        >
                          {s.on ? "Deactivate" : "Activate"}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => navigate(`/scene/${s.id}`)}>
                          <SlidersHorizontal className="h-4 w-4" /> Edit
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setRecordId(s.id)}>
                          Record
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openRaw(s.id)}
                          title="Edit raw JSON"
                        >
                          <Code2 className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteId(s.id)}
                          title="Delete scene"
                        >
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
              No scenes yet. Create one, then record a look into it.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Create scene */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New scene</DialogTitle>
            <DialogDescription>
              Creates an empty scene. Record a look into it afterwards.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Label (e.g. Stage Wash)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) doCreate();
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={doCreate} disabled={busy}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Record confirmation */}
      <Dialog open={recordId !== null} onOpenChange={(o) => !o && setRecordId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record “{labelOf(recordId)}”?</DialogTitle>
            <DialogDescription>
              Captures the <strong>current output exactly as it is right now</strong>, overwriting
              whatever was stored. Record with other layers down so the scene only captures its own
              channels.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRecordId(null)}>
              Cancel
            </Button>
            <Button onClick={doRecord} disabled={busy}>
              Record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{labelOf(deleteId)}”?</DialogTitle>
            <DialogDescription>
              This permanently removes scene #{deleteId} and its recorded data. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteId(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={doDelete} disabled={busy}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Raw JSON editor */}
      <Dialog open={rawId !== null} onOpenChange={(o) => !o && setRawId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit raw — “{labelOf(rawId)}”</DialogTitle>
            <DialogDescription>
              The stored scene object. <code>data</code> is an array of universes, each an array of
              channel values (0–255). Validated on save.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={rawLoading ? "Loading…" : rawText}
            onChange={(e) => setRawText(e.target.value)}
            spellCheck={false}
            className="h-80 font-mono text-xs"
            disabled={rawLoading}
          />
          {rawError && <p className="text-sm text-destructive">{rawError}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRawId(null)}>
              Cancel
            </Button>
            <Button onClick={saveRaw} disabled={busy || rawLoading}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
