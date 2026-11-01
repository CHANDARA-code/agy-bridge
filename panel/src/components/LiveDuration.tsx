import { useEffect, useState } from "react";
import type { Task } from "../api";
import { formatDuration } from "../format";

const listeners = new Set<(now: number) => void>();
let timer: number | null = null;

function subscribe(listener: (now: number) => void) {
  listeners.add(listener);
  if (timer === null) {
    timer = window.setInterval(() => {
      const now = Date.now();
      for (const each of listeners) each(now);
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

export function LiveDuration({ task }: { task: Pick<Task, "status" | "startedAt" | "durationMs"> }) {
  const running = task.status === "running";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => (running ? subscribe(setNow) : undefined), [running]);

  if (!running) return <>{formatDuration(task.durationMs)}</>;
  const startMs = Date.parse(task.startedAt);
  return <>{formatDuration(Number.isNaN(startMs) ? task.durationMs : Math.max(0, now - startMs))}</>;
}
