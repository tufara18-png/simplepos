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

// Keep in sync with SRM_NAME_RE / srmNameError in app-v2.js.
const SRM_NAME_RE=/^[a-zA-Z0-9@:!#$%&'()*+,\-.=?_|~/\\ ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝàáâãäåæçèéêëìíîïðñòóôõöøùúûüýÿ]+$/;
function srmNameError(name){
  const v=String(name??'');
  if(v.length<2||v.length>128)return 'length';
  if(v!==v.trim())return 'whitespace';
  if(!SRM_NAME_RE.test(v))return 'charset';
  return null;
}

assert.equal(srmNameError("Jus d'orange"),null);
assert.equal(srmNameError('Crème brûlée'),null);
assert.equal(srmNameError('Bacon (1)'),null);
assert.equal(srmNameError('Jus d’orange'),'charset');   // curly apostrophe
assert.equal(srmNameError('Bœuf Wellington'),'charset'); // ligature oe
assert.equal(srmNameError('Bacon [1]'),'charset');       // square brackets
assert.equal(srmNameError('Cheese 🧀'),'charset');        // emoji
assert.equal(srmNameError('S'),'length');
assert.equal(srmNameError('Cobb Salad '),'whitespace');

// Addition wording: first print is original, later prints are revisions.
function additionHeading(printed){return printed?['FACTURE RÉVISÉE',`Remplace ${printed} facture${printed>1?'s':''}`]:['FACTURE ORIGINALE']}
assert.deepEqual(additionHeading(0),['FACTURE ORIGINALE']);
assert.deepEqual(additionHeading(1),['FACTURE RÉVISÉE','Remplace 1 facture']);
assert.deepEqual(additionHeading(2),['FACTURE RÉVISÉE','Remplace 2 factures']);

// Keep in sync with sw76-readiness.js. Kitchen slips are intentionally excluded.
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
function injectLocalReference(text,reference){if(String(text).includes(reference))return String(text);const note=`RÉFÉRENCE LOCALE ${reference}\nDOCUMENT NON CERTIFIÉ — TRANSPORT MEV OFFICIEL NON CONFIGURÉ`;const lines=String(text||'').split('\n');const heading=lines.findIndex(line=>/FACTURE|PAIEMENT|NOTE DE CR|COPIE DU COMMER|RAPPORT DE L|COMMANDE ANNUL|REPRODUCTION/i.test(line));lines.splice(heading>=0?heading+1:Math.min(1,lines.length),0,note);return lines.join('\n')}

assert.equal(inferDocumentType('CUISINE\nTable 1'),null);
assert.equal(inferDocumentType('FACTURE ORIGINALE\nTable 1'),'addition_original');
assert.equal(inferDocumentType('FACTURE RÉVISÉE\nTable 1'),'addition_revised');
assert.equal(inferDocumentType('PAIEMENT REÇU'),'closing_receipt');
assert.equal(inferDocumentType('NOTE DE CRÉDIT'),'credit_note');
assert.equal(inferDocumentType('*** COPIE DU COMMERÇANT ***'),'merchant_duplicate');
assert.equal(inferDocumentType('REPRODUCTION DESTINÉE AU CLIENT'),'customer_reproduction');
assert.equal(inferDocumentType("RAPPORT DE L'UTILISATEUR"),'user_report');
const traced=injectLocalReference('Restaurant\nFACTURE ORIGINALE\nTOTAL 10 $','SP-20260817-ABC123-00001');
assert.match(traced,/RÉFÉRENCE LOCALE SP-20260817-ABC123-00001/);
assert.equal((traced.match(/SP-20260817-ABC123-00001/g)||[]).length,1);
assert.equal(injectLocalReference(traced,'SP-20260817-ABC123-00001'),traced);

// PWA capability probe rules. A browser signing test is not an official MEV key.
const SHA256_HEX=/^[0-9a-f]{64}$/;
function pwaCapability({standalone,persisted,cryptoVerified,privateExtractable,bridgeReachable}){
  const localSigningReady=standalone&&persisted&&cryptoVerified&&privateExtractable===false;
  return{localSigningReady,fullOperationalPath:localSigningReady&&bridgeReachable};
}
assert.equal(SHA256_HEX.test('a'.repeat(64)),true);
assert.equal(SHA256_HEX.test('a'.repeat(63)),false);
assert.deepEqual(pwaCapability({standalone:true,persisted:true,cryptoVerified:true,privateExtractable:false,bridgeReachable:true}),{localSigningReady:true,fullOperationalPath:true});
assert.deepEqual(pwaCapability({standalone:true,persisted:true,cryptoVerified:true,privateExtractable:false,bridgeReachable:false}),{localSigningReady:true,fullOperationalPath:false});
assert.equal(pwaCapability({standalone:false,persisted:true,cryptoVerified:true,privateExtractable:false,bridgeReachable:true}).localSigningReady,false);

console.log('OK - taxes, split, pourboire, statuts MEV, noms SRM, documents SW-76 et diagnostic PWA');
