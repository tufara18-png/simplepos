const CFG=window.SIMPLEPOS_CONFIG||{};
const API=`${CFG.supabaseUrl}/rest/v1`;
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const seatCache=new Map();
let currentSeat=1,rendering=false,refreshTimer=null;
let pendingShare=null;const shareSeats=new Set();
// Seats the server opened with "Client suivant" that do not carry an item yet.
let openedSeats=1;
// Per-restaurant switch: table service wants seats, a counter does not.
let seatEnabled=true,settingsLoadedFor=null,restaurantId=null;

function session(){try{return JSON.parse(localStorage.getItem('simplepos-session')||'null')}catch{return null}}
function headers(extra={}){const s=session();return{apikey:CFG.supabasePublishableKey||'',Authorization:`Bearer ${s?.access_token||''}`,'Content-Type':'application/json',...extra}}
function money(n){return Number(n||0).toLocaleString('fr-CA',{style:'currency',currency:'CAD'})}
function toast(message,type='ok'){const el=$('#toast');if(!el)return;el.textContent=message;el.dataset.type=type;el.classList.add('show');clearTimeout(el._pivotTimer);el._pivotTimer=setTimeout(()=>el.classList.remove('show'),2400)}
async function rest(path,{method='GET',body,prefer='return=representation'}={}){const r=await fetch(`${API}/${path}`,{method,headers:headers(prefer?{Prefer:prefer}:{}),body:body===undefined?undefined:JSON.stringify(body)}),t=await r.text(),d=t?JSON.parse(t):null;if(!r.ok)throw new Error(d?.message||`Supabase ${r.status}`);return d}

/*
  Compatibility layer: app-v2 remains the source of truth. We only enrich writes
  with seat_number, so fiscal/payment code is not rewritten.
*/
const wrappedFetch=window.fetch.bind(window);
window.fetch=async(input,init={})=>{
  const url=typeof input==='string'?input:input?.url||'';
  const method=String(init?.method||'GET').toUpperCase();
  if(method==='POST'&&init?.body&&typeof init.body==='string'){
    try{
      const body=JSON.parse(init.body);
      if(seatEnabled&&/\/rest\/v1\/order_items(?:\?|$)/.test(url)){
        const enrich=x=>x&&typeof x==='object'&&!Array.isArray(x)&&x.order_id&&x.seat_number==null?{...x,seat_number:currentSeat}:x;
        const next=Array.isArray(body)?body.map(enrich):enrich(body);
        init={...init,body:JSON.stringify(next)};
      }
      if(/\/rest\/v1\/invoice_items(?:\?|$)/.test(url)){
        const enrich=x=>{const seat=seatCache.get(x?.order_item_id)?.seat_number;return seat&&x?.seat_number==null?{...x,seat_number:seat}:x};
        const next=Array.isArray(body)?body.map(enrich):enrich(body);
        init={...init,body:JSON.stringify(next)};
      }
    }catch{}
  }
  return wrappedFetch(input,init);
};

