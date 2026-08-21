const CFG=window.RESTO360_CONFIG||{};
const API=CFG.supabaseUrl?`${CFG.supabaseUrl}/rest/v1`:'';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const previousFetch=window.fetch.bind(window);
const OUTBOX_KEY='resto360-fiscal-document-outbox-v1';
const DEVICE_KEY='resto360-fiscal-device-id-v1';
const SEQUENCE_KEY='resto360-fiscal-local-sequences-v1';
let restaurantCache=null;
let syncing=false;
let nextPrintContext=null;
let decorateTimer=null;

function session(){try{return JSON.parse(localStorage.getItem('resto360-session')||'null')}catch{return null}}
function authHeaders(extra={}){const s=session();return{apikey:CFG.supabasePublishableKey||'',Authorization:`Bearer ${s?.access_token||''}`,'Content-Type':'application/json',...extra}}
function isDemo(){return window.RESTO360_DEMO===true||document.body.classList.contains('preview-demo')}
function safeJson(value,fallback){try{return JSON.parse(value)}catch{return fallback}}
function escapeHtml(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function money(n){return Number(n||0).toLocaleString('fr-CA',{style:'currency',currency:'CAD'})}
function toast(message,type='ok'){const el=$('#toast');if(!el)return;el.textContent=message;el.dataset.type=type;el.classList.add('show');clearTimeout(el._sw76Timer);el._sw76Timer=setTimeout(()=>el.classList.remove('show'),2800)}
function uuid(){return crypto.randomUUID()}
function todayKey(){const d=new Date();return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`}
function deviceId(){let id=localStorage.getItem(DEVICE_KEY);if(!id){id=uuid();localStorage.setItem(DEVICE_KEY,id)}return id}
function nextLocalReference(){const day=todayKey(),all=safeJson(localStorage.getItem(SEQUENCE_KEY)||'{}',{});const n=Number(all[day]||0)+1;all[day]=n;localStorage.setItem(SEQUENCE_KEY,JSON.stringify(all));const suffix=deviceId().replaceAll('-','').slice(-6).toUpperCase();return`SP-${day}-${suffix}-${String(n).padStart(5,'0')}`}
// A document waiting here has already been printed on paper. localStorage is
// evictable and capped, so the queue lives in IndexedDB under a persistent
// storage grant; an in-memory mirror keeps the call sites synchronous.
const IDB_NAME='resto360-fiscal-v1',IDB_STORE='outbox';
let outboxCache=[],outboxReady=false;
function idb(){return new Promise((resolve,reject)=>{const r=indexedDB.open(IDB_NAME,1);r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains(IDB_STORE))db.createObjectStore(IDB_STORE,{keyPath:'key'})};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function idbGet(){const db=await idb();return new Promise((resolve,reject)=>{const tx=db.transaction(IDB_STORE,'readonly'),q=tx.objectStore(IDB_STORE).get('queue');q.onsuccess=()=>resolve(q.result?.rows||null);q.onerror=()=>reject(q.error)})}
async function idbPut(rows){const db=await idb();return new Promise((resolve,reject)=>{const tx=db.transaction(IDB_STORE,'readwrite');tx.objectStore(IDB_STORE).put({key:'queue',rows});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)})}
async function initOutbox(){
  try{await navigator.storage?.persist?.()}catch{}
  let rows=null;
  try{rows=await idbGet()}catch{}
  if(!rows){
    // One-time migration of anything the previous localStorage queue still holds.
    rows=safeJson(localStorage.getItem(OUTBOX_KEY)||'[]',[]);
    try{await idbPut(rows);localStorage.removeItem(OUTBOX_KEY)}catch{}
  }
  // A document may have been printed while we were reading; merge instead of
  // overwriting, or that entry would be lost before it ever reached the ledger.
  const stored=Array.isArray(rows)?rows:[];
  const seen=new Set(outboxCache.map(x=>x.id));
  outboxCache=[...stored.filter(x=>!seen.has(x.id)),...outboxCache];
  outboxReady=true;
  void idbPut(outboxCache).catch(()=>{});
  updateStatusUi();
}
function outbox(){return outboxCache}
function saveOutbox(rows){outboxCache=Array.isArray(rows)?rows:[];void idbPut(outboxCache).catch(()=>{try{localStorage.setItem(OUTBOX_KEY,JSON.stringify(outboxCache))}catch{}});updateStatusUi()}

async function api(path,{method='GET',body,prefer='return=representation'}={}){
  const s=session();if(!API||!s?.access_token)throw new Error('Non connecté');
  const response=await previousFetch(`${API}/${path}`,{method,headers:authHeaders(prefer?{Prefer:prefer}:{}),body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();const data=text?safeJson(text,{message:text}):null;
  if(!response.ok)throw new Error(data?.message||data?.hint||`Supabase ${response.status}`);
  return data;
}
async function restaurant(){if(restaurantCache)return restaurantCache;const rows=await api('restaurants?select=*&order=created_at.asc&limit=1');restaurantCache=rows?.[0]||null;return restaurantCache}
async function logEvent(eventType,extra={}){try{const r=await restaurant();if(!r)return;await api('fiscal_events',{method:'POST',prefer:'return=minimal',body:{restaurant_id:r.id,event_type:eventType,created_by:session()?.user?.id||null,...extra}})}catch{}}

function inferDocumentType(text=''){
  const v=String(text).toUpperCase();
  if(v.includes('CUISINE')&&!v.includes('FACTURE'))return null;
  if(v.includes('REPRODUCTION DESTINÉE AU CLIENT')||v.includes('REPRODUCTION DESTINEE AU CLIENT'))return'customer_reproduction';
  if(v.includes('*** COPIE DU COMMERÇANT ***')||v.includes('*** COPIE DU COMMERCANT ***'))return'merchant_duplicate';
  if(v.includes('NOTE DE CRÉDIT')||v.includes('NOTE DE CREDIT'))return'credit_note';
  if(v.includes('COMMANDE ANNULÉE')||v.includes('COMMANDE ANNULEE'))return'order_cancellation';
  if(v.includes("RAPPORT DE L'UTILISATEUR")||v.includes('RAPPORT DE L’UTILISATEUR'))return'user_report';
  if(v.includes('FACTURE RÉVISÉE')||v.includes('FACTURE REVISEE'))return'addition_revised';
  if(v.includes('FACTURE ORIGINALE'))return'addition_original';
  if(v.includes('PAIEMENT REÇU')||v.includes('PAIEMENT RECU')||v.includes('PARTI SANS PAYER'))return'closing_receipt';
  return null;
}
function injectLocalReference(text,reference){if(String(text).includes(reference))return String(text);const note=`RÉFÉRENCE LOCALE ${reference}\nDOCUMENT NON CERTIFIÉ — TRANSPORT MEV OFFICIEL NON CONFIGURÉ`;
  const lines=String(text||'').split('\n');const heading=lines.findIndex(line=>/FACTURE|PAIEMENT|NOTE DE CR|COPIE DU COMMER|RAPPORT DE L|COMMANDE ANNUL|REPRODUCTION/i.test(line));
  lines.splice(heading>=0?heading+1:Math.min(1,lines.length),0,note);return lines.join('\n')}
function documentPayload({id,reference,type,text,context={}}){return{
  p_restaurant_id:context.restaurantId,
  p_local_document_id:id,
  p_local_reference:reference,
  p_document_type:type,
  p_invoice_id:context.invoiceId||null,
  p_order_id:context.orderId||null,
  p_replaces_document_id:context.replacesDocumentId||null,
  p_support:context.support||'paper',
  p_produced_offline:context.producedOffline??(!navigator.onLine||/PROBLÈME DE COMMUNICATION/i.test(text)),
  p_content_text:text,
  p_payload:{source:'print_interceptor',device_id:deviceId(),page:location.pathname,created_at:new Date().toISOString(),...context.payload}
}}
async function registerDocument(entry){
  const r=await restaurant();if(!r)throw new Error('Restaurant introuvable');
  entry.rpc.p_restaurant_id=r.id;
  const saved=await api('rpc/record_fiscal_document',{method:'POST',body:entry.rpc});
  const row=Array.isArray(saved)?saved[0]:saved;
  // The RPC answers an existing row when a reference collides. Two tabs share the
  // same device counter, so that can happen — and accepting the answer blindly
  // would drop a document that was really printed. Take a fresh reference and retry.
  if(row&&row.local_document_id!==entry.rpc.p_local_document_id){
    entry.rpc.p_local_reference=nextLocalReference();
    const retried=await api('rpc/record_fiscal_document',{method:'POST',body:entry.rpc});
    const retriedRow=Array.isArray(retried)?retried[0]:retried;
    if(retriedRow&&retriedRow.local_document_id!==entry.rpc.p_local_document_id)throw new Error('Référence locale en conflit, document non enregistré');
    return retriedRow;
  }
  return row;
}
function enqueue(entry){const rows=outbox();if(!rows.some(x=>x.id===entry.id))rows.push(entry);saveOutbox(rows)}
async function syncOutbox(){if(syncing||isDemo()||!navigator.onLine||!session()?.access_token)return;syncing=true;try{let rows=outbox();for(const entry of [...rows]){try{await registerDocument(entry);rows=rows.filter(x=>x.id!==entry.id);saveOutbox(rows)}catch(err){entry.attempts=Number(entry.attempts||0)+1;entry.last_error=String(err.message||err).slice(0,400);saveOutbox(rows);break}}}finally{syncing=false;updateStatusUi();loadLedger().catch(()=>{})}}

window.fetch=async function(input,init={}){
  const url=typeof input==='string'?input:input?.url||'';
  const method=String(init?.method||(typeof input!=='string'&&input?.method)||'GET').toUpperCase();
  const isLocalPrint=method==='POST'&&(/(^|\/)print(?:\?|$)/.test(url)||url==='/print');
  if(!isLocalPrint||!init?.body||isDemo())return previousFetch(input,init);
  let body;try{body=typeof init.body==='string'?JSON.parse(init.body):init.body}catch{return previousFetch(input,init)}
  const type=inferDocumentType(body?.text);if(!type)return previousFetch(input,init);
  const reference=nextLocalReference(),id=uuid(),context=nextPrintContext||{};nextPrintContext=null;
  const printedText=injectLocalReference(body.text,reference);const nextInit={...init,body:JSON.stringify({...body,text:printedText})};
  let response;
  try{response=await previousFetch(input,nextInit)}catch(err){await logEvent('print_error',{invoice_id:context.invoiceId||null,order_id:context.orderId||null,error_message:String(err.message||err),payload:{document_type:type,local_reference:reference}});throw err}
  if(!response.ok){await logEvent('print_error',{invoice_id:context.invoiceId||null,order_id:context.orderId||null,error_code:String(response.status),error_message:'Impression refusée',payload:{document_type:type,local_reference:reference}});return response}
  try{const r=await restaurant();const entry={id,reference,type,created_at:new Date().toISOString(),attempts:0,rpc:documentPayload({id,reference,type,text:printedText,context:{...context,restaurantId:r?.id||null}})};enqueue(entry);if(type==='customer_reproduction')void logEvent('customer_reproduction',{invoice_id:context.invoiceId||null,order_id:context.orderId||null,payload:{local_reference:reference}});void syncOutbox()}catch{}
  return response;
};

async function getReceiptPrinter(){const r=await restaurant();if(!r)return null;const rows=await api(`printers?restaurant_id=eq.${r.id}&role=eq.receipt&enabled=eq.true&select=ip_address,port&limit=1`);return rows?.[0]||null}
function companyLines(r){const address=[r.address,[r.city,r.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');return[r.legal_name||r.name,r.phone,address,r.gst_number?`TPS ${r.gst_number}`:null,r.qst_number?`TVQ ${r.qst_number}`:null].filter(Boolean)}
function paymentLabel(method){return{cash:'ARGENT COMPTANT',card:'CARTE',other:'AUTRE',left_without_paying:'PARTI SANS PAYER'}[method]||String(method||'PAIEMENT').toUpperCase()}
async function invoiceBundle(invoiceId){
  const [invoiceRows,itemRows,paymentRows,mevRows]=await Promise.all([
    api(`invoices?id=eq.${invoiceId}&select=*&limit=1`),
    api(`invoice_items?invoice_id=eq.${invoiceId}&select=*`),
    api(`payments?invoice_id=eq.${invoiceId}&select=*&order=created_at.asc`),
    api(`mev_transactions?invoice_id=eq.${invoiceId}&select=*&limit=1`).catch(()=>[])
  ]);
  const invoice=invoiceRows?.[0];if(!invoice)throw new Error('Facture introuvable');
  const ids=(itemRows||[]).map(x=>x.order_item_id).filter(Boolean);let source=[];
  if(ids.length)source=await api(`order_items?id=in.(${ids.join(',')})&select=id,name,notes,seat_number`);
  const byId=new Map((source||[]).map(x=>[x.id,x]));return{invoice,items:(itemRows||[]).map(x=>({...x,source:byId.get(x.order_item_id)})),payments:paymentRows||[],mev:mevRows?.[0]||null}
}
function buildCustomerReproduction(r,bundle){const{invoice,items,payments,mev}=bundle;const lines=[...companyLines(r),'REPRODUCTION DESTINÉE AU CLIENT','FORMAT LOCAL PROVISOIRE — NON CERTIFIÉ',`Facture d’origine ${invoice.invoice_number?`#${invoice.invoice_number}`:invoice.id.slice(0,8).toUpperCase()}`,`Date originale ${new Date(invoice.created_at).toLocaleString('fr-CA')}`,''];
  if(items.length){for(const row of items){const name=row.source?.name||'Article',precision=row.source?.notes,seat=row.seat_number||row.source?.seat_number;lines.push(`${Number(row.quantity)} x ${name}  ${money(row.line_total)} FP${seat?`  P${seat}`:''}`);if(precision)lines.push(`  ${precision}`)}}else lines.push('Paiement partiel sans ventilation par article');
  lines.push('',`SOUS-TOTAL ${money(invoice.subtotal)}`,r.gst_number?`TPS ${r.gst_number}  ${money(invoice.gst)}`:`TPS ${money(invoice.gst)}`,r.qst_number?`TVQ ${r.qst_number}  ${money(invoice.qst)}`:`TVQ ${money(invoice.qst)}`,`TOTAL ${money(invoice.total)}`);
  for(const p of payments)lines.push(paymentLabel(p.method),`Versement ${money(p.amount)}`);
  lines.push(Number(invoice.subtotal)<0?'NOTE DE CRÉDIT':'PAIEMENT REÇU');if(mev?.transaction_id)lines.push(`MEV ${mev.transaction_id}`);else lines.push('MEV OFFICIEL NON TRANSMIS');lines.push('');return lines.join('\n')}
async function printCustomerReproduction(invoiceId){const r=await restaurant(),printer=await getReceiptPrinter();if(!r)throw new Error('Restaurant introuvable');if(!printer?.ip_address)throw new Error('Configurez l’imprimante reçu dans Gestion');const bundle=await invoiceBundle(invoiceId),text=buildCustomerReproduction(r,bundle);nextPrintContext={invoiceId,orderId:bundle.invoice.order_id||null,payload:{source_invoice_number:bundle.invoice.invoice_number||null}};const response=await window.fetch('/print',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip:printer.ip_address,port:printer.port||9100,text,cut:true})});if(!response.ok)throw new Error('Imprimante reçu inaccessible');toast('Reproduction client imprimée')}

function decorateHistory(){const host=$('#historyList');if(!host)return;for(const row of host.querySelectorAll('.history-row')){const source=row.querySelector('[data-duplicata]');if(!source||row.querySelector('[data-reproduction]'))continue;const b=document.createElement('button');b.className='btn small';b.dataset.reproduction=source.dataset.duplicata;b.textContent='Reproduction client';source.insertAdjacentElement('afterend',b)}ensureLedgerPanel()}
function ensureLedgerPanel(){const history=$('#historyScreen .business-shell'),list=$('#historyList');if(!history||!list||$('#fiscalLedgerPanel'))return;const panel=document.createElement('section');panel.id='fiscalLedgerPanel';panel.className='biz-panel sw76-ledger';panel.innerHTML='<div class="panel-head"><div><h2>Documents fiscaux locaux</h2><p class="muted">Registre immuable préparatoire. Le transport officiel reste bloqué jusqu’au SW-73.</p></div><button class="btn small" id="refreshFiscalLedger">Actualiser</button></div><div id="fiscalLedgerList" class="sw76-list"><div class="muted">Chargement…</div></div>';list.insertAdjacentElement('afterend',panel);$('#refreshFiscalLedger').onclick=()=>loadLedger().catch(e=>toast(e.message,'error'));void loadLedger()}
async function loadLedger(){const host=$('#fiscalLedgerList');if(!host||!session()?.access_token)return;try{const rows=await api('fiscal_documents?select=id,civil_date,transaction_number,document_type,local_reference,official_status,produced_offline,created_at&order=created_at.desc&limit=30');host.innerHTML=(rows||[]).map(x=>`<div class="sw76-row"><div><strong>#${escapeHtml(x.transaction_number)} · ${escapeHtml(labelType(x.document_type))}</strong><span>${escapeHtml(x.local_reference)} · ${new Date(x.created_at).toLocaleString('fr-CA')}</span></div><span class="sw76-status">${x.produced_offline?'Hors ligne · ':''}${escapeHtml(x.official_status)}</span></div>`).join('')||'<div class="muted">Aucun document enregistré.</div>'}catch(err){host.innerHTML=`<div class="muted">Registre indisponible : ${escapeHtml(err.message)}</div>`}}
function labelType(type){return{addition_original:'Addition originale',addition_revised:'Addition révisée',closing_receipt:'Reçu de fermeture',credit_note:'Note de crédit',customer_reproduction:'Reproduction client',merchant_duplicate:'Duplicata marchand',order_cancellation:'Commande annulée',user_report:'Rapport utilisateur'}[type]||type}

async function fetchArchiveTable(name,query='select=*&limit=10000'){try{return await api(`${name}?${query}`)}catch(err){return{_error:err.message}}}
async function sha256(text){const bytes=new TextEncoder().encode(text),hash=await crypto.subtle.digest('SHA-256',bytes);return[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('')}
// A bare Android WebView (unlike a real browser tab) does not reliably save a blob: URL
// clicked via <a download> -- there is no "Downloads" affordance behind it. Route through
// the official Filesystem + Share plugins there instead; every other platform (iOS PWA,
// desktop browser) keeps the existing anchor-click behaviour untouched.
function androidFilesystem(){return window.Capacitor?.isNativePlatform?.()?window.Capacitor.Plugins?.Filesystem:null}
function androidShare(){return window.Capacitor?.isNativePlatform?.()?window.Capacitor.Plugins?.Share:null}
async function download(name,content,type){
  const fs=androidFilesystem(),share=androidShare();
  if(fs&&share){
    const written=await fs.writeFile({path:name,data:content,directory:'CACHE',encoding:'utf8'});
    await share.share({title:name,url:written.uri});
    return;
  }
  const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function exportFiscalArchive(){const r=await restaurant();if(!r)throw new Error('Restaurant introuvable');const names=['invoices','invoice_items','payments','fiscal_documents','fiscal_events','user_reports','mev_attempts','mev_transactions','mev_receipts','orders','order_items'];const values=await Promise.all(names.map(n=>fetchArchiveTable(n)));const data=Object.fromEntries(names.map((n,i)=>[n,values[i]]));const core={schema:'resto360-sw76-archive-v1',generated_at:new Date().toISOString(),restaurant:{id:r.id,name:r.name,legal_name:r.legal_name,gst_number:r.gst_number,qst_number:r.qst_number},data};const canonical=JSON.stringify(core),digest=await sha256(canonical),archive={manifest:{schema:core.schema,generated_at:core.generated_at,sha256_of_data:digest,algorithm:'SHA-256'},...core};await download(`resto360-archive-fiscale-${todayKey()}.json`,JSON.stringify(archive,null,2),'application/json');await logEvent('fiscal_archive_exported',{payload:{format:'json',sha256:digest}});toast('Archive fiscale JSON exportée')}
function csvCell(v){const s=v==null?'':typeof v==='object'?JSON.stringify(v):String(v);return`"${s.replaceAll('"','""')}"`}
async function exportFiscalCsv(){const rows=await api('fiscal_documents?select=*&order=civil_date.asc,transaction_number.asc&limit=10000');const cols=['civil_date','transaction_number','document_type','local_reference','invoice_id','order_id','support','produced_offline','official_status','content_sha256','created_at'];const csv=[cols.join(','),...(rows||[]).map(r=>cols.map(c=>csvCell(r[c])).join(','))].join('\r\n');await download(`resto360-documents-fiscaux-${todayKey()}.csv`,csv,'text/csv;charset=utf-8');await logEvent('fiscal_archive_exported',{payload:{format:'csv',rows:rows?.length||0}});toast('CSV fiscal exporté')}
function ensureSettingsCards(){const grid=$('#settingsScreen .settings-grid');if(!grid)return;if(!$('#sw76ArchiveSettings')){const card=document.createElement('section');card.className='settings-card';card.id='sw76ArchiveSettings';card.innerHTML='<h2>Archives fiscales locales</h2><p class="muted">Exporte les factures, paiements, journaux, documents et tentatives MEV dans un format intelligible. Conservez ces fichiers hors du POS.</p><div id="sw76LocalStatus" class="status-panel"></div><div class="button-row"><button class="btn primary" id="exportFiscalJson">Exporter JSON</button><button class="btn" id="exportFiscalCsv">Exporter CSV</button><button class="btn" id="syncFiscalDocs">Synchroniser le registre</button></div>';grid.append(card);$('#exportFiscalJson').onclick=()=>exportFiscalArchive().catch(e=>toast(e.message,'error'));$('#exportFiscalCsv').onclick=()=>exportFiscalCsv().catch(e=>toast(e.message,'error'));$('#syncFiscalDocs').onclick=()=>syncOutbox().catch(e=>toast(e.message,'error'))}
  if(!$('#sw76ReadinessSettings')){const card=document.createElement('section');card.className='settings-card';card.id='sw76ReadinessSettings';card.innerHTML='<h2>Préparation SW-76</h2><div class="sw76-checks"><div><strong>Actif</strong><span>Registre immuable, références locales, reproduction client, archives et journal d’erreurs d’impression.</span></div><div><strong>À compléter</strong><span>Certificats, comptes utilisateurs MEV, signature, JSON officiel, QR officiel et codes de retour. Ces éléments dépendent du SW-73.</span></div><div><strong>Statut</strong><span>Resto360 demeure non certifié et le mode production MEV doit rester verrouillé.</span></div></div>';grid.append(card)}updateStatusUi()}
function updateStatusUi(){const el=$('#sw76LocalStatus');if(!el)return;const pending=outbox().length;el.innerHTML=`<strong>Registre local</strong><span>${pending?`${pending} document${pending>1?'s':''} en attente de synchronisation`:'Aucun document local en attente'}</span>`}
function injectStyles(){if($('#sw76ReadinessStyles'))return;const style=document.createElement('style');style.id='sw76ReadinessStyles';style.textContent=`
.sw76-list{display:grid}.sw76-row{display:flex;justify-content:space-between;gap:14px;align-items:center;padding:11px 0;border-top:1px solid var(--line,#e5e7eb)}.sw76-row:first-child{border-top:0}.sw76-row strong,.sw76-row span{display:block}.sw76-row span{font-size:12px;color:var(--muted,#6b7280);margin-top:3px}.sw76-status{white-space:nowrap;text-align:right;font-weight:750}.sw76-checks{display:grid;gap:10px}.sw76-checks>div{padding:11px 0;border-top:1px solid var(--line,#e5e7eb)}.sw76-checks>div:first-child{border-top:0}.sw76-checks strong,.sw76-checks span{display:block}.sw76-checks span{font-size:13px;color:var(--muted,#6b7280);margin-top:4px;line-height:1.4}@media(max-width:700px){.sw76-row{align-items:flex-start;display:block}.sw76-status{text-align:left;margin-top:7px}}
`;document.head.append(style)}
function decorate(){decorateHistory();ensureSettingsCards()}
function scheduleDecorate(){clearTimeout(decorateTimer);decorateTimer=setTimeout(decorate,80)}
function start(){injectStyles();void initOutbox().then(()=>syncOutbox());document.addEventListener('click',e=>{const b=e.target.closest('[data-reproduction]');if(b){e.preventDefault();printCustomerReproduction(b.dataset.reproduction).catch(err=>toast(err.message,'error'))}},true);new MutationObserver(scheduleDecorate).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});window.addEventListener('online',()=>void syncOutbox());document.addEventListener('visibilitychange',()=>{if(!document.hidden)void syncOutbox()});setInterval(()=>void syncOutbox(),15000);decorate();void syncOutbox()}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();

export{inferDocumentType,injectLocalReference};
