// Non-zero pairs to output, capped to pairlimit (0 = all), in fuchs order.
function outputPairs(){
  const p=P();
  const nz=kerningData.filter(d=>d.correction!==0);
  return p.pairlimit>0?nz.slice(0,p.pairlimit):nz;
}

// Human-readable parameter summary — CSV/copy header and Glyphs run documentation.
// Lists every menu parameter; smooth is reported as the menu value (P() stores it inverted).
function paramSummary(p){
  const smoothMenu=p.smooth===0?0:Math.round((1-p.smooth)*100);
  return `zones=${p.zones} smooth=${smoothMenu}% blur=${p.blur} round=${p.round} mingap=${Math.round(p.mingap*100)}% bias=${p.bias} lazy=${p.lazy} width=${p.width}% stemgap=${p.stemgap}% inset=${p.inset} rhythm=${p.rhythm?'on':'off'} tracking=${p.tracking} glow=${p.glow?'on':'off'} glowblur=${p.glowblur} slant=${p.slant} pairlimit=${p.pairlimit} base=${p.baselc}/${p.baseuc}`;
}

// Send non-zero pairs to Python for application to the font.
function applyToGlyphs(){
  if(isComputing){pendingAction=()=>applyToGlyphs();log('⏳ Apply queued — waiting for computation to finish','info');return;}
  if(!kerningData.length){alert('No kerning data — run Compute first.');return;}
  const out=outputPairs();
  if(!out.length){alert('All corrections are zero — nothing to apply.');return;}
  const pairs=out.map(d=>({left:d.left,right:d.right,correction:d.correction}));
  // Params ride along so Python can document the run in Font Info (master
  // custom parameter + appended note). plugin.py also accepts a bare array.
  const payload={pairs,params:paramSummary(P())};
  window.location.href='kerntrip://applykerning?'+encodeURIComponent(JSON.stringify(payload));
}

// Called by Python after applying kerning.
function showApplyResult(result){
  log(result.msg, result.ok>0?'ok':'err');
  setStatus(result.msg, result.ok>0?'active':'error');
}

// ── GROUP KERNING ─────────────────────────────────────
// Compresses individual pairs into kerning classes: a glyph's real ink
// sidebearing (geomSB — the same "true geometric minimum" reading
// 09-spacing.js centers glyphs on) decides its class on that side, once,
// independent of any single pair — so a glyph never needs two different
// classes at the same time and grouping can never silently misassign a
// pair. Left glyphs sharing an identical right-side sidebearing become one
// right-class; right glyphs sharing an identical left-side sidebearing
// become one left-class. Wherever a class-pair's members overwhelmingly
// agree on one correction value, that value becomes a single class-class
// kerning entry; any pair that disagrees with its class stays (or falls
// back to) an individual exception pair, exactly like a normal Apply.
function buildGroupKerning(){
  const out=outputPairs();

  // 1. RSB of every left glyph, LSB of every right glyph (integer font
  // units — matches the granularity sidebearings are actually designed at,
  // and absorbs curve-flattening noise in the geometric measurement).
  const rsbOf={}, lsbOf={};
  for(const d of out){
    if(!(d.left in rsbOf)){
      const gc=glyphCache[d.left];
      rsbOf[d.left]=gc?Math.round(geomSB(gc.rightFine??gc.rightGeom)):null;
    }
    if(!(d.right in lsbOf)){
      const gc=glyphCache[d.right];
      lsbOf[d.right]=gc?Math.round(geomSB(gc.leftFine??gc.leftGeom)):null;
    }
  }
  const rsbClasses={}, lsbClasses={}; // sidebearing value -> [glyphNames]
  for(const g in rsbOf){const v=rsbOf[g];if(v==null)continue;(rsbClasses[v]=rsbClasses[v]||[]).push(g);}
  for(const g in lsbOf){const v=lsbOf[g];if(v==null)continue;(lsbClasses[v]=lsbClasses[v]||[]).push(g);}

  // 2. Only classes with >=2 members are worth grouping — collect the
  // actual pairs that fall inside a (right-class, left-class) combo.
  const comboPairs={}; // "rsb|lsb" -> [pair,…]
  for(const d of out){
    const rv=rsbOf[d.left], lv=lsbOf[d.right];
    if(rv==null||lv==null)continue;
    if((rsbClasses[rv]||[]).length<2||(lsbClasses[lv]||[]).length<2)continue;
    const key=rv+'|'+lv;
    (comboPairs[key]=comboPairs[key]||[]).push(d);
  }

  // 3. Per combo: the majority correction value becomes the class-class
  // entry; a combo needs >=2 pairs sharing that value to be worth it at
  // all (otherwise it's a wash — leave every pair in it individual).
  const usedRsb=new Set(), usedLsb=new Set();
  const classPairs=[]; // {rv,lv,value}
  const groupedKeys=new Set(); // 'left|right' already covered by a class entry
  for(const key in comboPairs){
    const pairsHere=comboPairs[key];
    const counts=new Map();
    for(const d of pairsHere)counts.set(d.correction,(counts.get(d.correction)||0)+1);
    let bestVal=null,bestN=0;
    for(const [v,n] of counts)if(n>bestN){bestN=n;bestVal=v;}
    if(bestN<2)continue;
    const [rv,lv]=key.split('|');
    classPairs.push({rv,lv,value:bestVal});
    usedRsb.add(rv);usedLsb.add(lv);
    for(const d of pairsHere)if(d.correction===bestVal)groupedKeys.add(d.left+'|'+d.right);
  }
  const individual=out.filter(d=>!groupedKeys.has(d.left+'|'+d.right))
    .map(d=>({left:d.left,right:d.right,correction:d.correction}));

  // 4. Classes get a local id here only — kerning groups are shared across
  // every master in the font, and other masters may already rely on
  // existing group names, so the actual "G000N" names are assigned by
  // Python (_apply_group_kerning), which can see the whole font and picks
  // up counting after the highest number already in use instead of
  // reusing (or deleting) anything.
  const groups=[];
  for(const rv of usedRsb)groups.push({side:'right',localId:'R'+rv,glyphs:rsbClasses[rv]});
  for(const lv of usedLsb)groups.push({side:'left',localId:'L'+lv,glyphs:lsbClasses[lv]});
  const classEntries=classPairs.map(cp=>({rightLocalId:'R'+cp.rv,leftLocalId:'L'+cp.lv,value:cp.value}));

  return {groups,classEntries,pairs:individual};
}