function guestCount(){const text=$('#guestButton')?.textContent||'1';const n=parseInt(text,10);return Number.isInteger(n)&&n>0?n:1}
function visibleItemIds(selector,attr){return $$(selector).map(el=>el.querySelector(`[${attr}]`)?.getAttribute(attr)||el.getAttribute(attr)).filter(Boolean)}
async function loadItems(ids){if(!ids.length)return[];const unique=[...new Set(ids)];const rows=await rest(`order_items?id=in.(${unique.join(',')})&select=id,order_id,name,unit_price,quantity,paid_quantity,seat_number,kitchen_status,share_group_id`);rows.forEach(r=>seatCache.set(r.id,r));return rows}
// How many people are actually at the table: the guest count, but never fewer than
// the highest seat already carrying an item.
function seatCount(){return Math.max(guestCount(),maxKnownSeat(),openedSeats,currentSeat)}
async function loadSeatSetting(){
  try{
    if(!restaurantId){const r=await rest('restaurants?select=id&order=created_at.asc&limit=1');restaurantId=r?.[0]?.id||null}
    if(!restaurantId||settingsLoadedFor===restaurantId)return;
    const rows=await rest(`app_settings?restaurant_id=eq.${restaurantId}&select=seat_tracking_enabled&limit=1`);
    if(rows&&rows.length){seatEnabled=rows[0].seat_tracking_enabled!==false;settingsLoadedFor=restaurantId}
  }catch{}
}
function teardownSeatUi(){
  $('#pivotSeatBar')?.remove();$('#payPivotBar')?.remove();$('#pivotPrintAll')?.remove();
  $$('.pivot-separator').forEach(x=>x.remove());
  $$('.pivot-row-seat, .pivot-row-share').forEach(x=>x.remove());
}
function ensureSeatSettingCard(){
  const grid=$('#settingsScreen .settings-grid');
  if(!grid||$('#seatTrackingSettings'))return;
  const card=document.createElement('section');
  card.className='settings-card';card.id='seatTrackingSettings';
  card.innerHTML='<h2>Places à table</h2><p class="muted">Activé : le serveur choisit la place avant d\'entrer les plats, et vous savez qui a commandé quoi. Désactivé : toute la table sur une seule addition, sans étape supplémentaire.</p><label class="switch-row"><span>Suivre les places à table</span><input id="seatTrackingToggle" type="checkbox"></label>';
  grid.append(card);
  $('#seatTrackingToggle').onchange=async e=>{
    const next=e.target.checked;
    try{
      if(!restaurantId)throw new Error('Restaurant introuvable');
      await rest(`app_settings?restaurant_id=eq.${restaurantId}`,{method:'PATCH',body:{seat_tracking_enabled:next}});
      seatEnabled=next;
      if(!seatEnabled)teardownSeatUi();
      scheduleRefresh();
      toast(next?'Suivi des places activé':'Suivi des places désactivé');
    }catch(err){e.target.checked=!next;toast(err.message,'error')}
  };
}
function shareSize(item){return item?.share_group_id?[...seatCache.values()].filter(x=>x.share_group_id===item.share_group_id).length:0}
function maxKnownSeat(){return Math.max(1,...[...seatCache.values()].map(x=>Number(x.seat_number||1)))}

