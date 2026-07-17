// ══════════════════════════════════════════════════════
// GLYPHS MODE — DATA BRIDGE
// ══════════════════════════════════════════════════════

// ── Glyphs-mode progress helpers ─────────────────────────────────────────────

// Called by Python mid-serialization to show live progress in the WebView.
// pct: 0-100 for the progress bar; msg: short status string.
function setLoadProgress(pct, msg){
  setProgress(pct);
  setStatus(msg,'busy');
  const lb=document.getElementById('btn-glyphs-load');
  if(lb)lb.textContent=msg;
  log('[dbg] '+msg,'info');
}

// Lightweight debug logger — only active in Glyphs mode, visible in logbox.
function dbg(msg){
  if(!IS_GLYPHS)return;
  log('[dbg] '+msg,'info');
  console.log('[KernTrip dbg]',msg);
}

// ── Chunked glyph data accumulator (Glyphs mode) ─────────────────────────────
// Python sends: beginGlyphData(meta) → appendGlyphChunk(arr) × N → finalizeGlyphData()
// Each evaluateJavaScript call carries ~40 KB instead of the full 475 KB payload.
// The JS engine can evaluate and GC each chunk before the next arrives, preventing
// WebContent process memory accumulation that crashes Glyphs after repeated loads.
let _chunkMeta   = null;
let _chunkGlyphs = null;

function beginGlyphData(meta){
  _chunkMeta   = meta;
  _chunkGlyphs = [];
}

function appendGlyphChunk(arr){
  if(_chunkGlyphs) _chunkGlyphs.push(...arr);
}

function finalizeGlyphData(){
  if(!_chunkMeta || !_chunkGlyphs){ log('finalizeGlyphData: no pending data','err'); return; }
  const data = Object.assign({}, _chunkMeta, {glyphs: _chunkGlyphs});
  _chunkMeta   = null;
  _chunkGlyphs = null;  // release references so JS GC can collect
  receiveGlyphData(data);
}

function receiveGlyphData(data){
  dbg(`receiveGlyphData: ${data.glyphs.length} glyphs, UPM=${data.upm}, yBot=${data.yBot}, yTop=${data.yTop}`);
  currentUPM  = data.upm;
  yBotGlobal  = data.yBot;
  yTopGlobal  = data.yTop;
  xHeightGlobal = data.xHeight || 0;
  glyphsByName  = {};
  unicodeToGlyphName = {};
  for(const g of data.glyphs){
    glyphsByName[g.name] = g;
    if(g.unicode != null) unicodeToGlyphName[g.unicode] = g.name;
  }
  // space/nbspace: no outline, sent separately by Python (_send_glyph_data_inner)
  spaceGlyphInfo={sp:data.spaceGlyphs?.sp||null,nbsp:data.spaceGlyphs?.nbsp||null};
  const info = document.getElementById('header-font-info');
  if(info) info.innerHTML=`<strong>${esc(data.fontName)}</strong>&nbsp; Master:&nbsp;${esc(data.masterName)}&nbsp; UPM:${data.upm}`;
  const fname=document.getElementById('drop-fname');
  if(fname) fname.textContent=`${data.fontName}  ·  ${data.masterName}  ·  ${data.glyphs.length} glyphs`;
  log(`Data received: ${data.fontName} / ${data.masterName} — ${data.glyphs.length} glyphs`,'ok');
  setLoadProgress(38,'Data received — starting computation…');
  const _fk=data.fontName+'|'+data.masterName;
  const _newFont=_fk!==lastFontKey;
  lastFontKey=_fk;
  cadReset();
  if(_newFont) cadenceAutoFilled=false;
  cadEnsureInit();
  if(_newFont){
    const _gcv=document.getElementById('cad-cadence').value;
    const _gcn=cadToRound(parseFloat(_gcv));
    if(!isNaN(_gcn)&&_gcn>0){document.getElementById('p-round').value=_gcn;document.getElementById('light-cad-val').value=_gcn;cadenceAutoFilled=true;}
    // Auto-detect italic slant — on a STEM glyph (l/I/h), not on the "o":
    // humanist o axes would otherwise be read as an italic angle
    // (breaking the stem detection used by rhythm and stem gap).
    const _p0=P();
    let _slG=null,_slName='';
    for(const c of['l','I','h','H',_p0.baselc]){
      const n=unicodeToGlyphName[c.codePointAt(0)]||c;
      const g=glyphsByName[n];
      if(g&&g.commands&&g.commands.length){_slG=g;_slName=c;break;}
    }
    const _xh=xHeightGlobal||Math.round((data.yTop-data.yBot)*0.55);
    if(_slG&&_xh>0){
      const _detTan=detectSlantTan({commands:_slG.commands},_xh);
      const _deg=Math.round(Math.atan(_detTan)*1800/Math.PI)/10;
      document.getElementById('p-slant').value=_deg;
      log(`Slant detected: ${_deg}° (${_slName} at 1/4 and 3/4 of x-height)`,'info');
      dbg(`Slant: ${_deg}° tan=${Math.round(_detTan*1000)/1000}`);
    }
  }
  renderLightCadCanvas();
  runAnalysisFromGlyphsData(data);
}

