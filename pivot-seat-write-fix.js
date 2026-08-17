const previousFetch=window.fetch.bind(window);

function activeSeatFromUi(){
  const active=document.querySelector('#pivotSeatBar [data-seat-go].active');
  const seat=Number(active?.dataset?.seatGo||0);
  return Number.isInteger(seat)&&seat>0?seat:null;
}

window.fetch=async function(input,init={}){
  const url=typeof input==='string'?input:input?.url||'';
  const method=String(init?.method||(typeof input!=='string'&&input?.method)||'GET').toUpperCase();
  if(method==='POST'&&init?.body&&typeof init.body==='string'&&/\/rest\/v1\/order_items(?:\?|$)/.test(url)){
    const seat=activeSeatFromUi();
    if(seat){
      try{
        const body=JSON.parse(init.body);
        const apply=row=>row&&typeof row==='object'&&!Array.isArray(row)&&row.order_id?{...row,seat_number:seat}:row;
        const next=Array.isArray(body)?body.map(apply):apply(body);
        init={...init,body:JSON.stringify(next)};
      }catch{}
    }
  }
  return previousFetch(input,init);
};
