const CFG = window.SIMPLEPOS_CONFIG || {};
const API = `${CFG.supabaseUrl}/rest/v1`;
const POLL_MS = 6000;
let demoMode = false;
let previewMode = false;
let restaurantId = null;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const money = n => Number(n || 0).toLocaleString('fr-CA',{style:'currency',currency:'CAD'});

function toast(message,type='ok'){const el=$('#toast');if(!el)return;el.textContent=message;el.dataset.type=type;el.classList.add('show');clearTimeout(el._demoTimer);el._demoTimer=setTimeout(()=>el.classList.remove('show'),2600)}
function session(){try{return JSON.parse(localStorage.getItem('simplepos-session')||'null')}catch{return null}}
function headers(){const s=session();return{apikey:CFG.supabasePublishableKey||'',Authorization:`Bearer ${s?.access_token||''}`,'Content-Type':'application/json'}}
async function rest(path,{method='GET',body}={}){
  const s=session();
  if(!s?.access_token)throw new Error('Non connecté');
  const r=await fetch(`${API}/${path}`,{method,headers:headers(),body:body===undefined?undefined:JSON.stringify(body)});
  const t=await r.text();const d=t?JSON.parse(t):null;
  if(!r.ok)throw new Error(d?.message||`Supabase ${r.status}`);
  return d;
}

function injectStyles(){
  if($('#demoModeStyles'))return;
  const style=document.createElement('style');
  style.id='demoModeStyles';
  style.textContent=`
.demo-banner{position:fixed;top:0;left:0;right:0;z-index:9998;background:#7c2d12;color:#fff;text-align:center;padding:6px 10px;font-weight:800;font-size:12px;letter-spacing:.03em}
.demo-print-overlay{position:fixed;inset:0;background:rgba(17,18,22,.5);display:none;place-items:center;z-index:9999;padding:20px}
.demo-print-overlay.show{display:grid}
.demo-print-card{background:#fff;border-radius:14px;max-width:360px;width:100%;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.demo-print-card h3{margin:0 0 10px;font-size:14px;color:#7c2d12}
.demo-print-card pre{white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px;background:#f7f7f8;border-radius:8px;padding:12px;max-height:50vh;overflow:auto;margin:0 0 12px}
.demo-print-card button{width:100%;border:0;background:#4f13ff;color:#fff;border-radius:10px;padding:10px;font-weight:750;cursor:pointer}
.demo-entry{margin-top:8px;background:#f0ecff!important;color:#4f13ff!important;border:1px solid #dcd4ff!important}
.demo-entry-note{text-align:center;font-size:11px;color:#7a7d86;margin:8px 0 0}
.preview-demo .topbar{padding-top:28px;height:auto;min-height:46px}
.preview-seat-bar,.preview-pay-seats{display:flex;gap:8px;align-items:center;overflow:auto;margin:0 0 14px}
.preview-seat,.preview-pay-seat{border:1px solid #e1e1e6;background:#fff;border-radius:999px;padding:9px 13px;font-weight:750;white-space:nowrap}
.preview-seat.active,.preview-pay-seat.active{background:#202126;color:#fff}
.preview-seat-label{font-size:12px;color:#737780;white-space:nowrap}
.preview-seat-divider{display:flex;justify-content:space-between;align-items:center;padding:10px 2px 6px;border-bottom:1px solid #e7e7ea;margin-top:6px}
.preview-seat-divider button{border:0;background:transparent;color:#4f13ff;font-size:12px;font-weight:750}
.preview-seat-group select{display:block;margin-top:5px;border:0;background:#f4f4f5;border-radius:7px;padding:3px 6px;font-size:11px;color:#666}
.preview-demo #savePrinters,.preview-demo #saveCompanyInfo,.preview-demo #generateReportBtn,.preview-demo #newProductBtn,.preview-demo #newReservation,.preview-demo #scanCost,.preview-demo #newCost{opacity:.45;pointer-events:none}
`;
  document.head.append(style);
}

