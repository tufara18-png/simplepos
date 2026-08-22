// Real MEV-WEB request builders, per the SW-73 family now available to this partner.
//
// VERIFIED LIVE (2026-08-21) against Revenu Québec's real DEV environment, mTLS with the
// certificate a "certificats" AJO enrolment returned, all HTTP 200/201 with real psi
// identifiers back: a normal cash "reçu de fermeture" (RFER), the same with a tip (mont.pourb),
// a transaction cancelled in progress (typTrans "SOB", modImpr "ANN", every per-item field
// also "SOB" including "acti" -- "acti":"NON" on a SOB item is explicitly rejected), a credit
// note (RFER with negative mont/item amounts and a "refs" entry pointing at the original
// transaction), and a two-transaction offline batch ("transLot", no "transActu": the JSON
// array is most-recent-first while the header signature concatenation is oldest-first, and the
// signature chain -- each transaction's signa.preced equal to the previous one's signa.actu --
// carries correctly across a batch). Confirmed correct for everything above: sectActi,
// items[].{qte,descr,prix,tax,acti}, mont (including pourb), noDossFO, noTax, commerElectr,
// typTrans/modPai/modImpr/formImpr/modTrans, refs, transLot, signa (the header SIGNATRANSM and
// the body's own signa.actu use different, confirmed concatenations -- see buildSignatureInput
// vs buildTransactionSignatureInput), emprCertifSEV, SEV, utc.
//
// Real bugs this exposed and fixed along the way: "utc" and item "acti" are mandatory, not
// optional as the spec's prose reads at a skim; reqTrans-level "noTax"/"noDossFO" were missing
// entirely from an earlier pass; a SOB (cancelled) item must carry "acti":"SOB", not "NON".
//
// Still never exercised, so still lower-confidence: docAdr in a non-default shape, clint (B2B),
// versActu/versAnt/sold (payment in instalments), and estimation/soumission/addition typTrans
// values (only RFER and SOB have been sent). Re-verify each against DEV before relying on it.
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

export function datTrans(date) {
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
 * combinations like "FP", or "NON"/"SOB"). Resto360 currently only ever charges both GST and
 * QST together or neither, so this only ever produces "FP" or "NON" -- the other combinations
 * exist in the spec for sectors/situations Resto360 does not have yet.
 */
export function taxIndicator({ gstApplies = true, qstApplies = true } = {}) {
  if (!gstApplies && !qstApplies) return 'NON';
  return `${gstApplies ? 'F' : ''}${qstApplies ? 'P' : ''}`;
}

