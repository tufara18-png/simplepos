const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const areaForScreen=id=>['tablesScreen','orderScreen','payScreen'].includes(id)?'pos':id==='dashboardScreen'?'dashboard':id==='reservationsScreen'?'reservations':'management';
function syncArea(){const active=$('.screen.active');if(!active)return;const area=areaForScreen(active.id);$$('.sidebar .nav[data-area]').forEach(b=>b.classList.toggle('active',b.dataset.area===area))}
function syncPaymentPanel(id){$$('.payment-panel').forEach(p=>p.classList.toggle('active',p.id===id));$$('.payment-method').forEach(b=>b.classList.toggle('active',b.dataset.paymentPanel===id))}
function wirePaymentPanels(){$$('.payment-method[data-payment-panel]').forEach(b=>b.addEventListener('click',()=>syncPaymentPanel(b.dataset.paymentPanel)))}
function wireManagement(){$$('[data-management-scroll]').forEach(b=>b.addEventListener('click',()=>{const el=document.getElementById(b.dataset.managementScroll);if(el)el.scrollIntoView({behavior:'smooth',block:'start'})}))}
function wireNavigation(){document.addEventListener('click',e=>{if(e.target.closest('[data-nav]'))setTimeout(syncArea,0)});const observer=new MutationObserver(syncArea);$$('.screen').forEach(s=>observer.observe(s,{attributes:true,attributeFilter:['class']}));syncArea()}
function wireClock(){const el=$('#clock');if(!el)return;const tick=()=>{const d=new Date();el.textContent=d.toLocaleString('fr-CA',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})};tick();setInterval(tick,30000)}
function addSectionFallback(){const host=$('#sectionPills');if(!host||host.children.length)return;host.innerHTML='<button class="section-pill active">Toutes</button>'}
function blockKitchenSentFallback(){const original=window.confirm.bind(window);window.confirm=message=>{if(/Marquer envoyé quand même/i.test(String(message))){const t=$('#toast');if(t){t.textContent='Impression cuisine échouée — les articles restent à envoyer.';t.dataset.type='error';t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2800)}return false}return original(message)}}
blockKitchenSentFallback();
Promise.all([
  import('/pivots.js'),
  import('/demo-mode.js')
])
  .then(()=>import('/sw76-readiness.js'))
  .then(()=>import('/pwa-device-readiness.js'))
  .catch(err=>console.error('SimplePOS extension unavailable',err));
window.addEventListener('DOMContentLoaded',()=>{wireNavigation();wirePaymentPanels();wireManagement();wireClock();addSectionFallback()});
