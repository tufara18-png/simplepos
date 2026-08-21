const CFG=window.SIMPLEPOS_CONFIG||{};
const SUPABASE=CFG.supabaseUrl||'';
const REST_PREFIX=SUPABASE?`${SUPABASE}/rest/v1/`:'';
const DB_NAME='simplepos-local-v1';
const DB_VERSION=1;
const originalFetch=window.fetch.bind(window);
const idTables=new Set(['restaurants','restaurant_tables','products','orders','order_items','invoices','payments','printers','sync_events','mev_attempts','restaurant_sections','mev_devices','mev_transactions','mev_receipts']);
let replaying=false;

function openDb(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains('snapshots'))db.createObjectStore('snapshots',{keyPath:'key'});if(!db.objectStoreNames.contains('outbox'))db.createObjectStore('outbox',{keyPath:'id',autoIncrement:true});if(!db.objectStoreNames.contains('meta'))db.createObjectStore('meta',{keyPath:'key'})};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function storeGet(store,key){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readonly'),r=tx.objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function storePut(store,value){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite'),r=tx.objectStore(store).put(value);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function storeDelete(store,key){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite'),r=tx.objectStore(store).delete(key);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error)})}
async function storeAll(store){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readonly'),r=tx.objectStore(store).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error)})}
async function queueMutation(item){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction('outbox','readwrite'),r=tx.objectStore('outbox').add({...item,createdAt:new Date().toISOString(),attempts:0});r.onsuccess=()=>{dispatchStatus();resolve(r.result)};r.onerror=()=>reject(r.error)})}

