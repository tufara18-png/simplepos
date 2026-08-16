import assert from 'node:assert/strict';

function round2(n){return Math.round((Number(n)+Number.EPSILON)*100)/100}
function calcTax(sub){const gst=round2(sub*0.05),qst=round2(sub*0.09975);return {gst,qst,total:round2(sub+gst+qst)}}
function splitAmounts(total,n){const cents=Math.round(total*100),base=Math.floor(cents/n),rem=cents-base*n;return Array.from({length:n},(_,i)=>(base+(i>=n-rem?1:0))/100)}
function terminalTip(due,terminal,tipsEnabled=true){return tipsEnabled&&terminal>=due?round2(terminal-due):0}
function normalizeMevStatus({status,retryable,httpStatus=200}){
  if(status==='accepted') return 'accepted';
  if(retryable||status==='timeout'||httpStatus>=500) return 'retryable';
  if(status==='rejected'||httpStatus===422) return 'rejected';
  return httpStatus>=200&&httpStatus<300?'accepted':'failed';
}

assert.deepEqual(calcTax(100),{gst:5,qst:9.98,total:114.98});
assert.deepEqual(splitAmounts(100,3),[33.33,33.33,33.34]);
assert.equal(splitAmounts(86.40,4).reduce((a,b)=>round2(a+b),0),86.40);
assert.equal(splitAmounts(41.39,3).reduce((a,b)=>round2(a+b),0),41.39);
assert.equal(terminalTip(57.49,67.84),10.35);
assert.equal(terminalTip(57.49,57.49),0);
assert.equal(normalizeMevStatus({status:'accepted'}),'accepted');
assert.equal(normalizeMevStatus({status:'retryable',retryable:true}),'retryable');
assert.equal(normalizeMevStatus({status:'rejected',httpStatus:422}),'rejected');
assert.equal(normalizeMevStatus({status:'unknown',httpStatus:503}),'retryable');

console.log('OK - taxes, split, pourboire terminal et statuts MEV');
