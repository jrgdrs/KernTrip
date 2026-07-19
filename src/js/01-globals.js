// ══════════════════════════════════════════════════════
// STATE & GLOBALS
// ══════════════════════════════════════════════════════
// ── Runtime detection ─────────────────────────────────────────────────────────
// IS_GLYPHS is true when running inside Glyphs.app via WKWebView.
// In that case the drop zone is replaced by a "Connected" indicator,
// and the "Export CSV" button becomes "Apply Kerning to Glyphs".
// Injected by WKUserScript before page scripts run (see plugin.py _build_ui).
const IS_GLYPHS = !!(window.__IS_GLYPHS);

let fontObj=null,fontBuffer=null,fontName='',fontDataUrl='';
let glyphCache={},kerningData=[],filteredData=[];
let slantAutoFilled=false;
let sortCol='correction',sortAsc=false;
let showKerning=true,showMetrics=false,showBaseline=false,showXheight=false;
let showSmallCaps=false,showOSF=false,showGlow=false;
let glowPreviewCache={}; // 'glyphKey|blur' → HTMLCanvasElement
let analysisWasGlow=false; // true when last completed analysis used Glow mode
let lightMode=false; // full panel by default everywhere (browser + Glyphs); toggle via logo double-click
if(!lightMode)document.body.classList.remove('light-mode');
let isComputing=false; // true while runAnalysis / runAnalysisFromGlyphsData is active
let pendingAction=null; // queued action to run after current computation finishes
let cadenceAutoFilled=false; // true after first auto-fill of p-round from cadence scan
let lastFontKey=''; // tracks font+master to detect real font changes vs recompute
let useRegex=false;
let selectedPairIdx=-1;  // index into filteredData for pair-click preview
let pairPreviewMode=false;  // true when showing a clicked pair in preview
let selectedEquiIdx=-1;  // index into the rendered equilibrium rows for arrow-key nav
let baseValueLC=0,baseValueUC=0;
let currentUPM=1000,yBotGlobal=0,yTopGlobal=0,xHeightGlobal=0;
// space/nbspace have no outline (skipped from glyphCache) — their glyph
// name + current advance width are collected separately so Spacing
// Corrections can size them off "i" (09-spacing.js). {name,advanceWidth}|null
let spaceGlyphInfo={sp:null,nbsp:null};

// Glyphs mode state
let glyphsByName={};         // name → {commands, advanceWidth, unicode} (Glyphs mode)
let unicodeToGlyphName={};   // codepoint → glyph name (Glyphs mode)

// width (%): scales the base target gaps AND the min gap together — tightness
// with a constant overlap character. Tracking stays a purely additive offset.
// stemgap (%): target gap for stem pairs relative to the round reference
// (HH/nn vs. OO/oo, the classic HHOOHH experiment). Full effect on stem+stem,
// half on stem+round.
// rhythm: stem+stem gaps snap to the cadence grid (a real rhythm model
// instead of mere value rounding).
// bias (-100..+100): legible vs. readable — replaces the old threshold.
// Legible (-): contact model stronger, min gap up to +50%, small tightenings
// are dropped more freely. Readable (+): air model stronger, small loosenings
// are dropped more freely. Base drop tolerance: 0.3% of UPM.
const DEFAULTS={zones:16,smooth:50,round:20,blur:1,mingap:1,bias:0,lazy:50,width:100,stemgap:100,inset:0,rhythm:true,baselc:'o',baseuc:'O',tracking:0,pairlimit:6400,glowblur:0,glow:false,slant:0};

function P(){
  const mg=parseFloat(document.getElementById('p-mingap').value);
  return{
    zones:     parseInt(document.getElementById('p-zones').value)     ||DEFAULTS.zones,
    smooth:    (()=>{const s=parseFloat(document.getElementById('p-smooth').value)||0; return s===0?0:(1-s/100);})(),
    round:     parseInt(document.getElementById('p-round').value)     ||DEFAULTS.round,
    blur:      parseInt(document.getElementById('p-blur').value)      ||DEFAULTS.blur,
    mingap:    (isNaN(mg)?DEFAULTS.mingap:mg)/100,
    bias:      Math.max(-100,Math.min(100,parseFloat(document.getElementById('p-bias')?.value)||0)),
    lazy:      Math.max(0,Math.min(99,parseFloat(document.getElementById('p-lazy').value)||0)),
    width:     (()=>{const w=parseFloat(document.getElementById('p-width')?.value);return isNaN(w)?DEFAULTS.width:Math.max(25,Math.min(300,w));})(),
    stemgap:   (()=>{const s=parseFloat(document.getElementById('p-stemgap')?.value);return isNaN(s)?DEFAULTS.stemgap:Math.max(25,Math.min(300,s));})(),
    inset:     Math.max(0,parseFloat(document.getElementById('p-inset')?.value)||0),
    rhythm:    document.getElementById('p-rhythm')?.checked??DEFAULTS.rhythm,
    baselc:    (document.getElementById('p-baselc').value||DEFAULTS.baselc).trim(),
    baseuc:    (document.getElementById('p-baseuc').value||DEFAULTS.baseuc).trim(),
    tracking:  parseFloat(document.getElementById('p-tracking').value)||0,
    pairlimit: parseInt(document.getElementById('p-pairlimit').value)||0,
    glow: document.getElementById('p-glow').checked,
    glowblur:  Math.max(0,parseFloat(document.getElementById('p-glowblur').value)||DEFAULTS.glowblur),
    slant:     parseFloat(document.getElementById('p-slant').value)||0,
  };
}
function resetParams(){
  ['zones','smooth','round','blur','mingap','bias','lazy','width','stemgap','inset','tracking','pairlimit','glowblur','slant'].forEach(k=>{
    document.getElementById('p-'+k).value=DEFAULTS[k];
  });
  document.getElementById('p-baselc').value=DEFAULTS.baselc;
  document.getElementById('p-baseuc').value=DEFAULTS.baseuc;
  document.getElementById('p-glow').checked=DEFAULTS.glow;
  document.getElementById('p-rhythm').checked=DEFAULTS.rhythm;
}

