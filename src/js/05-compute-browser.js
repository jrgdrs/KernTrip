// ── STEM CADENCE (browser-mode scan) ──────────────────
function measureStemCadence(){
  if(!fontObj)return;
  const upm=fontObj.unitsPerEm;
  // x-height from OS/2; fall back to bounding-box top of glyph 'x'
  let xh=fontObj.tables?.os2?.sxHeight||0;
  if(!xh){
    const xg=fontObj.charToGlyph('x');
    if(xg&&xg.path&&xg.path.commands.length>0){const bb=xg.getBoundingBox();xh=Math.round(bb.y2);}
  }
  if(!xh){log('n cadence: no x-height available — skipped','info');return;}
  const nGlyph=fontObj.charToGlyph('n');
  if(!nGlyph||!nGlyph.path||nGlyph.path.commands.length===0){
    log('n cadence: glyph "n" not found','info');return;
  }
  try{
    // Derive vertical bounds directly from font (runAnalysis not yet called)
    let yTop=upm*0.8,yBot=-(upm*0.2);
    if(fontObj.tables?.os2){const o=fontObj.tables.os2;if(o.sTypoAscender)yTop=o.sTypoAscender;if(o.sTypoDescender!==undefined)yBot=o.sTypoDescender;}
    else if(fontObj.tables?.hhea){if(fontObj.tables.hhea.ascender)yTop=fontObj.tables.hhea.ascender;if(fontObj.tables.hhea.descender!==undefined)yBot=fontObj.tables.hhea.descender;}
    const aw=nGlyph.advanceWidth||upm;
    const scanYfu=xh/2;
    const scale=4; // 4 px per font unit
    const fontSize=scale*upm;
    const topPad=4;
    const baseline=topPad+Math.ceil(yTop*scale);
    const W=Math.ceil(aw*scale);
    const H=baseline+Math.ceil(Math.abs(yBot)*scale)+4;
    const off=document.createElement('canvas');
    off.width=W;off.height=H;
    const ctx=off.getContext('2d');
    ctx.fillStyle='#000';
    ctx.fill(new Path2D(nGlyph.getPath(0,baseline,fontSize).toPathData(2)));
    const scanRow=Math.round(baseline-scanYfu*scale);
    if(scanRow<0||scanRow>=H){log(`n cadence: scan row ${scanRow} out of bounds (H=${H})`,'info');return;}
    const px=ctx.getImageData(0,scanRow,W,1).data;
    const runs=[];let inRun=false,rs=0;
    for(let x=0;x<W;x++){
      const ink=px[x*4+3]>127;
      if(ink&&!inRun){inRun=true;rs=x;}
      else if(!ink&&inRun){inRun=false;runs.push([rs,x-1]);}
    }
    if(inRun)runs.push([rs,W-1]);
    if(runs.length<2){log(`n cadence: ${runs.length} ink run(s) at y=${Math.round(scanYfu)} fu — stems not distinct`,'info');return;}
    const stemW=(runs[0][1]-runs[0][0]+1)/scale;
    const interval=(runs[1][0]-runs[0][0])/scale;
    const n=Math.max(1,Math.round(interval*4/stemW));
    const cadence=interval/n;
    log(`n cadence: y=${Math.round(scanYfu)} fu (½·x-height ${xh}) · stem ${Math.round(stemW)} fu · L→R ${Math.round(interval)} fu ÷ ${n} → cadence ${Math.round(cadence)} fu`,'info');
  }catch(e){log('n cadence error: '+e.message,'err');}
}

// ── FONT LOAD ─────────────────────────────────────────
const dz=document.getElementById('drop-zone');
dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('over');});
dz.addEventListener('dragleave',()=>dz.classList.remove('over'));
dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('over');const f=e.dataTransfer.files[0];if(f)loadFont(f);});
document.getElementById('fi').addEventListener('change',e=>{if(e.target.files[0])loadFont(e.target.files[0]);});

function loadFont(file){
  const reader=new FileReader();
  reader.onload=async ev=>{
    try{
      fontBuffer=ev.target.result;
      // store as data URL for testpage embedding
      const b64=btoa(String.fromCharCode(...new Uint8Array(fontBuffer)));
      const ext=file.name.split('.').pop().toLowerCase();
      fontDataUrl=`data:font/${ext};base64,${b64}`;
      fontObj=opentype.parse(fontBuffer);
      fontName=file.name;
      currentUPM=fontObj.unitsPerEm;
      dz.classList.add('loaded');
      document.getElementById('drop-fname').textContent=file.name;
      const fn=fontObj.names.fullName?.en||file.name;
      document.getElementById('header-font-info').innerHTML=`<strong>${fn}</strong>&nbsp; UPM:${currentUPM}`;
      document.getElementById('btn-run').disabled=false;
      setStatus('Loaded','active');
      log(`Loaded: ${fn} — ${Object.keys(fontObj.glyphs.glyphs).length} glyphs`,'ok');
      measureStemCadence();
      cadReset();
      cadenceAutoFilled=false;
      slantAutoFilled=false;
      cadEnsureInit();
      const _lcv=document.getElementById('cad-cadence').value;
      const _lcn=cadToRound(parseFloat(_lcv));
      if(!isNaN(_lcn)&&_lcn>0){document.getElementById('p-round').value=_lcn;document.getElementById('light-cad-val').value=_lcn;cadenceAutoFilled=true;}
      renderLightCadCanvas();
      runAnalysis();
    }catch(err){setStatus('Load error','error');log('Error: '+err.message,'err');}
  };
  reader.readAsArrayBuffer(file);
}

