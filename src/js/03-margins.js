// ── SMOOTHING ─────────────────────────────────────────
function r1(v){return Math.round(v*10)/10;}
function smoothMargins(arr,zH,pct){
  if(pct<=0)return arr.slice();
  const mD=pct*zH,n=arr.length,out=arr.slice();
  let aZ=-1,aV=Infinity;
  for(let z=0;z<n;z++)if(arr[z]!==null&&arr[z]<aV){aV=arr[z];aZ=z;}
  if(aZ===-1)return out;
  let prev=aZ;
  for(let z=aZ-1;z>=0;z--){if(out[z]===null)continue;const mA=r1(out[prev]+mD);if(out[z]>mA)out[z]=mA;if(out[z]<aV)out[z]=r1(aV);prev=z;}
  prev=aZ;
  for(let z=aZ+1;z<n;z++){if(out[z]===null)continue;const mA=r1(out[prev]+mD);if(out[z]>mA)out[z]=mA;if(out[z]<aV)out[z]=r1(aV);prev=z;}
  return out;
}

// ── SLANT DETECTION ───────────────────────────────────
// Measures leftmost ink of a glyph at ¼ and ¾ of xHeight,
// returns tan(italic angle). 0 for upright fonts.
function detectSlantTan(pathOrCmds,xHeight){
  if(!xHeight||xHeight<=0)return 0;
  const nZ=80;
  const path=(pathOrCmds&&pathOrCmds.commands!==undefined)?pathOrCmds:{commands:pathOrCmds};
  if(!path.commands||!path.commands.length)return 0;
  const sub=pathXZones(path,nZ,0,xHeight,0);
  const zH=xHeight/nZ;
  const z1=Math.floor(nZ*0.25),z2=Math.floor(nZ*0.75);
  if(!sub[z1]||!sub[z2])return 0;
  const dy=(z2-z1)*zH;
  return dy>0?(sub[z2].xMin-sub[z1].xMin)/dy:0;
}

// ── GLYPH MARGINS ─────────────────────────────────────
// Fine profile resolution for the 2D distance field: fixed row count,
// independent of the user's measuring zones.
const KT_FINE_N=64;
function computeGlyphMargins(glyph,upm,p,yBot,yTop,slantTan){
  const aw=glyph.advanceWidth??0;
  const zH=(yTop-yBot)/p.zones;
  const subs=p.zones*p.blur;
  const path=glyph.getPath(0,0,upm);
  // Geometric margins (outline only, no glow) — authoritative for min-gap checks
  const sT=slantTan||0;
  const geomSubR=pathXZones(path,subs,yBot,yTop,sT);
  const lGeom=[],rGeom=[];
  for(let z=0;z<p.zones;z++){
    const s0=z*p.blur;let sL=0,sR=0,cnt=0;
    for(let s=0;s<p.blur;s++){const sub=geomSubR[s0+s];if(!sub)continue;sL+=sub.xMin;sR+=aw-sub.xMax;cnt++;}
    if(cnt===0){lGeom.push(null);rGeom.push(null);}else{lGeom.push(r1(sL/cnt));rGeom.push(r1(sR/cnt));}
  }
  // Fine profile: geometric margin curve in KT_FINE_N rows — the basis for
  // the true 2D minimum distance (serif corners, diagonal near-misses).
  const fineR=pathXZones(path,KT_FINE_N,yBot,yTop,sT);
  const lFine=[],rFine=[];
  for(let i=0;i<KT_FINE_N;i++){
    const s=fineR[i];
    if(!s){lFine.push(null);rFine.push(null);}
    else{lFine.push(r1(s.xMin));rFine.push(r1(aw-s.xMax));}
  }
  // Kerning margins: glow-spread when glow is on, else reuse geometric
  let lR,rR;
  if(p.glow){
    const glowSubR=glowZones(glyph,aw,p,yBot,yTop,false,upm,sT);
    lR=[];rR=[];
    for(let z=0;z<p.zones;z++){
      const s0=z*p.blur;let sL=0,sR=0,cnt=0;
      for(let s=0;s<p.blur;s++){const sub=glowSubR[s0+s];if(!sub)continue;sL+=sub.xMin;sR+=aw-sub.xMax;cnt++;}
      if(cnt===0){lR.push(null);rR.push(null);}else{lR.push(r1(sL/cnt));rR.push(r1(sR/cnt));}
    }
  }else{lR=lGeom;rR=rGeom;}
  const leftSm=smoothMargins(lR,zH,p.smooth);
  const rightSm=smoothMargins(rR,zH,p.smooth);
  let unicode=null;
  if(glyph.unicodes?.length>0)unicode=glyph.unicodes[0];
  return{left:leftSm,right:rightSm,leftRaw:lR,rightRaw:rR,leftGeom:lGeom,rightGeom:rGeom,leftFine:lFine,rightFine:rFine,advanceWidth:aw,unicode};
}