// Parameter presets for common font styles
const PARAM_PRESETS={
  'default':        {zones:16,  smooth:50,   mingap:1,  blur:1, round:20,  lazy:50, pairlimit:6400 },
  // Serif weights
  'serif-reg':      {zones:81, smooth:14,  mingap:12, blur:3,  round:1},
  'serif-it':       {zones:81, smooth:14, mingap:4,  blur:3,  round:1},
  'serif-bold':     {zones:81, smooth:14,   mingap:4,  blur:3,  round:1},
  'serif-boldit':   {zones:81, smooth:14,  mingap:12, blur:3,  round:1},
  // Sans-serif weights
  'sans-light':     {zones:48,  smooth:66,   mingap:4,  blur:1,  round:20,  lazy: 60 },
  'sans-regular':   {zones:48,  smooth:50,   mingap:3,  blur:2,  round:20,  lazy: 55},
  'sans-bold':      {zones:48, smooth:33, mingap:2, blur:3, round:20,  lazy:50 },
  // Slab-serif weights
  'slab-light':     {zones:40, smooth:30,   mingap:7,  blur:5,  round:1},
  'slab-regular':   {zones:40, smooth:35,  mingap:10, blur:5,  round:1},
  'slab-bold':      {zones:40, smooth:40,   mingap:12, blur:4,  round:1},
};
function applyParamPreset(key){
  if(!key)return;
  const pr=PARAM_PRESETS[key];
  if(!pr)return;
  document.getElementById('p-zones').value    =pr.zones;
  document.getElementById('p-smooth').value   =pr.smooth;
  document.getElementById('p-mingap').value   =pr.mingap;
  document.getElementById('p-blur').value     =pr.blur;
  document.getElementById('p-round').value    =pr.round;
  if(pr.lazy!==undefined)document.getElementById('p-lazy').value=pr.lazy;
}

// ── EXTENDED PARAMS SECTION ───────────────────────────
function toggleExtended(){
  const box=document.getElementById('extended-params');
  if(!box)return;
  const open=box.style.display==='none';
  box.style.display=open?'':'none';
  const arrow=document.getElementById('ext-arrow');
  if(arrow)arrow.textContent=open?'▾':'▸';
}

// ── LOG / STATUS ──────────────────────────────────────
function log(msg,cls=''){
  const el=document.getElementById('logbox');
  const d=document.createElement('div');
  d.className='ll '+(cls?cls:'');
  d.textContent=msg;
  el.appendChild(d);
  el.scrollTop=el.scrollHeight;
}
function setStatus(msg,cls=''){const el=document.getElementById('global-status');el.textContent=msg;el.className=cls;}
function setProgress(p){document.getElementById('prog-fill').style.width=p+'%';}

// ── LOG RESIZE DRAG ────────────────────────────────────
{
  const handle=document.getElementById('log-resize');
  const logbox=document.getElementById('logbox');
  let startY,startH;
  handle.addEventListener('mousedown',e=>{
    startY=e.clientY;startH=logbox.offsetHeight;
    handle.classList.add('dragging');
    const onMove=mv=>{
      const newH=Math.max(24,Math.min(600,startH-(mv.clientY-startY)));
      logbox.style.height=newH+'px';
    };
    const onUp=()=>{handle.classList.remove('dragging');document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);};
    document.addEventListener('mousemove',onMove);
    document.addEventListener('mouseup',onUp);
    e.preventDefault();
  });
}

if(typeof module!=='undefined')module.exports={IS_GLYPHS,DEFAULTS,P,resetParams,PARAM_PRESETS,applyParamPreset,log,setStatus,setProgress};
