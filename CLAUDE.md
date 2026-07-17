# KernTrip — Project Guide for Claude Code

## What this project is

KernTrip computes optical spacing and kerning from glyph outlines.
It ships as two products built from the same source:

- **Glyphs plugin** (Glyphs 3): `glyphs/KernTrip.glyphsPlugin`
- **Browser tool** (client-side, no server): `index.html`

Both use the **same file** `ui.html`, assembled by `build.js`.

KernTrip is a standalone fork of the classic Coupler v5 engine
(repo `../Coupler`) with an extended model. The Coupler repo also holds the
shared test fonts: `../Coupler/testfonts/` (Vergil, Kierkegaard,
Wittgenstein, Centenary, ...).

---

## Source of truth

```
src/html/template.html      <- HTML skeleton with %%STYLE%% and %%SCRIPTS%%
src/css/style.css           <- CSS (injected into %%STYLE%%)
src/js/01-globals.js        <- JS modules 01-16 (injected into %%SCRIPTS%%)
  02-geometry · 03-margins · 04-analysis · 05-compute-browser
  06-compute-glyphs · 07-output · 08-table · 09-spacing · 10-cadence
  11-preview · 12-testpage · 13-glyphs-init · 14-autoparam
  15-equilibrium · 16-wizard
glyphs/.../Resources/plugin.py  <- Python/PyObjC host (maintained by hand)
glyphs/.../Resources/fuchs.js   <- kerning corpus (KERNING_PAIRS) — do not edit
```

**Build artifacts** (never edit directly): `glyphs/.../Resources/ui.html`,
`index.html`, `fuchs.js` (root copy), `KernTrip.zip`.

---

## Build & test

```bash
bash make.sh        # build.js -> ui.html -> index.html + KernTrip.zip
                    # + installs the plugin into ~/Library/.../Glyphs 3/Plugins/
node build.js       # build only (optional version argument: node build.js 0.6.0)
```

**Browser:** open `index.html`, drop a font from `../Coupler/testfonts/`.
**Glyphs:** restart Glyphs (or reload the plugin), then Script menu -> KernTrip.
Logs appear with the prefix `[KernTrip]`; errors show in the Macro panel.
**Algorithm checks:** modules 02/03 run DOM-free in Node — repro scripts
against the test fonts are the fastest regression check.

---

## How the model works (key rules)

The whole pair formula lives ONCE in `pairCorrCore` + `buildPairCtx` +
`rhythmGridFromUI` (`03-margins.js`). Modules 05/06/14/16 call it.
**Add new rules there — never copy the formula into a caller.**

1. **Shape classes** (`pairShape`): each pair is classified by its geometric
   gap profile — opening depth = median − min (the median keeps O caps from
   marking convex pairs as "open"), eccentricity, giving **beta** (contact
   character) and **openness**.
2. **Air/contact blend**:
   `corr = ((1−beta)·(base−mean) + beta·(prox−dMin)) · (1−lazy) · (1−0.4·openness)`.
   Proximity target = closest reference self-pair distance + (base − mean_ref),
   so the reference pair gets the same correction for any beta (self-consistency).
   Beta is shown as a table column.
3. **Width** (`p-width`, default 100%): scales the base target gaps AND the
   min gap together; tracking stays purely additive (expert field, Extended).
4. **Rhythm grid** (`p-rhythm`, default on): stem+stem pairs snap their stem
   gap (edge to edge) to the cadence tick — the position snaps, not the value.
   Marked with a musical note in the table, `[rhythm]` in the CSV; exempt from
   dropping; the min gap always wins (capped pairs may leave the grid).
   **Stem detection** (`stemEdge`): the largest value cluster of the margin
   profile with a TIGHT tolerance (0.4% of UPM) over >=50% of the ink zones
   (and >=3) — serifs/brackets fall out as outliers; bowls and display stems
   with entasis form no tight cluster (by design).
5. **Stem gap** (`p-stemgap`, default 100%): target gap for stem pairs
   relative to the round reference (the HHOOHH experiment) — shifts base AND
   proximity target by `base·(f−1)`; full on stem+stem, half on stem+round.
