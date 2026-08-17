const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const money=n=>Number(n||0).toLocaleString('fr-CA',{style:'currency',currency:'CAD'});
const TAX={gst:.05,qst:.09975};
const state={active:false,tableId:null,seat:1,guestCount:3,category:'TOUS',selected:new Set(),items:[
{id:'i1',name:'Burger classique',price:21.75,seat:1,status:'sent'},
{id:'i2',name:'Bière blonde',price:8.5,seat:1,status:'sent'},
{id:'i3',name:'Tartare de boeuf',price:28.5,seat:2,status:'new'},
{id:'i4',name:'Vin rouge',price:12,seat:2,status:'new'},
{id:'i5',name:'Poutine maison',price:16.95,seat:3,status:'new'}
]};
const products=[
{id:'p1',name:'Burger classique',price:21.75,category:'PLATS'},
{id:'p2',name:'Tartare de boeuf',price:28.50,category:'PLATS'},
{id:'p3',name:'Poutine maison',price:16.95,category:'PLATS'},
{id:'p4',name:'Salade César',price:18.25,category:'PLATS'},
{id:'p5',name:'Bière blonde',price:8.50,category:'BOISSONS'},
{id:'p6',name:'Vin rouge',price:12.00,category:'VINS'},
{id:'p7',name:'Cola',price:4.95,category:'BOISSONS'},
{id:'p8',name:'Crème brûlée',price:9.50,category:'DESSERTS'}
];
const tables=[1,2,3,4,5,6,7,8].map(n=>({id:String(n),label:`Table ${n}`,open:[1,3,6].includes(n)}));
function tax(sub){const gst=Math.round(sub*TAX.gst*100)/100,qst=Math.round(sub*TAX.qst*100)/100;return{gst,qst,total:Math.round((sub+gst+qst)*100)/100}}
function toast(m){const e=$('#toast');if(!e)return;e.textContent=m;e.dataset.type='ok';e.classList.add('show');setTimeout(()=>e.classList.remove('show'),1800)}
function show(id){$$('.screen').forEach(s=>s.classList.toggle('active',s.id===id));const area=['tablesScreen','orderScreen','payScreen'].includes(id)?'pos':id==='dashboardScreen'?'dashboard':id==='reservationsScreen'?'reservations':'management';$$('.sidebar .nav[data-area]').forEach(b=>b.classList.toggle('active',b.dataset.area===area))}
function totalItems(items=state.items){const sub=items.reduce((s,i)=>s+i.price,0);return{sub,...tax(sub)}}
function renderTables(){
 $('#tablesGrid').innerHTML=tables.map(t=>`<button class="table-card ${t.open?'occupied':''}" data-demo-table="${t.id}"><div class="table-card-top"><strong>${t.label}</strong><span>${t.open?'En cours':'Libre'}</span></div>${t.open?`<div class="table-total">${money(t.id==='1'?100.82:t.id==='3'?126.40:47.90)}</div><div class="table-meta">${t.id==='1'?'3':t.id==='3'?'4':'2'} clients</div>`:'<div class="table-empty">Ouvrir la table</div>'}</button>`).join('');
 $('#openTablesCount').textContent='3';$('#openGuestsCount').textContent='9';$('#openSalesTotal').textContent=money(275.12);
}
function renderSeatBar(){
 let host=$('#demoSeatBar');if(!host){host=document.createElement('div');host.id='demoSeatBar';host.className='demo-seat-bar';$('#categories')?.parentElement?.before(host)}
 host.innerHTML=`<span class="demo-seat-label">Ajouter pour :</span>${Array.from({length:state.guestCount},(_,i)=>i+1).map(n=>`<button class="demo-seat ${state.seat===n?'active':''}" data-demo-seat="${n}">Place ${n}</button>`).join('')}<button class="demo-seat add" data-demo-add-seat>+</button>`;
}
function renderOrder(){
 $('#orderTableLabel').textContent=`Table ${state.tableId||1}`;$('#guestButton').textContent=`${state.guestCount} clients`;renderSeatBar();
 const cats=['TOUS','PLATS','BOISSONS','VINS','DESSERTS'];$('#categories').innerHTML=cats.map(c=>`<button class="category-tab ${state.category===c?'active':''}" data-demo-cat="${c}">${c}</button>`).join('');
 const list=state.category==='TOUS'?products:products.filter(p=>p.category===state.category);$('#products').innerHTML=list.map(p=>`<button class="product-card" data-demo-product="${p.id}"><span>${p.name}</span><strong>${money(p.price)}</strong></button>`).join('');
 const groups=Array.from({length:state.guestCount},(_,i)=>i+1).map(seat=>({seat,items:state.items.filter(x=>x.seat===seat)})).filter(g=>g.items.length);
 $('#ticketTitle').textContent='Commande en cours';$('#ticketMeta').textContent=`${state.items.length} articles · ${state.guestCount} places`;
 $('#ticketList').innerHTML=groups.map(g=>`<div class="demo-seat-group"><div class="demo-seat-divider"><strong>Place ${g.seat}</strong><button data-demo-print-seat="${g.seat}">Imprimer</button></div>${g.items.map(i=>`<div class="ticket-row"><div><strong>${i.name}</strong><span class="item-state ${i.status}">${i.status==='sent'?'Envoyé':'Nouveau'}</span><select data-demo-move="${i.id}" aria-label="Changer de place">${Array.from({length:state.guestCount},(_,k)=>k+1).map(n=>`<option value="${n}" ${n===i.seat?'selected':''}>Place ${n}</option>`).join('')}</select></div><span>${money(i.price)}</span><button class="icon-btn" data-demo-remove="${i.id}">×</button></div>`).join('')}</div>`).join('')||'<div class="empty-state small-empty">Touchez un article pour commencer.</div>';
 const t=totalItems();$('#ticketTotals').innerHTML=`<div class="total-line"><span>Sous-total</span><span>${money(t.sub)}</span></div><div class="total-line minor"><span>TPS</span><span>${money(t.gst)}</span></div><div class="total-line minor"><span>TVQ</span><span>${money(t.qst)}</span></div><div class="total-line grand"><span>Total</span><span>${money(t.total)}</span></div>`;
}
function renderPay(){
 $('#payTableLabel').textContent=`Table ${state.tableId||1}`;let host=$('#demoPaySeats');if(!host){host=document.createElement('div');host.id='demoPaySeats';host.className='demo-pay-seats';$('#payItems')?.before(host)}
 const seats=Array.from({length:state.guestCount},(_,i)=>i+1);host.innerHTML=`<button class="demo-pay-seat active" data-demo-pay-all>Toute la table</button>${seats.map(n=>`<button class="demo-pay-seat" data-demo-pay-seat="${n}">Place ${n}</button>`).join('')}`;
 $('#payItems').innerHTML=state.items.map(i=>`<button class="pay-row ${state.selected.has(i.id)?'selected':''}" data-demo-payitem="${i.id}"><span class="check">${state.selected.has(i.id)?'✓':''}</span><span><small>Place ${i.seat}</small><br>${i.name}</span><strong>${money(i.price)}</strong></button>`).join('');renderPaySummary();
}
function selectedItems(){return state.selected.size?state.items.filter(i=>state.selected.has(i.id)):state.items}
function renderPaySummary(){const t=totalItems(selectedItems());$('#selectedSummary').innerHTML=`<div class="selection-note">${state.selected.size?`${state.selected.size} article(s) sélectionné(s)`:'Toute la table'}</div>`;$('#payTotals').innerHTML=`<div class="total-line"><span>Sous-total</span><span>${money(t.sub)}</span></div><div class="total-line minor"><span>TPS</span><span>${money(t.gst)}</span></div><div class="total-line minor"><span>TVQ</span><span>${money(t.qst)}</span></div><div class="total-line grand"><span>Total</span><span>${money(t.total)}</span></div>`;$('#baseDue').textContent=money(t.total)}
function renderDashboard(){const sales=4826.35,expenses=3190.20;$('#dashMetrics').innerHTML=`<div class="metric"><span>Ventes</span><strong>${money(sales)}</strong></div><div class="metric"><span>Dépenses</span><strong>${money(expenses)}</strong></div><div class="metric"><span>Résultat</span><strong>${money(sales-expenses)}</strong></div><div class="metric"><span>Ticket moyen</span><strong>${money(64.35)}</strong></div>`;$('#coverageCard').innerHTML=`<div><span class="eyebrow">Mode démo</span><h2>Dépenses couvertes à 100 %</h2><p class="muted">Données fictives, aucune incidence comptable.</p></div>`;$('#quickStats').innerHTML='<div class="biz-row"><div><strong>75 transactions</strong><span>32 clients connus</span></div></div>';$('#popularProducts').innerHTML='<div class="biz-row"><div><strong>Burger classique</strong><span>41 vendus</span></div></div><div class="biz-row"><div><strong>Poutine maison</strong><span>36 vendues</span></div></div>';$('#expenseHighlights').innerHTML='<div class="biz-row"><div><strong>Loyer</strong><span>2 100 $</span></div></div><div class="biz-row"><div><strong>Hydro</strong><span>490 $</span></div></div>';$('#customerStats').innerHTML='<div class="biz-row"><div><strong>Client démo A</strong><span>8 visites · 612 $</span></div></div>'}
function renderReservations(){const h=$('#reservationList');if(h)h.innerHTML='<div class="biz-row"><div><strong>18:30 · Marie Tremblay</strong><span>4 personnes · Table 3</span></div><strong>Confirmée</strong></div><div class="biz-row"><div><strong>19:15 · Alex Roy</strong><span>2 personnes · À assigner</span></div><strong>Confirmée</strong></div>';const s=$('#reservationTodaySummary');if(s)s.innerHTML='<div><span>Réservations</span><strong>7</strong></div><div><span>Couverts</span><strong>22</strong></div>'}
function enterDemo(){state.active=true;window.SIMPLEPOS_DEMO=true;$('#authScreen').classList.add('hidden');$('#app').classList.remove('hidden');$('#restaurantName').textContent='Bistro Démo';$('#connectionLabel').textContent='Mode démo';$('#liveDot')?.classList.remove('down');document.body.classList.add('demo-mode');let badge=$('#demoBadge');if(!badge){badge=document.createElement('div');badge.id='demoBadge';badge.className='demo-badge';badge.textContent='DÉMO · aucune donnée réelle';$('.topbar')?.append(badge)}renderTables();renderDashboard();renderReservations();show('tablesScreen')}
function leaveDemo(){location.reload()}
function addButton(){const form=$('#authForm');if(!form||$('#demoModeBtn'))return;const b=document.createElement('button');b.type='button';b.id='demoModeBtn';b.className='btn demo-entry full';b.textContent='Essayer le mode démo';b.onclick=enterDemo;form.insertBefore(b,$('#authError'));const p=document.createElement('p');p.className='demo-entry-note';p.textContent='Aucun compte requis · données fictives · aucun paiement ou envoi MEV réel';form.insertBefore(p,$('#authError'))}
function handleClick(e){if(!state.active)return;const el=e.target.closest('button,[data-demo-move]');if(!el)return;
 const nav=e.target.closest('[data-nav]');if(nav){e.preventDefault();e.stopImmediatePropagation();const id=nav.dataset.nav;if(id==='tablesScreen')renderTables();if(id==='orderScreen')renderOrder();if(id==='payScreen')renderPay();if(id==='dashboardScreen')renderDashboard();if(id==='reservationsScreen')renderReservations();show(id);return}
 const area=e.target.closest('.sidebar .nav[data-area]');if(area){e.preventDefault();e.stopImmediatePropagation();const m={pos:'tablesScreen',dashboard:'dashboardScreen',reservations:'reservationsScreen',management:'settingsScreen'};show(m[area.dataset.area]);return}
 const t=e.target.closest('[data-demo-table]');if(t){e.preventDefault();e.stopImmediatePropagation();state.tableId=t.dataset.demoTable;renderOrder();show('orderScreen');return}
 const seat=e.target.closest('[data-demo-seat]');if(seat){e.preventDefault();e.stopImmediatePropagation();state.seat=Number(seat.dataset.demoSeat);renderOrder();return}
 if(e.target.closest('[data-demo-add-seat]')){e.preventDefault();e.stopImmediatePropagation();state.guestCount++;state.seat=state.guestCount;renderOrder();return}
 const cat=e.target.closest('[data-demo-cat]');if(cat){e.preventDefault();e.stopImmediatePropagation();state.category=cat.dataset.demoCat;renderOrder();return}
 const prod=e.target.closest('[data-demo-product]');if(prod){e.preventDefault();e.stopImmediatePropagation();const p=products.find(x=>x.id===prod.dataset.demoProduct);state.items.push({id:`d${Date.now()}`,name:p.name,price:p.price,seat:state.seat,status:'new'});renderOrder();return}
 const rem=e.target.closest('[data-demo-remove]');if(rem){e.preventDefault();e.stopImmediatePropagation();state.items=state.items.filter(i=>i.id!==rem.dataset.demoRemove);renderOrder();return}
 const ps=e.target.closest('[data-demo-print-seat]');if(ps){e.preventDefault();e.stopImmediatePropagation();toast(`Démo : addition Place ${ps.dataset.demoPrintSeat} prête à imprimer`);return}
 if(e.target.closest('#sendKitchen')){e.preventDefault();e.stopImmediatePropagation();state.items.forEach(i=>{if(i.status==='new')i.status='sent'});renderOrder();toast('Démo : ticket cuisine simulé');return}
 if(e.target.closest('#goPay')){e.preventDefault();e.stopImmediatePropagation();state.selected.clear();renderPay();show('payScreen');return}
 const pa=e.target.closest('[data-demo-pay-all]');if(pa){e.preventDefault();e.stopImmediatePropagation();state.selected.clear();renderPay();return}
 const pseat=e.target.closest('[data-demo-pay-seat]');if(pseat){e.preventDefault();e.stopImmediatePropagation();state.selected=new Set(state.items.filter(i=>i.seat===Number(pseat.dataset.demoPaySeat)).map(i=>i.id));renderPay();return}
 const pi=e.target.closest('[data-demo-payitem]');if(pi){e.preventDefault();e.stopImmediatePropagation();state.selected.has(pi.dataset.demoPayitem)?state.selected.delete(pi.dataset.demoPayitem):state.selected.add(pi.dataset.demoPayitem);renderPay();return}
 if(e.target.closest('#payCashBtn,#payCardBtn,#payOtherBtn,#payLeftBtn')){e.preventDefault();e.stopImmediatePropagation();toast('Démo : paiement simulé, aucune transaction créée');return}
 if(e.target.closest('#logoutBtn')){e.preventDefault();e.stopImmediatePropagation();leaveDemo();return}
}
function handleChange(e){if(!state.active)return;const m=e.target.closest('[data-demo-move]');if(!m)return;e.stopImmediatePropagation();const item=state.items.find(i=>i.id===m.dataset.demoMove);if(item){item.seat=Number(m.value);renderOrder()}}
function injectStyles(){const s=document.createElement('style');s.textContent=`.demo-entry{margin-top:8px;background:#f0ecff;color:#4f13ff;border:1px solid #dcd4ff}.demo-entry-note{text-align:center;font-size:11px;color:#7a7d86;margin:8px 0 0}.demo-badge{margin-left:auto;margin-right:14px;padding:6px 10px;border-radius:999px;background:#f0ecff;color:#4f13ff;font-size:11px;font-weight:800}.demo-seat-bar,.demo-pay-seats{display:flex;gap:8px;align-items:center;overflow:auto;margin:0 0 14px}.demo-seat,.demo-pay-seat{border:1px solid #e1e1e6;background:#fff;border-radius:999px;padding:9px 13px;font-weight:750;white-space:nowrap}.demo-seat.active,.demo-pay-seat.active{background:#202126;color:#fff}.demo-seat-label{font-size:12px;color:#737780;white-space:nowrap}.demo-seat-divider{display:flex;justify-content:space-between;align-items:center;padding:10px 2px 6px;border-bottom:1px solid #e7e7ea;margin-top:6px}.demo-seat-divider button{border:0;background:transparent;color:#4f13ff;font-size:12px;font-weight:750}.demo-seat-group select{display:block;margin-top:5px;border:0;background:#f4f4f5;border-radius:7px;padding:3px 6px;font-size:11px;color:#666}.demo-mode #savePrinters,.demo-mode #saveCompanyInfo,.demo-mode #generateReportBtn,.demo-mode #newProductBtn,.demo-mode #newReservation,.demo-mode #scanCost,.demo-mode #newCost{opacity:.45;pointer-events:none}`;document.head.append(s)}
injectStyles();document.addEventListener('click',handleClick,true);document.addEventListener('change',handleChange,true);if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',addButton);else addButton();