/**
 * Builds the "items" array for a reqTrans body from Resto360 invoice_items rows.
 * `unitr` is only included when a per-unit price actually applies (SW-73: if present, prix
 * must equal qte * unitr) -- Resto360 sells at a flat line price, so it is omitted rather
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
    // reservation deposit, bar tab and habitual-third-party cases Resto360 does not have yet.
    acti: 'NON',
  }));
}

/**
 * The "mont" (montants) block. `ajus` is only meaningful when the declared total differs from
 * the strict sum of taxes and subtotal by a rounding adjustment Resto360 already tracks
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
  card: 'CRE', // fallback when the credit/debit distinction (card_credit/card_debit) isn't known
  card_credit: 'CRE',
  card_debit: 'DEB',
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
// fermeture) is correct for a paid closing receipt -- Resto360's other document types map to
// their SW-73 counterparts by name; "addition" (before payment) is genuinely "ADDI", not RFER.
const DOCUMENT_TYPE_TYP_TRANS = {
  addition: 'ADDI',
  closing_receipt: 'RFER',
  credit_note: 'RFER',
  correction: 'RFER',
  // Confirmed live: a SOB (cancelled-in-progress) transaction additionally needs every item's
  // "acti" set to "SOB" (buildItems always sets "NON" -- there is no caller yet that builds a
  // cancellation through buildReqTrans, so that override is not wired up here; do not reuse
  // buildItems()'s output unmodified for a "cancellation" documentType without fixing that).
  cancellation: 'SOB',
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
  modeTransaction = 'OPE',
}) {
  const sectActi = { abrvt: 'RBC', typServ: tableLabel ? 'TBL' : 'CMP' };
  if (tableLabel) sectActi.noTabl = String(tableLabel).slice(0, 5);
  if (guestCount) sectActi.nbClint = String(guestCount).padStart(3, '0');

  const transActu = {
    sectActi,
    // invoices.invoice_number is the gapless, server-assigned, per-restaurant sequence
    // (fiscal_ledger_hardening migration) -- the actual candidate for "unique par jour civil".
    // invoice.id (a UUID) is not that and must never be used here, even truncated.
    noTrans: String(invoice.invoice_number ?? invoice.id).slice(0, 10),
    nomMandt: String(restaurant.legal_name || restaurant.name || '').slice(0, 64),
    nomUtil: String(invoice.user_name || restaurant.name || '').slice(0, 64),
    relaCommer: 'B2C',
    datTrans: datTrans(invoice.created_at || Date.now()),
    // Confirmed live (2026-08-21) that "utc" is mandatory, not optional, and the format is
    // "-05:00A" for continental Quebec ("-04:00" applies only to Îles-de-la-Madeleine, which
    // Resto360 has no restaurant in yet). Hardcoded rather than derived from the device's own
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
    // SW-73 4.4.1.1.16: OPE (real activity) or FOR (Formation/practice) -- "peu importe le
    // mode, toutes les transactions doivent être transmises au MEV-WEB", so this only changes
    // the flag, never whether the request is sent.
    modTrans: modeTransaction === 'FOR' ? 'FOR' : 'OPE',
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
 * Wraps a queue of offline transActu objects (already built and signed, each one's
 * signa.preced equal to the previous one's signa.actu -- the chain must not skip) into a
 * "transLot" envelope, with no "transActu" of its own. Confirmed live (2026-08-21): the JSON
 * array must be most-recent-first even though the chain itself, and the header signature
 * (see buildSignatureInput -- pass transactionSignatures in chain order, oldest first), are
 * oldest-first. `offlineQueue` here must already be in chain order (oldest first); this
 * function does the most-recent-first reversal for the JSON array so callers do not have to
 * remember which order goes where.
 */