// ── 2D DISTANCE FIELD: true minimum distance for the min gap ──
// The zonal horizontal check misses diagonal near-misses (serif corners,
// "V." cases between two zones). Here every row pair (i,j) of the fine
// profiles must satisfy the Euclidean condition dx >= sqrt(minGap^2 - dy^2),
// with dx = rightA[i] + leftB[j] + corr and dy conservatively taken as the
// band gap (|i-j|-1)*rowH (neighbor rows can touch at the edge -> dy=0).
// Returns the smallest corr that satisfies ALL conditions (can be negative
// = headroom), or null when there is no ink interaction.
function minGap2D(rightFineA,leftFineB,rowH,minGap){
  let minCorr=-Infinity,found=false;
  const K=Math.ceil(minGap/rowH);
  for(let i=0;i<rightFineA.length;i++){
    const a=rightFineA[i];if(a===null)continue;
    const jEnd=Math.min(leftFineB.length,i+K+1);
    for(let j=Math.max(0,i-K);j<jEnd;j++){
      const b=leftFineB[j];if(b===null)continue;
      const dyEff=Math.max(0,Math.abs(i-j)-1)*rowH;
      if(dyEff>=minGap)continue;
      const c=Math.sqrt(minGap*minGap-dyEff*dyEff)-(a+b);
      if(c>minCorr){minCorr=c;found=true;}
    }
  }
  return found?minCorr:null;
}

// ── CLASSIFICATION ────────────────────────────────────
function classifyGlyph(unicode,name){
    if(/\.sc$|\.smcp$/.test(name))return'UC';
  if(unicode===null)return /^[A-Z]/.test(name)?'UC':'LC';
  if(unicode>=48&&unicode<=57)return'UC';
  if(unicode>=65&&unicode<=90)return'UC';
  if((unicode>=192&&unicode<=214)||(unicode>=216&&unicode<=222))return'UC';
  if(unicode>=256&&unicode<=382&&unicode%2===0)return'UC';
  if(unicode>=0x0391&&unicode<=0x03A9)return'UC';
  if(unicode>=0x0410&&unicode<=0x042F)return'UC';
  return'LC';
}

// ── PAIR MEAN ─────────────────────────────────────────
function pairMean(rA,lB){
  const zv=[];let sum=0;
  for(let z=0;z<rA.length;z++){const a=rA[z],b=lB[z];if(a===null||b===null)continue;const s=a+b;sum+=s;zv.push({z,rA:a,lB:b,sum:r1(s)});}
  if(zv.length===0)return null;
  return{mean:sum/zv.length,validCount:zv.length,zoneValues:zv};
}
function rtm(v,mod){if(mod<=1)return Math.round(v);return Math.round(v/mod)*mod;}

