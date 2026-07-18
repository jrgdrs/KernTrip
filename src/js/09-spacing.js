// ── SPACING CORRECTIONS ────────────────────────────────
/**
 * Target margins per class come from the base glyphs (o/O). Five rules:
 *   1. The base glyph itself is centered: LSB = RSB (exact, no module
 *      rounding — snapping its own AW to the grid was tried and reverted,
 *      it visibly pulled the base off-center, which defeats the point of
 *      "everything else is based on the base"). "LSB/RSB" here means the
 *      ink extent at half the x-height (halfXhSB), not the true geometric
 *      minimum — that avoids letting serifs (near baseline/cap-height) or
 *      hooks/overshoots skew what should be a stem-width reading.
 *   2. Its centering offset shifts the class targets, so every other
 *      glyph inherits the same offset and keeps fitting the base.
 *   3. Sidebearings never go negative: the negative side is pinned at 0
 *      and the advance width rounds UP to the next module width (< 1
 *      module unit added in total); the remaining slack is distributed
 *      across the bearings in proportion to their computed widths. This
 *      is the true-minimum (geomSB) check — unlike rule 1/4, it must see
 *      the real outline, serifs and hooks included, or it would let ink
 *      actually overlap.
 *   4. Narrow glyphs (resulting width from rules 2/3 < half of "n"): the
 *      width itself is examined FIRST and never recomputed — only the
 *      already-decided dL/dR split is redistributed, using halfXhSB
 *      (same stem-width reading as rule 1), so LSB == RSB within that
 *      fixed width. If a deep localized overhang elsewhere (e.g. a
 *      descender hook) would then go negative at the TRUE minimum
 *      (geomSB), the deficit shifts to the other side, same width — a
 *      correctness backstop, not the old "skip if under one module"
 *      guard: it only engages on an actual negative bound and never
 *      reverts to the rules 2/3 split wholesale.
 *   5. space/nbspace have no ink (no margins, excluded from the loop
 *      above) — they simply take the advance width of "i" (picks up
 *      rule 4's centering if "i" itself qualifies as narrow).
 * computeSpacingRows() is the single source — table (renderSpacingTable)
 * and Apply Spacing (07) both consume its rows.
 */
// Two-decimal rounding for the New L / New R columns — finer than the
// general-purpose r1 (1 decimal) used elsewhere, since this table is where
// the sub-unit sidebearing precision actually matters to the reader.
function r2(v){return Math.round(v*100)/100;}
function avgMargin(arr){
  let sum=0,cnt=0;
  for(const v of arr)if(v!==null){sum+=v;cnt++;}
  return cnt>0?sum/cnt:null;
}
// Average only zones 0..maxZ (inclusive) — used for height-limited spacing
// Average zones minZ..maxZ only — zones outside the base glyph height are excluded
function avgMarginZones(arr,minZ,maxZ){
  let sum=0,cnt=0;
  const lo=Math.max(0,minZ),hi=Math.min(arr.length-1,maxZ);
  for(let z=lo;z<=hi;z++)if(arr[z]!==null){sum+=arr[z];cnt++;}
  return cnt>0?sum/cnt:null;
}
// Highest zone with non-null ink (top of ink)
function topZoneOf(gc){
  for(let z=gc.left.length-1;z>=0;z--)if(gc.left[z]!==null||gc.right[z]!==null)return z;
  return gc.left.length-1;
}
// Lowest zone with non-null ink (bottom of ink)
function botZoneOf(gc){
  for(let z=0;z<gc.left.length;z++)if(gc.left[z]!==null||gc.right[z]!==null)return z;
  return 0;
}

// Geometric sidebearing: minimum of the fine profile (per convention the
// geometric data, never the smoothed/glow arrays). Negative for overhangs.
function geomSB(arr){
  if(!arr)return null;
  let m=null;
  for(const v of arr)if(v!==null&&(m===null||v<m))m=v;
  return m;
}

