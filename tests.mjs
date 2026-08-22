import assert from 'node:assert/strict';
import {buildItems,buildMont,taxIndicator,interpretCodRetour,buildSignatureInput,buildTransactionSignatureInput,buildOfflineBatchEnvelope,buildReqCertif,buildReqUtil,buildReqTrans,buildReqDocumentRut,buildReportSignatureInput,withReportSignatureAndFooter,formatDocumentFields,datTrans,parseCertificateSerialHex,validateSevText} from './mev-protocol.js';
import {splitIntoBatches} from './mev-offline-queue.js';

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
function injectLocalReference(text,reference,mevStatus={}){if(String(text).includes(reference))return String(text);const note=mevStatus.certified?`RÉFÉRENCE LOCALE ${reference}\nDOCUMENT NON CERTIFIÉ (SEV EN COURS DE CERTIFICATION) — TRANSMIS AU MEV-WEB, ENVIRONNEMENT ${mevStatus.environment||'INCONNU'}`:`RÉFÉRENCE LOCALE ${reference}\nDOCUMENT NON CERTIFIÉ — TRANSPORT MEV OFFICIEL NON CONFIGURÉ`;const lines=String(text||'').split('\n');const heading=lines.findIndex(line=>/FACTURE|PAIEMENT|NOTE DE CR|COPIE DU COMMER|RAPPORT DE L|COMMANDE ANNUL|REPRODUCTION/i.test(line));lines.splice(heading>=0?heading+1:Math.min(1,lines.length),0,note);return lines.join('\n')}

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

// A live-mode transaction that was actually transmitted must not be stamped "transport not
// configured" -- that claim would be false. "DOCUMENT NON CERTIFIÉ" stays (Resto360 itself
// isn't a certified SEV yet), but it must say the transport was used, not that it's missing.
assert.doesNotMatch(injectLocalReference('Restaurant\nPAIEMENT REÇU\nTOTAL 10 $','SP-1',{certified:false}),/TRANSMIS AU MEV-WEB/);
const liveReceipt=injectLocalReference('Restaurant\nPAIEMENT REÇU\nTOTAL 10 $','SP-1',{certified:true,environment:'DEV'});
assert.match(liveReceipt,/TRANSMIS AU MEV-WEB, ENVIRONNEMENT DEV/);
assert.doesNotMatch(liveReceipt,/TRANSPORT MEV OFFICIEL NON CONFIGURÉ/);

// parseCertificateSerialHex: hand-built minimal DER (Certificate{ TBSCertificate{ [0] EXPLICIT
// version=2, serialNumber=0x1234ABCD } }) -- exercises both the optional-version-skip and the
// serial extraction without needing a real Revenu Québec-issued certificate as a fixture.
{
  const tbs = Buffer.concat([
    Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02]), // [0] EXPLICIT version INTEGER 2
    Buffer.from([0x02, 0x04, 0x12, 0x34, 0xab, 0xcd]), // serialNumber INTEGER 0x1234ABCD
  ]);
  const cert = Buffer.concat([Buffer.from([0x30, tbs.length]), tbs]);
  const wrapped = Buffer.concat([Buffer.from([0x30, cert.length]), cert]);
  const pem = `-----BEGIN CERTIFICATE-----\n${wrapped.toString('base64')}\n-----END CERTIFICATE-----`;
  assert.equal(parseCertificateSerialHex(pem), '1234ABCD');
}

