"""FastAPI application: REST API under /api, built React frontend served at /.

    uvicorn api.main:app --reload            # API only (dev, with `npm run dev` in web/)
    python run.py                            # everything, single process
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from api.routers import credit, explain, market, models, portfolio, pricing, rates
from api.services import MissingDataError

DIST = Path(__file__).resolve().parent.parent / "web" / "dist"

app = FastAPI(
    title="qplat — Quant Pricing Platform API",
    version="1.0.0",
    description="Pricing engine (vanillas, americans, barriers, autocalls, bonds, futures), "
                "market data, volatility smile and LLM news sentiment.",
)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"], allow_headers=["*"])

for r in (market.router, pricing.router, rates.router, explain.router, models.router, portfolio.router, credit.router):
    app.include_router(r)


@app.exception_handler(ValueError)
async def value_error_handler(_: Request, exc: ValueError):
    # invalid contract terms rejected by the engine (e.g. expiry <= 0, tree arbitrage)
    return JSONResponse(status_code=422, content={"detail": str(exc)})


@app.exception_handler(MissingDataError)
async def missing_data_handler(_: Request, exc: MissingDataError):
    return JSONResponse(status_code=409, content={"detail": str(exc)})


if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        if path.startswith("api/"):
            return JSONResponse(status_code=404, content={"detail": "not found"})
        candidate = DIST / path
        if path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html")  # client-side routing