// ── PAIR SHAPE (shape classes from the gap profile) ──
// Closest ink zone of a pair (geometric margins).
function minPairDist(rA,lB){
  let m=Infinity;
  for(let z=0;z<rA.length;z++){const a=rA[z],b=lB[z];if(a===null||b===null)continue;if(a+b<m)m=a+b;}
  return isFinite(m)?m:null;
}
// Reference depth (fraction of UPM) used to normalize the opening depth,
// and tolerance for "near the minimum".
const KT_DEPTH_REF=0.12,KT_NEAR_TOL=0.02;
// Classifies the geometric gap profile d[z]=A.rightGeom+B.leftGeom
// (only zones with ink on both sides):
//   depth – opening depth: MEDIAN(d) − min(d). Median instead of mean, so
//           the extreme ink zones where bowls close horizontally (O caps)
//           do not wrongly mark convex pairs as "open".
//   asym  – eccentricity of the near-minimum zones inside the ink band (0..1).
//   beta  – contact character: 0 = air model (mean gap), 1 = contact model
//           (closest point). Flat profile (stems) -> 0 (both models are
//           identical there — the distance stays a free style choice),
//           centered moderate curvature (convex vs convex, o+o) -> 1,
//           deep or eccentric opening (r arm, L, T, V) -> 0.
//   openness – degree of opening beyond the contact regime (0..1), brakes lazy.
function pairShape(rA,lB,upm){
  const zs=[],ds=[];
  for(let z=0;z<rA.length;z++){const a=rA[z],b=lB[z];if(a===null||b===null)continue;zs.push(z);ds.push(a+b);}
  if(!ds.length)return null;
  let dMin=Infinity;
  for(const d of ds)if(d<dMin)dMin=d;
  const sorted=ds.slice().sort((a,b)=>a-b);
  const mid=sorted.length>>1;
  const median=sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
  const depth=median-dMin;
  const depthN=depth/(KT_DEPTH_REF*upm);
  const tol=KT_NEAR_TOL*upm;
  let cSum=0,cN=0;
  for(let i=0;i<ds.length;i++)if(ds[i]-dMin<=tol){cSum+=zs[i];cN++;}
  const zF=zs[0],zL=zs[zs.length-1];
  const span=Math.max(1,(zL-zF)/2);
  const asym=Math.min(1,Math.abs(cSum/cN-(zF+zL)/2)/span);
  const rise=Math.min(1,depthN/0.15);                    // full contact from ~15% of the reference depth
  const fall=Math.max(0,Math.min(1,(1-depthN)/0.5));     // fade out from 50%, pure air from 100%
  const beta=rise*fall*(1-asym);
  const openness=Math.max(0,Math.min(1,(depthN-0.5)/0.5));
  return{beta,dMin,depth:r1(depth),asym:r1(asym),openness};
}

// ── STEM EDGE (base for the rhythm grid & the stem gap parameter) ──
// A glyph side counts as a stem line when the LARGEST VALUE CLUSTER of its
// margin profile covers at least half of the ink zones (and >=3) — the stem
// line dominates the profile; serifs and brackets fall out as outliers.
// The tolerance is TIGHT (0.4% of UPM): a real stem gives practically
// identical margins (vertical edge), a bowl (o) drifts continuously and
// forms no tight cluster.
// Returns the closest margin of the cluster (stem edge to advance edge), else null.
function stemEdge(arr,upm){
  const v=[];for(const x of arr)if(x!==null)v.push(x);
  if(v.length<4)return null;                 // too few zones for a profile
  const tol=0.004*upm;
  let best=null,bestN=0;
  for(const cand of v){
    let n=0,mn=Infinity;
    for(const x of v)if(Math.abs(x-cand)<=tol){n++;if(x<mn)mn=x;}
    if(n>bestN){bestN=n;best=mn;}
  }
  if(bestN<3||bestN<v.length*0.5)return null;
  return best;
}

