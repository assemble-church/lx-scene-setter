import { useEffect, useRef, useState } from "react";

// Tap vs hold on a touch surface. A hold fires once after `ms` (with a little
// haptic where the device has one); a tap fires on release if the hold didn't.
// Any real movement (the user is scrolling) cancels both.

const MOVE_TOLERANCE = 10; // px

export function useLongPress({ onTap, onHold, disabled, ms = 550 }: { onTap?: () => void; onHold?: () => void; disabled?: boolean; ms?: number }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const [holding, setHolding] = useState(false);

  function cancel() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
    setHolding(false);
  }
  useEffect(() => cancel, []);

  const handlers = {
    onPointerDown(e: React.PointerEvent) {
      if (disabled || (e.pointerType === "mouse" && e.button !== 0)) return;
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      if (!onHold) return;
      setHolding(true);
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        setHolding(false);
        navigator.vibrate?.(25);
        onHold();
      }, ms);
    },
    onPointerMove(e: React.PointerEvent) {
      const o = origin.current;
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > MOVE_TOLERANCE) cancel();
    },
    onPointerUp() {
      if (!origin.current) return; // cancelled (scrolled away) or never started
      const wasWaiting = !!timer.current || !onHold;
      cancel();
      if (wasWaiting && !fired.current) onTap?.();
    },
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu(e: React.MouseEvent) {
      e.preventDefault();
    },
  };

  return { handlers, holding };
}
