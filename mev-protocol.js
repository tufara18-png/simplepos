// Real MEV-WEB request builders, per the SW-73 family now available to this partner.
//
// VERIFIED LIVE (2026-08-21): a "certificats" AJO enrolment followed by a "transaction" RFER
// (reçu de fermeture) built by these exact functions were both sent to Revenu Québec's real
// DEV environment (mTLS with the certificate the first call returned) and both came back
// accepted (HTTP 201, then HTTP 200 with a real psiNoTrans). This is not a guess anymore for
// the fields exercised by that round trip: sectActi, items[].{qte,descr,prix,tax,acti}, mont,
// noDossFO, noTax, commerElectr, typTrans/modPai/modImpr/formImpr/modTrans, signa (both the
// header SIGNATRANSM and the body's own signa.actu, which use different, confirmed
// concatenations -- see buildSignatureInput vs buildTransactionSignatureInput), emprCertifSEV,
// SEV, utc. Three real bugs this exposed and fixed: "utc" and item "acti" are mandatory, not
// optional as the spec's prose reads at a skim, and the reqTrans-level "noTax"/"noDossFO"
// fields were missing entirely from an earlier pass.
//
// Not yet exercised by that round trip, so still lower-confidence: refs (correction/credit-note
// references), transLot (offline batching), docAdr, clint, and the tip/versement (pourb/versActu
// etc.) fields in mont -- the test transaction was a single-item cash sale with no tip, no
// table, no batch and no correction. Re-verify each of those against DEV before relying on them
// for a real cas d'essai.
//
// This module builds JSON. It does not send anything anywhere and it does not know about
// Supabase, fetch, or the DOM, so it can be unit-tested with plain sample data (see tests.mjs).

