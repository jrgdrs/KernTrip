// ── TRIPLE EQUILIBRIUM ────────────────────────────────
// After the pair computation: does the middle glyph B look optically
// centered between A and C? gapL/gapR = optical mean gap (pairMean on the
// smoothed/glow margins — the same weighting the kerning itself uses)
// plus the computed correction. Delta = |gapL − gapR| is the equilibrium
// error of the triple; the worst triples are the "bench tests" (critical
// combinations). Pure reporting, no solver — triples are built from the
// most frequent corpus pairs: (A,B) + (B,C) -> A·B·C.
let equiData=[];
let equiStats=null;

function computeEquilibrium(){
  equiData=[];equiStats=null;
  if(!kerningData.length)return;
  const corrOf={};
  for(const d of kerningData)corrOf[d.left+'|'+d.right]=d.correction;
  const gcOf={};
  for(const k of Object.keys(glyphCache))gcOf[glyphCache[k].charLabel]=glyphCache[k];
  // collect the most frequent corpus pairs, indexed by first character
  const TOPP=400,MAXT=800;
  const byFirst={};const top=[];
  for(const pair of KERNING_PAIRS){
    if(top.length>=TOPP)break;
    const c=[...pair];if(c.length<2)continue;
    if(!gcOf[c[0]]||!gcOf[c[1]])continue;
    top.push(c);
    if(!byFirst[c[0]])byFirst[c[0]]=[];
    byFirst[c[0]].push(c[1]);
  }
  const seen=new Set();
  outer:
  for(const[a,b]of top){
    const nexts=byFirst[b];
    if(!nexts)continue;
    for(const c of nexts){
      const id=a+b+c;
      if(seen.has(id))continue;
      seen.add(id);
      const gA=gcOf[a],gB=gcOf[b],gC=gcOf[c];
      const mL=pairMean(gA.right,gB.left),mR=pairMean(gB.right,gC.left);
      if(!mL||!mR)continue;
      const gapL=mL.mean+(corrOf[a+'|'+b]||0);
      const gapR=mR.mean+(corrOf[b+'|'+c]||0);
      equiData.push({t:a+b+c,gapL:r1(gapL),gapR:r1(gapR),err:r1(Math.abs(gapL-gapR))});
      if(equiData.length>=MAXT)break outer;
    }
  }
  if(!equiData.length)return;
  equiData.sort((x,y)=>y.err-x.err);
  const errs=equiData.map(d=>d.err).slice().sort((x,y)=>x-y);
  equiStats={
    n:equiData.length,
    med:r1(errs[Math.floor(errs.length/2)]),
    p95:r1(errs[Math.floor(errs.length*0.95)]),
  };
  log(`Equilibrium: ${equiStats.n} triples · median Δ ${equiStats.med} fu · P95 ${equiStats.p95} fu · max "${equiData[0].t}" Δ ${equiData[0].err}`,'info');
}

function renderEquilibrium(){
  const empty=document.getElementById('equi-empty');
  const content=document.getElementById('equi-content');
  if(!empty||!content)return;
  if(!equiData.length){empty.style.display='flex';content.style.display='none';return;}
  empty.style.display='none';content.style.display='block';
  const upm=currentUPM||1000;
  const sum=document.getElementById('equi-summary');
  if(sum)sum.textContent=`${equiStats.n} triples from the most frequent corpus pairs · median Δ ${equiStats.med} fu · P95 ${equiStats.p95} fu — Δ = |white space left − right| around the middle glyph (optically weighted, kerning included). Worst triples first: these are the bench tests. Click a row to preview.`;
  const tb=document.getElementById('equi-tbody');
  if(!tb)return;
  tb.innerHTML='';
  const shown=equiData.slice(0,150);
  for(let i=0;i<shown.length;i++){
    const d=shown[i];
    const tr=document.createElement('tr');
    const pct=Math.round(d.err/upm*1000)/10;
    if(i===selectedEquiIdx)tr.className='selected';
    tr.style.cursor='pointer';
    tr.innerHTML=`<td class="cc">${esc(d.t)}</td><td>${d.gapL}</td><td>${d.gapR}</td><td style="font-weight:700">${d.err}</td><td style="color:var(--text3)">${pct}%</td>`;
    tr.addEventListener('click',()=>selectEquiRow(i));
    tb.appendChild(tr);
  }
}

// load a triple into the preview: solo · in o context · in H context
function equiPreview(t){
  const inp=document.getElementById('preview-text');
  if(!inp)return;
  inp.value=`${t}  o${t}o  H${t}H`;
  const sel=document.getElementById('preset-select');
  if(sel)sel.value='';
  renderPreview();
}

// Row click / arrow-key navigation (mirrors selectPairRow on the Coupling tab)
function selectEquiRow(idx){
  const n=Math.min(equiData.length,150);
  if(idx<0||idx>=n)return;
  selectedEquiIdx=idx;
  renderEquilibrium();
  equiPreview(equiData[idx].t);
  const sel=document.querySelector('#equi-tbody tr.selected');
  if(sel)sel.scrollIntoView({block:'nearest'});
}

if(typeof module!=='undefined')module.exports={computeEquilibrium,renderEquilibrium,equiPreview,selectEquiRow};
