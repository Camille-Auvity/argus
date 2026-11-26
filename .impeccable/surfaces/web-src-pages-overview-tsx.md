---
version: 1
slug: "web-src-pages-overview-tsx"
primary_target: "web/src/pages/Overview.tsx"
related_targets: ["web/src/styles/designs.css","web/src/components/Layout.tsx"]
---

# Argus app shell — multi-world redesign

Scope: the whole web app (operate mode), shell plus overview signatures. The owner could not choose and asked for four
switchable worlds next to the untouched original ("Classique"), picked in the top-bar "Design" select
(persisted in localStorage `argus-design`, also `?design=` in the URL). Audience: recruiters/juries (first minute) and
the owner as practitioner (dense daily use), equally.

## Direction contract

THESIS: Argus owns four interchangeable visual worlds over one product shell; each world lends only type, palette,
density and one signature move, and refuses the category default (dark trading dashboard, kept only as « Classique »).

OWN-WORLD:
- Les cent yeux: deep peacock-teal rail #0E3B43, cool fog ground #E8EFEC, white panels, iridescent series (cobalt, gold, emerald, violet), Hanken Grotesk, ocellus brand mark.
- Plan de métro: midnight enamel #0F1A3A, porcelain text, line inks (cobalt, scarlet, amber, green, violet), Red Hat Text, nav groups as coloured lines, active page as a station ring.
- Série de billets: cool paper white, crisp 2-3px corners, one denomination hue per app section (20 blue, 10 red, 50 orange, 100 green, 500 violet, 5 grey, yellow for alerts) owning the nav band and the page-head band, Public Sans.
- Working paper: off-white #FCFCFA, Source Serif 4 text and tables with Source Sans 3 chrome, burgundy rubric #7A1F2B, no boxes, booktabs rules.

STORY: an evaluator sees in one viewport that the platform is real, broad and validated; a practitioner keeps every control and number where it was, in a world they chose.

FIRST VIEWPORT (overview, 1440x900): standard sidebar + top bar unchanged in structure; directly under the page title, the active world's signature —
eyes: « Les cent yeux » surveillance map (an ocellus per underlying: size = 1M realised vol on a fixed sqrt ramp, iris = day move) beside a dense quotes table, click selects the underlying;
metro: « Plan du réseau Argus », pages as stations on 5 lines following engine dependencies, clickable, option-chain stations suspended for EU underlyings;
billets: the selected underlying printed as a face value on a guilloché rosette;
paper: « Tableau 1. Résultats publiés reproduits par Argus » (only figures stated in docs/METHODOLOGIE.md), and every panel on every page numbered « Figure n. » / « Tableau n. ».

FORM: operate-mode shell, world lends type/palette/density/signature only; assigned direction of round 1 (eyes) plus three directions the owner kept from rounds 1-2. seed:11e25098b374a8e5

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