export const SEV_ALPHABET_RE = /^[a-zA-Z0-9 @:!#$%&'()*+,\-.=?_|~ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝàáâãäåæçèéêëìíîïðñòóôõöøùúûüýÿ]+$/;

function money(n) {
  const v = Number(n || 0);
  const sign = v < 0 ? '-' : '+';
  return `${sign}${Math.abs(v).toFixed(2).padStart(12, '0')}`;
}

function qty(n) {
  const v = Number(n || 0);
  const sign = v < 0 ? '-' : '+';
  return `${sign}${Math.abs(v).toFixed(2).padStart(8, '0')}`;
}

function datTrans(date) {
  const d = new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// SW-73 3.7.2's REGEX for a general field; the "desc" field of an item/precision may use the
// wider variant which additionally allows / < > \. This module only validates the general
// alphabet -- item description validation against the wider set already lives in app-v2.js
// (SRM_NAME_RE) and is intentionally not duplicated here.
export function validateSevText(value, { min = 1, max = 4000 } = {}) {
  const v = String(value ?? '');
  if (v.length < min || v.length > max) return `Longueur invalide (${min}-${max} caractères).`;
  if (v !== v.trim()) return 'Ne doit pas commencer ni finir par une espace.';
  if (!SEV_ALPHABET_RE.test(v)) return 'Caractère hors alphabet ASCII étendu accepté par le MEV-WEB.';
  return null;
}

/**
 * Tax indicator for an item ("F" federal only, "P" provincial only, "S" a supplementary tax,
 * combinations like "FP", or "NON"/"SOB"). SimplePOS currently only ever charges both GST and
 * QST together or neither, so this only ever produces "FP" or "NON" -- the other combinations
 * exist in the spec for sectors/situations SimplePOS does not have yet.
 */
export function taxIndicator({ gstApplies = true, qstApplies = true } = {}) {
  if (!gstApplies && !qstApplies) return 'NON';
  return `${gstApplies ? 'F' : ''}${qstApplies ? 'P' : ''}`;
}

/**
 * Builds the "items" array for a reqTrans body from SimplePOS invoice_items rows.
 * `unitr` is only included when a per-unit price actually applies (SW-73: if present, prix
 * must equal qte * unitr) -- SimplePOS sells at a flat line price, so it is omitted rather
 * than back-computed and risk being wrong.
 */
export function buildItems(invoiceItems) {
  return (invoiceItems || []).map((line) => ({
    qte: qty(line.quantity),
    descr: String(line.name || 'Article'),
    prix: money(line.line_total),
    tax: taxIndicator({ gstApplies: true, qstApplies: true }),
    // Confirmed live against Revenu Québec's real DEV transaction endpoint (2026-08-21):
    // "acti" is mandatory per item, not optional as it first read. "NON" is the RBC-sector
    // value for an ordinary sale -- the other codes (CDR/RES/BAR/HAB/SOB) are for cancellation,
    // reservation deposit, bar tab and habitual-third-party cases SimplePOS does not have yet.
    acti: 'NON',
  }));
}

/**
 * The "mont" (montants) block. `ajus` is only meaningful when the declared total differs from
 * the strict sum of taxes and subtotal by a rounding adjustment SimplePOS already tracks
 * elsewhere as `roundingAdjustment` -- pass 0 when there is none, never invent a value.
 */
export function buildMont({ subtotal, gst, qst, total, roundingAdjustment = 0, amountDue = null, tip = 0 }) {
  const mont = {
    avantTax: money(subtotal),
    TPS: money(gst),
    TVQ: money(qst),
    apresTax: money(total),
  };
  if (roundingAdjustment) mont.ajus = money(roundingAdjustment);
  if (amountDue != null) mont.mtdu = money(amountDue);
  if (tip) mont.pourb = money(tip);
  return mont;
}

const PAYMENT_METHOD_CODE = {
  cash: 'ARG',
  card: 'CRE', // SimplePOS does not distinguish credit/debit terminals yet; DEB exists for when it does.
  other: 'AUT',
  left_without_paying: 'SOB',
};

const DOCUMENT_TYPE_MOD_IMPR = {
  addition: 'FAC',
  closing_receipt: 'FAC',
  credit_note: 'FAC',
  correction: 'RPR',
  cancellation: 'ANN',
  duplicate: 'DUP',
  reproduction: 'RPR',
};

// typTrans: "ADDI"|"ESTM"|"RFER"|"SOUM"|"TIER"|"SOB". Confirmed live that "RFER" (reçu de
// fermeture) is correct for a paid closing receipt -- SimplePOS's other document types map to
// their SW-73 counterparts by name; "addition" (before payment) is genuinely "ADDI", not RFER.
const DOCUMENT_TYPE_TYP_TRANS = {
  addition: 'ADDI',
  closing_receipt: 'RFER',
  credit_note: 'RFER',
  correction: 'RFER',
};

/**
 * Full reqTrans envelope for one transaction. `signaturePreviousBase88` must be "=" * 88 for
 * this device's very first transaction (SW-73 footnote 3), and the real IEEE P1363 signature
 * of the immediately preceding transaction on this device for every one after that.
 */
export function buildReqTrans({
  restaurant,
  device,
  partnerConfig,
  invoice,
  invoiceItems,
  paymentMethod,
  documentType,
  tableLabel,
  guestCount,
  replacesTransaction,
  offlineBatch = [],
  signaturePreviousBase88,
}) {
  const sectActi = { abrvt: 'RBC', typServ: tableLabel ? 'TBL' : 'CMP' };
  if (tableLabel) sectActi.noTabl = String(tableLabel).slice(0, 5);
  if (guestCount) sectActi.nbClint = String(guestCount).padStart(3, '0');

  const transActu = {
    sectActi,
    noTrans: String(invoice.local_reference || invoice.id).slice(0, 10),
    nomMandt: String(restaurant.legal_name || restaurant.name || '').slice(0, 64),
    nomUtil: String(invoice.user_name || restaurant.name || '').slice(0, 64),
    relaCommer: 'B2C',
    datTrans: datTrans(invoice.created_at || Date.now()),
    // Confirmed live (2026-08-21) that "utc" is mandatory, not optional, and the format is
    // "-05:00A" for continental Quebec ("-04:00" applies only to Îles-de-la-Madeleine, which
    // SimplePOS has no restaurant in yet). Hardcoded rather than derived from the device's own
    // timezone, since a device set to the wrong local timezone must not silently produce the
    // wrong regulatory field.
    utc: '-05:00A',
    items: buildItems(invoiceItems),
    mont: buildMont({
      subtotal: invoice.subtotal,
      gst: invoice.gst,
      qst: invoice.qst,
      total: invoice.total,
      tip: invoice.tip_amount,
    }),
    // Confirmed live (2026-08-21) that noDossFO/noTax are mandatory -- an earlier pass had
    // both missing entirely, and the request was rejected until they were added.
    noDossFO: partnerConfig.dossier_number,
    noTax: { noTPS: partnerConfig.no_tps, noTVQ: partnerConfig.no_tvq },
    commerElectr: 'N',
    typTrans: DOCUMENT_TYPE_TYP_TRANS[documentType] || 'ADDI',
    modPai: PAYMENT_METHOD_CODE[paymentMethod] || 'AUT',
    modImpr: DOCUMENT_TYPE_MOD_IMPR[documentType] || 'FAC',
    formImpr: 'PAP',
    modTrans: 'OPE',
    signa: {
      datActu: datTrans(Date.now()),
      // `actu` (this transaction's own signature) is filled in by the caller after building
      // this object -- use buildTransactionSignatureInput(transActu) below, sign that string
      // (SHA-256 + ECDSA P-256 + IEEE P1363, same as the header signature), then set `actu` to
      // the result before this envelope is sent. Confirmed live against the real DEV endpoint.
      actu: null,
      preced: signaturePreviousBase88 || '='.repeat(88),
    },
    emprCertifSEV: device.certificate_thumbprint_sha1 || null,
    SEV: {
      idSEV: partnerConfig.id_sev,
      idVersi: partnerConfig.id_versi,
      codCertif: partnerConfig.cod_certif,
      idPartn: partnerConfig.id_partn,
      versi: partnerConfig.versi,
      versiParn: partnerConfig.versi_parn,
    },
  };

  if (restaurant.address) transActu.docAdr = { docNoCiviq: String(restaurant.address).slice(0, 16), docCp: restaurant.postal_code || undefined };
  if (replacesTransaction) transActu.refs = [{ noTrans: replacesTransaction.noTrans, datTrans: replacesTransaction.datTrans, avantTax: money(replacesTransaction.avantTax) }];

  const body = { reqTrans: { transActu } };
  if (offlineBatch.length) body.reqTrans.transLot = offlineBatch;
  return body;
}

/**
 * The exact text to sign for a transaction's own body signature (signa.actu), confirmed live
 * against Revenu Québec's real DEV transaction endpoint (2026-08-21) and matching SW-73.C's
 * reference implementation verbatim (Demo.cs "strConcateneePourSignature"). Call this with the
 * transActu object BEFORE signa.actu is set (it is not part of the signed text), sign the
 * result (SHA-256 + ECDSA P-256 + IEEE P1363), then set transActu.signa.actu to that signature.
 */
export function buildTransactionSignatureInput(transActu) {
  return `${transActu.noTrans}${transActu.datTrans}${transActu.mont.TPS}${transActu.mont.TVQ}${transActu.mont.apresTax}${transActu.noTax.noTPS}${transActu.noTax.noTVQ}${transActu.modImpr}${transActu.modTrans}${transActu.signa.preced}`;
}

/**
 * Header fields common to every request type (SW-73 Tableau 13 and equivalents). ENVIRN,
 * CASESSAI etc. Signature fields are attached separately once the body is known (see
 * buildSignatureInput) since they are computed over the finished body, not part of it.
 */
export function buildHeaders({ environment, caseEssai = '000.000', device, partnerConfig }) {
  return {
    ENVIRN: environment,
    CASESSAI: caseEssai,
    APPRLINIT: 'SEV',
    IDAPPRL: device.id_apprl,
    NOTPS: partnerConfig.no_tps,
    NOTVQ: partnerConfig.no_tvq,
    IDSEV: partnerConfig.id_sev,
    IDVERSI: partnerConfig.id_versi,
    CODCERTIF: partnerConfig.cod_certif,
    IDPARTN: partnerConfig.id_partn,
    VERSI: partnerConfig.versi,
    VERSIPARN: partnerConfig.versi_parn,
  };
}

/**
 * SW-73 Tableau 22: the exact, ordered concatenation to sign for a "transaction" request's
 * header. For a batch, `transactionSignatures` must already be ordered oldest-to-newest and
 * include the current transaction's own signature last.
 */
export function buildSignatureInput({ authorizationCode, idApprl, transactionSignatures }) {
  return `${authorizationCode}${idApprl}${transactionSignatures.join('')}`;
}

// SW-73.A: the second digit of codRetour (0-6) says why the MEV-WEB rejected the request; per
// the explicit table there, only 0, 1 and 5 mean "retransmit in the next batch" -- everything
// else is a terminal rejection this transaction will never succeed by retrying unmodified.
const RETRANSMIT_DIGITS = new Set(['0', '1', '5']);

export function interpretCodRetour(codRetour) {
  const code = String(codRetour ?? '').padStart(2, '0');
  const originDigit = code.slice(-1);
  const subjectDigit = code.slice(0, -1);
  return {
    code,
    subject: subjectDigit === '0' ? 'systeme' : subjectDigit === '1' ? 'utilisateur' : subjectDigit === '9' ? 'version_sev' : 'inconnu',
    shouldRetransmit: RETRANSMIT_DIGITS.has(originDigit),
  };
}

/**
 * "certificats" request to add ("AJO") a device's certificate, or replace/delete an existing
 * one ("REM"/"SUP"). `csrPem` comes straight from MevKeystorePlugin.createOperatorCsr -- this
 * function only wraps it in the envelope, it never builds or touches key material.
 */
export function buildReqCertif({ modif, csrPem = null, certificateSerialToReplace = null }) {
  const reqCertif = { modif };
  if (modif === 'AJO' && csrPem) reqCertif.csr = csrPem;
  if ((modif === 'REM' || modif === 'SUP') && certificateSerialToReplace) reqCertif.noSerie = certificateSerialToReplace;
  return { reqCertif };
}

/**
 * SW-73 Tableau 12: "AJO" (add a first/replacement certificate) goes to a distinct
 * "enrolement" host; "REM"/"SUP" and every other request type share the plain host. Both use
 * the "cnfr." prefix outside PROD. Confirmed live against the real DEV enrolement endpoint.
 */
export function endpointFor(requestType, modif, environment) {
  const confirm = environment === 'PROD' ? '' : 'cnfr.';
  if (requestType === 'certificats') {
    return modif === 'AJO'
      ? `https://certificats.${confirm}api.rq-fo.ca/enrolement`
      : `https://${confirm}api.rq-fo.ca/certificats`;
  }
  return `https://${confirm}api.rq-fo.ca/${requestType}`;
}
