# KernTrip

KernTrip computes optical spacing and kerning from glyph outlines.
No manual pair editing — all values come from the shapes themselves.

Two products, one code base:

- **Browser tool:** open `index.html`, drop a TTF/OTF font.
- **Glyphs 3 plugin:** `glyphs/KernTrip.glyphsPlugin` (installed by `make.sh`);
  Script menu -> *KernTrip*.

## Build

```bash
bash make.sh    # assembles src/ -> ui.html, index.html, KernTrip.zip,
                # and installs the plugin into Glyphs 3
```

## How it works, in short

- Glyph margins are measured in horizontal zones (plus a 64-row fine profile).
- Every pair is classified by its gap profile: convex pairs are set by their
  **closest point** (contact model), open pairs by their **mean gap**
  (air model); a blend factor *beta* mixes the two.
- Stem pairs snap to the **cadence grid** (rhythm) and get their own
  **stem gap** style control.
- A 2D distance field guards against collisions, a **bias** slider trades
  legibility against readability, and the **Equilibrium** tab scores how
  centered every glyph sits between its neighbors.
- The **Setup assistant** guides through the five design values on live type
  samples; the final step computes all corpus pairs.

Development notes for Claude Code live in `CLAUDE.md`.