// Compute margins from pre-built opentype.js-style path commands (Glyphs mode).
// commands = [{type:'M',x,y},{type:'L',x,y},{type:'C',x1,y1,x2,y2,x,y},{type:'Z'}]
// Y is already negated (Glyphs font-Y → screen-Y) so pathXZones works unchanged.
function computeMarginsFromCommands(commands, aw, p, yBot, yTop, slantTan){
  const zH=(yTop-yBot)/p.zones;
  const subs=p.zones*p.blur;
  const pathObj={commands};
  const sT=slantTan||0;
  // Geometric margins (outline only, no glow) — authoritative for min-gap checks
  const geomSubR=pathXZones(pathObj,subs,yBot,yTop,sT);
  const lGeom=[],rGeom=[];
  for(let z=0;z<p.zones;z++){
    const s0=z*p.blur;let sL=0,sR=0,cnt=0;
    for(let s=0;s<p.blur;s++){const sub=geomSubR[s0+s];if(!sub)continue;sL+=sub.xMin;sR+=aw-sub.xMax;cnt++;}
    if(cnt===0){lGeom.push(null);rGeom.push(null);}else{lGeom.push(r1(sL/cnt));rGeom.push(r1(sR/cnt));}
  }
  // fine profile for the 2D minimum distance — same as computeGlyphMargins
  const fineR=pathXZones(pathObj,KT_FINE_N,yBot,yTop,sT);
  const lFine=[],rFine=[];
  for(let i=0;i<KT_FINE_N;i++){
    const s=fineR[i];
    if(!s){lFine.push(null);rFine.push(null);}
    else{lFine.push(r1(s.xMin));rFine.push(r1(aw-s.xMax));}
  }
  // Kerning margins: glow-spread when glow is on, else reuse geometric
  let lR,rR;
  if(p.glow){
    const glowSubR=glowZones(commands,aw,p,yBot,yTop,true,null,sT);
    lR=[];rR=[];
    for(let z=0;z<p.zones;z++){
      const s0=z*p.blur;let sL=0,sR=0,cnt=0;
      for(let s=0;s<p.blur;s++){const sub=glowSubR[s0+s];if(!sub)continue;sL+=sub.xMin;sR+=aw-sub.xMax;cnt++;}
      if(cnt===0){lR.push(null);rR.push(null);}else{lR.push(r1(sL/cnt));rR.push(r1(sR/cnt));}
    }
  }else{lR=lGeom;rR=rGeom;}
  const leftSm=smoothMargins(lR,zH,p.smooth);
  const rightSm=smoothMargins(rR,zH,p.smooth);
  return{left:leftSm,right:rightSm,leftRaw:lR,rightRaw:rR,leftGeom:lGeom,rightGeom:rGeom,leftFine:lFine,rightFine:rFine,advanceWidth:aw};
}

