// ══════════════════════════════════════════════════════
// SETUP ASSISTANT (wizard) — guided parameter setup
// ══════════════════════════════════════════════════════
// "Global to local" as a UI: the MEASURED values (zones/smooth/blur/cadence/
// slant) are collected automatically; the DESIGN values (width, stem gap,
// inset, bias, lazy, min gap) only act inside the pair loop — so every step can
// simulate its type sample in real time (pairCorrCore on ~20 pairs) until
// all values are set. Only the final step runs the full computation.
// Optician principle: 3 clickable variants per step, plus a fine slider.

const WIZ_STEPS=[
  {key:'measure',title:'Measure'},
  {key:'width',title:'Width',param:'width',min:60,max:140,step:5,variants:[85,100,115],unit:'%',
   text:'Hamburgefonstiv wie im Wasser',
   hint:'How tight should the setting run? Words should group without melting together — tight for display, loose for reading text. Pick the variant with the calmest word image; the slider fine-tunes.'},
  {key:'stemgap',title:'Stem vs. Round',param:'stemgap',min:50,max:150,step:5,variants:[85,100,115],unit:'%',grid:true,
   toggle:{param:'rhythm',label:'Rhythm — stem gaps snap to the cadence grid (lines)'},
   text:'HHOOHHOO nnoonnoo',
   hint:'The HHOOHH experiment: do the gaps between stems look as big as the gaps between round shapes? The stem distance is a pure style choice — smaller = stems closer than rounds.'},
  // variants/max are re-measured per font in wizOpen (wizInsetFull)
  {key:'inset',title:'Inset',param:'inset',min:0,max:60,step:1,variants:[0,15,30],unit:' fu',grid:true,
   text:'noon HOOH nnoo',
   hint:'Stem vs. round, part two: how far do the stem sides tuck in toward the rounds? 0 keeps the tuck as kern pairs (o·n −1 module etc.); the measured variants (½ and full tuck) bake it into the sidebearings instead — Apply Spacing then carries it, the systematic round-vs-stem kerns disappear, and stem gaps close by twice the value.'},
  {key:'bias',title:'Bias',param:'bias',min:-100,max:100,step:10,variants:[-50,0,50],unit:'',
   text:'rn rm cl vv modern minimum',
   hint:'Legible (−): rn must not look like m, shapes stay clearly apart. Readable (+): the line should flow with a calm rhythm. Choose what matters more for this font.'},
  {key:'lazy',title:'Lazy',param:'lazy',min:0,max:90,step:5,variants:[30,50,70],unit:'%',
   text:'To Va Wa Ye Tokyo Value Water',
   hint:'How hard may the kerning grip? Small values = full correction, large = softer. Watch To/Va/Wa — tight, but not collapsed; for print usually softer.'},
  {key:'mingap',title:'Min gap',param:'mingap',min:0,max:6,step:0.5,variants:[0.5,1,2],unit:'%',markCapped:true,
   text:'f) fj gy r. v, w. T, L’',
   hint:'Minimum distance where shapes may touch — red dots mark capped pairs (⚑). Smaller = braver, larger = safe separation. The 2D distance field also checks diagonal near-misses.'},
  {key:'finish',title:'Finish'},
];

let wizIdx=0,wizVals={},wizRhythm=true,wizSel={},wizL2K=null;
let wizFinishPending=false,wizAutoNote='';

// ── Auto-open preference (can be turned off via localStorage) ──
// The open itself now happens after AutoParam: load → AutoParam → assistant
// (apAfterAnalysis in 14 checks wizAutoEnabled and calls wizOpen).
function wizAutoEnabled(){try{return localStorage.getItem('kerntripWizAuto')!=='0';}catch(_){return true;}}
function wizSetAuto(on){try{localStorage.setItem('kerntripWizAuto',on?'1':'0');}catch(_){}}
// Called after every completed analysis (05/06):
// after the wizard's own final run -> jump to the Equilibrium tab.
function wizMaybeAutoOpen(){
  if(wizFinishPending){wizFinishPending=false;wizClose();switchTab('equi');return;}
}

