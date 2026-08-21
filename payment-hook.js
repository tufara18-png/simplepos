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
  const cfg=window.RESTO360_CONFIG||{};
  const session=JSON.parse(localStorage.getItem('resto360-session')||'null');
  if(!cfg.supabaseUrl||!cfg.supabasePublishableKey||!session?.access_token)return null;
  const r=await fetch(`${cfg.supabaseUrl}/rest/v1/printers?role=eq.receipt&enabled=eq.true&select=ip_address,port&limit=1`,{
    headers:{apikey:cfg.supabasePublishableKey,Authorization:`Bearer ${session.access_token}`}
  });
  if(!r.ok)return null;
  const rows=await r.json();
  return rows?.[0]||null;
}

async function getCompanyInfo(){
  const cfg=window.RESTO360_CONFIG||{};
  const session=JSON.parse(localStorage.getItem('resto360-session')||'null');
  if(!cfg.supabaseUrl||!cfg.supabasePublishableKey||!session?.access_token)return null;
  const r=await fetch(`${cfg.supabaseUrl}/rest/v1/restaurants?select=name,legal_name,address,city,postal_code,phone,gst_number,qst_number&order=created_at.asc&limit=1`,{
    headers:{apikey:cfg.supabasePublishableKey,Authorization:`Bearer ${session.access_token}`}
  });
  if(!r.ok)return null;
  const rows=await r.json();
  return rows?.[0]||null;
}

function companyHeaderLines(biz){
  if(!biz)return[];
  const addr=[biz.address,[biz.city,biz.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return[biz.legal_name||biz.name,biz.phone,addr,biz.gst_number?`TPS ${biz.gst_number}`:null,biz.qst_number?`TVQ ${biz.qst_number}`:null].filter(Boolean);
}

function buildTicket(company){
  const restaurant=moneyText($('#restaurantName')?.textContent)||'Restaurant';
  const table=moneyText($('#orderTableLabel')?.textContent)||'Table';
  const header=companyHeaderLines(company);
  const rows=[...document.querySelectorAll('#ticketList .ticket-row')].map(row=>{
    const name=moneyText(row.querySelector('strong')?.textContent);
    const spans=[...row.querySelectorAll('span')];
    const price=moneyText(spans.at(-1)?.textContent);
    return name?`${name}${price?`  ${price}`:''}`:'';
  }).filter(Boolean);
  const totals=[...document.querySelectorAll('#ticketTotals .total-line')].map(row=>moneyText(row.textContent)).filter(Boolean);
  return [`FACTURE ORIGINALE`,...(header.length?header:[restaurant]),table,'',...rows,'',...totals,''].join('\n');
}

async function printCurrentTicket(){
  // app-v2 owns the FACTURE ORIGINALE / FACTURE REVISEE counter, so prefer its
  // implementation and only fall back to the DOM-scraped ticket if it is absent.
  if(typeof window.Resto360PrintAddition==='function'){await window.Resto360PrintAddition();return}
  const printer=await getReceiptPrinter();
  if(!printer?.ip_address)throw new Error('Configure l’imprimante reçu dans Réglages');
  const company=await getCompanyInfo();
  const r=await fetch('/print',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ip:printer.ip_address,port:printer.port||9100,text:buildTicket(company),cut:true})
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