// Build a Path2D from Glyphs-mode commands at a given canvas position + scale.
function commandsToPath2D(commands,xOff,yOff,scale){
  let d='';
  for(const cmd of commands){
    if(cmd.type==='M') d+=`M${xOff+cmd.x*scale},${yOff+cmd.y*scale}`;
    else if(cmd.type==='L') d+=`L${xOff+cmd.x*scale},${yOff+cmd.y*scale}`;
    else if(cmd.type==='C') d+=`C${xOff+cmd.x1*scale},${yOff+cmd.y1*scale},${xOff+cmd.x2*scale},${yOff+cmd.y2*scale},${xOff+cmd.x*scale},${yOff+cmd.y*scale}`;
    else if(cmd.type==='Z') d+='Z';
  }
  return d?new Path2D(d):null;
}

// Full analysis pipeline for Glyphs-mode data (mirrors runAnalysis() without fontObj).
async function runAnalysisFromGlyphsData(data){
  isComputing=true;
  const p=P();
  analysisWasGlow=p.glow;
  const btn=document.getElementById('btn-run');
  if(btn){btn.disabled=true;btn.innerHTML='<span class="spin"></span>Computing…';}
  setStatus('Computing…','busy');
  kerningData=[];glyphCache={};glowPreviewCache={};
  await new Promise(r=>setTimeout(r,10));
  dbg(`runAnalysisFromGlyphsData start: ${data.glyphs.length} glyphs`);
  try{
    const upm=data.upm,yBot=data.yBot,yTop=data.yTop;
    const slantTan=Math.tan((p.slant||0)*Math.PI/180);
    log(`Params: zones=${p.zones} smooth=${document.getElementById('p-smooth').value} blur=${p.blur} round=${p.round} mingap=${Math.round(p.mingap*100)}% bias=${p.bias} tracking=${p.tracking} baseLc=${p.baselc} baseUc=${p.baseuc} pairlimit=${p.pairlimit||'all'} slant=${p.slant||0}°`,'info');
    dbg(`yBot=${yBot} yTop=${yTop} upm=${upm} slantTan=${Math.round(slantTan*1000)/1000}`);

    // Step 1: margins — all glyphs (allowedChars filter only used for pair building)
    let done=0;
    const allGlyphs=data.glyphs;
    dbg(`Step 1: computing margins for ${allGlyphs.length} glyphs…`);
    setProgress(40);setStatus('Computing margins…','busy');
    for(const g of allGlyphs){
      done++;
      if(!g.commands||g.commands.length===0)continue;
      const cl=cLbl(g.unicode,g.name,g.name);
      const{left,right,leftRaw,rightRaw,leftGeom,rightGeom,leftFine,rightFine,advanceWidth}=computeMarginsFromCommands(g.commands,g.advanceWidth,p,yBot,yTop,slantTan);
      const cls=classifyGlyph(g.unicode,g.name);
      glyphCache[g.name]={left,right,leftRaw,rightRaw,leftGeom,rightGeom,leftFine,rightFine,charLabel:cl,unicode:g.unicode,glyphName:g.name,cls,advanceWidth};
      if(done%50===0){
        const pct=40+Math.round(done/allGlyphs.length*20);
        setProgress(pct);
        setStatus(`Margins ${done}/${allGlyphs.length}…`,'busy');
        await new Promise(r=>setTimeout(r,0));
      }
    }
    setProgress(62);
    const nCached=Object.keys(glyphCache).length;
    log(`Margins: ${nCached} glyphs`,'ok');
    dbg(`Step 1 done: ${nCached} glyphs in cache`);

    // Step 2+3 context through the shared pair core (buildPairCtx, 03)
    const rhythmGrid=rhythmGridFromUI(p);
    const ctx=buildPairCtx(p,glyphCache,upm,yBot,yTop,rhythmGrid);
    baseValueLC=ctx.baseLC;baseValueUC=ctx.baseUC;
    log(`Base LC (${p.baselc}+${p.baselc}): ${r1(ctx.baseLC)} (width ${p.width}% + tracking ${p.tracking})   Base UC (${p.baseuc}+${p.baseuc}): ${r1(ctx.baseUC)}`,'info');
    if(ctx.proxLC!==null||ctx.proxUC!==null)log(`Proximity target (closest point): LC ${ctx.proxLC===null?'—':r1(ctx.proxLC)} · UC ${ctx.proxUC===null?'—':r1(ctx.proxUC)}`,'info');
    log(`Min gap floor: ${r1(ctx.minGapEff)} fu (width ${p.width}%${p.bias<0?` × bias ${p.bias}`:''}) · 2D distance field ${KT_FINE_N} rows`);
    if(rhythmGrid>1)log(`Rhythm grid: ${rhythmGrid} fu (stem+stem pairs snap to the cadence module)`,'info');
    dbg(`Baselines: LC=${r1(ctx.baseLC)} UC=${r1(ctx.baseUC)}`);
    setProgress(65);setStatus('Building pair queue…','busy');

    const gks=Object.keys(glyphCache);
    const labelToKey={};
    for(const k of gks)labelToKey[glyphCache[k].charLabel]=k;

    const pairQueue=buildPairQueue(labelToKey,p.pairlimit);
    // SC and OSF expansion: UC+LC→UC+SC, LC+LC→SC+SC, all digit pairs
    {
      const scFor={};
      for(const k of Object.keys(glyphCache)){const gn=glyphCache[k].glyphName||k;if(!gn.endsWith('.sc'))continue;const base=gn.slice(0,-3);if(glyphCache[base])scFor[glyphCache[base].charLabel]=glyphCache[k].charLabel;}
      const ucToSc={};for(const k of Object.keys(glyphCache)){const gn=glyphCache[k].glyphName||k;if(!gn.endsWith('.sc'))continue;const base=gn.slice(0,-3);const ucKey=base[0].toUpperCase()+base.slice(1);if(glyphCache[ucKey])ucToSc[glyphCache[ucKey].charLabel]=glyphCache[k].charLabel;}
      const qSeen=new Set(pairQueue.map(({kA,kB})=>kA+'|'+kB));
      const addP=(kA,kB)=>{const id=kA+'|'+kB;if(!qSeen.has(id)&&glyphCache[kA]&&glyphCache[kB]){qSeen.add(id);pairQueue.push({kA,kB});}};
      for(const{kA,kB}of pairQueue.slice()){const a=glyphCache[kA],b=glyphCache[kB];if(!a||!b)continue;if(a.cls==='UC'&&b.cls==='LC'){const sl=scFor[b.charLabel];if(sl&&labelToKey[sl])addP(kA,labelToKey[sl]);}if(a.cls==='LC'&&b.cls==='LC'){const sa=scFor[a.charLabel],sb=scFor[b.charLabel];if(sa&&sb&&labelToKey[sa]&&labelToKey[sb])addP(labelToKey[sa],labelToKey[sb]);}if(a.cls==='UC'&&b.cls==='UC'){const sa=ucToSc[a.charLabel],sb=ucToSc[b.charLabel];if(sa&&sb&&labelToKey[sa]&&labelToKey[sb])addP(labelToKey[sa],labelToKey[sb]);}}
      const dN=['zero','one','two','three','four','five','six','seven','eight','nine'];
      const dK=dN.map(d=>labelToKey[d]).filter(Boolean);
      const oK=dN.map(d=>{for(const s of['oldstyle','.oldstyle','.onum','.osf']){const k=labelToKey[d+s];if(k)return k;}return null;}).filter(Boolean);
      for(const kA of dK)for(const kB of dK)addP(kA,kB);
      for(const kA of oK)for(const kB of oK)addP(kA,kB);
      if(scFor&&Object.keys(scFor).length)log(`SC pairs added (${Object.keys(scFor).length} SC glyphs found)`,'info');
      if(oK.length)log(`OSF digit pairs added (${oK.length} OSF glyphs found)`,'info');
    }

    const totalPairs=pairQueue.length;
    dbg(`Step 3: ${totalPairs} pairs queued`);
    log(`Pairs queued: ${totalPairs.toLocaleString()}`,'info');
    setProgress(68);setStatus(`Computing ${totalPairs.toLocaleString()} pairs…`,'busy');
    await new Promise(r=>setTimeout(r,0));
    for(let pi=0;pi<pairQueue.length;pi++){
      const {kA,kB}=pairQueue[pi];
      try{
        const gcA=glyphCache[kA],gcB=glyphCache[kB];
        if(!gcA||!gcB)continue;
        // shared pair core (03): the whole formula in one place
        const r=pairCorrCore(gcA,gcB,p,ctx);
        if(!r)continue;
        kerningData.push({left:gcA.charLabel,right:gcB.charLabel,correction:r.corr,mean:r1(r.calc.mean),base:r1(r.baseEff),beta:Math.round(r.beta*100)/100,tag:r.tag,capped:r.capped,rhythmic:r.rhythmic,thresholded:r.thresholded,zones:r.calc.zoneValues.map(v=>`z${v.z}:${v.sum}`).join(','),zonesArr:r.calc.zoneValues});
      }catch(pairErr){console.warn('pair error',kA,kB,pairErr);}
      if(pi%Math.max(1,Math.floor(pairQueue.length/20))===0){
        setProgress(68+Math.round(pi/pairQueue.length*30));
        setStatus(`Pairs ${pi.toLocaleString()} / ${pairQueue.length.toLocaleString()}…`,'busy');
        await new Promise(r=>setTimeout(r,0));
      }
    }

    // Space pairs: glyph+space and space+glyph, using base glyph margin
    addSpacePairs(gks,glyphCache,p,baseValueLC,baseValueUC);

    // triple equilibrium: quality metric after the pair computation
    computeEquilibrium();

    setProgress(100);
    const nz=kerningData.filter(d=>d.correction!==0).length;
    dbg(`Step 3 done: ${kerningData.length} pairs, ${nz} non-zero`);
    log(`Pairs: ${kerningData.length.toLocaleString()}  non-zero: ${nz.toLocaleString()}`,'ok');
    filteredData=kerningData.slice();
    sortAndRender();
    buildKernMap();
    renderPreview();
    setStatus(`${gks.length} gl · ${kerningData.length.toLocaleString()} pairs · ${nz.toLocaleString()} kern`,'active');
  }catch(err){
    dbg('ERROR: '+err.message);
    log('Error: '+err.message,'err');
    setStatus('Error — see log','error');
    console.error(err);
  }
  if(btn){btn.disabled=false;btn.innerHTML='▶ Recompute';}
  const loadBtn=document.getElementById('btn-glyphs-load');
  if(loadBtn){loadBtn.disabled=false;loadBtn.textContent='▶  Load & Compute';}
  dbg('runAnalysisFromGlyphsData complete');
  cadReset();
  if(currentTab==='cadence'){cadEnsureInit();renderCadence();}
  if(currentTab==='equi')renderEquilibrium();
  updateLightModeButton();
  updateCadenceField();
  afterCompute();
  if(typeof wizMaybeAutoOpen==='function')wizMaybeAutoOpen();
  if(typeof apAfterAnalysis==='function')apAfterAnalysis();
}

if(typeof module!=='undefined')module.exports={setLoadProgress,dbg,beginGlyphData,appendGlyphChunk,finalizeGlyphData,receiveGlyphData,computeMarginsFromCommands,commandsToPath2D,runAnalysisFromGlyphsData};