// Measured full tuck (fu) for the Inset step: the contact shortfall of the
// class base against a flat stem — dMin(base+stemRef) − dMin(base+base),
// i.e. how much closer the bulge tip must come to match the self-pair.
// LC and UC are measured separately; the larger one drives the variants.
function wizInsetFull(){
  const p=P();
  let best=0;
  for(const[baseKey,refs]of[[p.baselc,['n','i','l','h','m','u']],[p.baseuc,['H','I','N','M','U','L']]]){
    const b=glyphCache[wizL2K[baseKey]];
    if(!b)continue;
    for(const rl of refs){
      const g=glyphCache[wizL2K[rl]];
      if(!g||stemEdge(g.leftGeom,currentUPM)===null)continue;
      const self=minPairDist(b.rightGeom,b.leftGeom),mix=minPairDist(b.rightGeom,g.leftGeom);
      if(self!==null&&mix!==null)best=Math.max(best,mix-self);
      break; // first usable stem reference per class decides
    }
  }
  return Math.max(0,Math.round(best));
}

function wizOpen(){
  if(!glyphCache||!Object.keys(glyphCache).length){alert('Load a font first (compute runs automatically).');return;}
  wizL2K={};
  for(const k of Object.keys(glyphCache))wizL2K[glyphCache[k].charLabel]=k;
  // Inset step: variants 0 · ½ · full of THIS font's measured tuck
  const insStep=WIZ_STEPS.find(x=>x.key==='inset');
  if(insStep){
    const d=wizInsetFull()||(parseInt(document.getElementById('p-round')?.value)||20);
    insStep.variants=[0,Math.round(d/2),d];
    insStep.max=Math.max(20,Math.ceil(d*1.5));
  }
  // start values from the current fields
  wizVals={};wizSel={};
  for(const s of WIZ_STEPS){
    if(!s.param)continue;
    const el=document.getElementById('p-'+s.param);
    wizVals[s.param]=el?parseFloat(el.value)||0:0;
    wizSel[s.param]=-1;
  }
  wizRhythm=document.getElementById('p-rhythm')?.checked??true;
  wizAutoNote='';
  wizIdx=0;
  document.getElementById('wizard-overlay')?.classList.add('show');
  wizRender();
}
function wizClose(){document.getElementById('wizard-overlay')?.classList.remove('show');}

// ── Field access ──────────────────────────────────────
function wizSetField(param,val){
  if(param==='rhythm'){const el=document.getElementById('p-rhythm');if(el)el.checked=!!val;return;}
  const el=document.getElementById('p-'+param);if(el)el.value=val;
}
// P() with wizard overrides (mingap: the field holds %, P() divides by 100)
function wizP(step){
  const p=P();
  for(const s of WIZ_STEPS){
    if(!s.param)continue;
    const v=wizVals[s.param];
    if(s.param==='mingap')p.mingap=v/100;else p[s.param]=v;
  }
  p.rhythm=wizRhythm;
  return p;
}

// ── Glyph access (browser: opentype · Glyphs: commands) ──
function wizGlyph(ch){
  if(IS_GLYPHS){
    const name=unicodeToGlyphName[ch.codePointAt(0)];
    const g=name?glyphsByName[name]:null;
    if(!g||!g.commands||!g.commands.length)return null;
    return{adv:g.advanceWidth??currentUPM,mk:(x,y,s)=>commandsToPath2D(g.commands,x,y,s)};
  }
  const g=fontObj?fontObj.charToGlyph(ch):null;
  if(!g||!g.path||!g.path.commands.length)return null;
  return{adv:g.advanceWidth??currentUPM,mk:(x,y,s)=>{const d=g.getPath(x,y,s*currentUPM).toPathData(2);return d?new Path2D(d):null;}};
}

// ── Live simulation: only the pairs of the sample text (pairCorrCore) ──
function wizCorrs(text,pOv){
  const ctx=buildPairCtx(pOv,glyphCache,currentUPM,yBotGlobal,yTopGlobal,rhythmGridFromUI(pOv));
  const chars=[...text],out={};
  for(let i=0;i<chars.length-1;i++){
    const a=chars[i],b=chars[i+1];
    if(a===' '||b===' ')continue;
    const gA=glyphCache[wizL2K[a]],gB=glyphCache[wizL2K[b]];
    if(!gA||!gB)continue;
    const r=pairCorrCore(gA,gB,pOv,ctx);
    if(r)out[i]={corr:r.corr,capped:r.capped};
  }
  return{out,ctx};
}

