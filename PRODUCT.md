# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, weighted equally (confirmed by the owner):

- **Evaluators**: quant researcher / trader recruiters, interviewers and EDHEC juries who open the public GitHub Pages link. They have a minute or two and must understand what the author can build: models, data, validation.
- **The owner as a practitioner**: an EDHEC student who uses Argus as a working tool to price instruments, run portfolio risk and reproduce research results. Density and speed of use matter.

## Product Purpose

Argus is a quant pricing, risk and research platform. A Python engine (`qplat/`) prices vanilla, American, barrier, digital, Asian, cliquet and autocall options, bonds, futures, CDS, caps/floors, FX options and variance swaps. It calibrates Heston, SVI and Dupire, runs portfolio risk (VaR, ES, stress, P&L explain), allocation, factor research (Moreira-Muir), and applied continuous-time finance labs. Everything is shown in a web app (FastAPI + React) with French explainers. Success: an evaluator trusts the rigour within minutes, and the owner can work in it daily.

## Positioning

Every model is tested against a published reference (Haug, Kemna-Vorst, Derman-Kamal, DeMiguel 1/N, Moreira-Muir Table I, CBOE VIX), runs on real market data refreshed hourly, and the full Python engine runs in the visitor's browser through Pyodide: no server, nothing faked. Each block ships with formulas (`docs/METHODOLOGIE.md`), tests (225) and a French explainer page.

## Operating Context

- Local use: `python run.py`, served on localhost:8000; data in SQLite, refreshed on demand.
- Public use: static GitHub Pages build (https://camille-auvity.github.io/argus/), Pyodide web worker, ~25 MB first load then cached, data refreshed hourly on weekdays by GitHub Actions.
- Markets: US (AAPL, MSFT, NVDA, QQQ, SPY, with option chains) and Europe (AIR.PA, ASML.AS, MC.PA, SAN.PA, SAP.DE, TTE.PA, ^FCHI, ^STOXX50E, no option chains from Yahoo).
- Pages: overview, news & sentiment, portfolio & risk, allocation, vanilla options, pricing methods, implied vol, vol models, exotics, variance swaps, structured products, curves & bonds, rates & FX options, credit, research, applied theory, documentation.

## Capabilities and Constraints

- Stack is fixed: React + TypeScript + Vite, TanStack Query, ECharts (modular registration in `web/src/components/EChart.tsx`), KaTeX documentation rendered from `docs/METHODOLOGIE.md`, design tokens in `web/src/styles/tokens.css`, styles in `web/src/styles/app.css`.
- Interface language is French today; the owner did not make it binding.
- Dense numeric content everywhere: tables, Greeks, curves, smiles, densities. Tabular numerals required.
- Light and dark themes both exist; neither was made binding.
- The static build must keep working (Pyodide, numpy 1 compatible engine).

## Brand Commitments

- The name **Argus** is binding. Everything else visual (palette, type, layout, components) is open for replacement.

## Evidence on Hand

- Replicated results: Moreira-Muir Table I (market alpha 4.9 %, beta 0.60, appraisal ratio 0.33 on 1926-2015), DeMiguel et al. 1/N, Derman-Kamal hedging error, course binomial example (10.714 / 11.820), VIX recomputation (median gap 0.43 pt vs official), Heston smile replication = Heston expected variance to 1e-4.
- 225 automated tests; methodology document with 26 sections.
- No testimonials, users, press or employer endorsements exist; never invent them.

## Product Principles

1. Rigour is visible: every number can be traced to a formula, a test or a reference.
2. Real data, really computed: never mock what the engine can compute live.
3. Explain, then show: each tool teaches the finance behind it in plain French.
4. Dense but legible: practitioners need many numbers at once; hierarchy keeps them readable.
5. First minute counts: an evaluator must see scope and seriousness without clicking through twenty pages.
