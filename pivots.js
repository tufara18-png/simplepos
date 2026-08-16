const CFG=window.SIMPLEPOS_CONFIG||{};
const API=`${CFG.supabaseUrl}/rest/v1`;
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const seatCache=new Map();
let currentSeat=1,rendering=false,refreshTimer=null;

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
      if(/\/rest\/v1\/order_items(?:\?|$)/.test(url)){
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
async function loadItems(ids){if(!ids.length)return[];const unique=[...new Set(ids)];const rows=await rest(`order_items?id=in.(${unique.join(',')})&select=id,order_id,name,unit_price,quantity,paid_quantity,seat_number,kitchen_status`);rows.forEach(r=>seatCache.set(r.id,r));return rows}
function maxKnownSeat(){return Math.max(1,...[...seatCache.values()].map(x=>Number(x.seat_number||1)))}

function ensureSeatBar(){const screen=$('#orderScreen');const anchor=screen?.querySelector('.menu-search-row');if(!screen||!anchor)return null;let bar=$('#pivotSeatBar');if(!bar){bar=document.createElement('div');bar.id='pivotSeatBar';bar.className='pivot-seat-bar';anchor.before(bar)}return bar}
function renderSeatBar(){const bar=ensureSeatBar();if(!bar)return;const count=Math.max(guestCount(),maxKnownSeat());if(currentSeat>count)currentSeat=count;bar.innerHTML=`<span class="pivot-label">Ajouter pour</span>${Array.from({length:count},(_,i)=>i+1).map(n=>`<button class="pivot-seat ${n===currentSeat?'active':''}" data-pivot-seat="${n}">Place ${n}</button>`).join('')}<button class="pivot-seat add-seat" data-add-seat>+ Place</button>`;bar.querySelectorAll('[data-pivot-seat]').forEach(b=>b.onclick=()=>{currentSeat=Number(b.dataset.pivotSeat);renderSeatBar()});bar.querySelector('[data-add-seat]')?.addEventListener('click',()=>$('#guestButton')?.click())}

async function assignSeat(itemId){const item=seatCache.get(itemId);if(!item)return;const max=Math.max(guestCount(),maxKnownSeat());const raw=prompt(`Attribuer ${item.name} à quelle place?`,String(item.seat_number||1));if(raw===null)return;const seat=Number(raw);if(!Number.isInteger(seat)||seat<1||seat>Math.max(99,max)){toast('Numéro de place invalide','error');return}await rest(`order_items?id=eq.${itemId}`,{method:'PATCH',body:{seat_number:seat}});item.seat_number=seat;currentSeat=seat;await refreshOrderPivots();toast(`Article déplacé à la place ${seat}`)}

function separatorFor(seat,count){const sep=document.createElement('div');sep.className='pivot-separator';sep.dataset.seat=String(seat);sep.innerHTML=`<div><strong>Place ${seat}</strong><span>${count} article${count>1?'s':''}</span></div><button class="pivot-print" type="button">Imprimer l’addition</button>`;sep.querySelector('.pivot-print').onclick=()=>printSeatAddition(seat).catch(e=>toast(e.message,'error'));return sep}
async function refreshOrderPivots(){if(rendering)return;const host=$('#ticketList');if(!host||!$('#orderScreen')?.classList.contains('active'))return;const rows=[...host.querySelectorAll('.ticket-row')];if(!rows.length){renderSeatBar();return}rendering=true;try{
  const ids=rows.map(r=>r.querySelector('[data-remove]')?.dataset.remove).filter(Boolean);await loadItems(ids);
  rows.forEach(r=>r.querySelector('.pivot-row-seat')?.remove());
  host.querySelectorAll('.pivot-separator').forEach(x=>x.remove());
  const groups=new Map();
  rows.forEach(row=>{const id=row.querySelector('[data-remove]')?.dataset.remove,item=seatCache.get(id),seat=Number(item?.seat_number||1);if(!groups.has(seat))groups.set(seat,[]);groups.get(seat).push(row);const badge=document.createElement('button');badge.type='button';badge.className='pivot-row-seat';badge.textContent=`P${seat}`;badge.title='Changer de place';badge.onclick=e=>{e.stopPropagation();assignSeat(id).catch(err=>toast(err.message,'error'))};row.insertBefore(badge,row.querySelector('[data-remove]'))});
  const frag=document.createDocumentFragment();[...groups.entries()].sort((a,b)=>a[0]-b[0]).forEach(([seat,list])=>{frag.append(separatorFor(seat,list.length));list.forEach(r=>frag.append(r))});host.append(frag);renderSeatBar();
}finally{rendering=false}}

function ensurePayPivotBar(){const items=$('#payItems');if(!items)return null;let bar=$('#payPivotBar');if(!bar){bar=document.createElement('div');bar.id='payPivotBar';bar.className='pay-pivot-bar';items.before(bar)}return bar}
async function setPaymentSelection(seat){let guard=0;const step=()=>{if(guard++>100)return;const rows=$$('#payItems [data-payitem]');if(!rows.length)return;let target=null;for(const row of rows){const id=row.dataset.payitem,selected=row.classList.contains('selected'),should=seat===null?false:Number(seatCache.get(id)?.seat_number||1)===seat;if(selected!==should){target=row;break}}if(target){target.click();setTimeout(step,0)}};step()}
async function refreshPayPivots(){const screen=$('#payScreen');if(!screen?.classList.contains('active'))return;const ids=$$('#payItems [data-payitem]').map(x=>x.dataset.payitem).filter(Boolean);await loadItems(ids);const bar=ensurePayPivotBar();if(!bar)return;const seats=[...new Set(ids.map(id=>Number(seatCache.get(id)?.seat_number||1)))].sort((a,b)=>a-b);bar.innerHTML=`<span class="pivot-label">Qui paie?</span><button class="pivot-pay-choice" data-pay-seat="all">Toute la table</button>${seats.map(s=>`<button class="pivot-pay-choice" data-pay-seat="${s}">Place ${s}</button>`).join('')}`;bar.querySelectorAll('[data-pay-seat]').forEach(b=>b.onclick=()=>{bar.querySelectorAll('.pivot-pay-choice').forEach(x=>x.classList.toggle('active',x===b));const v=b.dataset.paySeat;setPaymentSelection(v==='all'?null:Number(v))})}

async function printSeatAddition(seat){const rows=[...seatCache.values()].filter(x=>Number(x.seat_number||1)===seat&&x.kitchen_status!=='cancelled'&&Number(x.paid_quantity||0)<Number(x.quantity||1));if(!rows.length)throw new Error(`Aucun article impayé pour la place ${seat}`);const orderId=rows[0].order_id;const orders=await rest(`orders?id=eq.${orderId}&select=id,restaurant_id,table_id,guest_count&limit=1`),order=orders?.[0];if(!order)throw new Error('Commande introuvable');const [settings,company,printer,tables]=await Promise.all([rest(`app_settings?restaurant_id=eq.${order.restaurant_id}&select=tax_gst,tax_qst&limit=1`),rest(`restaurants?id=eq.${order.restaurant_id}&select=name,legal_name,address,city,postal_code,phone,gst_number,qst_number&limit=1`),rest(`printers?restaurant_id=eq.${order.restaurant_id}&role=eq.receipt&enabled=eq.true&select=ip_address,port&limit=1`),rest(`restaurant_tables?id=eq.${order.table_id}&select=number,label&limit=1`)]);const p=printer?.[0];if(!p?.ip_address)throw new Error('Configure l’imprimante reçu dans Gestion');const cfg=settings?.[0]||{},biz=company?.[0]||{},table=tables?.[0]||{};const gstRate=Number(cfg.tax_gst??.05),qstRate=Number(cfg.tax_qst??.09975);const sub=Math.round(rows.reduce((s,i)=>s+Number(i.unit_price)*(Number(i.quantity)-Number(i.paid_quantity||0)),0)*100)/100,gst=Math.round(sub*gstRate*100)/100,qst=Math.round(sub*qstRate*100)/100,total=Math.round((sub+gst+qst)*100)/100;const addr=[biz.address,[biz.city,biz.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');const lines=[biz.legal_name||biz.name,addr||null,biz.phone||null,biz.gst_number?`TPS ${biz.gst_number}`:null,biz.qst_number?`TVQ ${biz.qst_number}`:null,'FACTURE ORIGINALE',table.label||`Table ${table.number}`,`PLACE ${seat}`,'',...rows.map(i=>`${Number(i.quantity)-Number(i.paid_quantity||0)} x ${i.name}  ${money(i.unit_price)}`),'',`Sous-total ${money(sub)}`,`TPS ${money(gst)}`,`TVQ ${money(qst)}`,`TOTAL ${money(total)}`,''].filter(x=>x!==null);const r=await fetch('/print',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip:p.ip_address,port:p.port||9100,text:lines.join('\n'),cut:true})});if(!r.ok)throw new Error('Imprimante reçu inaccessible');toast(`Addition place ${seat} imprimée`)}

function scheduleRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{refreshOrderPivots().catch(()=>{});refreshPayPivots().catch(()=>{})},80)}
function injectStyles(){if($('#pivotStyles'))return;const style=document.createElement('style');style.id='pivotStyles';style.textContent=`
.pivot-seat-bar,.pay-pivot-bar{display:flex;gap:8px;align-items:center;overflow:auto;padding:4px 0 14px;margin-bottom:2px}.pivot-label{font-size:12px;font-weight:800;color:#777b85;white-space:nowrap}.pivot-seat,.pivot-pay-choice{border:1px solid #e2e2e7;background:#fff;border-radius:999px;padding:9px 14px;font-weight:750;white-space:nowrap}.pivot-seat.active,.pivot-pay-choice.active{background:#202126;color:#fff;border-color:#202126}.pivot-seat.add-seat{color:#4f13ff}.pivot-separator{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 2px 7px;margin-top:10px;border-top:1px solid #e8e8eb}.pivot-separator:first-child{margin-top:0;border-top:0}.pivot-separator>div{display:flex;align-items:baseline;gap:8px}.pivot-separator span{font-size:11px;color:#777b85}.pivot-print{border:0;background:transparent;color:#4f13ff;font-size:12px;font-weight:800}.pivot-row-seat{border:0;background:#f1edff;color:#4f13ff;border-radius:999px;padding:5px 7px;font-size:10px;font-weight:850}.ticket-row{grid-template-columns:minmax(0,1fr) auto auto auto!important}.pay-pivot-bar{margin:6px 0 14px}@media(max-width:820px){.pivot-seat-bar,.pay-pivot-bar{padding-bottom:10px}.pivot-separator{align-items:flex-start}.pivot-print{padding-top:2px}}
`;document.head.append(style)}

function wire(){injectStyles();const observer=new MutationObserver(scheduleRefresh);['ticketList','payItems','guestButton'].forEach(id=>{const el=document.getElementById(id);if(el)observer.observe(el,{childList:true,subtree:true,characterData:true})});$$('.screen').forEach(s=>observer.observe(s,{attributes:true,attributeFilter:['class']}));document.addEventListener('click',e=>{if(e.target.closest('[data-product]'))setTimeout(scheduleRefresh,60);if(e.target.closest('#guestButton'))setTimeout(scheduleRefresh,80)});scheduleRefresh()}
if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',wire);else wire();

window.SimplePOSPivots={get currentSeat(){return currentSeat},setCurrentSeat(n){if(Number.isInteger(n)&&n>0){currentSeat=n;renderSeatBar()}},refresh:scheduleRefresh};