6. **Triple equilibrium** (`15-equilibrium.js`, own tab): triples from the
   most frequent corpus pairs ((A,B)+(B,C)); delta = |optical white space
   left − right| around the middle glyph (kerning included). Median/P95 as a
   score, worst triples listed as bench tests; click -> preview. Reporting
   only, no solver.
7. **2D distance field for the min gap** (`minGap2D` + `KT_FINE_N=64`):
   per glyph a geometric fine profile (64 rows); the min gap checks the
   Euclidean condition `dx >= sqrt(minGap² − dy²)` across row borders too
   (dy conservatively = band gap). Replaces the zonal band-extreme check:
   identical on straight cases, more precise (less falsely pessimistic) on
   diagonals (V., L., A·V).
8. **Bias instead of threshold** (`p-bias`, −100..+100, default 0): one
   slider for legible vs. readable. Shifts beta (− -> contact, + -> air),
   raises the min gap up to +50% towards legible, and drops small corrections
   cost-based (base tolerance 0.3% of UPM, up to 4x wider on the disfavored
   side; never on capped/rhythmic pairs). The threshold parameter is gone
   everywhere (AutoParam runs automatically after font load and scans
   smooth/blur/mingap — zones fixed at 16 — in 5 range steps over
   coarse-to-fine rounds until max triple-equilibrium Δ < 10 fu (max 6
   rounds), keeps the value with the lowest max Δ, documents the result —
   timestamp · max-equilibrium · palette parameters — in Font Info → Notes
   via `kerntrip://note`, then opens the setup assistant; space pairs in
   `04-analysis` use the 0.3% noise floor).

**Slant detection on stem glyphs** (l/I/h, not "o", in 05/06): humanist
o axes (Centenary: 12.5°!) would otherwise be read as an italic angle and
break the stem detection.

**Setup assistant** (`16-wizard.js`, "Setup" button; opens automatically
after load → AutoParam (`apAfterAnalysis` in 14 calls `wizOpen`), can be
turned off via localStorage `kerntripWizAuto`):
measured values are collected automatically; the five design values
(width · stem gap+rhythm · bias · lazy · min gap) are set step by step on
type samples — 3 clickable variants per step (optician principle) plus a
fine slider; the live simulation computes only the ~20 pairs of the sample
via `pairCorrCore` (margins come from the `glyphCache` of the first
analysis). "Automatic" sets values via serif classification. Finish -> full
computation -> Equilibrium tab (`wizFinishPending` flag, hook
`wizMaybeAutoOpen()` at the end of 05/06).

Parameter panel: design values (Width · Stem gap · Rhythm · Lazy · Bias ·
Min gap · Round · Pair limit) in front; measuring values + Tracking
(expert field) under "Extended". There is no help page.

---

## Browser vs. Glyphs — same file, different behavior

```js
const IS_GLYPHS = !!window.__IS_GLYPHS;   // injected by plugin.py via WKUserScript
```

| Behavior | Browser | Glyphs |
|---|---|---|
| Font source | drag & drop TTF/OTF | Python -> evaluateJavaScript |
| Output | export CSV / copy | apply to font |
| IPC | — | kerntrip:// URL navigation |

## Important conventions

- **Source lives in `src/`** — never edit `ui.html` or `index.html` directly.
- **fuchs.js is read-only** — it holds the kerning corpus (KERNING_PAIRS).
- **All output goes through `outputPairs()`** — never use `kerningData`
  directly for apply/CSV/copy.
- **Min gap always uses the geometric data** (`leftGeom`/`rightGeom`/
  `leftFine`/`rightFine`) — never the smoothed/glow arrays.
- **No PyObjC block as a completion handler** — causes SIGSEGV; pass `None`.
- **Large IPC payloads are chunked** (URL length limit); ObjC class names
  (`KernTripPlugin`, `_KernTripNavDelegate`) and the `kerntrip://` scheme are
  unique on purpose, so KernTrip can coexist with Coupler/Tripler in Glyphs.

## Versioning

The version lives in `src/html/template.html` (search for `v0.`).
`node build.js X.Y.Z` updates it and builds.