// Send the compressed group-kerning result to Python for application to the font.
function applyGroupKerningToGlyphs(){
  if(isComputing){pendingAction=()=>applyGroupKerningToGlyphs();log('⏳ With Kerning Groups queued — waiting for computation to finish','info');return;}
  if(!kerningData.length){alert('No kerning data — run Compute first.');return;}
  if(!outputPairs().length){alert('All corrections are zero — nothing to apply.');return;}
  const {groups,classEntries,pairs}=buildGroupKerning();
  const payload={groups,classEntries,pairs,params:paramSummary(P())};
  window.location.href='kerntrip://applygroupkerning?'+encodeURIComponent(JSON.stringify(payload));
}

function applySpacingToGlyphs(){
  if(!IS_GLYPHS){return;}
  if(!Object.keys(glyphCache).length){alert('No spacing data — run Compute first.');return;}
  // Shared spacing rows (09): base glyph centered, offset inherited,
  // negative sidebearings clamped to 0. dwidth is applied width-first in
  // Python (RSB shifts by dwidth, then LSB by dlsb keeping RSB).
  const rows=computeSpacingRows();
  const items=rows.map(r=>({name:r.gc.glyphName,dlsb:r.dL,dwidth:r.newAW-r.oldAW-r.dL}));
  if(!items.length){alert('No adjustments to apply.');return;}
  // unit rides along so Python sets the master's unitizerUnit custom
  // parameter to the module value. plugin.py also accepts a bare array.
  const payload={items,unit:P().round};
  window.location.href='kerntrip://applyspacing?'+encodeURIComponent(JSON.stringify(payload));
}

function showSpacingApplyResult(result){
  log(result.msg, result.ok>0?'ok':'err');
  setStatus(result.msg, result.ok>0?'active':'error');
}

// ── EXPORT ────────────────────────────────────────────
function exportCSV(){
  if(isComputing){pendingAction=()=>exportCSV();log('⏳ Export queued — waiting for computation to finish','info');return;}
  if(IS_GLYPHS){applyToGlyphs();return;}
  if(!kerningData.length){alert('No data to export.');return;}
  const p=P();
  const out=outputPairs();
  const lines=[
    `# KernTrip — Font Kerning | ${fontName} | ${paramSummary(p)}`,
    `# Format: Left;Right;Correction (Class zones)`,
    ...out.map(d=>`${d.left};${d.right};${d.correction} (${d.tag} ${d.zones})${d.capped?' [cap]':''}${d.rhythmic?' [rhythm]':''}`)
  ];
  const blob=new Blob([lines.join('\n')],{type:'text/plain'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=fontName.replace(/\.[^.]+$/,'')+'.csv';a.click();
}
function copyKerningToClipboard(){
  if(isComputing){pendingAction=()=>copyKerningToClipboard();log('⏳ Copy queued — waiting for computation to finish','info');return;}
  if(!kerningData.length){return;}
  const p=P();
  const out=outputPairs();
  const lines=[
    `# KernTrip — Font Kerning | ${fontName} | ${paramSummary(p)}`,
    `# Format: Left;Right;Correction (Class zones)`,
    ...out.map(d=>`${d.left};${d.right};${d.correction} (${d.tag} ${d.zones})${d.capped?' [cap]':''}${d.rhythmic?' [rhythm]':''}`)
  ];
  navigator.clipboard.writeText(lines.join('\n')).then(()=>{
    const b=document.getElementById('btn-light-clip');
    if(b){const orig=b.textContent;b.textContent='✓ Copied!';setTimeout(()=>{b.textContent=orig;},1400);}
    log(`Copied ${out.length.toLocaleString()} kerning pairs to clipboard`,'ok');
  }).catch(()=>log('Clipboard write failed','err'));
}

if(typeof module!=='undefined')module.exports={outputPairs,paramSummary,applyToGlyphs,showApplyResult,applySpacingToGlyphs,showSpacingApplyResult,exportCSV,copyKerningToClipboard,buildGroupKerning,applyGroupKerningToGlyphs};