// Nearest non-null fine-profile row to idx (outward search) — a stem
// glyph's sample row at exactly half x-height is essentially never empty,
// but this guards degenerate/very short glyphs.
function nearestNonNull(arr,idx){
  if(arr[idx]!==null)return arr[idx];
  for(let d=1;d<arr.length;d++){
    if(idx-d>=0&&arr[idx-d]!==null)return arr[idx-d];
    if(idx+d<arr.length&&arr[idx+d]!==null)return arr[idx+d];
  }
  return null;
}
// Left/right ink extent sampled at half the x-height — a clean stem-width
// reading, away from serifs (which sit at baseline/x-height/cap-height)
// and hooks/overshoots (descenders, bowls) that would skew the true
// geometric minimum (geomSB) used for centering. x-height falls back to
// 55% of the em (same estimate used for slant auto-detection) when the
// font provides none.
function halfXhSB(gc){
  const l=gc.leftFine??gc.leftGeom,r=gc.rightFine??gc.rightGeom;
  if(!l||!r||!l.length)return{l:null,r:null};
  const rowH=(yTopGlobal-yBotGlobal)/l.length;
  if(rowH<=0)return{l:null,r:null};
  const xh=(IS_GLYPHS?xHeightGlobal:(fontObj?.tables?.os2?.sxHeight||0))||Math.round((yTopGlobal-yBotGlobal)*0.55);
  let idx=Math.floor((xh/2-yBotGlobal)/rowH);
  idx=Math.max(0,Math.min(l.length-1,idx));
  return{l:nearestNonNull(l,idx),r:nearestNonNull(r,idx)};
}

