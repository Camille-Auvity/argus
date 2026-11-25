/// <reference lib="webworker" />
// In-browser backend (static / GitHub Pages build): runs the FastAPI app with
// Pyodide in a web worker, so heavy pricing never freezes the page.

const PYODIDE_VERSION = "0.26.4";
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
// packages shipped by Pyodide itself
const PYODIDE_PACKAGES = ["numpy", "scipy", "pandas", "pydantic", "sqlite3", "ssl", "micropip"];
// pure-Python wheels from PyPI, pinned to versions compatible with Pyodide's typing-extensions / pydantic
const PYPI_PACKAGES = ["fastapi==0.115.6", "starlette==0.41.3", "anyio==4.6.2.post1", "sniffio==1.3.1", "idna==3.10", "tzdata==2024.2"];

export type WorkerIn =
  | { type: "init"; base: string; positions: string | null }
  | { type: "request"; id: number; method: string; path: string; body: string | null };

export type WorkerOut =
  | { type: "progress"; step: string; done: number; total: number }
  | { type: "ready"; manifest: Record<string, unknown> }
  | { type: "fatal"; message: string }
  | { type: "response"; id: number; status: number; body: string }
  | { type: "positions"; json: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pyodide = any;

const post = (msg: WorkerOut) => (self as unknown as Worker).postMessage(msg);
let pyodide: Pyodide = null;
let queue: Promise<unknown> = Promise.resolve();

async function init(base: string, positions: string | null) {
  const total = 5;
  post({ type: "progress", step: "Chargement de Python (WebAssembly)", done: 0, total });
  const { loadPyodide } = await import(/* @vite-ignore */ `${PYODIDE_URL}pyodide.mjs`);
  pyodide = await loadPyodide({ indexURL: PYODIDE_URL });

  post({ type: "progress", step: "Bibliothèques scientifiques : numpy, scipy, pandas", done: 1, total });
  await pyodide.loadPackage(PYODIDE_PACKAGES);

  post({ type: "progress", step: "Serveur d'API (FastAPI)", done: 2, total });
  const micropip = pyodide.pyimport("micropip");
  await micropip.install(PYPI_PACKAGES, { deps: false });

  post({ type: "progress", step: "Moteur de pricing et données de marché", done: 3, total });
  const [code, db, manifest] = await Promise.all([
    fetch(`${base}engine/argus.zip`).then((r) => r.arrayBuffer()),
    fetch(`${base}engine/qplat.db`).then((r) => r.arrayBuffer()),
    fetch(`${base}engine/manifest.json`).then((r) => r.json()),
  ]);
  pyodide.unpackArchive(code, "zip", { extractDir: "/home/pyodide/argus" });
  pyodide.FS.writeFile("/home/pyodide/qplat.db", new Uint8Array(db));

  post({ type: "progress", step: "Démarrage de l'application", done: 4, total });
  pyodide.globals.set("_positions", positions);
  await pyodide.runPythonAsync(`
import sys
sys.path.insert(0, "/home/pyodide/argus")
from api import browser
browser.setup("/home/pyodide/qplat.db", _positions)
`);
  post({ type: "ready", manifest });
}

async function handle(id: number, method: string, path: string, body: string | null) {
  try {
    pyodide.globals.set("_m", method);
    pyodide.globals.set("_p", path);
    pyodide.globals.set("_b", body);
    const res = await pyodide.runPythonAsync("await browser.handle(_m, _p, _b)");
    const [status, text] = res.toJs();
    res.destroy();
    post({ type: "response", id, status, body: text });
    // the visitor's book lives in their browser: hand it back after every change
    if (method !== "GET" && path.startsWith("/api/portfolio") && status < 400) {
      post({ type: "positions", json: await pyodide.runPythonAsync("browser.export_positions()") });
    }
  } catch (e) {
    post({ type: "response", id, status: 500, body: JSON.stringify({ detail: String((e as Error).message ?? e) }) });
  }
}

self.onmessage = (event: MessageEvent<WorkerIn>) => {
  const msg = event.data;
  if (msg.type === "init") {
    init(msg.base, msg.positions).catch((e) => post({ type: "fatal", message: String((e as Error).message ?? e) }));
  } else if (msg.type === "request") {
    // one Python runtime: requests are served one after the other
    queue = queue.then(() => handle(msg.id, msg.method, msg.path, msg.body));
  }
};