// ── Render a sample ───────────────────────────────────
function wizDraw(cv,text,pOv,opts){
  opts=opts||{};
  const dpr=window.devicePixelRatio||1;
  const W=cv.clientWidth||640,H=cv.clientHeight||64;
  cv.width=W*dpr;cv.height=H*dpr;
  const g2=cv.getContext('2d');
  g2.setTransform(dpr,0,0,dpr,0,0);
  g2.clearRect(0,0,W,H);
  const upm=currentUPM;
  const chars=[...text];
  const{out,ctx}=wizCorrs(text,pOv);
  const infos=chars.map(ch=>ch===' '?null:wizGlyph(ch));
  let totalFU=0;
  for(let i=0;i<chars.length;i++){
    totalFU+=chars[i]===' '?upm*0.3:(infos[i]?infos[i].adv:upm*0.3);
    if(out[i])totalFU+=out[i].corr;
  }
  const pad=14;
  const scaleH=(H*0.66)/Math.max(1,(yTopGlobal>0?yTopGlobal:upm*0.75));
  const scale=Math.min(scaleH,(W-2*pad)/Math.max(1,totalFU));
  const baseY=H*0.76;
  const ink=getComputedStyle(document.documentElement).getPropertyValue('--text').trim()||'#ddd';
  // cadence grid (stem vs. round step): tick lines as a rhythm reference
  if(opts.grid&&ctx.rhythmGrid>1){
    g2.strokeStyle='rgba(122,107,214,0.25)';g2.lineWidth=1;
    for(let x=pad;x<W-pad;x+=ctx.rhythmGrid*scale){
      g2.beginPath();g2.moveTo(x,H*0.14);g2.lineTo(x,baseY+4);g2.stroke();
    }
  }
  let x=pad;
  g2.fillStyle=ink;
  for(let i=0;i<chars.length;i++){
    const ch=chars[i];
    if(ch===' '){x+=upm*0.3*scale;continue;}
    const inf=infos[i];
    if(inf){const path=inf.mk(x,baseY,scale);if(path)g2.fill(path);x+=inf.adv*scale;}
    else x+=upm*0.3*scale;
    if(out[i]){
      x+=out[i].corr*scale;
      if(opts.markCapped&&out[i].capped){
        g2.fillStyle='#e05555';g2.beginPath();g2.arc(x,baseY+7,2.5,0,7);g2.fill();g2.fillStyle=ink;
      }
    }
  }
}

// ── Automatic: reasonable values from a simple classification ──
function wizAutoValues(){
  const l=glyphCache[wizL2K['l']]||glyphCache[wizL2K['I']];
  let serif=false;
  if(l){
    const se=stemEdge(l.leftGeom,currentUPM);
    if(se!==null){let mn=Infinity;for(const v of l.leftGeom)if(v!==null&&v<mn)mn=v;serif=(se-mn)>0.01*currentUPM;}
  }
  return{vals:{width:100,stemgap:100,inset:0,bias:0,lazy:serif?40:50,mingap:serif?1.5:1},rhythm:true,serif};
}
function wizAuto(){
  const a=wizAutoValues();
  for(const k of Object.keys(a.vals)){wizVals[k]=a.vals[k];wizSetField(k,a.vals[k]);}
  wizRhythm=a.rhythm;wizSetField('rhythm',a.rhythm);
  wizAutoNote=`Values set automatically (serifs detected: ${a.serif?'yes':'no'}) — use "Back" to fine-tune single steps.`;
  wizIdx=WIZ_STEPS.length-1;
  wizRender();
}

