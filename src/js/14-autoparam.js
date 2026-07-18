// ══════════════════════════════════════════════════════
// AUTOPARAM — parameter scan by triple equilibrium
// ══════════════════════════════════════════════════════
// Scans smooth, blur and mingap (zones fixed at 16; glow/glowblur, lazy
// and round stay untouched — glow is off by default, lazy/round are style
// choices). Each parameter is iterated in 5 even steps across its range;
// the candidate with the lowest max triple-equilibrium Δ wins (lite
// computation on the test-string glyphs, triples from the corpus pairs —
// same construction as 15-equilibrium); median Δ is logged alongside it
// for context but is not the selection criterion. Coarse-to-fine rounds:
// each round re-scans a range halved around the previous optimum, running
// the full _AP_ROUNDS_MAX rounds (or until all ranges converge) to find
// the true minimum max Δ — the 10 fu target is reported once reached but
// no longer stops the scan early. Runs automatically after every font
// load; afterwards the result is documented in Font Info → Notes (Glyphs
// mode) — timestamp, max- and median-equilibrium, palette parameters —
// and the optician window (setup assistant, 16-wizard) opens.
// Test text covers a broad mix of upper/lower, round/diagonal, straight shapes.
const _AP_TEXT = 'Arrowroot Barley Chervil Dumpling Endive Flaxseed Garbanzo Hijiki Ishtu Jicama Kale Lychee Marjoram Nectarine Oxtail Pizza Quinoa Roquefort Squash Tofu Uppuma Vanilla Wheat Xergis Yogurt Zweiback';

let _apRunning = false;
let _apNotePending = false;

// ── Field helpers ─────────────────────────────────────
function _apSaveFields() {
  return {
    zones:     document.getElementById('p-zones').value,
    smooth:    document.getElementById('p-smooth').value,
    blur:      document.getElementById('p-blur').value,
    mingap:    document.getElementById('p-mingap').value,
    glowblur:  document.getElementById('p-glowblur').value,
    round:     document.getElementById('p-round').value,
    bias:      document.getElementById('p-bias').value,
    lazy:      document.getElementById('p-lazy').value,
    pairlimit: document.getElementById('p-pairlimit').value,
    glow:      document.getElementById('p-glow').checked,
    baselc:    document.getElementById('p-baselc').value,
    baseuc:    document.getElementById('p-baseuc').value,
    tracking:  document.getElementById('p-tracking').value,
  };
}

function _apRestoreFields(saved) {
  document.getElementById('p-zones').value     = saved.zones;
  document.getElementById('p-smooth').value    = saved.smooth;
  document.getElementById('p-blur').value      = saved.blur;
  document.getElementById('p-mingap').value    = saved.mingap;
  document.getElementById('p-glowblur').value  = saved.glowblur;
  document.getElementById('p-round').value     = saved.round;
  document.getElementById('p-bias').value      = saved.bias;
  document.getElementById('p-lazy').value      = saved.lazy;
  document.getElementById('p-pairlimit').value = saved.pairlimit;
  document.getElementById('p-glow').checked    = saved.glow;
  document.getElementById('p-baselc').value    = saved.baselc;
  document.getElementById('p-baseuc').value    = saved.baseuc;
  document.getElementById('p-tracking').value  = saved.tracking;
}

function _apSetField(key, value) {
  const el = document.getElementById('p-' + key);
  if (!el) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value;
}

// ── Scan candidates: 5 even steps across [lo, hi] ─────────────────────────────
// _AP_RANGE holds the full scan domain per parameter (round 1); the input max
// would be a validation limit, not a plausible design range (mingap up to
// 100% of UPM, blur up to 50). Later rounds pass a narrowed [lo, hi].
const _AP_RANGE = { smooth: [0, 99], blur: [1, 16], mingap: [0, 8] };
const _AP_TARGET = 10;     // fu — informational threshold, reported but no longer stops the scan early
const _AP_ROUNDS_MAX = 6;  // hard cap on refinement rounds