// Credit note wiring (SW-77 Cas 006/506, FO-116): documentType 'credit_note' must map to
// RFER/FAC (already confirmed live for a credit note in commit bc25b83), each item must carry
// an inversely-equal price rather than being collapsed into one "Annulation" line (SW-73
// 4.4.1.1.8), and refs[] must point back at the original transaction.
{
  const restaurant={legal_name:'Michel Untel enr.',name:'Michel Untel enr.',gst_number:'123456789RT0001',qst_number:'1234567890TQ0001'};
  const device={certificate_thumbprint_sha1:'ABCDEF'};
  const partnerConfig={dossier_number:'AA9999',no_tps:restaurant.gst_number,no_tvq:restaurant.qst_number,id_sev:'0000000000000001',id_versi:'0000000000000002',cod_certif:'FOB201999999',id_partn:'0000000000000003',versi:'1.0',versi_parn:'0'};
  const originalCreatedAt='2026-08-17T12:00:00Z';
  const note={id:'note-1',invoice_number:42,user_name:'Michel Untel',created_at:'2026-08-17T12:05:00Z',subtotal:-4.80,gst:-0.24,qst:-0.48,total:-5.52,tip_amount:0};
  const items=[{name:'Article 1',quantity:1,line_total:-4.80}];
  const {reqTrans}=buildReqTrans({
    restaurant,device,partnerConfig,invoice:note,invoiceItems:items,paymentMethod:'card',documentType:'credit_note',
    replacesTransaction:{noTrans:'41',datTrans:datTrans(originalCreatedAt),avantTax:4.80},
    signaturePreviousBase88:'='.repeat(88),
  });
  assert.equal(reqTrans.transActu.typTrans,'RFER');
  assert.equal(reqTrans.transActu.modImpr,'FAC');
  assert.deepEqual(reqTrans.transActu.items,[{qte:'+00001.00',descr:'Article 1',prix:'-000000004.80',tax:'FP',acti:'NON'}]);
  assert.deepEqual(reqTrans.transActu.refs,[{noTrans:'41',datTrans:datTrans(originalCreatedAt),avantTax:'+000000004.80'}]);
}

// Rapport de l'utilisateur transmis en "document" (SW-77 Cas 103/603, SW-78 FO-110/128): field
// order/format per Tableau 28's worked example, SI inserted before EM/AD (not after, as the
// naive append order would give).
{
  const restaurant={legal_name:'Michel Untel enr.',name:'Michel Untel enr.',gst_number:'123456789RT0001',qst_number:'1234567890TQ0001',address:'3800, rue de Marly, Québec, G1X4A5'};
  const device={id_apprl:'0001-2345-6789',certificate_thumbprint_sha1:'11E1D6307770C96B63227E3EA7E18A9C48E02A8C'};
  const partnerConfig={no_tps:restaurant.gst_number,no_tvq:restaurant.qst_number,id_sev:'1234567890ABCDEF',versi:'1.0'};
  const report={user_name:'Michel Untel',period_year:2020,sales_count:16,sales_subtotal:20,sales_gst:1,sales_qst:2,sales_total:23};
  const lastInvoice={invoice_number:'1234567890',total:15,created_at:'2020-01-01T12:59:39Z'};
  const loginAt='2020-01-01T13:01:08Z';
  const fields=buildReqDocumentRut({restaurant,device,partnerConfig,report,lastInvoice,loginAt});
  assert.deepEqual(fields.slice(0,6),[['RT','123456789RT0001'],['TQ','1234567890TQ0001'],['UT','Michel Untel'],['NO','1234567890'],['MT','+000000015.00'],['DF',datTrans(lastInvoice.created_at)]]);
  const withFooter=withReportSignatureAndFooter(fields,{signatureBase64:'SIGNATURE',device,restaurant});
  const doc=formatDocumentFields(withFooter);
  assert.match(doc,/DR=\d{14};SI=SIGNATURE;EM=11E1D6307770C96B63227E3EA7E18A9C48E02A8C;AD=3800, rue de Marly, Québec, G1X4A5$/);
  assert.match(doc,/^RT=123456789RT0001;TQ=1234567890TQ0001;UT=Michel Untel;NO=1234567890;MT=\+000000015\.00;/);
  const signInput=buildReportSignatureInput({partnerConfig,nomUtilOuMandt:'Michel Untel',lastInvoice,report,device,loginAt});
  const expectedPrefix=`123456789RT00011234567890TQ0001Michel Untel1234567890+000000015.00${datTrans(lastInvoice.created_at)}20201616+000000020.00+000000001.00+000000002.00+000000023.000001-2345-67891234567890ABCDEF1.0${datTrans(loginAt)}`;
  assert.ok(signInput.startsWith(expectedPrefix),'signature input must match Tableau 30\'s order up to DR (report time, appended last, is the only non-deterministic part)');
  assert.equal(signInput.length,expectedPrefix.length+14,'DR is a 14-digit AAAAMMJJHHmmSS timestamp');
}

