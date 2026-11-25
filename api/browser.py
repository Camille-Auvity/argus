"""Run the FastAPI app inside the browser (Pyodide, no server, no threads).

The web worker calls `handle(method, path, body)`, which feeds one request to
the ASGI app in-process and returns (status, body). The visitor's own
positions live in their browser and are re-imported at start-up.
"""

from __future__ import annotations

import json
import os


def _patch_threadpool() -> None:
    """Pyodide has no threads: run FastAPI's sync endpoints directly on the event loop."""
    import fastapi.concurrency
    import fastapi.dependencies.utils
    import fastapi.routing
    import starlette.concurrency

    async def run_direct(func, *args, **kwargs):
        return func(*args, **kwargs)

    for module in (starlette.concurrency, fastapi.concurrency, fastapi.routing, fastapi.dependencies.utils):
        if hasattr(module, "run_in_threadpool"):
            module.run_in_threadpool = run_direct


_app = None


def setup(db_path: str, positions_json: str | None = None) -> None:
    global _app
    os.environ["QPLAT_DB"] = db_path
    os.environ["QPLAT_STATIC"] = "1"
    _patch_threadpool()
    from api.main import app  # imported after the environment is set

    _app = app
    if positions_json:
        import_positions(positions_json)


async def handle(method: str, path: str, body: str | None = None) -> tuple[int, str]:
    path_only, _, query = path.partition("?")
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method.upper(),
        "scheme": "http", "path": path_only, "raw_path": path_only.encode(), "query_string": query.encode(),
        "root_path": "", "headers": [(b"host", b"argus"), (b"content-type", b"application/json")],
        "client": ("browser", 0), "server": ("argus", 80),
    }
    payload = (body or "").encode()
    delivered = False

    async def receive():
        nonlocal delivered
        if not delivered:
            delivered = True
            return {"type": "http.request", "body": payload, "more_body": False}
        return {"type": "http.disconnect"}

    status = 500
    chunks: list[bytes] = []

    async def send(message):
        nonlocal status
        if message["type"] == "http.response.start":
            status = message["status"]
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))

    await _app(scope, receive, send)
    return status, b"".join(chunks).decode()


def export_positions() -> str:
    from api import services

    return json.dumps(services.get_db().positions())


def import_positions(positions_json: str) -> int:
    from api import services

    db = services.get_db()
    db.clear_positions()
    rows = json.loads(positions_json)
    for r in rows:
        db.add_position(r["kind"], r["quantity"], r["params"], r.get("ticker"), r.get("entry_price"),
                        r.get("book") or "Principal", r.get("label") or "")
    return len(rows)
