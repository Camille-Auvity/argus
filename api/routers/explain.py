"""Step-by-step views of each pricing method (same engine code paths as /api/price)."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from fastapi import APIRouter
from pydantic import Field

from api.routers.pricing import _cache_key, _vanilla
from api.schemas import VanillaRequest
from qplat.analytics import explain

router = APIRouter(prefix="/api/explain", tags=["methods"])


class TreeExplainRequest(VanillaRequest):
    display_steps: int = Field(6, ge=1, le=12)


class LsmExplainRequest(VanillaRequest):
    lsm_steps: int = Field(50, ge=5, le=200)
    snapshot_step: int | None = Field(None, ge=0)


class GreeksExplainRequest(VanillaRequest):
    method: Literal["tree", "mc"] = "tree"


@lru_cache(maxsize=64)
def _bs(payload: str, _curve: str):
    return explain.explain_black_scholes(_vanilla(VanillaRequest.model_validate_json(payload)))


@lru_cache(maxsize=64)
def _tree(payload: str, _curve: str):
    req = TreeExplainRequest.model_validate_json(payload)
    return explain.explain_tree(_vanilla(req), req.display_steps)


@lru_cache(maxsize=64)
def _mc(payload: str, _curve: str):
    req = VanillaRequest.model_validate_json(payload)
    return explain.explain_monte_carlo(_vanilla(req), n_paths=req.mc_paths)


@lru_cache(maxsize=64)
def _lsm(payload: str, _curve: str):
    req = LsmExplainRequest.model_validate_json(payload)
    return explain.explain_lsm(_vanilla(req), n_paths=min(req.mc_paths, 200_000), lsm_steps=req.lsm_steps,
                               snapshot_step=req.snapshot_step)


@lru_cache(maxsize=64)
def _greeks(payload: str, _curve: str):
    req = GreeksExplainRequest.model_validate_json(payload)
    return explain.explain_greeks(_vanilla(req), req.method, req.tree_steps, req.mc_paths)


@router.post("/black-scholes")
def black_scholes(req: VanillaRequest):
    """d1, d2, N(d1), N(d2), the two terms of the formula and the risk-neutral density of S_T."""
    return _bs(*_cache_key(req))


@router.post("/tree")
def tree(req: TreeExplainRequest):
    """Full small lattice (spot, value, exercise per node), u/d/p, convergence in N, exercise frontier."""
    return _tree(*_cache_key(req))


@router.post("/monte-carlo")
def monte_carlo(req: VanillaRequest):
    """Sample paths, distribution of S_T and payoffs, running estimate with 95% CI, antithetic gain."""
    return _mc(*_cache_key(req))


@router.post("/lsm")
def lsm(req: LsmExplainRequest):
    """Longstaff-Schwartz regression snapshot and estimated exercise frontier vs the tree's."""
    return _lsm(*_cache_key(req))


@router.post("/greeks")
def greeks(req: GreeksExplainRequest):
    """Bumped repricings behind each finite-difference Greek, vs closed form when available."""
    return _greeks(*_cache_key(req))