// One row per glyph — shared by the table and Apply Spacing.
function computeSpacingRows(){
  const gks=Object.keys(glyphCache);
  if(!gks.length)return[];
  const p=P();
  const trk=p.tracking/2; // tracking split equally across left and right margin targets
  const baseLcGC=glyphCache[p.baselc],baseUcGC=glyphCache[p.baseuc];
  const lcBotZ=baseLcGC?botZoneOf(baseLcGC):null, lcTopZ=baseLcGC?topZoneOf(baseLcGC):null;
  const ucBotZ=baseUcGC?botZoneOf(baseUcGC):null, ucTopZ=baseUcGC?topZoneOf(baseUcGC):null;
  // centering offset per base glyph: shift that equalizes its half-x-height
  // ink extent — folded into the class targets so all glyphs inherit it
  const sbOff=gc=>{
    if(!gc)return 0;
    const s=halfXhSB(gc);
    return s.l===null||s.r===null?0:(s.r-s.l)/2;
  };
  const sLc=sbOff(baseLcGC),sUc=sbOff(baseUcGC);
  const baseLcL=baseLcGC&&lcBotZ!==null?avgMarginZones(baseLcGC.left,lcBotZ,lcTopZ)+trk+sLc:null;
  const baseLcR=baseLcGC&&lcBotZ!==null?avgMarginZones(baseLcGC.right,lcBotZ,lcTopZ)+trk-sLc:null;
  const baseUcL=baseUcGC&&ucBotZ!==null?avgMarginZones(baseUcGC.left,ucBotZ,ucTopZ)+trk+sUc:null;
  const baseUcR=baseUcGC&&ucBotZ!==null?avgMarginZones(baseUcGC.right,ucBotZ,ucTopZ)+trk-sUc:null;

  const rows=[];
  for(const gk of gks){
    const gc=glyphCache[gk];
    if(!gc)continue;
    const isUC=gc.cls==='UC';
    const botZ=isUC?ucBotZ:lcBotZ, topZ=isUC?ucTopZ:lcTopZ;
    const bL=isUC?baseUcL:baseLcL,bR=isUC?baseUcR:baseLcR;
    if(bL===null||bR===null||botZ===null||topZ===null)continue;
    const gL=avgMarginZones(gc.left,botZ,topZ),gR=avgMarginZones(gc.right,botZ,topZ);
    if(gL===null||gR===null)continue;
    const isBase=gc===baseLcGC||gc===baseUcGC;
    const oldAW=gc.advanceWidth;
    let dL,dR,newAW;
    if(isBase){
      // exact centering: LSB = RSB afterwards, module rounding would break it
      const s=isUC?sUc:sLc;
      dL=Math.round(trk+s);dR=Math.round(trk-s);
      newAW=oldAW+dL+dR;
    }else{
      dL=rtm(bL-gL,p.round);
      dR=rtm(bR-gR,p.round);
      newAW=rtm(oldAW+dL+dR,p.round);
      const lsb=geomSB(gc.leftFine??gc.leftGeom),rsb=geomSB(gc.rightFine??gc.rightGeom);
      const clampL=lsb!==null&&lsb+dL<0;
      const clampR=rsb!==null&&rsb+(newAW-oldAW-dL)<0;
      if(clampL||clampR){
        // Negative sidebearings never reach the output: the negative side is
        // pinned at 0 and the advance width stays on the module grid — the
        // NEXT module width up (smaller would push a bearing negative again),
        // so at most one module unit is added. The remaining slack is split
        // across the bearings ∝ the previously computed bearing widths:
        // the pinned side (width 0) gets nothing and stays exactly 0.
        const dLx=clampL?-lsb:dL, dRx=clampR?-rsb:dR;
        const exact=oldAW+dLx+dRx;
        const mod=Math.max(1,p.round);
        newAW=Math.ceil(exact/mod-1e-9)*mod;
        const slack=newAW-exact;
        const sideL=Math.max(0,(lsb??0)+dLx), sideR=Math.max(0,(rsb??0)+dRx);
        const propL=sideL+sideR>0?sideL/(sideL+sideR):0.5;
        dL=Math.round(dLx+slack*propL);
        dR=Math.round(newAW-oldAW-dL); // effective right correction
      }
    }
    const dAW=newAW-oldAW;
    rows.push({gk,gc,oldAW,newAW,dAW,dL:r2(dL),dR:r2(dR),newL:r2(gL+dL),newR:r2(gR+dR)});
  }

  // Narrow glyphs (period, comma, dots, j …): first examine the RESULTING
  // width rules 2/3 already settled on (module grid, negative-bearing
  // clamp already applied) — only if that width is under half of "n" do
  // we then improve the ALIGNMENT within it. The width itself is never
  // recomputed here: dL/dR are redistributed (their sum, and so newAW,
  // stays exactly what rules 2/3 decided) so LSB == RSB, using halfXhSB
  // (stem-width reading, not the true geometric minimum — see rule 1)
  // so a descender hook like on "j" can't skew the split. Needs the full
  // "n" row, so this runs as a second pass over the already-built rows
  // (build order is unreliable).
  const nRow=rows.find(r=>r.gc.charLabel==='n');
  if(nRow){
    for(const r of rows){
      if(r.gc.cls==='SP'||r.gc===baseLcGC||r.gc===baseUcGC)continue;
      if(r.newAW>=nRow.newAW/2)continue;
      const s=halfXhSB(r.gc);
      if(s.l===null||s.r===null)continue;
      const widthDelta=r.newAW-r.oldAW; // fixed — the resulting width, decided above, is never touched
      const sumSlack=s.l+s.r+widthDelta; // curLSB+curRSB at that fixed width, independent of the L/R split
      let dL=Math.round(sumSlack/2)-s.l;
      let dR=widthDelta-dL;              // derived, so dL+dR stays exactly widthDelta
      // Centering reads the clean stem (halfXhSB), so it can land a split
      // that a deep localized overhang elsewhere (e.g. a descender hook)
      // would push past zero at the TRUE minimum (geomSB) — shift the
      // deficit to the other side, same width, rather than letting ink
      // actually overlap. Unlike the removed guard this never reverts the
      // whole centering attempt, it only engages on a real negative bound.
      const trueL=geomSB(r.gc.leftFine??r.gc.leftGeom),trueR=geomSB(r.gc.rightFine??r.gc.rightGeom);
      if(trueL!==null&&trueL+dL<0){const deficit=-(trueL+dL);dL+=deficit;dR-=deficit;}
      if(trueR!==null&&trueR+dR<0){const deficit=-(trueR+dR);dR+=deficit;dL-=deficit;}
      r.dL=r2(dL);r.dR=r2(dR);r.newL=r2(s.l+dL);r.newR=r2(s.r+dR);
      // r.newAW / r.dAW intentionally untouched — only the L/R split moves
    }
  }

  // space & nbspace: no ink, so they never enter the loop above (no left/
  // right margins). Instead they take the same advance width as "i" — the
  // whole delta is a pure width change, no sidebearing to shift.
  const iRow=rows.find(r=>r.gc.charLabel==='i');
  if(iRow){
    for(const key of['sp','nbsp']){
      const info=spaceGlyphInfo[key];
      if(!info)continue;
      const oldAW=info.advanceWidth,newAW=iRow.newAW,dAW=newAW-oldAW;
      rows.push({gk:'__'+key,gc:{charLabel:info.name,cls:'SP',glyphName:info.name},oldAW,newAW,dAW,dL:0,dR:dAW,newL:null,newR:null});
    }
  }
  return rows;
}