// ── Navigation ────────────────────────────────────────
function wizNext(apply){
  const s=WIZ_STEPS[wizIdx];
  if(apply&&s.param){
    wizSetField(s.param,wizVals[s.param]);
    if(s.toggle)wizSetField(s.toggle.param,wizRhythm);
  }
  if(wizIdx<WIZ_STEPS.length-1){wizIdx++;wizRender();}
}
function wizBack(){if(wizIdx>0){wizIdx--;wizRender();}}
function wizFinish(){
  wizFinishPending=true;
  wizClose();
  runAnalysis();   // full computation; wizMaybeAutoOpen then jumps to the Equilibrium tab
}
function wizSelectVariant(i){
  const s=WIZ_STEPS[wizIdx];
  if(!s.param)return;
  wizSel[s.param]=i;
  wizVals[s.param]=s.variants[i];
  wizRender();
}
function wizSlider(v){
  const s=WIZ_STEPS[wizIdx];
  if(!s.param)return;
  wizVals[s.param]=parseFloat(v);
  const lbl=document.getElementById('wiz-val');
  if(lbl)lbl.textContent=wizVals[s.param]+(s.unit||'');
  const i=wizSel[s.param]>=0?wizSel[s.param]:1;
  const cv=document.getElementById('wiz-cv-'+i);
  if(cv)wizDraw(cv,s.text,wizP(s),s);
  const vl=document.getElementById('wiz-vl-'+i);
  if(vl)vl.textContent=wizVals[s.param]+(s.unit||'');
}
function wizToggle(on){
  wizRhythm=!!on;
  const s=WIZ_STEPS[wizIdx];
  if(!s.param)return;
  for(let i=0;i<s.variants.length;i++){
    const cv=document.getElementById('wiz-cv-'+i);
    if(!cv)continue;
    const pv=Object.assign({},wizP(s));
    const val=(wizSel[s.param]===i||(wizSel[s.param]<0&&i===1))?wizVals[s.param]:s.variants[i];
    if(s.param==='mingap')pv.mingap=val/100;else pv[s.param]=val;
    wizDraw(cv,s.text,pv,s);
  }
}