// Revenu Québec's registered product declares "Carte de crédit" and "Carte de débit" as
// distinct payment modes (modPai CRE/DEB) -- paymentMethod 'card_credit'/'card_debit' must map
// to the right one, and the older bare 'card' still falls back to CRE for any caller that
// hasn't been updated to pass the split value.
{
  const restaurant={legal_name:'Michel Untel enr.',name:'Michel Untel enr.',gst_number:'123456789RT0001',qst_number:'1234567890TQ0001'};
  const device={certificate_thumbprint_sha1:'ABCDEF'};
  const partnerConfig={dossier_number:'AA9999',no_tps:restaurant.gst_number,no_tvq:restaurant.qst_number,id_sev:'0000000000000001',id_versi:'0000000000000002',cod_certif:'FOB201999999',id_partn:'0000000000000003',versi:'1.0',versi_parn:'0'};
  const invoice={invoice_number:1,id:'inv-1',created_at:'2026-08-22T12:00:00Z',subtotal:10,gst:0.5,qst:1,total:11.5,tip_amount:0};
  const items=[{name:'Article',quantity:1,line_total:10}];
  const modPaiFor=(paymentMethod)=>buildReqTrans({restaurant,device,partnerConfig,invoice,invoiceItems:items,paymentMethod,documentType:'closing_receipt',signaturePreviousBase88:'='.repeat(88)}).reqTrans.transActu.modPai;
  assert.equal(modPaiFor('card_credit'),'CRE');
  assert.equal(modPaiFor('card_debit'),'DEB');
  assert.equal(modPaiFor('card'),'CRE');
}

// SW-77 Cas 008/508 "Utiliser le mode Formation": modTrans must be FOR when the invoice was
// created under formation_mode, OPE otherwise (SW-73 4.4.1.1.16 -- still transmitted either way).
{
  const restaurant={legal_name:'Michel Untel enr.',name:'Michel Untel enr.',gst_number:'123456789RT0001',qst_number:'1234567890TQ0001'};
  const device={certificate_thumbprint_sha1:'ABCDEF'};
  const partnerConfig={dossier_number:'AA9999',no_tps:restaurant.gst_number,no_tvq:restaurant.qst_number,id_sev:'0000000000000001',id_versi:'0000000000000002',cod_certif:'FOB201999999',id_partn:'0000000000000003',versi:'1.0',versi_parn:'0'};
  const items=[{name:'Article',quantity:1,line_total:4.80}];
  const invoice={invoice_number:1,id:'inv-1',created_at:'2026-08-22T12:00:00Z',subtotal:4.80,gst:0.24,qst:0.48,total:5.52,tip_amount:0};
  const modTransFor=(modeTransaction)=>buildReqTrans({restaurant,device,partnerConfig,invoice,invoiceItems:items,paymentMethod:'cash',documentType:'closing_receipt',signaturePreviousBase88:'='.repeat(88),modeTransaction}).reqTrans.transActu.modTrans;
  assert.equal(modTransFor('FOR'),'FOR');
  assert.equal(modTransFor('OPE'),'OPE');
  assert.equal(modTransFor(undefined),'OPE','no mode_transaction on the invoice must default to OPE, never silently FOR');
}

// SW-78 FO-132: a transLot batch over the 256 ko cap must be split into consecutive,
// oldest-first groups that each fit, not sent as one oversized request.
{
  const row = (n) => ({ transActu: { noTrans: String(n), signa: { actu: `sig${n}` }, pad: 'x'.repeat(100) } });
  const rows = Array.from({ length: 10 }, (_, i) => row(i));
  // Each row's own transLot-wrapped size is well under 1000 bytes; capping at 900 forces a
  // split into multiple groups instead of one.
  const groups = splitIntoBatches(rows, 900);
  assert.ok(groups.length > 1, 'expected more than one batch once the cap is exceeded');
  assert.deepEqual(groups.flat(), rows, 'splitting must not drop or reorder any transaction');
  for (const g of groups) assert.ok(g.length >= 1);
  // Well under the cap: everything fits in one batch, unchanged from before FO-132.
  assert.deepEqual(splitIntoBatches(rows, 1_000_000), [rows]);
}