function ensureOverlay(){
  let el=$('#demoPrintOverlay');
  if(!el){
    el=document.createElement('div');
    el.id='demoPrintOverlay';
    el.className='demo-print-overlay';
    el.innerHTML='<div class="demo-print-card"><h3>Impression simulée (mode démo)</h3><pre id="demoPrintText"></pre><button type="button" id="demoPrintClose">Fermer</button></div>';
    document.body.append(el);
    el.querySelector('#demoPrintClose').onclick=()=>el.classList.remove('show');
    el.onclick=e=>{if(e.target===el)el.classList.remove('show')};
  }
  return el;
}

function showSimulatedPrint(text){
  injectStyles();
  const el=ensureOverlay();
  el.querySelector('#demoPrintText').textContent=text||'';
  el.classList.add('show');
}

function ensureBanner(){
  injectStyles();
  let el=$('#demoModeBanner');
  if(!el){
    el=document.createElement('div');
    el.id='demoModeBanner';
    el.className='demo-banner';
    el.textContent='MODE DÉMO — impression simulée, aucune donnée réelle transmise';
    el.style.display='none';
    document.body.prepend(el);
  }
  return el;
}

function setBannerVisible(visible){ensureBanner().style.display=visible?'block':'none'}

async function currentRestaurantId(){
  if(restaurantId)return restaurantId;
  const rows=await rest('restaurants?select=id&order=created_at.asc&limit=1');
  restaurantId=rows?.[0]?.id||null;
  return restaurantId;
}

function ensureSettingsCard(){
  const grid=$('#settingsScreen .settings-grid');
  if(!grid||$('#demoModeSettings'))return;
  const card=document.createElement('section');
  card.className='settings-card';
  card.id='demoModeSettings';
  card.innerHTML='<h2>Mode démo</h2><p class="muted">Simule l\'impression à l\'écran pour tester tout le flux (commande, paiement, MEV, reçus) sans imprimante physique. Ne jamais activer pendant un vrai service.</p><label class="switch-row"><span>Activer le mode démo</span><input id="demoModeToggle" type="checkbox"></label>';
  grid.append(card);
  $('#demoModeToggle').onchange=async e=>{
    if(previewMode){e.target.checked=true;return}
    const next=e.target.checked;
    try{
      const rid=await currentRestaurantId();
      if(!rid)throw new Error('Restaurant introuvable');
      await rest(`app_settings?restaurant_id=eq.${rid}`,{method:'PATCH',body:{demo_mode:next}});
      demoMode=next;
      setBannerVisible(demoMode);
    }catch(err){
      e.target.checked=!next;
      toast(err.message,'error');
    }
  };
}

function syncToggleUi(){
  ensureSettingsCard();
  const toggle=$('#demoModeToggle');
  if(toggle)toggle.checked=previewMode||demoMode;
}

async function refreshDemoMode(){
  if(previewMode)return;
  try{
    const rid=await currentRestaurantId();
    if(!rid)return;
    const rows=await rest(`app_settings?restaurant_id=eq.${rid}&select=demo_mode&limit=1`);
    demoMode=!!rows?.[0]?.demo_mode;
    setBannerVisible(demoMode);
    if($('#settingsScreen')?.classList.contains('active'))syncToggleUi();
  }catch{}
}

const wrappedFetch=window.fetch.bind(window);
window.fetch=async(input,init={})=>{
  const url=typeof input==='string'?input:input?.url||'';
  const method=String(init?.method||'GET').toUpperCase();
  if((demoMode||previewMode)&&method==='POST'&&/^\/print(\?|$)/.test(url)){
    try{
      const body=init?.body?JSON.parse(init.body):{};
      showSimulatedPrint(body.text||'');
    }catch{}
    return new Response(JSON.stringify({demo:true,ok:true}),{status:200,headers:{'content-type':'application/json'}});
  }
  if(previewMode&&/\/rest\/v1|\/auth\/v1|mev/i.test(url)){
    return new Response(JSON.stringify({message:'Mode démo local: appel réseau bloqué'}),{status:418,headers:{'content-type':'application/json'}});
  }
  return wrappedFetch(input,init);
};