// ── Render the current step ───────────────────────────
function wizRender(){
  const box=document.getElementById('wizard-box');
  if(!box)return;
  const s=WIZ_STEPS[wizIdx];
  const chips=WIZ_STEPS.map((st,i)=>`<span style="padding:2px 7px;border-radius:9px;font-size:9px;font-family:var(--mono);${i===wizIdx?'background:var(--accent);color:#000':'background:var(--bg3);color:var(--text3)'}">${i}·${st.title}</span>`).join(' ');
  const footer=`<div style="display:flex;align-items:center;gap:10px;margin-top:14px;border-top:1px solid var(--border);padding-top:10px">
    ${wizIdx>0?'<button class="btn-hdr" onclick="wizBack()">◀ Back</button>':''}
    <span style="flex:1"></span>
    <label style="font-size:10px;color:var(--text3);display:flex;align-items:center;gap:5px"><input type="checkbox" ${wizAutoEnabled()?'checked':''} onchange="wizSetAuto(this.checked)">open automatically after loading</label>
    <button class="btn-hdr" onclick="wizClose()">✕ Close</button>
  </div>`;
  const head=`<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
    <b style="font-size:14px">✦ Setup</b>${chips}
    <span style="flex:1"></span>
    <button class="btn-hdr accent" onclick="wizAuto()" title="Set reasonable values automatically and jump to the summary">⚡ Automatic</button>
  </div>`;

  if(s.key==='measure'){
    const v=id=>document.getElementById(id)?.value??'—';
    box.innerHTML=head+
      `<p style="font-size:12px;color:var(--text2);line-height:1.6">These <b>measured values</b> were collected automatically while loading — they describe the font and normally need no changes. The next steps set the <b>design values</b>: every sample is computed live with your slider value.</p>
      <table style="font-family:var(--mono);font-size:11px;margin:10px 0;color:var(--text2)">
        <tr><td style="padding:2px 14px 2px 0">Cadence (n stem)</td><td>${v('cad-cadence')} fu → round module ${v('p-round')}</td></tr>
        <tr><td style="padding:2px 14px 2px 0">Slant</td><td>${v('p-slant')}°</td></tr>
        <tr><td style="padding:2px 14px 2px 0">Zones · Smooth · Blur</td><td>${v('p-zones')} · ${v('p-smooth')} · ${v('p-blur')}</td></tr>
        <tr><td style="padding:2px 14px 2px 0">Glyphs measured</td><td>${Object.keys(glyphCache).length}</td></tr>
      </table>
      <p style="font-size:11px;color:var(--text3)">Tip: AutoParam (in the parameter panel) can further tune the measured values for this font.</p>
      <div style="margin-top:12px"><button class="btn-hdr accent" onclick="wizNext(false)">Next ▶</button></div>`+footer;
    return;
  }

  if(s.key==='finish'){
    const rows=WIZ_STEPS.filter(x=>x.param).map(x=>`<tr><td style="padding:2px 14px 2px 0">${x.title}</td><td style="font-family:var(--mono)">${wizVals[x.param]}${x.unit||''}${x.toggle?` · rhythm ${wizRhythm?'on':'off'}`:''}</td></tr>`).join('');
    box.innerHTML=head+
      `${wizAutoNote?`<p style="font-size:11px;color:var(--accent)">${wizAutoNote}</p>`:''}
      <p style="font-size:12px;color:var(--text2);line-height:1.6">All design values are set. The full computation now runs all corpus pairs and then opens the <b>Equilibrium</b> tab — the worst triples there show whether a step is worth revisiting.</p>
      <table style="font-size:11px;color:var(--text2);margin:10px 0">${rows}</table>
      <div style="margin-top:12px"><button class="btn-hdr accent" style="font-size:12px;padding:8px 16px" onclick="wizFinish()">✓ Compute all pairs</button></div>`+footer;
    // write values into the fields (in case they changed via ⚡ or Back navigation)
    for(const x of WIZ_STEPS)if(x.param)wizSetField(x.param,wizVals[x.param]);
    wizSetField('rhythm',wizRhythm);
    return;
  }

  // regular step: hint + 3 variants (optician principle) + fine slider
  const cur=wizVals[s.param];
  const variants=s.variants.map((val,i)=>{
    const sel=wizSel[s.param]===i||(wizSel[s.param]<0&&val===s.variants[1]&&cur===s.variants[1]);
    const shown=(wizSel[s.param]===i)?cur:val;
    return`<div onclick="wizSelectVariant(${i})" style="cursor:pointer;border:1px solid ${sel?'var(--accent)':'var(--border)'};border-radius:6px;padding:4px 8px;margin:5px 0;background:var(--bg2)">
      <div style="font-family:var(--mono);font-size:9px;color:${sel?'var(--accent)':'var(--text3)'}" id="wiz-vl-${i}">${shown}${s.unit||''}</div>
      <canvas id="wiz-cv-${i}" style="width:100%;height:62px;display:block"></canvas>
    </div>`;
  }).join('');
  box.innerHTML=head+
    `<div style="font-size:13px;font-weight:700;margin-bottom:4px">${s.title}</div>
    <p style="font-size:12px;color:var(--text2);line-height:1.55;margin-bottom:8px">${s.hint}</p>
    ${variants}
    <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
      <input type="range" id="wiz-slider" min="${s.min}" max="${s.max}" step="${s.step}" value="${cur}" style="flex:1" oninput="wizSlider(this.value)">
      <span id="wiz-val" style="font-family:var(--mono);font-size:12px;min-width:52px;text-align:right">${cur}${s.unit||''}</span>
    </div>
    ${s.toggle?`<label style="font-size:11px;color:var(--text2);display:flex;align-items:center;gap:6px;margin-top:6px"><input type="checkbox" ${wizRhythm?'checked':''} onchange="wizToggle(this.checked)">${s.toggle.label}</label>`:''}
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn-hdr accent" onclick="wizNext(true)">Apply &amp; next ▶</button>
      <button class="btn-hdr" onclick="wizNext(false)" title="Keep the old value and go to the next step">Skip</button>
    </div>`+footer;
  // draw the canvases (after layout)
  requestAnimationFrame(()=>{
    for(let i=0;i<s.variants.length;i++){
      const cv=document.getElementById('wiz-cv-'+i);
      if(!cv)continue;
      const pv=Object.assign({},wizP(s));
      const val=(wizSel[s.param]===i)?cur:s.variants[i];
      if(s.param==='mingap')pv.mingap=val/100;else pv[s.param]=val;
      wizDraw(cv,s.text,pv,s);
    }
  });
}

if(typeof module!=='undefined')module.exports={wizOpen,wizClose,wizMaybeAutoOpen,wizAutoValues};