// ── CHAR LABEL ────────────────────────────────────────
// charLabel: use the actual unicode character so it matches KERNING_PAIRS entries directly.
// Glyph-name fallback only when unicode is unavailable (unnamed/private-use glyphs).
function cLbl(unicode,gn,gk){
  if(unicode!==null){try{return String.fromCodePoint(unicode);}catch(_){}}
  if(gn&&!/^glyph\d+$/i.test(gn))return gn;
  return gk;
}

// ── SHARED PAIR CORE (one formula for 05/06/14/16) ──
// Rhythm grid from the UI: cadence tick (cad-cadence via cadToRound),
// fallback is the round module. 0 = rhythm off.
function rhythmGridFromUI(p){
  if(!p.rhythm||typeof document==='undefined')return 0;
  const cadv=parseFloat(document.getElementById('cad-cadence')?.value);
  const g=(!isNaN(cadv)&&cadv>0&&typeof cadToRound==='function')?cadToRound(cadv):p.round;
  return g>1?g:p.round;
}
// Context for pairCorrCore: base gaps (x width + tracking), proximity
// targets (self-consistently calibrated on the reference), min gap
// (x width, bias towards legible up to +50%), fine row height.
function buildPairCtx(p,store,upm,yBot,yTop,rhythmGrid){
  const wf=(p.width||100)/100;
  const nD=store[p.baselc],oD=store[p.baseuc];
  const lcC=nD?pairMean(nD.right,nD.left):null;
  const baseLC=(lcC?lcC.mean*wf:0)+p.tracking;
  const ucC=oD?pairMean(oD.right,oD.left):null;
  const baseUC=(ucC?ucC.mean*wf:(baseLC-p.tracking))+p.tracking;
  const pdLC=nD?minPairDist(nD.rightGeom,nD.leftGeom):null;
  const proxLC=(lcC&&pdLC!==null)?pdLC+(baseLC-lcC.mean):null;
  const pdUC=oD?minPairDist(oD.rightGeom,oD.leftGeom):null;
  const proxUC=(ucC&&pdUC!==null)?pdUC+(baseUC-ucC.mean):null;
  const minGapFU=upm*p.mingap*wf;
  const minGapEff=minGapFU*(1+Math.max(0,-(p.bias||0))/200);
  // stem-ness of the base glyphs' sides — the inset (stem vs. round) moves
  // exactly the sides whose stem-ness DIFFERS from the base's, so the base
  // stays the fixed anchor and repeated runs cannot drift
  const bStem=g=>g?{r:stemEdge(g.rightGeom,upm)!==null,l:stemEdge(g.leftGeom,upm)!==null}:{r:false,l:false};
  return{upm,baseLC,baseUC,proxLC,proxUC,minGapFU,minGapEff,
    baseStem:{lc:bStem(nD),uc:bStem(oD)},
    rhythmGrid:rhythmGrid||0,fineRowH:(yTop-yBot)/KT_FINE_N};
}
// The complete pair formula: shape classes -> bias beta -> stem gap ->
// air/contact blend -> lazy + opening brake -> rounding -> rhythm grid ->
// 2D min gap -> cost-based dropping.
// Returns null when the pair shares no ink, otherwise a result object.
function pairCorrCore(gcA,gcB,p,ctx){
  const calc=pairMean(gcA.right,gcB.left);
  if(!calc)return null;
  const bothUC=gcA.cls==='UC'&&gcB.cls==='UC';
  const base=bothUC?ctx.baseUC:ctx.baseLC;
  const tag=bothUC?'UC':(gcA.cls==='UC'||gcB.cls==='UC')?'mixed':'LC';
  const shape=pairShape(gcA.rightGeom,gcB.leftGeom,ctx.upm);
  // bias: legible (-) -> contact model, readable (+) -> air model
  const bias=p.bias||0;
  const beta0=shape?shape.beta:0;
  const beta=bias>=0?beta0*(1-bias/100):beta0+(1-beta0)*(-bias/100);
  let prox=bothUC?ctx.proxUC:ctx.proxLC;
  let baseEff=base;
  // stem gap: full effect on stem+stem, half on stem+round
  const sA=stemEdge(gcA.rightGeom,ctx.upm),sB=stemEdge(gcB.leftGeom,ctx.upm);
  const nStem=(sA!==null?1:0)+(sB!==null?1:0);
  if(nStem>0&&p.stemgap!==100){
    const f=nStem===2?p.stemgap/100:(1+p.stemgap/100)/2;
    const dS=base*(f-1);
    baseEff=base+dS;if(prox!==null)prox+=dS;
  }
  // Inset (stem vs. round, part two): the spacing side (09) pulls every
  // side whose stem-ness differs from the base's in by p.inset. The AIR
  // target follows every shifted side (that white is missing by design, so
  // the air model must not reopen it). The CONTACT target follows only when
  // BOTH facing sides moved (stem+stem: a rhythm decision, not a tuck);
  // one-sided (round+stem) pairs keep their contact target — their physical
  // −inset eats the tuck desire, so once Apply Spacing has run, the
  // systematic round-vs-stem kerns (o·n, o·H …) collapse to 0.
  if((p.inset||0)>0){
    const shA=(sA!==null)!==(gcA.cls==='UC'?ctx.baseStem.uc:ctx.baseStem.lc).r;
    const shB=(sB!==null)!==(gcB.cls==='UC'?ctx.baseStem.uc:ctx.baseStem.lc).l;
    const nSh=(shA?1:0)+(shB?1:0);
    if(nSh>0){
      baseEff-=p.inset*nSh;
      if(prox!==null&&nSh===2)prox-=2*p.inset;
    }
  }
  // air/contact blend + lazy + opening brake
  let raw=baseEff-calc.mean;
  if(shape&&prox!==null&&beta>0)raw=(1-beta)*raw+beta*(prox-shape.dMin);
  if(p.lazy>0)raw*=1-p.lazy/100;
  raw*=1-0.4*(shape?shape.openness:0);
  let corr=rtm(raw,p.round);
  // rhythm grid: snap stem+stem gaps to the cadence grid
  let rhythmic=false,thresholded=false;
  if(ctx.rhythmGrid>1&&nStem===2){
    const gap=sA+sB;
    const target=Math.max(ctx.rhythmGrid,Math.round((gap+corr)/ctx.rhythmGrid)*ctx.rhythmGrid);
    corr=Math.round(target-gap);rhythmic=true;
    // A snap smaller than one module is noise, not rhythm: the gap already
    // sits within half a module of its tick — that residue is spacing's
    // territory, so sub-module pair values never reach the output.
    if(Math.abs(corr)<p.round){corr=0;rhythmic=false;thresholded=true;}
  }
  // 2D min gap
  let capped=false;
  if(ctx.minGapEff>0){
    const mc=minGap2D(gcA.rightFine,gcB.leftFine,ctx.fineRowH,ctx.minGapEff);
    if(mc!==null){
      const minCorr=p.round>1?Math.ceil(mc/p.round)*p.round:Math.ceil(mc);
      if(corr<minCorr){corr=minCorr;capped=true;}
    }
  }
  // cost-based dropping (replaces the old threshold)
  if(!capped&&!rhythmic&&corr!==0){
    const tBase=ctx.upm*0.003,widen=1+Math.abs(bias)/33;
    const tPos=bias>0?tBase*widen:tBase;
    const tNeg=bias<0?tBase*widen:tBase;
    if((corr>0&&corr<tPos)||(corr<0&&-corr<tNeg)){corr=0;thresholded=true;}
  }
  return{corr,calc,baseEff,beta,tag,capped,rhythmic,thresholded};
}

if(typeof module!=='undefined')module.exports={r1,smoothMargins,detectSlantTan,computeGlyphMargins,classifyGlyph,pairMean,rtm,minPairDist,pairShape,stemEdge,minGap2D,KT_FINE_N,buildPairCtx,pairCorrCore,rhythmGridFromUI,cLbl};