// mev-protocol.js: real SW-73 field builders, checked against the worked example printed in
// SW-76 4.4.1 (Michel Untel enr., 1 item at 4,80 $, TPS 0,24 $, TVQ 0,48 $, total 5,52 $).
assert.deepEqual(taxIndicator({gstApplies:true,qstApplies:true}),'FP');
assert.deepEqual(taxIndicator({gstApplies:false,qstApplies:false}),'NON');
assert.deepEqual(buildItems([{name:'Article 1',quantity:1,line_total:4.80}]),[{qte:'+00001.00',descr:'Article 1',prix:'+000000004.80',tax:'FP',acti:'NON'}]);
// Locks in the exact concatenation confirmed live against Revenu Québec's real DEV
// transaction endpoint (2026-08-21, T0000002 / psiNoTrans 066J-03VQ-00RT-05T2, HTTP 200).
assert.equal(
  buildTransactionSignatureInput({noTrans:'T0000002',datTrans:'20260821164439',mont:{TPS:'+00000000.24',TVQ:'+00000000.48',apresTax:'+00000005.52'},noTax:{noTPS:'567891234RT0001',noTVQ:'5678912340TQ0001'},modImpr:'FAC',modTrans:'OPE',signa:{preced:'='.repeat(88)}}),
  'T0000002'+'20260821164439'+'+00000000.24'+'+00000000.48'+'+00000005.52'+'567891234RT0001'+'5678912340TQ0001'+'FAC'+'OPE'+'='.repeat(88)
);
// SW-73.D: the transLot JSON array is most-recent-first even though the signature chain
// (each one's signa.preced == the previous one's signa.actu) runs oldest-first -- confirmed
// live (2026-08-21, noLot 0000131830, HTTP 200) with a real two-transaction offline batch.
assert.deepEqual(
  buildOfflineBatchEnvelope([{noTrans:'T0000007'},{noTrans:'T0000008'}]),
  {reqTrans:{transLot:[{noTrans:'T0000008'},{noTrans:'T0000007'}]}}
);
const mont=buildMont({subtotal:4.80,gst:0.24,qst:0.48,total:5.52});
assert.equal(mont.avantTax,'+000000004.80');
assert.equal(mont.TPS,'+000000000.24');
assert.equal(mont.TVQ,'+000000000.48');
assert.equal(mont.apresTax,'+000000005.52');
assert.equal(buildMont({subtotal:0,gst:0,qst:0,total:0}).ajus,undefined); // no invented adjustment when there is none

// SW-73.A: only codes ending in 0, 1 or 5 mean "retransmit in the next batch".
assert.equal(interpretCodRetour('94').shouldRetransmit,false); // JW00B999000E family (contexte)
assert.equal(interpretCodRetour('11').shouldRetransmit,true);
assert.equal(interpretCodRetour('91').shouldRetransmit,true);
assert.equal(interpretCodRetour('12').shouldRetransmit,false);
assert.equal(interpretCodRetour('00').shouldRetransmit,true);
assert.equal(interpretCodRetour(5).shouldRetransmit,true); // accepts a bare number, not just "05"

// SW-73 Tableau 22: authCode + IDAPPRL + signature(s), oldest to newest, no separators.
assert.equal(
  buildSignatureInput({authorizationCode:'X1X1-X1X1',idApprl:'9999-9999-9999',transactionSignatures:['sigA','sigB']}),
  'X1X1-X1X19999-9999-9999sigAsigB'
);

// SW-73 4.3.1.1: "AJO" carries the CSR, "REM"/"SUP" carry the serial being replaced -- never both.
assert.deepEqual(buildReqCertif({modif:'AJO',csrPem:'-----BEGIN...'}),{reqCertif:{modif:'AJO',csr:'-----BEGIN...'}});
assert.deepEqual(buildReqCertif({modif:'SUP',certificateSerialToReplace:'AB12'}),{reqCertif:{modif:'SUP',noSerie:'AB12'}});
// SW-77 §3.3.2 worked example (cas 002/501, étape 01): AJO with tax numbers for the first
// account created for an exploitant.
assert.deepEqual(buildReqUtil({modif:'AJO',userName:'Michel Untel',gstNumber:'567891234RT0001',qstNumber:'5678912340TQ0001'}),{reqUtil:{modif:'AJO',nomUtil:'Michel Untel',noTax:{noTPS:'567891234RT0001',noTVQ:'5678912340TQ0001'}}});
// Étape 02 (SUP) and étape 03/04 (AJO for later accounts) carry no noTax in the doc's examples.
assert.deepEqual(buildReqUtil({modif:'SUP',userName:'Michel Untel'}),{reqUtil:{modif:'SUP',nomUtil:'Michel Untel'}});
assert.deepEqual(buildReqUtil({modif:'AJO',userName:'John Smith'}),{reqUtil:{modif:'AJO',nomUtil:'John Smith'}});

assert.equal(validateSevText('Terrasse'),null);
assert.match(validateSevText(' Terrasse'),/espace/);
assert.match(validateSevText('Café ☕'),/alphabet/);

console.log('OK - taxes, split, pourboire, statuts MEV, noms SRM, documents SW-76 et protocole MEV-WEB (SW-73)');
