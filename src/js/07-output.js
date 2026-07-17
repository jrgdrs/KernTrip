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
  return `zones=${p.zones} smooth=${smoothMenu}% blur=${p.blur} round=${p.round} mingap=${Math.round(p.mingap*100)}% bias=${p.bias} lazy=${p.lazy} width=${p.width}% stemgap=${p.stemgap}% rhythm=${p.rhythm?'on':'off'} tracking=${p.tracking} glow=${p.glow?'on':'off'} glowblur=${p.glowblur} slant=${p.slant} pairlimit=${p.pairlimit} base=${p.baselc}/${p.baseuc}`;
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

if(typeof module!=='undefined')module.exports={outputPairs,paramSummary,applyToGlyphs,showApplyResult,applySpacingToGlyphs,showSpacingApplyResult,exportCSV,copyKerningToClipboard};