/* ---------- Démo locale avant connexion ---------- */
const preview={tableId:'1',seat:1,guestCount:3,category:'TOUS',selected:new Set(),items:[
  {id:'d1',name:'Burger classique',price:21.75,seat:1,status:'sent'},
  {id:'d2',name:'Bière blonde',price:8.50,seat:1,status:'sent'},
  {id:'d3',name:'Tartare de boeuf',price:28.50,seat:2,status:'new'},
  {id:'d4',name:'Vin rouge',price:12.00,seat:2,status:'new'},
  {id:'d5',name:'Poutine maison',price:16.95,seat:3,status:'new'}
]};
const previewProducts=[
  {id:'p1',name:'Burger classique',price:21.75,category:'PLATS'},
  {id:'p2',name:'Tartare de boeuf',price:28.50,category:'PLATS'},
  {id:'p3',name:'Poutine maison',price:16.95,category:'PLATS'},
  {id:'p4',name:'Salade César',price:18.25,category:'PLATS'},
  {id:'p5',name:'Bière blonde',price:8.50,category:'BOISSONS'},
  {id:'p6',name:'Vin rouge',price:12.00,category:'VINS'},
  {id:'p7',name:'Cola',price:4.95,category:'BOISSONS'},
  {id:'p8',name:'Crème brûlée',price:9.50,category:'DESSERTS'}
];
const previewTables=[1,2,3,4,5,6,7,8].map(n=>({id:String(n),label:`Table ${n}`,open:[1,3,6].includes(n)}));
function previewTax(sub){const gst=Math.round(sub*.05*100)/100,qst=Math.round(sub*.09975*100)/100;return{gst,qst,total:Math.round((sub+gst+qst)*100)/100}}
function previewTotals(items=preview.items){const sub=items.reduce((s,i)=>s+i.price,0);return{sub,...previewTax(sub)}}
function previewShow(id){$$('.screen').forEach(s=>s.classList.toggle('active',s.id===id));const area=['tablesScreen','orderScreen','payScreen'].includes(id)?'pos':id==='dashboardScreen'?'dashboard':id==='reservationsScreen'?'reservations':'management';$$('.sidebar .nav[data-area]').forEach(b=>b.classList.toggle('active',b.dataset.area===area))}
function previewRenderTables(){
  const grid=$('#tablesGrid');if(!grid)return;
  grid.innerHTML=previewTables.map(t=>`<button class="table-card ${t.open?'occupied':''}" data-preview-table="${t.id}"><div class="table-card-top"><strong>${t.label}</strong><span>${t.open?'En cours':'Libre'}</span></div>${t.open?`<div class="table-total">${money(t.id==='1'?100.82:t.id==='3'?126.40:47.90)}</div><div class="table-meta">${t.id==='1'?'3':t.id==='3'?'4':'2'} clients</div>`:'<div class="table-empty">Ouvrir la table</div>'}</button>`).join('');
  if($('#openTablesCount'))$('#openTablesCount').textContent='3';if($('#openGuestsCount'))$('#openGuestsCount').textContent='9';if($('#openSalesTotal'))$('#openSalesTotal').textContent=money(275.12);
}
function previewSeatBar(){
  let host=$('#previewSeatBar');if(!host){host=document.createElement('div');host.id='previewSeatBar';host.className='preview-seat-bar';$('#categories')?.parentElement?.before(host)}
  host.innerHTML=`<span class="preview-seat-label">Ajouter pour :</span>${Array.from({length:preview.guestCount},(_,i)=>i+1).map(n=>`<button class="preview-seat ${preview.seat===n?'active':''}" data-preview-seat="${n}">Place ${n}</button>`).join('')}<button class="preview-seat" data-preview-add-seat>+</button>`;
}
function previewRenderOrder(){
  if($('#orderTableLabel'))$('#orderTableLabel').textContent=`Table ${preview.tableId}`;if($('#guestButton'))$('#guestButton').textContent=`${preview.guestCount} clients`;previewSeatBar();
  const cats=['TOUS','PLATS','BOISSONS','VINS','DESSERTS'];if($('#categories'))$('#categories').innerHTML=cats.map(c=>`<button class="category-tab ${preview.category===c?'active':''}" data-preview-cat="${c}">${c}</button>`).join('');
  const list=preview.category==='TOUS'?previewProducts:previewProducts.filter(p=>p.category===preview.category);if($('#products'))$('#products').innerHTML=list.map(p=>`<button class="product-card" data-preview-product="${p.id}"><span>${p.name}</span><strong>${money(p.price)}</strong></button>`).join('');
  const groups=Array.from({length:preview.guestCount},(_,i)=>i+1).map(seat=>({seat,items:preview.items.filter(x=>x.seat===seat)})).filter(g=>g.items.length);
  if($('#ticketTitle'))$('#ticketTitle').textContent='Commande en cours';if($('#ticketMeta'))$('#ticketMeta').textContent=`${preview.items.length} articles · ${preview.guestCount} places`;
  if($('#ticketList'))$('#ticketList').innerHTML=groups.map(g=>`<div class="preview-seat-group"><div class="preview-seat-divider"><strong>Place ${g.seat}</strong><button data-preview-print-seat="${g.seat}">Imprimer</button></div>${g.items.map(i=>`<div class="ticket-row"><div><strong>${i.name}</strong><span class="item-state ${i.status}">${i.status==='sent'?'Envoyé':'Nouveau'}</span><select data-preview-move="${i.id}">${Array.from({length:preview.guestCount},(_,k)=>k+1).map(n=>`<option value="${n}" ${n===i.seat?'selected':''}>Place ${n}</option>`).join('')}</select></div><span>${money(i.price)}</span><button class="icon-btn" data-preview-remove="${i.id}">×</button></div>`).join('')}</div>`).join('');
  const t=previewTotals();if($('#ticketTotals'))$('#ticketTotals').innerHTML=`<div class="total-line"><span>Sous-total</span><span>${money(t.sub)}</span></div><div class="total-line minor"><span>TPS</span><span>${money(t.gst)}</span></div><div class="total-line minor"><span>TVQ</span><span>${money(t.qst)}</span></div><div class="total-line grand"><span>Total</span><span>${money(t.total)}</span></div>`;
}
function previewSelected(){return preview.selected.size?preview.items.filter(i=>preview.selected.has(i.id)):preview.items}
function previewPaySummary(){const t=previewTotals(previewSelected());if($('#selectedSummary'))$('#selectedSummary').innerHTML=`<div class="selection-note">${preview.selected.size?`${preview.selected.size} article(s) sélectionné(s)`:'Toute la table'}</div>`;if($('#payTotals'))$('#payTotals').innerHTML=`<div class="total-line"><span>Sous-total</span><span>${money(t.sub)}</span></div><div class="total-line minor"><span>TPS</span><span>${money(t.gst)}</span></div><div class="total-line minor"><span>TVQ</span><span>${money(t.qst)}</span></div><div class="total-line grand"><span>Total</span><span>${money(t.total)}</span></div>`;if($('#baseDue'))$('#baseDue').textContent=money(t.total)}
function previewRenderPay(){
  if($('#payTableLabel'))$('#payTableLabel').textContent=`Table ${preview.tableId}`;let host=$('#previewPaySeats');if(!host){host=document.createElement('div');host.id='previewPaySeats';host.className='preview-pay-seats';$('#payItems')?.before(host)}
  host.innerHTML=`<button class="preview-pay-seat" data-preview-pay-all>Toute la table</button>${Array.from({length:preview.guestCount},(_,i)=>i+1).map(n=>`<button class="preview-pay-seat" data-preview-pay-seat="${n}">Place ${n}</button>`).join('')}`;
  if($('#payItems'))$('#payItems').innerHTML=preview.items.map(i=>`<button class="pay-row ${preview.selected.has(i.id)?'selected':''}" data-preview-payitem="${i.id}"><span class="check">${preview.selected.has(i.id)?'✓':''}</span><span><small>Place ${i.seat}</small><br>${i.name}</span><strong>${money(i.price)}</strong></button>`).join('');previewPaySummary();
}
function previewRenderDashboard(){if($('#dashMetrics'))$('#dashMetrics').innerHTML=`<div class="metric"><span>Ventes</span><strong>${money(4826.35)}</strong></div><div class="metric"><span>Dépenses</span><strong>${money(3190.20)}</strong></div><div class="metric"><span>Résultat</span><strong>${money(1636.15)}</strong></div><div class="metric"><span>Ticket moyen</span><strong>${money(64.35)}</strong></div>`;if($('#coverageCard'))$('#coverageCard').innerHTML='<div><span class="eyebrow">Mode démo</span><h2>Données fictives</h2><p class="muted">Aucune incidence comptable ou fiscale.</p></div>';if($('#popularProducts'))$('#popularProducts').innerHTML='<div class="biz-row"><div><strong>Burger classique</strong><span>41 vendus</span></div></div>';if($('#expenseHighlights'))$('#expenseHighlights').innerHTML='<div class="biz-row"><div><strong>Loyer</strong><span>2 100 $</span></div></div>';if($('#quickStats'))$('#quickStats').innerHTML='<div class="biz-row"><div><strong>75 transactions</strong><span>32 clients connus</span></div></div>'}
function previewRenderReservations(){if($('#reservationList'))$('#reservationList').innerHTML='<div class="biz-row"><div><strong>18:30 · Marie Tremblay</strong><span>4 personnes · Table 3</span></div><strong>Confirmée</strong></div><div class="biz-row"><div><strong>19:15 · Alex Roy</strong><span>2 personnes · À assigner</span></div><strong>Confirmée</strong></div>';if($('#reservationTodaySummary'))$('#reservationTodaySummary').innerHTML='<div><span>Réservations</span><strong>7</strong></div><div><span>Couverts</span><strong>22</strong></div>'}
function enterPreviewMode(){previewMode=true;demoMode=true;window.SIMPLEPOS_DEMO=true;document.body.classList.add('preview-demo');$('#authScreen')?.classList.add('hidden');$('#app')?.classList.remove('hidden');if($('#restaurantName'))$('#restaurantName').textContent='Bistro Démo';if($('#connectionLabel'))$('#connectionLabel').textContent='Mode démo local';setBannerVisible(true);ensureBanner().textContent='MODE DÉMO LOCAL — aucun compte, aucune écriture Supabase, aucun paiement ou envoi MEV réel';previewRenderTables();previewRenderDashboard();previewRenderReservations();previewShow('tablesScreen')}
function addPreLoginButton(){const form=$('#authForm');if(!form||$('#demoPreviewBtn'))return;const b=document.createElement('button');b.type='button';b.id='demoPreviewBtn';b.className='btn demo-entry full';b.textContent='Essayer le mode démo';b.onclick=enterPreviewMode;const err=$('#authError');form.insertBefore(b,err);const note=document.createElement('p');note.className='demo-entry-note';note.textContent='Aucun compte requis · données fictives · rien n’est envoyé';form.insertBefore(note,err)}
function previewClick(e){if(!previewMode)return;const target=e.target.closest('button,[data-preview-move]');if(!target)return;
  const nav=e.target.closest('[data-nav]');if(nav){e.preventDefault();e.stopImmediatePropagation();const id=nav.dataset.nav;if(id==='tablesScreen')previewRenderTables();if(id==='orderScreen')previewRenderOrder();if(id==='payScreen')previewRenderPay();if(id==='dashboardScreen')previewRenderDashboard();if(id==='reservationsScreen')previewRenderReservations();previewShow(id);return}
  const area=e.target.closest('.sidebar .nav[data-area]');if(area){e.preventDefault();e.stopImmediatePropagation();previewShow({pos:'tablesScreen',dashboard:'dashboardScreen',reservations:'reservationsScreen',management:'settingsScreen'}[area.dataset.area]);return}
  const table=e.target.closest('[data-preview-table]');if(table){e.preventDefault();e.stopImmediatePropagation();preview.tableId=table.dataset.previewTable;previewRenderOrder();previewShow('orderScreen');return}
  const seat=e.target.closest('[data-preview-seat]');if(seat){e.preventDefault();e.stopImmediatePropagation();preview.seat=Number(seat.dataset.previewSeat);previewRenderOrder();return}
  if(e.target.closest('[data-preview-add-seat]')){e.preventDefault();e.stopImmediatePropagation();preview.guestCount++;preview.seat=preview.guestCount;previewRenderOrder();return}
  const cat=e.target.closest('[data-preview-cat]');if(cat){e.preventDefault();e.stopImmediatePropagation();preview.category=cat.dataset.previewCat;previewRenderOrder();return}
  const prod=e.target.closest('[data-preview-product]');if(prod){e.preventDefault();e.stopImmediatePropagation();const p=previewProducts.find(x=>x.id===prod.dataset.previewProduct);preview.items.push({id:`demo-${Date.now()}`,name:p.name,price:p.price,seat:preview.seat,status:'new'});previewRenderOrder();return}
  const rem=e.target.closest('[data-preview-remove]');if(rem){e.preventDefault();e.stopImmediatePropagation();preview.items=preview.items.filter(i=>i.id!==rem.dataset.previewRemove);previewRenderOrder();return}
  const ps=e.target.closest('[data-preview-print-seat]');if(ps){e.preventDefault();e.stopImmediatePropagation();const items=preview.items.filter(i=>i.seat===Number(ps.dataset.previewPrintSeat));showSimulatedPrint(`FACTURE DÉMO\nTable ${preview.tableId} — Place ${ps.dataset.previewPrintSeat}\n\n${items.map(i=>`${i.name}  ${money(i.price)}`).join('\n')}\n\nSIMULATION — NON FISCALE`);return}
  if(e.target.closest('#sendKitchen')){e.preventDefault();e.stopImmediatePropagation();preview.items.forEach(i=>{if(i.status==='new')i.status='sent'});previewRenderOrder();showSimulatedPrint(`CUISINE DÉMO\nTable ${preview.tableId}\n${preview.items.map(i=>`Place ${i.seat} — ${i.name}`).join('\n')}`);return}
  if(e.target.closest('#goPay')){e.preventDefault();e.stopImmediatePropagation();preview.selected.clear();previewRenderPay();previewShow('payScreen');return}
  if(e.target.closest('[data-preview-pay-all]')){e.preventDefault();e.stopImmediatePropagation();preview.selected.clear();previewRenderPay();return}
  const pseat=e.target.closest('[data-preview-pay-seat]');if(pseat){e.preventDefault();e.stopImmediatePropagation();preview.selected=new Set(preview.items.filter(i=>i.seat===Number(pseat.dataset.previewPaySeat)).map(i=>i.id));previewRenderPay();return}
  const pi=e.target.closest('[data-preview-payitem]');if(pi){e.preventDefault();e.stopImmediatePropagation();preview.selected.has(pi.dataset.previewPayitem)?preview.selected.delete(pi.dataset.previewPayitem):preview.selected.add(pi.dataset.previewPayitem);previewRenderPay();return}
  if(e.target.closest('#payCashBtn,#payCardBtn,#payOtherBtn,#payLeftBtn')){e.preventDefault();e.stopImmediatePropagation();toast('Paiement simulé — aucune transaction créée');return}
  if(e.target.closest('#logoutBtn')){e.preventDefault();e.stopImmediatePropagation();location.reload();return}
}
function previewChange(e){if(!previewMode)return;const m=e.target.closest('[data-preview-move]');if(!m)return;e.stopImmediatePropagation();const item=preview.items.find(i=>i.id===m.dataset.previewMove);if(item){item.seat=Number(m.value);previewRenderOrder()}}

function tick(){refreshDemoMode()}
function start(){
  injectStyles();
  ensureBanner();
  addPreLoginButton();
  tick();
  setInterval(tick,POLL_MS);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick()});
  document.addEventListener('click',previewClick,true);
  document.addEventListener('change',previewChange,true);
  new MutationObserver(()=>{if($('#settingsScreen')?.classList.contains('active'))syncToggleUi()}).observe(document.body,{attributes:true,attributeFilter:['class'],subtree:true});
}
if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',start);else start();