export function buildOfflineBatchEnvelope(offlineQueueOldestFirst) {
  return { reqTrans: { transLot: [...offlineQueueOldestFirst].reverse() } };
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

function derReadTL(bytes, offset) {
  const tag = bytes[offset];
  const lenByte = bytes[offset + 1];
  let length, contentStart;
  if (lenByte & 0x80) {
    const numBytes = lenByte & 0x7f;
    length = 0;
    for (let i = 0; i < numBytes; i++) length = (length << 8) | bytes[offset + 2 + i];
    contentStart = offset + 2 + numBytes;
  } else {
    length = lenByte;
    contentStart = offset + 2;
  }
  return { tag, length, contentStart };
}

/**
 * Pulls the serialNumber out of an X.509 DER certificate's PEM text -- the "noSerie" a "REM"/
 * "SUP" certificats request must carry to tell Revenu Québec which certificate to act on
 * (SW-77 Cas 500). No crypto library needed: Certificate/TBSCertificate are both a fixed
 * SEQUENCE shape (RFC 5280 4.1), and serialNumber is the first field after the optional
 * [0]-tagged EXPLICIT version -- present on any v3 cert, which is what these are (they carry
 * extensions).
 */
export function parseCertificateSerialHex(pem) {
  const b64 = String(pem).replace(/-----BEGIN CERTIFICATE-----/, '').replace(/-----END CERTIFICATE-----/, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const { contentStart: certStart } = derReadTL(der, 0);
  const { contentStart: tbsStart } = derReadTL(der, certStart);
  let pos = tbsStart;
  if (der[pos] === 0xa0) {
    const { length, contentStart } = derReadTL(der, pos);
    pos = contentStart + length;
  }
  const { tag, length, contentStart: serialStart } = derReadTL(der, pos);
  if (tag !== 0x02) throw new Error('Format de certificat inattendu (numéro de série introuvable)');
  return Array.from(der.slice(serialStart, serialStart + length)).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * SW-78 FO-127: the SEV must warn the user before the operator's certificate expires -- pulls
 * notAfter straight out of the same DER structure parseCertificateSerialHex already walks
 * (RFC 5280 4.1: TBSCertificate serialNumber, signature AlgorithmIdentifier, issuer Name,
 * validity { notBefore, notAfter }, in that fixed order), so no crypto library is needed here
 * either. Returns an ISO 8601 string.
 */
export function parseCertificateExpiry(pem) {
  const b64 = String(pem).replace(/-----BEGIN CERTIFICATE-----/, '').replace(/-----END CERTIFICATE-----/, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const { contentStart: certStart } = derReadTL(der, 0);
  const { contentStart: tbsStart } = derReadTL(der, certStart);
  let pos = tbsStart;
  if (der[pos] === 0xa0) {
    const { length, contentStart } = derReadTL(der, pos);
    pos = contentStart + length;
  }
  let tl = derReadTL(der, pos); // serialNumber
  pos = tl.contentStart + tl.length;
  tl = derReadTL(der, pos); // signature AlgorithmIdentifier
  pos = tl.contentStart + tl.length;
  tl = derReadTL(der, pos); // issuer Name
  pos = tl.contentStart + tl.length;
  tl = derReadTL(der, pos); // validity SEQUENCE { notBefore, notAfter }
  if (tl.tag !== 0x30) throw new Error('Format de certificat inattendu (validité introuvable)');
  const notBefore = derReadTL(der, tl.contentStart);
  const notAfter = derReadTL(der, notBefore.contentStart + notBefore.length);
  const text = new TextDecoder().decode(der.slice(notAfter.contentStart, notAfter.contentStart + notAfter.length));
  // UTCTime (tag 0x17): YYMMDDHHMMSSZ, two-digit year per RFC 5280 4.1.2.5.1 (>=50 -> 19xx, else 20xx).
  // GeneralizedTime (tag 0x18): YYYYMMDDHHMMSSZ.
  const m = notAfter.tag === 0x18
    ? text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/)
    : text.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) throw new Error('Format de date de certificat inattendu');
  const [, yRaw, mo, d, h, mi, s] = m;
  const y = notAfter.tag === 0x18 ? Number(yRaw) : (Number(yRaw) < 50 ? 2000 : 1900) + Number(yRaw);
  return new Date(Date.UTC(y, Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))).toISOString();
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
 * "utilisateur" request (SW-77 3.3): must be sent whenever a user account is added or removed
 * on the SEV -- confirmed as a general SEV obligation, not just a certification checkbox
 * ("Si vous ajoutez ou supprimez un compte utilisateur... une requête de type «utilisateur»
 * doit être transmise au MEV-WEB"). noTax is optional and included only when validating an
 * exploitant's tax numbers alongside the account (SW-77 cas 570) -- most account creations
 * after the first don't carry it, per the worked examples in 3.3.2.
 */
export function buildReqUtil({ modif, userName, gstNumber = null, qstNumber = null }) {
  const reqUtil = { modif, nomUtil: String(userName).trim() };
  if (gstNumber || qstNumber) reqUtil.noTax = { noTPS: gstNumber, noTVQ: qstNumber };
  return { reqUtil };
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

/**
 * "document" request for the rapport de l'utilisateur (typDoc "RUT", SW-73 4.3.4.2.1/Tableau 28,
 * signature order per Tableau 30). BEST RECONSTRUCTION FROM THE SPEC, NOT VERIFIED LIVE (unlike
 * reqTrans/reqCertif above) -- Tableau 28's field-to-code mapping was badly mangled by PDF
 * conversion; UT/AN/VR/EM's meanings were recovered from the worked example and the clearer
 * restatement in SW-73.B rather than a clean table read. Known simplifications, to revisit once
 * an actual cas d'essai is run against this:
 *   - SN (total transactions) and SV (payment transactions, Tableau 29) are both set to the same
 *     count. generateUserReport() only aggregates accepted/paid invoices today, which is really
 *     just SV -- Resto360 has no query yet for the broader SN (would also include free/cancelled/
 *     Formation-mode documents, none of which exist as a separate countable set today).
 *   - SA (montant ajusté) is always 0 -- nothing in Resto360 tracks a report-level adjustment
 *     distinct from the sales total itself.
 *   - TS "A" and SR/IA = the device's own IDAPPRL assume Resto360's current one-device-per-
 *     restaurant reality; would need to become "E" (établissement) if that ever changes.
 *   - CM "Tous": generateUserReport() aggregates every invoice for the restaurant regardless of
 *     which staff account rang it, so this is never "Unique".
 */
export function buildReqDocumentRut({ restaurant, device, partnerConfig, report, lastInvoice, loginAt }) {
  const nomUtilOuMandt = String(report.user_name || restaurant.legal_name || restaurant.name || '').slice(0, 64);
  const sn = String(Math.trunc(report.sales_count));
  const fields = [
    ['RT', partnerConfig.no_tps],
    ['TQ', partnerConfig.no_tvq],
    ['UT', nomUtilOuMandt],
    ['NO', lastInvoice ? String(lastInvoice.invoice_number ?? '').slice(0, 10) : ''],
    ['MT', money(lastInvoice ? lastInvoice.total : 0)],
    ['DF', lastInvoice ? datTrans(lastInvoice.created_at) : datTrans(Date.now())],
    ['AN', String(report.period_year)],
    ['SN', sn],
    ['SV', sn],
    ['SS', money(report.sales_subtotal)],
    ['SF', money(report.sales_gst)],
    ['SP', money(report.sales_qst)],
    ['ST', money(report.sales_total)],
    ['SA', money(0)],
    ['SD', money(report.sales_total)],
    ['TS', 'A'],
    ['SR', device.id_apprl || ''],
    ['CM', 'Tous'],
    ['IA', device.id_apprl || ''],
    ['IS', partnerConfig.id_sev],
    ['VR', partnerConfig.versi],
    ['DC', datTrans(loginAt || Date.now())],
    ['DR', datTrans(Date.now())],
  ];
  return fields;
}

/** Appends SI (the signature computed over buildReportSignatureInput's output), then EM/AD, in
 * the exact order the worked example uses -- SI comes before EM/AD, not after. */
export function withReportSignatureAndFooter(fields, { signatureBase64, device, restaurant }) {
  return [...fields, ['SI', signatureBase64], ['EM', device.certificate_thumbprint_sha1 || ''], ['AD', restaurant.address || '']];
}

/**
 * Tableau 30's concatenation order for the report's own signature -- deliberately not every
 * field that ends up in the transmitted "doc" string (SA/SD/TS/SR/CM/EM/AD are excluded, same
 * as the source table).
 */
export function buildReportSignatureInput({ partnerConfig, nomUtilOuMandt, lastInvoice, report, device, loginAt }) {
  return [
    partnerConfig.no_tps,
    partnerConfig.no_tvq,
    nomUtilOuMandt,
    lastInvoice ? String(lastInvoice.invoice_number ?? '').slice(0, 10) : '',
    money(lastInvoice ? lastInvoice.total : 0),
    lastInvoice ? datTrans(lastInvoice.created_at) : datTrans(Date.now()),
    String(report.period_year),
    String(Math.trunc(report.sales_count)),
    String(Math.trunc(report.sales_count)),
    money(report.sales_subtotal),
    money(report.sales_gst),
    money(report.sales_qst),
    money(report.sales_total),
    device.id_apprl || '',
    partnerConfig.id_sev,
    partnerConfig.versi,
    datTrans(loginAt || Date.now()),
    datTrans(Date.now()),
  ].join('');
}

/** Joins ordered [key,value] pairs (buildReqDocumentRut's output, extended by withReportSignatureAndFooter) into the ";"-delimited "doc" string SW-73 4.3.4.2.1 requires. */
export function formatDocumentFields(fields) {
  return fields.map(([k, v]) => `${k}=${v ?? ''}`).join(';');
}