function _apSteps(key, lo, hi) {
  const el = document.getElementById('p-' + key);
  const st = parseFloat(el.step || '1') || 1;
  const out = [];
  for (let i = 0; i < 5; i++) {
    const v = +(Math.round((lo + (hi - lo) * i / 4) / st) * st).toFixed(4);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

// ── Char map: char → {aw, charLabel} ─────────────────
// Built once per font; stays valid across all scan iterations.
function _apBuildCharMap() {
  const map = {};
  for (const ch of _AP_TEXT) {
    if (ch === ' ' || map[ch]) continue;
    if (IS_GLYPHS) {
      const cp = ch.codePointAt(0);
      const gname = unicodeToGlyphName[cp];
      const g = gname ? glyphsByName[gname] : null;
      if (g && g.commands && g.commands.length > 0) {
        map[ch] = { charLabel: ch, aw: g.advanceWidth || 0 };
      }
    } else {
      const g = fontObj ? fontObj.charToGlyph(ch) : null;
      if (g && g.name && g.name !== '.notdef') {
        map[ch] = { charLabel: ch, aw: g.advanceWidth || 0 };
      }
    }
  }
  return map;
}

// ── Triples from the corpus pairs, restricted to test-string chars ────────────
// Same construction as computeEquilibrium (15): top pairs → (A,B)+(B,C).
// Built once per run; also returns the unique pairs the triples need.
function _apBuildTriples(charMap) {
  const TOPP = 400, MAXT = 800;
  const byFirst = {}, top = [];
  for (const pair of KERNING_PAIRS) {
    if (top.length >= TOPP) break;
    const c = [...pair];
    if (c.length < 2) continue;
    if (!charMap[c[0]] || !charMap[c[1]]) continue;
    top.push(c);
    (byFirst[c[0]] = byFirst[c[0]] || []).push(c[1]);
  }
  const triples = [], pairSet = new Set(), seen = new Set();
  outer:
  for (const [a, b] of top) {
    const nexts = byFirst[b];
    if (!nexts) continue;
    for (const c of nexts) {
      const id = a + b + c;
      if (seen.has(id)) continue;
      seen.add(id);
      triples.push([a, b, c]);
      pairSet.add(a + '|' + b);
      pairSet.add(b + '|' + c);
      if (triples.length >= MAXT) break outer;
    }
  }
  return { triples, pairs: [...pairSet] };
}

// ── Lite equilibrium score for the current field values ───────────────────────
// Margins for the test-string chars, corrections via the shared pair core
// (03), then Δ = |gapL − gapR| over the triples. Returns {max, med, n} —
// max is the selection criterion (lower is better), med is reported for context.
async function _apEquiScore(charMap, tri) {
  await new Promise(r => setTimeout(r, 0)); // yield so log messages paint

  const p   = P();
  const upm = currentUPM;
  const yBot = yBotGlobal, yTop = yTopGlobal;

  // Margins for unique chars in test string + base glyphs
  const localGC = {};
  const needed  = new Set([...Object.keys(charMap), p.baselc, p.baseuc]);

  for (const ch of needed) {
    if (IS_GLYPHS) {
      const cp    = ch.codePointAt(0);
      const gname = unicodeToGlyphName[cp];
      const g     = gname ? glyphsByName[gname] : null;
      if (!g || !g.commands || g.commands.length === 0) continue;
      const margins = computeMarginsFromCommands(g.commands, g.advanceWidth, p, yBot, yTop);
      localGC[ch]   = { ...margins, charLabel: ch, glyphName: g.name, cls: classifyGlyph(g.unicode, g.name) };
    } else {
      const g = fontObj.charToGlyph(ch);
      if (!g || !g.path || g.path.commands.length === 0) continue;
      const unicode = g.unicodes?.[0] ?? null;
      const gk      = g.name ?? ch;
      const margins = computeGlyphMargins(g, upm, p, yBot, yTop);
      localGC[ch]   = { ...margins, charLabel: ch, glyphName: gk, cls: classifyGlyph(unicode, gk) };
    }
  }

  // shared pair core (03): same context as 05/06
  const ctx = buildPairCtx(p, localGC, upm, yBot, yTop, rhythmGridFromUI(p));

  const corrOf = {};
  for (const key of tri.pairs) {
    const [a, b] = key.split('|');
    const gA = localGC[a], gB = localGC[b];
    if (!gA || !gB) continue;
    // shared pair core (03): the whole formula in one place
    const r = pairCorrCore(gA, gB, p, ctx);
    if (r) corrOf[key] = r.corr;
  }

  const errs = [];
  for (const [a, b, c] of tri.triples) {
    const gA = localGC[a], gB = localGC[b], gC = localGC[c];
    if (!gA || !gB || !gC) continue;
    const mL = pairMean(gA.right, gB.left), mR = pairMean(gB.right, gC.left);
    if (!mL || !mR) continue;
    const gapL = mL.mean + (corrOf[a + '|' + b] || 0);
    const gapR = mR.mean + (corrOf[b + '|' + c] || 0);
    errs.push(Math.abs(gapL - gapR));
  }
  if (!errs.length) return { max: Infinity, med: Infinity, n: 0 };
  errs.sort((x, y) => x - y);
  return { max: errs[errs.length - 1], med: errs[Math.floor(errs.length / 2)], n: errs.length };
}

// ── Scan one parameter: 5 steps, keep the lowest max equilibrium Δ ────────────
async function _apScan(label, paramKey, candidates, base, optimal, charMap, tri, stepN, totalSteps) {
  const btn = document.getElementById('btn-autoparam');
  if (btn) btn.textContent = `⚙ ${label} (${stepN}/${totalSteps})`;
  log(`AutoParam ${stepN}/${totalSteps}: scanning ${label} [${candidates.join(', ')}]`, 'info');

  let bestIdx = 0, bestScore = Infinity, bestMed = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    _apRestoreFields(base);
    for (const [k, v] of Object.entries(optimal)) _apSetField(k, v);
    _apSetField(paramKey, candidates[i]);
    const stats = await _apEquiScore(charMap, tri);
    log(`  ${label}=${candidates[i]} → median Δ ${r1(stats.med)} fu, max Δ ${r1(stats.max)} fu`, 'info');
    if (stats.max < bestScore) { bestScore = stats.max; bestMed = stats.med; bestIdx = i; }
  }

  log(`AutoParam ${stepN}/${totalSteps}: ${label} → ${candidates[bestIdx]} (median Δ ${r1(bestMed)} fu, max Δ ${r1(bestScore)} fu)`, 'ok');
  return { best: candidates[bestIdx], score: bestScore, med: bestMed };
}

// ── Run documentation: Font Info → Notes block ────────────────────────────────
// Palette parameters in panel order, as menu values.
function _apPaletteLine() {
  const p = P();
  return `width ${p.width}, stemgap ${p.stemgap}, rhythm ${p.rhythm ? 'on' : 'off'}, ` +
         `lazy ${p.lazy}, bias ${p.bias}, mingap ${+(p.mingap * 100).toFixed(1)}, ` +
         `round ${p.round}, pairlimit ${p.pairlimit}`;
}

// Called from the end of 05/06 (like wizMaybeAutoOpen), two duties:
// 1. After the full analysis that AutoParam itself triggered: equiData holds
//    the real equilibrium — document timestamp, result and palette parameters
//    as an appended note block, then open the optician window (setup
//    assistant; respects its "open automatically" preference).
// 2. After the first analysis of a freshly loaded font: start AutoParam
//    automatically — the flow is load → AutoParam → optician window.
let _apSeenFont = '';
function apAfterAnalysis() {
  if (_apNotePending) {
    _apNotePending = false;
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const maxE = (typeof equiData !== 'undefined' && equiData.length) ? equiData[0].err : null;
    const medE = (typeof equiStats !== 'undefined' && equiStats) ? equiStats.med : null;
    const lines = [
      `[KernTrip AutoParam] ${stamp}`,
      `max-equilibrium ${maxE != null ? maxE : 'n/a'}`,
      `median-equilibrium ${medE != null ? medE : 'n/a'}`,
      _apPaletteLine(),
    ];
    for (const l of lines) log(l, 'ok');
    if (IS_GLYPHS) {
      window.location.href = 'kerntrip://note?' + encodeURIComponent(JSON.stringify({ lines }));
    }
    const wizAuto = typeof wizAutoEnabled === 'function' ? wizAutoEnabled() : true;
    if (wizAuto && typeof wizOpen === 'function') wizOpen();
    return;
  }
  // fresh font? (same key logic as the wizard: font+master, fontName fallback)
  const key = (typeof lastFontKey !== 'undefined' && lastFontKey) ? lastFontKey : fontName;
  if (!key || key === _apSeenFont) return;
  _apSeenFont = key;
  if (!glyphCache || !Object.keys(glyphCache).length) return;
  if (_apRunning) return;
  log('AutoParam: starting automatically after font load…', 'info');
  setTimeout(() => autoParam(), 0);
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function autoParam() {
  if (_apRunning) { log('AutoParam already running — please wait', 'info'); return; }
  if (isComputing){ log('AutoParam: waiting for current computation to finish', 'info'); return; }

  // Guard: need font data loaded in either mode
  if (IS_GLYPHS && Object.keys(glyphsByName).length === 0) {
    alert('No font loaded — click Load & Compute first.');
    return;
  }
  if (!IS_GLYPHS && !fontObj) {
    alert('No font loaded — drop a TTF/OTF first.');
    return;
  }

  _apRunning = true;
  document.body.classList.add('ap-running');
  const btn = document.getElementById('btn-autoparam');
  if (btn) { btn.disabled = true; btn.textContent = '⚙ Starting…'; }
  log('AutoParam: starting — building char map…', 'ok');

  try {
    const base    = _apSaveFields();
    const charMap = _apBuildCharMap();
    const mapped  = Object.keys(charMap).length;
    if (mapped === 0) { log('AutoParam: no test-string glyphs found in font', 'err'); return; }
    const tri = _apBuildTriples(charMap);
    if (!tri.triples.length) { log('AutoParam: no corpus triples possible with this font', 'err'); return; }
    log(`AutoParam: ${mapped} unique chars, ${tri.triples.length} triples (${tri.pairs.length} pairs) — criterion: lowest max equilibrium Δ`, 'info');

    // zones is fixed at 16, glow/glowblur stay off, lazy/round/bias are
    // style choices — only the measuring trio is scanned, coarse-to-fine:
    // round 1 covers the full _AP_RANGE, each later round halves the range
    // around the previous optimum. Always runs the full _AP_ROUNDS_MAX
    // rounds (converged ranges are skipped, never used to stop early) —
    // whether or not the target is reached after round 1 makes no
    // difference. The scan order rotates by one position each round, so
    // every parameter takes its turn going first: the parameter scanned
    // first in a round only sees the *other* two params at their prior
    // round's values, while later params in that round already see
    // this round's fresher neighbor — rotating spreads that first-mover
    // disadvantage evenly instead of always favoring the same parameter.
    const PARAMS  = [['Smooth', 'smooth'], ['Blur', 'blur'], ['MinGap', 'mingap']];
    const TOTAL   = PARAMS.length * _AP_ROUNDS_MAX;
    const optimal = { zones: 16 };
    const range   = {};
    for (const [, key] of PARAMS) range[key] = _AP_RANGE[key].slice();

    let stepN = 0, score = Infinity, med = Infinity;
    for (let round = 1; round <= _AP_ROUNDS_MAX; round++) {
      const offset = (round - 1) % PARAMS.length;
      const order  = [...PARAMS.slice(offset), ...PARAMS.slice(0, offset)];
      let scanned = 0;
      for (const [label, key] of order) {
        stepN++;
        const cands = _apSteps(key, range[key][0], range[key][1]);
        if (cands.length < 2) { log(`AutoParam ${stepN}/${TOTAL}: ${label} range converged (${cands[0]})`, 'info'); continue; }
        scanned++;
        const r = await _apScan(`${label} R${round}`, key, cands, base, optimal, charMap, tri, stepN, TOTAL);
        optimal[key] = r.best;
        score = r.score;
        med   = r.med;
        // refine: next round scans half the span, centered on the optimum
        const half = (range[key][1] - range[key][0]) / 4;
        const [blo, bhi] = _AP_RANGE[key];
        range[key] = [Math.max(blo, r.best - half), Math.min(bhi, r.best + half)];
      }
      if (!scanned) { log('AutoParam: all ranges converged — stopping', 'info'); break; }
    }
    log(`AutoParam: scan finished — median Δ ${r1(med)} fu, max Δ ${r1(score)} fu ` +
        (score < _AP_TARGET ? `(target ${_AP_TARGET} fu reached)` : `(target ${_AP_TARGET} fu not reached)`), 'ok');

    // Apply all optimal values, then trigger the full analysis to refresh the UI
    if (btn) btn.textContent = '⚙ Applying…';
    _apRestoreFields(base);
    for (const [k, v] of Object.entries(optimal)) _apSetField(k, v);
    log('AutoParam: optimal parameters applied — running full analysis…', 'ok');
    // apMaybeDocument (hook at the end of 05/06) writes the note block once
    // the full analysis — and with it the real equilibrium — is done.
    _apNotePending = true;
    // In Glyphs mode runAnalysis() navigates to Python and returns immediately;
    // the panel is restored in finally so the user sees params while Python responds.
    runAnalysis();
    log('AutoParam complete.', 'ok');
  } catch (e) {
    log('AutoParam error: ' + e.message, 'err');
    console.error(e);
  } finally {
    _apRunning = false;
    document.body.classList.remove('ap-running');
    if (btn) { btn.disabled = false; btn.textContent = '⚙ AutoParam'; }
  }
}

if (typeof module !== 'undefined') module.exports = { autoParam, apAfterAnalysis };