// ══════════════════════════════════════════════════════
// MAIN ANALYSIS (browser mode)
// ══════════════════════════════════════════════════════
function initLoadAndCompute(){lastFontKey='';runAnalysis();}
async function runAnalysis(){
  log('▶ runAnalysis called (IS_GLYPHS='+IS_GLYPHS+')','info');
  // ── Glyphs mode: request glyph data from Python ──────────────────────────
  if(IS_GLYPHS){
    if(isComputing){pendingAction=()=>runAnalysis();log('⏳ Compute queued — waiting for current run to finish','info');return;}
    isComputing=true;
    const btn=document.getElementById('btn-run');
    const loadBtn=document.getElementById('btn-glyphs-load');
    if(btn){btn.disabled=true;btn.innerHTML='<span class="spin"></span>Requesting…';}
    if(loadBtn){loadBtn.disabled=true;loadBtn.textContent='Requesting…';}
    setStatus('Requesting data…','busy');
    dbg('Navigating kerntrip://requestdata → Python…');
    window.location.href = 'kerntrip://requestdata';
    return;  // Python intercepts nav, cancels it, calls receiveGlyphData() when ready
  }
  // ── Browser mode ─────────────────────────────────────────────────────────
  if(!fontObj){setStatus('No font','error');return;}
  if(isComputing){pendingAction=()=>runAnalysis();log('⏳ Compute queued — waiting for current run to finish','info');return;}
  isComputing=true;
  const p=P();
  analysisWasGlow=p.glow;
  const btn=document.getElementById('btn-run');
  btn.disabled=true;btn.innerHTML='<span class="spin"></span>Computing…';
  setStatus('Computing…','busy');setProgress(0);
  kerningData=[];glyphCache=[];
  await new Promise(r=>setTimeout(r,10));

  try{
    const upm=fontObj.unitsPerEm; currentUPM=upm;
    let yBot=-(upm*.2),yTop=upm*.8;
    if(fontObj.tables?.os2){const o=fontObj.tables.os2;if(o.sTypoDescender!==undefined)yBot=o.sTypoDescender;if(o.sTypoAscender!==undefined)yTop=o.sTypoAscender;}
    else if(fontObj.tables?.hhea){if(fontObj.tables.hhea.descender!==undefined)yBot=fontObj.tables.hhea.descender;if(fontObj.tables.hhea.ascender!==undefined)yTop=fontObj.tables.hhea.ascender;}
    yBotGlobal=yBot; yTopGlobal=yTop;

    // Auto-detect slant on new font load — on a STEM glyph (l/I/h), not on
    // the "o": humanist designs have a tilted o axis that would otherwise be
    // read as an italic angle and would break the stem detection used by
    // rhythm and stem gap.
    let slantTan=Math.tan((p.slant||0)*Math.PI/180);
    if(!slantAutoFilled){
      let _slG=null,_slName='';
      for(const c of['l','I','h','H',p.baselc]){const g=fontObj.charToGlyph(c);if(g&&g.path&&g.path.commands.length){_slG=g;_slName=c;break;}}
      const _xh=fontObj.tables.os2?.sxHeight||Math.round(yTop*0.72);
      if(_slG&&_xh>0){
        const _detTan=detectSlantTan(_slG.getPath(0,0,upm),_xh);
        const _deg=Math.round(Math.atan(_detTan)*1800/Math.PI)/10;
        document.getElementById('p-slant').value=_deg;
        slantTan=_detTan;
        log(`Slant detected: ${_deg}° (${_slName} at 1/4 and 3/4 of x-height)`,'info');
      }
      slantAutoFilled=true;
    }
    log(`Params: zones=${p.zones} smooth=${document.getElementById('p-smooth').value} blur=${p.blur} round=${p.round} mingap=${Math.round(p.mingap*100)}% bias=${p.bias} tracking=${p.tracking} baseLc=${p.baselc} baseUc=${p.baseuc} pairlimit=${p.pairlimit||'all'} slant=${document.getElementById('p-slant').value||0}°`,'info');

    // space/nbspace: no outline, so the margin loop below skips them —
    // resolve name + current advance width directly for Spacing Corrections
    spaceGlyphInfo={sp:null,nbsp:null};
    for(const[key,ch]of[['sp',' '],['nbsp','\u00A0']]){
      const g=fontObj.charToGlyph(ch);
      if(g&&g.name&&g.name!=='.notdef')spaceGlyphInfo[key]={name:g.name,advanceWidth:g.advanceWidth||0};
    }

    // Step 1: margins — all glyphs in font (allowedChars filter only used for pair building)
    const allKeys=Object.keys(fontObj.glyphs.glyphs);
    let done=0;
    glyphCache={};glowPreviewCache={};
    for(const key of allKeys){
      const g=fontObj.glyphs.glyphs[key];
      done++;
      if(!g.path||g.path.commands.length===0)continue;
      const gk=g.name??`glyph_${key}`;
      const unicode=g.unicodes?.[0]??null;
      const cl=cLbl(unicode,g.name,gk);
      const{left,right,leftRaw,rightRaw,leftGeom,rightGeom,leftFine,rightFine,advanceWidth}=computeGlyphMargins(g,upm,p,yBot,yTop,slantTan);
      const cls=classifyGlyph(unicode,gk);
      glyphCache[gk]={left,right,leftRaw,rightRaw,leftGeom,rightGeom,leftFine,rightFine,charLabel:cl,unicode,glyphName:gk,cls,advanceWidth};
      if(done%50===0){setProgress(done/allKeys.length*40);await new Promise(r=>setTimeout(r,0));}
    }
    setProgress(40);
    log(`Margins: ${Object.keys(glyphCache).length} glyphs`,'ok');

    // Step 2+3 context: base gaps, proximity targets, min gap, rhythm grid —
    // all through the shared pair core (buildPairCtx/pairCorrCore, 03).
    const rhythmGrid=rhythmGridFromUI(p);
    const ctx=buildPairCtx(p,glyphCache,upm,yBot,yTop,rhythmGrid);
    baseValueLC=ctx.baseLC;baseValueUC=ctx.baseUC;
    log(`Base LC (${p.baselc}+${p.baselc}): ${r1(ctx.baseLC)} (width ${p.width}% + tracking ${p.tracking})   Base UC (${p.baseuc}+${p.baseuc}): ${r1(ctx.baseUC)}`,'info');
    if(ctx.proxLC!==null||ctx.proxUC!==null)log(`Proximity target (closest point): LC ${ctx.proxLC===null?'—':r1(ctx.proxLC)} · UC ${ctx.proxUC===null?'—':r1(ctx.proxUC)}`,'info');
    log(`Min gap floor: ${r1(ctx.minGapEff)} fu (${Math.round(p.mingap*100)}% × UPM ${upm} × width ${p.width}%${p.bias<0?` × bias ${p.bias}`:''}) · 2D distance field ${KT_FINE_N} rows`);
    if(rhythmGrid>1)log(`Rhythm grid: ${rhythmGrid} fu (stem+stem pairs snap to the cadence module)`,'info');
    setProgress(45);

    const gks=Object.keys(glyphCache);
    const gc=gks.length;

    // Build pair queue from KERNING_PAIRS in frequency order (pairlimit=0 means all)
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
    log(`Pair queue: ${pairQueue.length.toLocaleString()} pairs${p.pairlimit>0?' (limit '+p.pairlimit+')':''}`,"info");

    const totalPairs=pairQueue.length;
    done=0;
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
      if(pi%Math.max(1,Math.floor(pairQueue.length/20))===0){setProgress(45+pi/pairQueue.length*50);await new Promise(r=>setTimeout(r,0));}
    }

    // Space pairs: glyph+space and space+glyph, using base glyph margin
    addSpacePairs(gks,glyphCache,p,baseValueLC,baseValueUC);

    // triple equilibrium: quality metric after the pair computation
    computeEquilibrium();

    setProgress(100);
    const nz=kerningData.filter(d=>d.correction!==0).length;
    log(`Pairs: ${kerningData.length.toLocaleString()}  non-zero: ${nz.toLocaleString()}`,'ok');

    filteredData=kerningData.slice();
    sortAndRender();
    buildKernMap();
    applyTextMode();
    renderPreview();
    if(currentTab==='spacing')renderSpacingTable();
    if(currentTab==='cadence'){cadEnsureInit();renderCadence();}
    if(currentTab==='equi')renderEquilibrium();
    const nzCount=kerningData.filter(d=>d.correction!==0).length;
    setStatus(`${gc} gl · ${kerningData.length.toLocaleString()} pairs · ${nzCount.toLocaleString()} kern`,'active');
    updateLightModeButton();
  }catch(err){
    log('Error: '+err.message,'err');
    setStatus('Error','error');
    console.error(err);
  }
  btn.disabled=false;btn.innerHTML='▶ Recompute';
  updateCadenceField();
  afterCompute();
  if(typeof wizMaybeAutoOpen==='function')wizMaybeAutoOpen();
  if(typeof apAfterAnalysis==='function')apAfterAnalysis();
}

if(typeof module!=='undefined')module.exports={measureStemCadence,loadFont,initLoadAndCompute,runAnalysis};
