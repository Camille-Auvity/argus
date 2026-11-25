#!/usr/bin/env python3
"""Launch the platform.

    python run.py            # build the web app if needed, serve everything on http://localhost:8000
    python run.py --dev      # API with auto-reload on :8000 + Vite dev server with hot reload on :5173
    python run.py --build    # force a rebuild of the web app before serving
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"


def npm(*args: str) -> None:
    if not shutil.which("npm"):
        sys.exit("npm introuvable : installez Node.js (brew install node).")
    subprocess.run(["npm", *args], cwd=WEB, check=True)


def needs_build() -> bool:
    dist = WEB / "dist" / "index.html"
    if not dist.exists():
        return True
    built = dist.stat().st_mtime
    sources = [p for p in (WEB / "src").rglob("*") if p.is_file()] + [WEB / "index.html", WEB / "package.json"]
    return any(p.stat().st_mtime > built for p in sources)


def open_browser_later(url: str) -> None:
    threading.Thread(target=lambda: (time.sleep(1.5), webbrowser.open(url)), daemon=True).start()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dev", action="store_true", help="hot reload for API and frontend")
    parser.add_argument("--build", action="store_true", help="force a frontend rebuild")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    if not (WEB / "node_modules").exists():
        npm("install")

    uvicorn_cmd = [sys.executable, "-m", "uvicorn", "api.main:app", "--port", str(args.port)]
    if args.dev:
        api = subprocess.Popen([*uvicorn_cmd, "--reload", "--reload-dir", "api", "--reload-dir", "qplat"], cwd=ROOT)
        if not args.no_browser:
            open_browser_later("http://localhost:5173")
        try:
            npm("run", "dev")
        finally:
            api.terminate()
        return

    if args.build or needs_build():
        print("Construction de l'interface web…")
        npm("run", "build")
    url = f"http://localhost:{args.port}"
    print(f"Plateforme disponible sur {url}  (Ctrl+C pour arrêter)")
    if not args.no_browser:
        open_browser_later(url)
    subprocess.run(uvicorn_cmd, cwd=ROOT)


if __name__ == "__main__":
    main()
