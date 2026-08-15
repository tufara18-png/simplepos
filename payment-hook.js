const $=s=>document.querySelector(s);
const moneyText=s=>String(s||'').replace(/\s+/g,' ').trim();

function toast(message,type='ok'){
  const el=$('#toast');
  if(!el)return;
  el.textContent=message;
  el.dataset.type=type;
  el.classList.add('show');
  clearTimeout(el._ticketTimer);
  el._ticketTimer=setTimeout(()=>el.classList.remove('show'),2600);
}

async function getReceiptPrinter(){
  const cfg=window.SIMPLEPOS_CONFIG||{};
  const session=JSON.parse(localStorage.getItem('simplepos-session')||'null');
  if(!cfg.supabaseUrl||!cfg.supabasePublishableKey||!session?.access_token)return null;
  const r=await fetch(`${cfg.supabaseUrl}/rest/v1/printers?role=eq.receipt&enabled=eq.true&select=ip_address,port&limit=1`,{
    headers:{apikey:cfg.supabasePublishableKey,Authorization:`Bearer ${session.access_token}`}
  });
  if(!r.ok)return null;
  const rows=await r.json();
  return rows?.[0]||null;
}

function buildTicket(){
  const restaurant=moneyText($('#restaurantName')?.textContent)||'Restaurant';
  const table=moneyText($('#orderTableLabel')?.textContent)||'Table';
  const rows=[...document.querySelectorAll('#ticketList .ticket-row')].map(row=>{
    const name=moneyText(row.querySelector('strong')?.textContent);
    const spans=[...row.querySelectorAll('span')];
    const price=moneyText(spans.at(-1)?.textContent);
    return name?`${name}${price?`  ${price}`:''}`:'';
  }).filter(Boolean);
  const totals=[...document.querySelectorAll('#ticketTotals .total-line')].map(row=>moneyText(row.textContent)).filter(Boolean);
  return [`ADDITION`,restaurant,table,'',...rows,'',...totals,''].join('\n');
}

async function printCurrentTicket(){
  const printer=await getReceiptPrinter();
  if(!printer?.ip_address)throw new Error('Configure l’imprimante reçu dans Réglages');
  const r=await fetch('/print',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ip:printer.ip_address,port:printer.port||9100,text:buildTicket(),cut:true})
  });
  if(!r.ok)throw new Error('Imprimante reçu inaccessible');
}

queueMicrotask(()=>{
  const pay=$('#goPay');
  if(!pay)return;
  const original=pay.onclick;
  pay.onclick=async event=>{
    event.preventDefault();
    if(pay.dataset.busy==='1')return;
    pay.dataset.busy='1';
    const oldText=pay.textContent;
    pay.textContent='Impression…';
    try{
      await printCurrentTicket();
      toast('Addition imprimée');
      if(typeof original==='function')original.call(pay,event);
    }catch(err){
      toast(`${err.message} — paiement bloqué`,'error');
    }finally{
      pay.textContent=oldText;
      pay.dataset.busy='0';
    }
  };
});