const CFG = window.SIMPLEPOS_CONFIG || {};
const API = `${CFG.supabaseUrl}/rest/v1`;
const POLL_MS = 6000;
let demoMode = false;
let restaurantId = null;

const $ = s => document.querySelector(s);
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
  if(toggle)toggle.checked=demoMode;
}

async function refreshDemoMode(){
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
  if(demoMode&&method==='POST'&&/^\/print(\?|$)/.test(url)){
    try{
      const body=init?.body?JSON.parse(init.body):{};
      showSimulatedPrint(body.text||'');
    }catch{}
    return new Response(JSON.stringify({demo:true,ok:true}),{status:200,headers:{'content-type':'application/json'}});
  }
  return wrappedFetch(input,init);
};

function tick(){refreshDemoMode()}
function start(){
  injectStyles();
  ensureBanner();
  tick();
  setInterval(tick,POLL_MS);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick()});
  new MutationObserver(()=>{if($('#settingsScreen')?.classList.contains('active'))syncToggleUi()}).observe(document.body,{attributes:true,attributeFilter:['class'],subtree:true});
}
if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',start);else start();