// Lives in the ticket dock, right above the items, so the client control sits
// where the server is already looking instead of across the screen.
function ensureSeatBar(){const anchor=$('#ticketList');if(!anchor)return null;let bar=$('#pivotSeatBar');if(!bar){bar=document.createElement('div');bar.id='pivotSeatBar';bar.className='pivot-seat-bar';anchor.before(bar)}return bar}
// Seats laid out around the table so the server can see at a glance who ordered
// what, instead of reading a flat list of labels.
function renderSeatBar(){
  const bar=ensureSeatBar();if(!bar)return;
  const count=seatCount();if(currentSeat>count)currentSeat=count;
  const sharing=!!pendingShare;
  if(sharing){
    // Picking who shares one dish: plain pills, same language as the rest of the app.
    const pills=Array.from({length:count},(_,i)=>i+1).map(n=>
      `<button type="button" class="pivot-pill ${shareSeats.has(n)?'active':''}" data-seat-pick="${n}">Place ${n}</button>`).join('');
    bar.innerHTML=`<div class="pivot-share"><div class="pivot-share-title">Partager « ${esc(seatCache.get(pendingShare)?.name||'')} » entre :</div><div class="pivot-pills">${pills}</div><div class="pivot-share-actions"><button type="button" class="btn primary small" data-share-confirm>Partager (${shareSeats.size})</button><button type="button" class="btn small" data-share-cancel>Annuler</button></div></div>`;
  }else{
    bar.innerHTML=`<div class="pivot-now"><span class="pivot-chip">Place ${currentSeat}</span><button type="button" class="pivot-link" data-next-seat>Client suivant →</button></div>`;
  }
  bar.querySelectorAll('[data-seat-pick]').forEach(b=>b.onclick=()=>{
    const n=Number(b.dataset.seatPick);
    shareSeats.has(n)?shareSeats.delete(n):shareSeats.add(n);renderSeatBar();
  });
  // Sequential flow: one tap opens the next person, nothing already entered moves.
  bar.querySelector('[data-next-seat]')?.addEventListener('click',()=>{currentSeat+=1;openedSeats=Math.max(openedSeats,currentSeat);renderSeatBar();refreshOrderPivots().catch(()=>{})});
  bar.querySelector('[data-share-cancel]')?.addEventListener('click',()=>{pendingShare=null;shareSeats.clear();renderSeatBar();refreshOrderPivots()});
  bar.querySelector('[data-share-confirm]')?.addEventListener('click',()=>confirmShare().catch(e=>toast(e.message,'error')));
}
function esc(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
async function confirmShare(){
  if(!pendingShare)return;
  if(shareSeats.size<2)throw new Error('Choisissez au moins deux places');
  const id=pendingShare,seats=[...shareSeats].sort((a,b)=>a-b);
  pendingShare=null;shareSeats.clear();
  await rest('rpc/split_order_item',{method:'POST',body:{p_order_item_id:id,p_seats:seats}});
  seatCache.delete(id);
  toast(`Article partagé entre ${seats.length} places`);
  window.dispatchEvent(new CustomEvent('simplepos-reload'));
  scheduleRefresh();
}

async function assignSeat(itemId){const item=seatCache.get(itemId);if(!item)return;const max=Math.max(guestCount(),maxKnownSeat());const raw=prompt(`Attribuer ${item.name} à quelle place?`,String(item.seat_number||1));if(raw===null)return;const seat=Number(raw);if(!Number.isInteger(seat)||seat<1||seat>Math.max(99,max)){toast('Numéro de place invalide','error');return}await rest(`order_items?id=eq.${itemId}`,{method:'PATCH',body:{seat_number:seat}});item.seat_number=seat;currentSeat=seat;await refreshOrderPivots();toast(`Article déplacé à la place ${seat}`)}

function separatorFor(seat,count){const sep=document.createElement('div');sep.className='pivot-separator'+(count?'':' empty');sep.dataset.seat=String(seat);
  // An empty seat gets no print button: there is nothing to bill yet.
  sep.innerHTML=`<div><strong>Place ${seat}</strong><span>${count?`${count} article${count>1?'s':''}`:'en attente'}</span></div>${count?'<button class="pivot-print" type="button">Imprimer l’addition</button>':''}`;
  sep.querySelector('.pivot-print')?.addEventListener('click',()=>printSeatAddition(seat).catch(e=>toast(e.message,'error')));
  return sep}
// Decorating is split from loading so the ticket never flickers: we redraw from
// what we already know first, and only wait on the network for items we have
// genuinely never seen.
function decorateTicket(host,rows){
  rows.forEach(r=>r.querySelectorAll('.pivot-row-seat, .pivot-row-share').forEach(x=>x.remove()));
  host.querySelectorAll('.pivot-separator').forEach(x=>x.remove());
  // The ticket stays in the order the server entered it. We only slip a separator
  // in where the client changes, so nothing already on screen moves. A client who
  // orders again later gets a second heading, counting only that run of dishes.
  const seatOf=r=>Number(seatCache.get(r.querySelector('[data-remove]')?.dataset.remove)?.seat_number||1);
  const runLength=new Map();
  rows.forEach((r,i)=>{if(i===0||seatOf(r)!==seatOf(rows[i-1])){let n=0;for(let j=i;j<rows.length&&seatOf(rows[j])===seatOf(r);j++)n++;runLength.set(i,n)}});
  let lastSeat=null;
  rows.forEach((row,i)=>{
    const id=row.querySelector('[data-remove]')?.dataset.remove,item=seatCache.get(id),seat=Number(item?.seat_number||1);
    if(seat!==lastSeat){host.insertBefore(separatorFor(seat,runLength.get(i)||1),row);lastSeat=seat}
    const n=shareSize(item);
    const badge=document.createElement('button');badge.type='button';badge.className='pivot-row-seat';
    badge.textContent=n?`P${seat} · 1/${n}`:`P${seat}`;
    badge.title=n?`Part partagée entre ${n} places`:'Changer de place';
    badge.onclick=e=>{e.stopPropagation();assignSeat(id).catch(err=>toast(err.message,'error'))};
    row.insertBefore(badge,row.querySelector('[data-remove]'));
    // Only a whole, unpaid, not-yet-shared item can be split further.
    if(!n&&item&&Number(item.paid_quantity||0)===0){
      const sh=document.createElement('button');sh.type='button';sh.className='pivot-row-share';sh.textContent='⇄';
      sh.title='Partager entre plusieurs places';
      sh.onclick=e=>{e.stopPropagation();pendingShare=id;shareSeats.clear();shareSeats.add(seat);renderSeatBar()};
      row.insertBefore(sh,row.querySelector('[data-remove]'));
    }
  });
  // "Client suivant" has to show something straight away, otherwise the server
  // taps it and nothing happens until the first dish lands.
  if(lastSeat!==currentSeat)host.append(separatorFor(currentSeat,0));
}
async function refreshOrderPivots(){
  if(rendering)return;
  const host=$('#ticketList');
  if(!host||!$('#orderScreen')?.classList.contains('active'))return;
  await loadSeatSetting();
  if(!seatEnabled){teardownSeatUi();return}
  let rows=[...host.querySelectorAll('.ticket-row')];
  if(!rows.length){renderSeatBar();return}
  rendering=true;
  try{
    decorateTicket(host,rows);
    renderSeatBar();ensurePrintAllButton();
    const missing=rows.map(r=>r.querySelector('[data-remove]')?.dataset.remove).filter(id=>id&&!seatCache.has(id));
    if(!missing.length)return;
    await loadItems(missing);
    // app-v2 may have rebuilt #ticketList while we awaited, so re-read the DOM.
    rows=[...host.querySelectorAll('.ticket-row')];
    if(!rows.length)return;
    decorateTicket(host,rows);
    renderSeatBar();ensurePrintAllButton();
  }finally{rendering=false}}

function ensurePayPivotBar(){const items=$('#payItems');if(!items)return null;let bar=$('#payPivotBar');if(!bar){bar=document.createElement('div');bar.id='payPivotBar';bar.className='pay-pivot-bar';items.before(bar)}return bar}
async function setPaymentSelection(seat){let guard=0;const step=()=>{if(guard++>100)return;const rows=$$('#payItems [data-payitem]');if(!rows.length)return;let target=null;for(const row of rows){const id=row.dataset.payitem,selected=row.classList.contains('selected'),should=seat===null?false:Number(seatCache.get(id)?.seat_number||1)===seat;if(selected!==should){target=row;break}}if(target){target.click();setTimeout(step,0)}};step()}
async function refreshPayPivots(){const screen=$('#payScreen');if(!screen?.classList.contains('active'))return;await loadSeatSetting();if(!seatEnabled){$('#payPivotBar')?.remove();return}const ids=$$('#payItems [data-payitem]').map(x=>x.dataset.payitem).filter(Boolean);await loadItems(ids);const bar=ensurePayPivotBar();if(!bar)return;const seats=[...new Set(ids.map(id=>Number(seatCache.get(id)?.seat_number||1)))].sort((a,b)=>a-b);bar.innerHTML=`<span class="pivot-label">Qui paie?</span><button class="pivot-pay-choice" data-pay-seat="all">Toute la table</button>${seats.map(s=>`<button class="pivot-pay-choice" data-pay-seat="${s}">Place ${s}</button>`).join('')}<button class="pivot-pay-choice pivot-sep-btn" data-open-split>Séparer…</button>`;bar.querySelectorAll('[data-pay-seat]').forEach(b=>b.onclick=()=>{bar.querySelectorAll('.pivot-pay-choice').forEach(x=>x.classList.toggle('active',x===b));const v=b.dataset.paySeat;setPaymentSelection(v==='all'?null:Number(v))});bar.querySelector('[data-open-split]').onclick=()=>openSplitScreen()}

// "Separate at the end": assign items to people once the meal is over, for the
// server who did not use Client suivant during the order. It only writes
// seat_number; paying still goes through the normal per-seat selection, so no
// second fiscal path exists.
let splitDraft=null,splitBucket=1;
function openSplitScreen(){
  const ids=$$('#payItems [data-payitem]').map(x=>x.dataset.payitem).filter(Boolean);
  if(!ids.length){toast('Rien à séparer','error');return}
  splitDraft=new Map(ids.map(id=>[id,Number(seatCache.get(id)?.seat_number||1)]));
  splitBucket=1;
  renderSplitScreen();
}
function closeSplitScreen(){splitDraft=null;$('#pivotSplitModal')?.remove()}
function renderSplitScreen(){
  if(!splitDraft)return;
  let el=$('#pivotSplitModal');
  if(!el){el=document.createElement('div');el.id='pivotSplitModal';el.className='modal show';document.body.append(el);
    el.onclick=e=>{if(e.target===el)closeSplitScreen()};}
  const buckets=Math.max(splitBucket,...[...splitDraft.values()]);
  const totalFor=n=>[...splitDraft.entries()].filter(([,s])=>s===n)
    .reduce((sum,[id])=>{const it=seatCache.get(id);return sum+Number(it?.unit_price||0)*(Number(it?.quantity||1)-Number(it?.paid_quantity||0))},0);
  const tabs=Array.from({length:buckets},(_,i)=>i+1).map(n=>{
    const count=[...splitDraft.values()].filter(s=>s===n).length;
    return `<button type="button" class="pivot-pill ${n===splitBucket?'active':''}" data-bucket="${n}">Client ${n} · ${money(totalFor(n))}</button>`;
  }).join('');
  const rows=[...splitDraft.entries()].map(([id,seat])=>{
    const it=seatCache.get(id)||{};
    const qty=Number(it.quantity||1)-Number(it.paid_quantity||0);
    return `<button type="button" class="pivot-split-row ${seat===splitBucket?'mine':''}" data-split-item="${id}"><span class="pivot-split-name">${esc(it.name||'Article')}</span><span class="pivot-split-seat">C${seat}</span><span class="pivot-split-amt">${money(Number(it.unit_price||0)*qty)}</span></button>`;
  }).join('');
  el.innerHTML=`<div class="modal-card"><div class="modal-title-row"><div><span class="eyebrow">Paiement</span><h2>Séparer l'addition</h2><p class="muted">Choisissez un client, puis touchez ses articles.</p></div><button class="icon-btn" data-split-close>×</button></div>
    <div class="pivot-pills">${tabs}<button type="button" class="pivot-pill" data-bucket-add>+ Client</button></div>
    <div class="pivot-split-list">${rows}</div>
    <div class="button-row"><button class="btn primary" data-split-confirm>Confirmer</button><button class="btn" data-split-close>Annuler</button></div></div>`;
  el.querySelectorAll('[data-bucket]').forEach(b=>b.onclick=()=>{splitBucket=Number(b.dataset.bucket);renderSplitScreen()});
  el.querySelector('[data-bucket-add]').onclick=()=>{splitBucket=Math.max(splitBucket,...[...splitDraft.values()])+1;renderSplitScreen()};
  el.querySelectorAll('[data-split-item]').forEach(b=>b.onclick=()=>{splitDraft.set(b.dataset.splitItem,splitBucket);renderSplitScreen()});
  el.querySelectorAll('[data-split-close]').forEach(b=>b.onclick=closeSplitScreen);
  el.querySelector('[data-split-confirm]').onclick=()=>confirmSplitScreen().catch(e=>toast(e.message,'error'));
}
async function confirmSplitScreen(){
  if(!splitDraft)return;
  const changed=[...splitDraft.entries()].filter(([id,seat])=>Number(seatCache.get(id)?.seat_number||1)!==seat);
  for(const [id,seat] of changed){
    await rest(`order_items?id=eq.${id}`,{method:'PATCH',prefer:'return=minimal',body:{seat_number:seat}});
    const it=seatCache.get(id);if(it)it.seat_number=seat;
  }
  closeSplitScreen();
  toast(changed.length?`${changed.length} article${changed.length>1?'s':''} réassigné${changed.length>1?'s':''}`:'Aucun changement');
  window.dispatchEvent(new CustomEvent('simplepos-reload'));
  scheduleRefresh();
}
async function printSeatAddition(seat){const rows=[...seatCache.values()].filter(x=>Number(x.seat_number||1)===seat&&x.kitchen_status!=='cancelled'&&Number(x.paid_quantity||0)<Number(x.quantity||1));if(!rows.length)throw new Error(`Aucun article impayé pour la place ${seat}`);const orderId=rows[0].order_id;const orders=await rest(`orders?id=eq.${orderId}&select=id,restaurant_id,table_id,guest_count&limit=1`),order=orders?.[0];if(!order)throw new Error('Commande introuvable');const [settings,company,printer,tables]=await Promise.all([rest(`app_settings?restaurant_id=eq.${order.restaurant_id}&select=tax_gst,tax_qst&limit=1`),rest(`restaurants?id=eq.${order.restaurant_id}&select=name,legal_name,address,city,postal_code,phone,gst_number,qst_number&limit=1`),rest(`printers?restaurant_id=eq.${order.restaurant_id}&role=eq.receipt&enabled=eq.true&select=ip_address,port&limit=1`),rest(`restaurant_tables?id=eq.${order.table_id}&select=number,label&limit=1`)]);const p=printer?.[0];if(!p?.ip_address)throw new Error('Configure l’imprimante reçu dans Gestion');const cfg=settings?.[0]||{},biz=company?.[0]||{},table=tables?.[0]||{};const gstRate=Number(cfg.tax_gst??.05),qstRate=Number(cfg.tax_qst??.09975);const sub=Math.round(rows.reduce((s,i)=>s+Number(i.unit_price)*(Number(i.quantity)-Number(i.paid_quantity||0)),0)*100)/100,gst=Math.round(sub*gstRate*100)/100,qst=Math.round(sub*qstRate*100)/100,total=Math.round((sub+gst+qst)*100)/100;const addr=[biz.address,[biz.city,biz.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');const lines=[biz.legal_name||biz.name,addr||null,biz.phone||null,biz.gst_number?`TPS ${biz.gst_number}`:null,biz.qst_number?`TVQ ${biz.qst_number}`:null,'FACTURE ORIGINALE',table.label||`Table ${table.number}`,`PLACE ${seat}`,'',...rows.map(i=>{const n=shareSize(i);const qty=Number(i.quantity)-Number(i.paid_quantity||0);const amount=money(Number(i.unit_price)*qty);return n?`${i.name} (part 1/${n})  ${amount}`:`${qty} x ${i.name}  ${amount}`}),'',`Sous-total ${money(sub)}`,`TPS ${money(gst)}`,`TVQ ${money(qst)}`,`TOTAL ${money(total)}`,''].filter(x=>x!==null);const r=await fetch('/print',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip:p.ip_address,port:p.port||9100,text:lines.join('\n'),cut:true})});if(!r.ok)throw new Error('Imprimante reçu inaccessible');toast(`Addition place ${seat} imprimée`)}

// Sits with the other order actions, and only appears once more than one person
// actually has something on the table.
function ensurePrintAllButton(){
  const host=$('#orderScreen .dock-actions');if(!host)return;
  const seats=new Set([...seatCache.values()]
    .filter(x=>x.kitchen_status!=='cancelled'&&Number(x.paid_quantity||0)<Number(x.quantity||1))
    .map(x=>Number(x.seat_number||1)));
  let b=$('#pivotPrintAll');
  if(seats.size<2){b?.remove();return}
  if(!b){b=document.createElement('button');b.id='pivotPrintAll';b.type='button';b.className='btn';b.onclick=()=>printAllSeatAdditions().catch(e=>toast(e.message,'error'));host.append(b)}
  b.textContent=`Imprimer les ${seats.size} additions`;
}
// One bill per person, printed in order. Failures are reported per seat rather
// than aborting the run, so one dead printer does not cost you the other bills.
async function printAllSeatAdditions(){
  const seats=[...new Set([...seatCache.values()]
    .filter(x=>x.kitchen_status!=='cancelled'&&Number(x.paid_quantity||0)<Number(x.quantity||1))
    .map(x=>Number(x.seat_number||1)))].sort((a,b)=>a-b);
  if(!seats.length)throw new Error('Aucun article impayé à imprimer');
  const failed=[];
  for(const s of seats){
    try{await printSeatAddition(s)}catch(e){failed.push(`place ${s}`)}
    await new Promise(r=>setTimeout(r,250));
  }
  toast(failed.length?`Imprimé, sauf ${failed.join(', ')}`:`${seats.length} addition${seats.length>1?'s':''} imprimée${seats.length>1?'s':''}`,failed.length?'error':'ok');
}
function scheduleRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{refreshOrderPivots().catch(()=>{});refreshPayPivots().catch(()=>{})},80)}
function injectStyles(){if($('#pivotStyles'))return;const style=document.createElement('style');style.id='pivotStyles';style.textContent=`
.pivot-seat-bar{display:block;padding:0 0 10px}
.pivot-now{display:flex;align-items:center;justify-content:space-between;gap:10px}
.pivot-chip{background:#f0ecff;color:#4f13ff;border-radius:999px;padding:6px 12px;font-size:12px;font-weight:850}
.pivot-link{border:0;background:transparent;color:#4f13ff;font-size:12px;font-weight:800;padding:6px 0;white-space:nowrap}
.pivot-share{background:var(--soft,#f7f7f8);border-radius:12px;padding:12px}
.pivot-share-title{font-size:12px;font-weight:800;color:#3f4249;margin-bottom:8px}
.pivot-pills{display:flex;gap:7px;flex-wrap:wrap}
.pivot-pill{border:1px solid #d7d7de;background:#fff;border-radius:999px;padding:7px 12px;font-size:12px;font-weight:750}
.pivot-pill.active{background:#4f13ff;border-color:#4f13ff;color:#fff}
.pivot-share-actions{display:flex;gap:8px;margin-top:10px}
.pivot-row-share{border:0;background:#f1edff;color:#4f13ff;border-radius:999px;padding:5px 8px;font-size:12px;font-weight:850;margin-left:4px}
.pivot-sep-btn{color:#4f13ff;font-weight:850}
.pivot-split-list{display:grid;gap:6px;margin-top:12px;max-height:46vh;overflow:auto}
.pivot-split-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:10px;width:100%;text-align:left;border:1px solid var(--line,#e4e4e7);background:#fff;border-radius:10px;padding:11px 12px}
.pivot-split-row.mine{border-color:#c9bfff;background:#f8f6ff}
.pivot-split-name{font-weight:750;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pivot-split-seat{background:#f0ecff;color:#4f13ff;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:850}
.pivot-split-amt{font-weight:750;font-variant-numeric:tabular-nums}
.pay-pivot-bar{display:flex;gap:8px;align-items:center;overflow:auto;padding:4px 0 14px;margin-bottom:2px}.pivot-label{font-size:12px;font-weight:800;color:#777b85}.pivot-seat,.pivot-pay-choice{border:1px solid #e2e2e7;background:#fff;border-radius:999px;padding:9px 14px;font-weight:750;white-space:nowrap}.pivot-seat.active,.pivot-pay-choice.active{background:#202126;color:#fff;border-color:#202126}.pivot-seat.add-seat{color:#4f13ff}.pivot-separator{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 2px 7px;margin-top:10px;border-top:1px solid #e8e8eb}.pivot-separator:first-child{margin-top:0;border-top:0}.pivot-separator.empty strong{color:#777b85}.pivot-separator.empty span{font-style:italic}.pivot-separator>div{display:flex;align-items:baseline;gap:8px}.pivot-separator span{font-size:11px;color:#777b85}.pivot-print{border:0;background:transparent;color:#4f13ff;font-size:12px;font-weight:800}.pivot-row-seat{border:0;background:#f1edff;color:#4f13ff;border-radius:999px;padding:5px 7px;font-size:10px;font-weight:850}.ticket-row{grid-template-columns:minmax(0,1fr) auto auto auto auto!important}.pay-pivot-bar{margin:6px 0 14px}@media(max-width:820px){.pivot-seat-bar,.pay-pivot-bar{padding-bottom:10px}.pivot-separator{align-items:flex-start}.pivot-print{padding-top:2px}}
`;document.head.append(style)}

function wire(){injectStyles();
  // The settings card lives here too so the whole seat feature stays in one file.
  new MutationObserver(()=>{if($('#settingsScreen')?.classList.contains('active')){loadSeatSetting().then(()=>{ensureSeatSettingCard();const t=$('#seatTrackingToggle');if(t)t.checked=seatEnabled})}}).observe(document.body,{attributes:true,attributeFilter:['class'],subtree:true});const observer=new MutationObserver(scheduleRefresh);['ticketList','payItems','guestButton'].forEach(id=>{const el=document.getElementById(id);if(el)observer.observe(el,{childList:true,subtree:true,characterData:true})});$$('.screen').forEach(s=>observer.observe(s,{attributes:true,attributeFilter:['class']}));document.addEventListener('click',e=>{if(e.target.closest('[data-product]'))setTimeout(scheduleRefresh,60);if(e.target.closest('#guestButton'))setTimeout(scheduleRefresh,80)});scheduleRefresh()}
if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',wire);else wire();

window.SimplePOSPivots={get currentSeat(){return currentSeat},setCurrentSeat(n){if(Number.isInteger(n)&&n>0){currentSeat=n;renderSeatBar()}},refresh:scheduleRefresh,openSplit:openSplitScreen};