const clone=x=>x==null?x:JSON.parse(JSON.stringify(x));
function tableFromUrl(url){if(!REST_PREFIX||!url.startsWith(REST_PREFIX))return null;return decodeURIComponent(url.slice(REST_PREFIX.length).split('?')[0])}
function parseJsonBody(body){if(body==null)return null;if(typeof body==='string'){try{return JSON.parse(body)}catch{return null}}return body}
function ensureIds(table,body){const add=row=>{if(row&&typeof row==='object'&&idTables.has(table)&&!row.id)row.id=crypto.randomUUID();return row};if(Array.isArray(body))return body.map(x=>add({...x}));return body&&typeof body==='object'?add({...body}):body}
function queryMatches(row,url){const u=new URL(url);for(const [key,value] of u.searchParams){if(['select','order','limit','offset'].includes(key))continue;if(value.startsWith('eq.')){const wanted=value.slice(3);if(String(row?.[key])!==wanted)return false}else if(value.startsWith('in.(')&&value.endsWith(')')){const vals=value.slice(4,-1).split(',').map(x=>x.replace(/^"|"$/g,''));if(!vals.includes(String(row?.[key])))return false}else if(value==='is.null'){if(row?.[key]!=null)return false}else if(value==='is.not.null'){if(row?.[key]==null)return false}}
return true}
function mutationMatches(row,url){return queryMatches(row,url)}
async function cacheSnapshot(url,data){await storePut('snapshots',{key:url,data:clone(data),updatedAt:new Date().toISOString()});await storePut('meta',{key:'primed',value:true,updatedAt:new Date().toISOString()})}
async function mutateSnapshots(table,url,method,body){const snaps=await storeAll('snapshots');for(const snap of snaps){if(tableFromUrl(snap.key)!==table||!Array.isArray(snap.data))continue;let rows=clone(snap.data);if(method==='POST'){const add=Array.isArray(body)?body:[body];for(const row of add.filter(Boolean)){if(queryMatches(row,snap.key)&&!rows.some(x=>row.id&&x.id===row.id))rows.push(clone(row))}}else if(method==='PATCH'){rows=rows.map(row=>mutationMatches(row,url)?{...row,...clone(body)}:row).filter(row=>queryMatches(row,snap.key))}else if(method==='DELETE'){rows=rows.filter(row=>!mutationMatches(row,url))}await cacheSnapshot(snap.key,rows)}}
function syntheticMutationResponse(method,body,url){let data;if(method==='POST')data=Array.isArray(body)?body:[body];else if(method==='PATCH')data=[{...(body||{}),id:new URL(url).searchParams.get('id')?.replace(/^eq\./,'')}];else data=[];return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json','x-simplepos-offline':'1'}})}
async function cachedGet(url){const snap=await storeGet('snapshots',url);if(!snap)return null;return new Response(JSON.stringify(snap.data),{status:200,headers:{'content-type':'application/json','x-simplepos-cache':'1'}})}
function currentAuthHeaders(prefer){const s=JSON.parse(localStorage.getItem('simplepos-session')||'null');const h={'Content-Type':'application/json',apikey:CFG.supabasePublishableKey||'',Authorization:`Bearer ${s?.access_token||CFG.supabasePublishableKey||''}`};if(prefer)h.Prefer=prefer;return h}
async function replayOutbox(){if(replaying||!navigator.onLine||!REST_PREFIX)return;replaying=true;try{const rows=(await storeAll('outbox')).sort((a,b)=>a.id-b.id);for(const item of rows){const r=await originalFetch(item.url,{method:item.method,headers:currentAuthHeaders(item.prefer),body:item.body==null?undefined:JSON.stringify(item.body)}).catch(()=>null);if(!r)break;if(r.ok){await storeDelete('outbox',item.id);continue}const text=await r.text().catch(()=>'');if(r.status===409&&item.method==='POST'&&item.body&&text.toLowerCase().includes('duplicate')){await storeDelete('outbox',item.id);continue}await storePut('outbox',{...item,attempts:Number(item.attempts||0)+1,lastError:`${r.status} ${text}`.slice(0,500)});break}}finally{replaying=false;dispatchStatus()}}
async function dispatchStatus(){const pending=(await storeAll('outbox').catch(()=>[])).length;const primed=!!(await storeGet('meta','primed').catch(()=>null));window.dispatchEvent(new CustomEvent('simplepos-local-status',{detail:{pending,primed,online:navigator.onLine}}))}
function bridgeBase(){return (localStorage.getItem('simplepos-bridge-url')||CFG.bridgeUrl||'').replace(/\/$/,'')}
function bridgeToken(){return localStorage.getItem('simplepos-bridge-token')||CFG.bridgeToken||''}

// Android (unlike Safari/WKWebView) can open a raw TCP socket, so the wrapped app talks to
// the printer directly and never needs server.mjs. iOS and any browser fall through to the
// existing bridge-URL / same-origin behaviour untouched below.
function androidPrinterPlugin(){return window.Capacitor?.isNativePlatform?.()?window.Capacitor.Plugins?.PrinterBridge:null}
async function nativePrint(body){
  const plugin=androidPrinterPlugin();
  try{
    const r=await plugin.printReceipt({ip:body.ip,port:body.port||9100,text:body.text,cut:body.cut!==false});
    return new Response(JSON.stringify({ok:true,ip:r.ip,port:r.port}),{status:200,headers:{'content-type':'application/json'}});
  }catch(e){
    return new Response(JSON.stringify({error:String(e?.message||e)}),{status:502,headers:{'content-type':'application/json'}});
  }
}
async function kickDrawer(ip,port=9100,pin=0){
  const plugin=androidPrinterPlugin();
  if(!plugin)throw new Error('Tiroir-caisse disponible seulement dans l’appli Android');
  return plugin.kickDrawer({ip,port,pin});
}
window.SimplePOSPrinter={kickDrawer,isAndroidNative:()=>!!androidPrinterPlugin()};

async function routedPrint(input,init={}){
  const plugin=androidPrinterPlugin();
  if(plugin){const body=parseJsonBody(init.body);if(body)return nativePrint(body)}
  const base=bridgeBase();if(!base)return originalFetch(input,init);const headers=new Headers(init.headers||{});const token=bridgeToken();if(token)headers.set('x-simplepos-token',token);return originalFetch(`${base}/print`,{...init,headers})}

window.fetch=async function(input,init={}){const raw=typeof input==='string'?input:input.url;const method=String(init.method||(typeof input!=='string'&&input.method)||'GET').toUpperCase();if(raw==='/print'||raw.endsWith('/print')&&new URL(raw,location.href).origin===location.origin)return routedPrint(input,init);if(!REST_PREFIX||!raw.startsWith(REST_PREFIX))return originalFetch(input,init);
const table=tableFromUrl(raw);if(method==='GET'){try{const r=await originalFetch(input,init);if(r.ok){const data=await r.clone().json().catch(()=>null);if(data!==null)await cacheSnapshot(raw,data)}return r}catch(e){const cached=await cachedGet(raw);if(cached)return cached;throw e}}
// Client-side ids exist so an offline INSERT can be reconciled later. Adding one
// to a PATCH would rewrite the row's primary key: the update either fails on a
// foreign key or silently re-keys the row and orphans every in-memory reference.
let body=parseJsonBody(init.body);if(method==='POST')body=ensureIds(table,body);const nextInit={...init,body:body==null?init.body:JSON.stringify(body)};if(!navigator.onLine){await queueMutation({url:raw,method,body,prefer:new Headers(init.headers||{}).get('Prefer')||'return=representation'});await mutateSnapshots(table,raw,method,body);return syntheticMutationResponse(method,body,raw)}
try{const r=await originalFetch(input,nextInit);if(r.ok){let result=null;try{result=await r.clone().json()}catch{}const effective=method==='POST'&&result?result:body;await mutateSnapshots(table,raw,method,effective);return r}return r}catch(e){await queueMutation({url:raw,method,body,prefer:new Headers(init.headers||{}).get('Prefer')||'return=representation'});await mutateSnapshots(table,raw,method,body);return syntheticMutationResponse(method,body,raw)}};

async function requestPersistentStorage(){try{if(navigator.storage?.persist)await navigator.storage.persist()}catch{}}
window.SimplePOSLocal={replay:replayOutbox,status:dispatchStatus,bridgeBase,requestPersistentStorage};
window.addEventListener('online',()=>{replayOutbox();dispatchStatus()});window.addEventListener('offline',dispatchStatus);setInterval(replayOutbox,10000);requestPersistentStorage();dispatchStatus();
