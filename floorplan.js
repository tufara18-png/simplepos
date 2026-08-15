const cfg = window.SIMPLEPOS_CONFIG;
const API = `${cfg.supabaseUrl}/rest/v1`;
const KEY = cfg.supabasePublishableKey;

const $fp = s => document.querySelector(s);
let fpSections = [];
let fpTables = [];
let activeSectionId = 'all';
let fpBusy = false;

function fpSession(){try{return JSON.parse(localStorage.getItem('simplepos-session')||'null')}catch{return null}}
function fpHeaders(extra={}){const s=fpSession();return{apikey:KEY,Authorization:`Bearer ${s?.access_token||KEY}`,'Content-Type':'application/json',...extra}}
async function fpRest(path,{method='GET',body,prefer='return=representation'}={}){
  const r=await fetch(`${API}/${path}`,{method,headers:fpHeaders(prefer?{Prefer:prefer}:{}),body:body===undefined?undefined:JSON.stringify(body)});
  const text=await r.text();const d=text?JSON.parse(text):null;
  if(!r.ok)throw new Error(d?.message||d?.hint||d?.details||`Supabase ${r.status}`);return d;
}
function fpRestaurantId(){
  const name=$fp('#restaurantName')?.textContent?.trim();
  return fpTables[0]?.restaurant_id||fpSections[0]?.restaurant_id||null;
}
async function fpLoad(){
  const s=fpSession();if(!s?.access_token)return;
  const restaurants=await fpRest('restaurants?select=id&order=created_at.asc&limit=1');
  const rid=restaurants?.[0]?.id;if(!rid)return;
  [fpSections,fpTables]=await Promise.all([
    fpRest(`restaurant_sections?restaurant_id=eq.${rid}&active=eq.true&select=*&order=sort_order.asc,created_at.asc`),
    fpRest(`restaurant_tables?restaurant_id=eq.${rid}&active=eq.true&select=id,restaurant_id,section_id,number,label,seats,sort_order&order=sort_order.asc,number.asc`)
  ]);
  if(!fpSections.length){
    const created=await fpRest('restaurant_sections',{method:'POST',body:{restaurant_id:rid,name:'Salle',sort_order:0}});
    fpSections=created;
    await Promise.all(fpTables.filter(t=>!t.section_id).map(t=>fpRest(`restaurant_tables?id=eq.${t.id}`,{method:'PATCH',body:{section_id:created[0].id}})));
    fpTables.forEach(t=>{if(!t.section_id)t.section_id=created[0].id});
  }
  renderSectionTabs();renderFloorSettings();applySectionFilter();
}
function renderSectionTabs(){
  const head=$fp('#tablesScreen .screen-head');if(!head)return;
  let bar=$fp('#sectionTabs');if(!bar){bar=document.createElement('div');bar.id='sectionTabs';bar.className='section-tabs';head.insertAdjacentElement('afterend',bar)}
  const options=[{id:'all',name:'Toutes'},...fpSections];
  if(!options.some(x=>x.id===activeSectionId))activeSectionId='all';
  bar.innerHTML=options.map(s=>`<button class="section-tab ${s.id===activeSectionId?'active':''}" data-section="${s.id}">${escapeFp(s.name)}</button>`).join('');
  bar.querySelectorAll('[data-section]').forEach(b=>b.onclick=()=>{activeSectionId=b.dataset.section;renderSectionTabs();applySectionFilter()});
}
function applySectionFilter(){
  const grid=$fp('#tablesGrid');if(!grid)return;
  grid.querySelectorAll('[data-table]').forEach(card=>{
    const t=fpTables.find(x=>String(x.id)===String(card.dataset.table));
    card.style.display=activeSectionId==='all'||String(t?.section_id)===String(activeSectionId)?'':'none';
  });
}
function renderFloorSettings(){
  const grid=$fp('#settingsScreen .settings-grid');if(!grid)return;
  let card=$fp('#floorPlanSettings');
  if(!card){card=document.createElement('section');card.id='floorPlanSettings';card.className='settings-card';grid.prepend(card)}
  card.innerHTML=`<div class="card-head"><div><h2>Plan de salle</h2><p class="muted">Crée une section et indique simplement combien de tables elle contient.</p></div></div>
  <div class="floor-create"><label>Nom de la section<input id="newSectionName" placeholder="Salle, Terrasse, Bar"></label><label>Nombre de tables<input id="newSectionCount" type="number" min="1" max="100" value="8"></label><label>Places / table<input id="newSectionSeats" type="number" min="1" max="50" value="4"></label><button id="createSectionBtn" class="btn primary">Créer la section</button></div>
  <div class="floor-summary">${fpSections.map(s=>{const count=fpTables.filter(t=>t.section_id===s.id).length;return `<div class="floor-section-row"><div><strong>${escapeFp(s.name)}</strong><span>${count} table${count!==1?'s':''}</span></div><div class="floor-actions"><button class="btn small" data-add-table-section="${s.id}">+ Table</button><button class="btn small" data-rename-section="${s.id}">Renommer</button></div></div>`}).join('')}</div>`;
  $fp('#createSectionBtn').onclick=createSection;
  card.querySelectorAll('[data-add-table-section]').forEach(b=>b.onclick=()=>addSingleTable(b.dataset.addTableSection));
  card.querySelectorAll('[data-rename-section]').forEach(b=>b.onclick=()=>renameSection(b.dataset.renameSection));
}
async function createSection(){
  if(fpBusy)return;fpBusy=true;
  try{
    const name=$fp('#newSectionName').value.trim();const count=Number($fp('#newSectionCount').value);const seats=Number($fp('#newSectionSeats').value);
    if(!name)throw new Error('Entre un nom de section');if(!Number.isInteger(count)||count<1)throw new Error('Nombre de tables invalide');
    const rid=fpRestaurantId();const section=(await fpRest('restaurant_sections',{method:'POST',body:{restaurant_id:rid,name,sort_order:fpSections.length}}))[0];
    const maxNumber=fpTables.reduce((m,t)=>Math.max(m,Number(t.number)||0),0);
    const rows=Array.from({length:count},(_,i)=>({restaurant_id:rid,section_id:section.id,number:maxNumber+i+1,label:`Table ${maxNumber+i+1}`,seats:Number.isInteger(seats)&&seats>0?seats:4,sort_order:fpTables.length+i}));
    const created=await fpRest('restaurant_tables',{method:'POST',body:rows});fpSections.push(section);fpTables.push(...created);activeSectionId=section.id;
    await fpLoad();document.querySelector('[data-nav="tablesScreen"]')?.click();
  }catch(e){alert(e.message)}finally{fpBusy=false}
}
async function addSingleTable(sectionId){
  const section=fpSections.find(s=>s.id===sectionId);if(!section)return;
  const rid=section.restaurant_id;const maxNumber=fpTables.reduce((m,t)=>Math.max(m,Number(t.number)||0),0);
  const created=await fpRest('restaurant_tables',{method:'POST',body:{restaurant_id:rid,section_id:sectionId,number:maxNumber+1,label:`Table ${maxNumber+1}`,seats:4,sort_order:fpTables.length}});fpTables.push(created[0]);await fpLoad();
}
async function renameSection(id){const s=fpSections.find(x=>x.id===id);if(!s)return;const name=prompt('Nom de la section',s.name)?.trim();if(!name||name===s.name)return;const d=await fpRest(`restaurant_sections?id=eq.${id}`,{method:'PATCH',body:{name}});Object.assign(s,d[0]);renderSectionTabs();renderFloorSettings()}
function escapeFp(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}

const observer=new MutationObserver(()=>{renderSectionTabs();applySectionFilter();if($fp('#settingsScreen')?.classList.contains('active'))renderFloorSettings()});
observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
setInterval(()=>fpLoad().catch(()=>{}),7000);
window.addEventListener('load',()=>setTimeout(()=>fpLoad().catch(()=>{}),800));