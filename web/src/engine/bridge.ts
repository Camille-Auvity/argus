// Main-thread side of the in-browser backend: starts the worker, forwards API
// calls to it and keeps the visitor's portfolio in localStorage.

import type { WorkerIn, WorkerOut } from "./worker";

export const STATIC_MODE = import.meta.env.VITE_STATIC === "1";

const POSITIONS_KEY = "argus-positions";

export interface EngineProgress {
  step: string;
  done: number;
  total: number;
}

type Listener = (state: EngineState) => void;

export type EngineState =
  | { status: "loading"; progress: EngineProgress }
  | { status: "ready"; manifest: Record<string, unknown> }
  | { status: "error"; message: string };

let worker: Worker | null = null;
let state: EngineState = { status: "loading", progress: { step: "Initialisation", done: 0, total: 5 } };
const listeners = new Set<Listener>();
const pending = new Map<number, (r: { status: number; body: string }) => void>();
let nextId = 1;
let ready: Promise<void> | null = null;

function setState(s: EngineState) {
  state = s;
  listeners.forEach((l) => l(s));
}

function readPositions(): string | null {
  try {
    return localStorage.getItem(POSITIONS_KEY);
  } catch {
    return null;
  }
}

function savePositions(json: string) {
  try {
    localStorage.setItem(POSITIONS_KEY, json);
  } catch {
    /* storage unavailable: the book lasts for this visit only */
  }
}

export function startEngine(): Promise<void> {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerOut>) => {
      const msg = event.data;
      if (msg.type === "progress") setState({ status: "loading", progress: msg });
      else if (msg.type === "ready") {
        setState({ status: "ready", manifest: msg.manifest });
        resolve();
      } else if (msg.type === "fatal") {
        setState({ status: "error", message: msg.message });
        reject(new Error(msg.message));
      } else if (msg.type === "response") {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      } else if (msg.type === "positions") savePositions(msg.json);
    };
    worker.onerror = (e) => {
      setState({ status: "error", message: e.message || "le moteur n'a pas pu démarrer" });
      reject(new Error(e.message));
    };
    const init: WorkerIn = { type: "init", base: import.meta.env.BASE_URL, positions: readPositions() };
    worker.postMessage(init);
  });
  return ready;
}

export function subscribeEngine(listener: Listener): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

/** Same contract as fetch on the real API: resolves with the HTTP status and JSON body text. */
export async function engineRequest(method: string, path: string, body: string | null): Promise<{ status: number; body: string }> {
  await startEngine();
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    const msg: WorkerIn = { type: "request", id, method, path, body };
    worker!.postMessage(msg);
  });
}