function showSpacingContent(show){
  const empty=document.getElementById('spacing-empty');
  const content=document.getElementById('spacing-content');
  if(show){empty.style.display='none';content.style.display='flex';}
  else{empty.style.display='flex';content.style.display='none';}
}

function renderSpacingTable(){
  if(!Object.keys(glyphCache).length){showSpacingContent(false);return;}
  const rows=computeSpacingRows();

  if(!rows.length){
    showSpacingContent(false);
    document.getElementById('spacing-empty').querySelector('div:last-child').textContent='No glyphs with margins found';
    return;
  }

  rows.sort((a,b)=>a.newAW-b.newAW||(a.gc.charLabel<b.gc.charLabel?-1:1));

  // Histogram grouped by newAW — horizontal rows with glyphs inside bars
  const byAW=new Map();
  for(const r of rows){if(!byAW.has(r.newAW))byAW.set(r.newAW,[]);byAW.get(r.newAW).push(r);}
  const sortedAW=[...byAW.entries()].sort((a,b)=>a[0]-b[0]);
  const maxCount=Math.max(...sortedAW.map(([,a])=>a.length));
  const histEl=document.getElementById('spacing-histogram');
  let histHtml='<div style="display:flex;flex-direction:column;gap:2px;padding:8px 0">';
  for(const[aw,items] of sortedAW){
    const pct=Math.max(6,Math.round(items.length/maxCount*100));
    const chars=items.map(r=>r.gc.charLabel).join(' ');
    const tooltip=items.map(r=>r.gc.charLabel).join(' ');
    histHtml+=`<div title="${esc(tooltip)}" style="display:flex;align-items:center;gap:6px">`;
    histHtml+=`<span style="font-size:10px;color:var(--text2);width:44px;text-align:right;flex-shrink:0;font-variant-numeric:tabular-nums">${aw}</span>`;
    histHtml+=`<div style="flex:1;min-width:0;background:rgba(255,255,255,.07);border-radius:3px;height:24px;position:relative">`;
    histHtml+=`<div style="position:absolute;left:0;top:0;height:100%;width:${pct}%;background:var(--accent);opacity:.8;border-radius:3px;display:flex;align-items:center;padding:0 7px;overflow:hidden;white-space:nowrap;font-size:14px;letter-spacing:.05em;color:#fff;line-height:1">${esc(chars)}</div>`;
    histHtml+=`</div>`;
    histHtml+=`<span style="font-size:10px;color:var(--text2);flex-shrink:0;width:22px;text-align:left">${items.length}</span>`;
    histHtml+=`</div>`;
  }
  histHtml+='</div>';
  histEl.innerHTML=histHtml;

  const tbody=document.getElementById('spacing-tbody');
  tbody.innerHTML='';
  const fmt=v=>v===0?'0':(v>0?'+'+v:String(v));
  for(const r of rows){
    const tr=document.createElement('tr');
    const cls=r.gc.cls==='UC'?'tuc':'tlc';
    tr.innerHTML=`<td class="cc">${esc(r.gc.charLabel)}</td><td class="${cls}">${r.gc.cls}</td><td>${r.oldAW}</td><td style="font-weight:700">${r.newAW}</td><td class="${r.dAW<0?'vneg':r.dAW>0?'vpos':'vzero'}">${fmt(r.dAW)}</td><td class="${r.dL<0?'vneg':r.dL>0?'vpos':'vzero'}">${fmt(r.dL)}</td><td class="${r.dR<0?'vneg':r.dR>0?'vpos':'vzero'}">${fmt(r.dR)}</td><td>${r.newL??'—'}</td><td>${r.newR??'—'}</td>`;
    tbody.appendChild(tr);
  }
  showSpacingContent(true);
}

if(typeof module!=='undefined')module.exports={avgMargin,avgMarginZones,topZoneOf,botZoneOf,geomSB,computeSpacingRows,showSpacingContent,renderSpacingTable};
